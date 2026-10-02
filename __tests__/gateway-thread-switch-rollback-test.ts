import { pinLiveSession } from '@/lib/gateway/session-resume';

// SESS-3: selectSession pinned the new thread BEFORE reading its history. When
// that read was refused, the header named the new thread while the transcript
// on screen was still the old one. `reloadHistoryFor` now reports whether its
// read landed, and the caller rolls the identity back. These pin both halves.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function reloadBody(): string {
  const start = provider.indexOf('const reloadHistoryFor = useCallback');
  expect(start).toBeGreaterThan(-1);
  return provider.slice(start, provider.indexOf('const reconcileInterrupted = useCallback', start));
}

describe('SESS-3: a refused history read rolls the thread identity back', () => {
  test('reloadHistoryFor reports success and failure', () => {
    const body = reloadBody();
    expect(body).toContain('): Promise<boolean> => {');
    expect(body).toMatch(/if \(!historyRead\.ok\) \{[\s\S]*?return false;/);
    expect(body).toContain('setLastError(`Session history could not be read');
    // A landed read returns true; so does a no-op with no client.
    expect(body).toMatch(/setLastError\(null\);\s*return true;/);
    expect(body).toMatch(/catch \(error\) \{[\s\S]*?return false;[\s\S]*?\} finally \{/);
  });

  test('selectSession awaits the read and puts the previous identity back on failure', () => {
    const body = selectSessionBody();
    const pinAt = body.indexOf('sessionIdRef.current = sessionId;');
    const readAt = body.indexOf('await reloadHistoryFor(gateway)');
    const rollbackAt = body.indexOf('sessionIdRef.current = previousSessionId;');
    expect(pinAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(pinAt);
    expect(rollbackAt).toBeGreaterThan(readAt);
    expect(body).toMatch(/const read = await reloadHistoryFor\(gateway\);\s*if \(!read\) \{/);
    expect(body).toContain('setCurrentSessionId(previousSessionId);');
    // The profile pin is restored too, so the next launch agrees.
    expect(body).toMatch(/sessionId: previousSessionId,/);
  });

  test('the rollback restores the identity the client and the profile carry', () => {
    // Model the two-step pin/rollback against a real client and profile.
    const calls: (string | undefined)[] = [];
    const client = { setSessionId: (id: string | undefined) => calls.push(id) };
    const profile = { id: 'gw', url: 'http://gw', kind: 'hermes', createdAt: 0, sessionId: 'old' } as never;

    const pinned = pinLiveSession({ client, sessionId: 'new', profile });
    expect(calls).toEqual(['new']);
    expect((pinned as { sessionId?: string }).sessionId).toBe('new');

    const restored = pinLiveSession({ client, sessionId: 'old', profile: pinned });
    expect(calls).toEqual(['new', 'old']);
    expect((restored as { sessionId?: string }).sessionId).toBe('old');
  });

  function selectSessionBody(): string {
    const start = provider.indexOf('const selectSession = useCallback');
    expect(start).toBeGreaterThan(-1);
    return provider.slice(start, provider.indexOf('selectSessionRef.current = selectSession', start));
  }
});
