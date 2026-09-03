import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { sessionUsageSpendFromUnknown } from '@/lib/gateway/session-analytics';

/**
 * Bare `/session usage` prints the words "Session usage" while the one fact
 * the operator asked for — tokens and cost — sits only in Raw. The Gate
 * answers two shapes behind one RPC
 * (`gate/core/capabilities/gateway-methods.mjs:218-229`): bare catalogue
 * totals without an id, one session's counters with one. Both must render
 * the same spend line `/usage` already prints; a rejection and an
 * unfamiliar envelope keep today's copies byte-identical.
 */
describe('/session usage copy', () => {
  const contextFor = (gatewayRequest: jest.Mock) => ({
    hello: null,
    gatewayRequest,
    runAgentCommand: jest.fn(),
  });

  test('bare catalogue totals render the spend line, not the title', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      sessions: 3,
      message_count: 12,
      tool_call_count: 4,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      api_call_count: 9,
    });
    const result = await executeGatewaySlashCommand('/session usage', contextFor(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('session.usage', {});
    expect(result.text).toBe('Sessions: 3\nTokens: 1.5k\nCost: —');
    expect(result.title).toBe('/session usage');
    expect(result.raw).toContain('"sessions": 3');
  });

  test('one session record renders its own tokens and cost', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      sessionId: 's1',
      message_count: 6,
      tool_call_count: 2,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      api_call_count: 3,
      estimated_cost_usd: 0.42,
      actual_cost_usd: null,
    });
    const result = await executeGatewaySlashCommand('/session usage s1', contextFor(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('session.usage', { sessionId: 's1' });
    expect(result.text).toBe('Sessions: 1\nTokens: 150\nCost: $0.42');
    expect(result.title).toBe('/session usage');
    expect(result.raw).toContain('"sessionId": "s1"');
  });

  test('a rejecting usage RPC keeps the failure copy', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.usage is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session usage', contextFor(gatewayRequest));
    expect(result.text).toContain('Session usage could not be read');
    expect(result.text).toContain('session.usage is not supported');
  });

  test('an unfamiliar usage envelope keeps the title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ usage: 'u1' });
    const result = await executeGatewaySlashCommand('/session usage', contextFor(gatewayRequest));
    expect(result.text).toBe('Session usage');
    expect(result.raw).toBe('{\n  "usage": "u1"\n}');
  });

  test('actual cost wins over estimated in a single record', async () => {
    expect(
      sessionUsageSpendFromUnknown({ sessionId: 's9', input_tokens: 10, output_tokens: 5, actual_cost_usd: 1.2, estimated_cost_usd: 3.4 }),
    ).toEqual({ sessionCount: 1, tokens: 15, costUsd: 1.2 });
  });

  test('a non-record usage payload is not a spend read', async () => {
    expect(sessionUsageSpendFromUnknown(null)).toBeNull();
    expect(sessionUsageSpendFromUnknown([{ input_tokens: 1 }])).toBeNull();
  });
});
