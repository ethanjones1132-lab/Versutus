import { GatewayHttpError } from '@/lib/gateway/errors';
import { botOpenFailureKeepsScope } from '@/lib/gateway/bot-open-failure';

declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const readSource = (...parts: string[]) =>
  nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');

describe('a Bot Chat that fails to open keeps its Bot only when the Bot is still there', () => {
  test('a slow host keeps the Bot, so the next message still reaches that Bot', () => {
    // 2026-09-16: Hermes was still recovering from a startup migration, the
    // session list timed out, openBot cleared the Bot scope and left the Bot
    // Chat on screen — the next message went out with no Bot, fell to the
    // Gate's provider fallback, and came back "chat failed: 404".
    const hermesTimeout = new GatewayHttpError(
      'hermes did not answer "list sessions" within 30s — the host is reachable but its state database is not answering queries',
      500,
    );
    expect(botOpenFailureKeepsScope(hermesTimeout)).toBe(true);
    expect(botOpenFailureKeepsScope(new GatewayHttpError('upstream', 502))).toBe(true);
    expect(botOpenFailureKeepsScope(new GatewayHttpError('No backend that could serve listSessions is answering', 503))).toBe(true);
    expect(botOpenFailureKeepsScope(new GatewayHttpError('gateway timeout', 504))).toBe(true);
    expect(botOpenFailureKeepsScope(new Error('Request timed out: GET /v1/sessions'))).toBe(true);
    expect(botOpenFailureKeepsScope(new TypeError('Network request failed'))).toBe(true);
  });

  test('a Bot that is gone or refused drops the scope, as before', () => {
    expect(botOpenFailureKeepsScope(new GatewayHttpError('unknown bot "ghost"', 404))).toBe(false);
    expect(botOpenFailureKeepsScope(new GatewayHttpError('bot "x" has no API_SERVER_KEY', 409))).toBe(false);
    expect(botOpenFailureKeepsScope(new GatewayHttpError('Unauthorized', 401))).toBe(false);
    expect(botOpenFailureKeepsScope(new GatewayHttpError('Forbidden', 403))).toBe(false);
  });

  test('an unexplained server error is not assumed to be transient', () => {
    expect(botOpenFailureKeepsScope(new GatewayHttpError('Internal Server Error', 500))).toBe(false);
    expect(botOpenFailureKeepsScope(new Error('something else broke'))).toBe(false);
    expect(botOpenFailureKeepsScope('not an error')).toBe(false);
  });

  test('a stale open cannot commit a session, clear the winning Bot, or repair its model', () => {
    const provider = readSource('src', 'context', 'gateway-provider.tsx');
    const open = provider.slice(provider.indexOf('const openBot = useCallback('), provider.indexOf('  useEffect(() => {\n    repairStalePinRef'));
    expect(open).toContain('const requestId = ++botOpenRequestRef.current;');
    expect(open).toContain('requestId === botOpenRequestRef.current && clientRef.current === client');
    expect(open).toContain('selectedBotIdRef.current = botId;');
    expect(open).toMatch(/client\.createSession!\(title\),\s*isCurrent,/);
    expect(open.indexOf('if (!chat || !isCurrent()) return false;')).toBeLessThan(open.indexOf('const pinned = pinLiveSession('));
    expect(open).toMatch(/catch \(error\) \{\s*if \(!isCurrent\(\)\) return false;/);
    expect(open).toMatch(/repairStalePinRef\.current\?\.\(\s*client,\s*isCurrent,/);
    for (const start of ['const clearBot = useCallback(', 'const selectBackend = useCallback(']) {
      const action = provider.slice(provider.indexOf(start));
      expect(action.indexOf('++botOpenRequestRef.current;')).toBeLessThan(action.indexOf('setBotId?.(undefined)'));
    }
  });

  test('openBot consults the rule before clearing the Bot', () => {
    const provider = readSource('src', 'context', 'gateway-provider.tsx');
    expect(provider).toContain("from '@/lib/gateway/bot-open-failure'");
    expect(provider).toContain('if (!botOpenFailureKeepsScope(error)) {');
  });
});
