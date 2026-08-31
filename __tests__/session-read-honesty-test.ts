import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/session get`, `/session messages` and `/session usage` swallow a
 * rejected RPC into `{}` and print the success title ("Session s1",
 * "Messages for session s1", "Session usage") as if the read happened —
 * the same failure class sessionActionResult was built to kill. A caught
 * rejection must carry the failure into the bubble text, with the
 * METHOD_GUIDANCE next step when the method has an entry and the error
 * does not already name it; resolved reads keep today's title and Raw
 * byte-identical.
 */
describe('/session get, /session messages and /session usage honesty', () => {
  test('a rejecting session.get RPC names the failure, not "Session s1"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.get is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session get s1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.get', { sessionId: 's1' });
    expect(result.text).toContain('Session s1 could not be read');
    expect(result.text).toContain('session.get is not supported');
    expect(result.text).not.toBe('Session s1');
    expect(result.raw).not.toBe('{}');
  });

  test('a rejecting session.messages RPC names the failure, not "Messages for session s1"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.messages is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session messages s1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.messages', { sessionId: 's1', limit: 50 });
    expect(result.text).toContain('Messages for session s1 could not be read');
    expect(result.text).toContain('session.messages is not supported');
    expect(result.text).not.toBe('Messages for session s1');
    expect(result.raw).not.toBe('{}');
  });

  test('a rejecting session.usage RPC names the failure, not "Session usage"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.usage is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session usage s1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.usage', { sessionId: 's1' });
    expect(result.text).toContain('Session usage could not be read');
    expect(result.text).toContain('session.usage is not supported');
    expect(result.text).not.toBe('Session usage');
    expect(result.raw).not.toBe('{}');
  });

  test('a rejecting session.usage RPC without an id still fails honestly', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.usage is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session usage', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.usage', {});
    expect(result.text).toContain('Session usage could not be read');
  });

  test('a rejecting session.get RPC with a bare error is not padded with guidance it has no entry for', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/session get s1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Session s1 could not be read: Error: boom');
  });

  test('a resolving session.get RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's1', title: 'T' });
    const result = await executeGatewaySlashCommand('/session get s1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.get', { sessionId: 's1' });
    expect(result.text).toBe('Session s1');
    expect(result.raw).toBe('{\n  "sessionId": "s1",\n  "title": "T"\n}');
  });

  test('a resolving session.messages RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ messages: ['m1'] });
    const result = await executeGatewaySlashCommand('/session messages s1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.messages', { sessionId: 's1', limit: 50 });
    expect(result.text).toBe('Messages for session s1');
    expect(result.raw).toBe('{\n  "messages": [\n    "m1"\n  ]\n}');
  });

  test('a resolving session.usage RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ usage: 'u1' });
    const result = await executeGatewaySlashCommand('/session usage', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Session usage');
    expect(result.raw).toBe('{\n  "usage": "u1"\n}');
  });

  test('an unknown /session subcommand still answers with the usage line naming every subcommand', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session frobnicate', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Usage: /session');
    expect(result.text).toContain('get <id>');
    expect(result.text).toContain('messages <id>');
    expect(result.text).toContain('usage [id]');
  });
});