import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/session compact and /session abort honesty', () => {
  test('a rejecting session.compact RPC names the failure, not "Session compact requested"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.compact is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session compact', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.compact', {});
    expect(result.text).not.toContain('Session compact requested');
    expect(result.text).toContain('could not be run');
    expect(result.text).toContain('session.compact is not supported');
  });

  test('a rejecting session.abort RPC names the failure, not "Session abort requested"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.abort is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session abort', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.abort', {});
    expect(result.text).not.toContain('Session abort requested');
    expect(result.text).toContain('could not be run');
    expect(result.text).toContain('session.abort is not supported');
  });

  test('a rejecting session.compact RPC with a bare error still carries the METHOD_GUIDANCE next step', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/session compact', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).not.toContain('Session compact requested');
    expect(result.text).toContain('No remote compaction endpoint');
  });

  test('a resolving session.compact RPC still prints the success copy', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/session compact', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.compact', {});
    expect(result.text).toContain('Session compact requested');
  });

  test('a resolving session.abort RPC still prints the success copy', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/session abort', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.abort', {});
    expect(result.text).toContain('Session abort requested');
  });

  test('a fresh snapshot blocking session-compact answers with the METHOD_GUIDANCE next step, not the generic reason', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session compact', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { 'session-compact': { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('No remote compaction endpoint');
    expect(result.text).toContain('Use /help to see what is.');
    expect(result.text).not.toContain('not dispatched by this gateway');
  });

  test('a fresh snapshot blocking session-abort answers with the METHOD_GUIDANCE next step', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session abort', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { 'session-abort': { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('app stop button aborts the stream');
  });

  test('a blocked command whose method has no guidance keeps the snapshot reason', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { 'session-current': { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('not dispatched by this gateway');
    expect(result.text).toContain('Use /help to see what is.');
  });

  test('/session current is untouched when nothing blocks it', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's1' });
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.current', {});
    expect(result.text).toContain('Current session');
  });
});