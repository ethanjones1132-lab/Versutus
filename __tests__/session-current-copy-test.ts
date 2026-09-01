import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/session current` (and bare `/session`) print the words "Current session"
 * while the one fact the operator asked for — which session is open — sits
 * only in Raw. A resolved `sessions.current` read must render the id (and
 * title when present) into the bubble text; a resolved payload with no id
 * and a rejected read must keep the honest fallback copy byte-identical.
 */
describe('/session current honesty', () => {
  test('a resolved sessions.current read renders the session id in the text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-abc' });
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.current', {});
    expect(result.text).toBe('Current session: s-abc');
    expect(result.title).toBe('/session current');
    expect(result.raw).toContain('"sessionId": "s-abc"');
  });

  test('a resolved payload keyed by id instead of sessionId renders the id', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ id: 'abc-123' });
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Current session: abc-123');
  });

  test('a resolved payload with a title renders both id and title', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-abc', title: 'My session' });
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Current session: s-abc — My session');
  });

  test('bare /session takes the same branch and renders the id', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ sessionId: 's-abc' });
    const result = await executeGatewaySlashCommand('/session', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.current', {});
    expect(result.text).toBe('Current session: s-abc');
    expect(result.title).toBe('/session current');
  });

  test('a resolved payload without an id falls back gracefully and keeps Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('No current session or command not supported.');
    expect(result.raw).toContain('"ok": true');
  });

  test('a rejecting sessions.current read names the failure instead of claiming there is no session', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('sessions.current is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.title).toBe('/session current');
    expect(result.text).toContain('Current session could not be read');
    // The operator must see WHY, and must not be told there is no session when
    // the read simply failed -- there may well be one.
    expect(result.text).toContain('sessions.current is not supported');
    expect(result.text).not.toContain('No current session or command not supported.');
    expect(result.raw).toBeDefined();
  });

  test('a resolved payload with no id still reports no current session', async () => {
    // The copy above is correct for the case it actually describes: the read
    // worked and the host reports nothing open.
    const gatewayRequest = jest.fn().mockResolvedValue({});
    const result = await executeGatewaySlashCommand('/session current', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('No current session or command not supported.');
    expect(result.raw).toBe('{}');
  });
});