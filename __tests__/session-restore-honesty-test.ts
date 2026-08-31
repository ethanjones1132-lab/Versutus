import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/session restore honesty', () => {
  test('a successful read with a restoreSession hook switches the thread and invokes the hook exactly once', async () => {
    const restoreSession = jest.fn();
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-42', title: 'Old talk' });
    const result = await executeGatewaySlashCommand('/session restore s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession,
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.restore', { sessionId: 's-42' });
    expect(restoreSession).toHaveBeenCalledTimes(1);
    expect(restoreSession).toHaveBeenCalledWith('s-42');
    expect(result.text).toContain('Session s-42 restored');
    expect(result.text).not.toContain('not switched');
  });

  test('a successful read without a hook says the thread was not switched and points at the session selector', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-42', title: 'Old talk' });
    const result = await executeGatewaySlashCommand('/session restore s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.restore', { sessionId: 's-42' });
    expect(result.text).toContain('record read');
    expect(result.text).toContain('not switched');
    expect(result.text).toContain('session selector');
    expect(result.text).not.toContain('restored; the open thread');
  });

  test('a rejecting read never invokes the hook and names the failure instead of the success copy', async () => {
    const restoreSession = jest.fn();
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('Session not found'));
    const result = await executeGatewaySlashCommand('/session restore s-999', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession,
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.restore', { sessionId: 's-999' });
    expect(restoreSession).not.toHaveBeenCalled();
    expect(result.text).toContain('could not be restored');
    expect(result.text).toContain('Session not found');
    expect(result.text).not.toContain('restored; the open thread');
  });

  test('a rejecting read without a hook answers the same failure copy', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('Session not found'));
    const result = await executeGatewaySlashCommand('/session restore s-999', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('could not be restored');
    expect(result.text).toContain('Session not found');
  });

  test('missing id keeps the usage line and makes no wire call', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session restore', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Usage: /session restore <session-id>');
  });

  test('/session get <id> is unchanged when a restoreSession hook is present', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-42' });
    const result = await executeGatewaySlashCommand('/session get s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.get', { sessionId: 's-42' });
    expect(result.text).toContain('Session s-42');
  });

  test('/session messages <id> is unchanged when a restoreSession hook is present', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ messages: [] });
    const result = await executeGatewaySlashCommand('/session messages s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.messages', { sessionId: 's-42', limit: 50 });
    expect(result.text).toContain('Messages for session s-42');
  });

  test('/session usage and /session current are unchanged when a restoreSession hook is present', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-42' });
    const usage = await executeGatewaySlashCommand('/session usage s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession: jest.fn(),
    });
    expect(usage.text).toContain('Session usage');
    const current = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      restoreSession: jest.fn(),
    });
    expect(current.text).toContain('Current session');
  });
});