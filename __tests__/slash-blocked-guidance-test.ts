import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: null,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
    ...overrides,
  };
}

describe('/blocked slash commands surface METHOD_GUIDANCE, not the generic reason', () => {
  test('a fresh snapshot blocking /bots answers with the Gate guidance, not "not dispatched by this gateway"', async () => {
    const result = await executeGatewaySlashCommand('/bots', {
      ...context(),
      methods: { bots: { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(result.text).not.toContain('not dispatched by this gateway');
    expect(result.text).toContain('Connect to the Gate, not Hermes directly');
    expect(result.text).toContain('Use /help to see what is.');
  });

  test('/bots still routes the real RPC when nothing blocks it', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ bots: [] });
    const result = await executeGatewaySlashCommand('/bots', {
      ...context(),
      gatewayRequest,
    });
    expect(gatewayRequest).toHaveBeenCalledWith('bots.list', {});
    expect(result.text).toContain('Bots:');
  });
});
