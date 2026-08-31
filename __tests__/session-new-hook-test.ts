import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/session new hook', () => {
  test('a createNewSession hook is invoked exactly once for /session new, with no wire call', async () => {
    const createNewSession = jest.fn();
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session new', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      createNewSession,
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(createNewSession).toHaveBeenCalledWith(undefined);
    expect(result.text).toContain('New session opened');
    expect(result.text).toContain('starts fresh');
    expect(result.text).not.toContain('session selector');
  });

  test('/session new forwards an optional quoted title to the hook', async () => {
    const createNewSession = jest.fn();
    const result = await executeGatewaySlashCommand('/session new "Fresh talk"', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      createNewSession,
    });
    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(createNewSession).toHaveBeenCalledWith('Fresh talk');
    expect(result.text).toContain('Fresh talk');
  });

  test('/session new forwards a bare single-word title', async () => {
    const createNewSession = jest.fn();
    const result = await executeGatewaySlashCommand('/session new Fresh', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      createNewSession,
    });
    expect(createNewSession).toHaveBeenCalledWith('Fresh');
    expect(result.text).toContain('Fresh');
  });

  test('an empty-title /session new behaves like no title', async () => {
    const createNewSession = jest.fn();
    const result = await executeGatewaySlashCommand('/session new ""', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      createNewSession,
    });
    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(createNewSession).toHaveBeenCalledWith(undefined);
    expect(result.text).toContain('New session opened');
    expect(result.text).not.toContain('""');
  });

  test('without a hook, /session new answers honestly and names the session selector', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session new', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('cannot be opened');
    expect(result.text).toContain('session selector');
    expect(result.text).not.toContain('starts fresh');
  });

  test('a /session new never touches a restoreSession hook', async () => {
    const restoreSession = jest.fn();
    const result = await executeGatewaySlashCommand('/session new', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      createNewSession: jest.fn(),
      restoreSession,
    });
    expect(restoreSession).not.toHaveBeenCalled();
    expect(result.text).toContain('New session opened');
  });

  test('the /session usage line keeps naming every subcommand, including new [title]', async () => {
    const result = await executeGatewaySlashCommand('/session frobnicate', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Usage: /session');
    for (const fragment of [
      'current',
      'new [title]',
      'list',
      'get <id>',
      'messages <id>',
      'usage [id]',
      'abort [id]',
      'compact [id]',
      'restore <id>',
    ]) {
      expect(result.text).toContain(fragment);
    }
  });

  test('/session restore and /session get are unchanged when a createNewSession hook is present', async () => {
    const restoreSession = jest.fn();
    const gatewayRequest = jest
      .fn()
      .mockResolvedValueOnce({ sessionId: 's-42', title: 'Old talk' })
      .mockResolvedValueOnce({ sessionId: 's-42' });
    const restored = await executeGatewaySlashCommand('/session restore s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      createNewSession: jest.fn(),
      restoreSession,
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.restore', { sessionId: 's-42' });
    expect(restoreSession).toHaveBeenCalledTimes(1);
    expect(restoreSession).toHaveBeenCalledWith('s-42');
    expect(restored.text).toContain('Session s-42 restored');
    const got = await executeGatewaySlashCommand('/session get s-42', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      createNewSession: jest.fn(),
      restoreSession,
    });
    expect(got.text).toContain('Session s-42');
  });
});