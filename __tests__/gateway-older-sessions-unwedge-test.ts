// SESS-2: "Show older sessions" set its in-flight guard and released it only
// when `isCurrent()` — which also required the client that started the read to
// still be current. A reconnect replaces the client without any other reset, so
// the button stayed "Loading older…" and disabled for the rest of the sheet's
// life. The finally now releases on the sequence alone. Pinned off the source.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function loadOlderBody(): string {
  const start = provider.indexOf('const loadOlderSessions = useCallback');
  expect(start).toBeGreaterThan(-1);
  return provider.slice(start, provider.indexOf('const closeSessionSelector = useCallback', start));
}

describe('SESS-2: a superseded older-paging read releases the busy control', () => {
  test('the finally releases on the read sequence, not the client identity', () => {
    const body = loadOlderBody();
    expect(body).toMatch(/finally \{[\s\S]*?if \(seq === sessionReadSeqRef\.current\) \{\s*loadingOlderSessionsRef\.current = false;\s*setLoadingOlderSessions\(false\);/);
    // The old shape — release only under isCurrent() — is gone.
    expect(body).not.toMatch(/finally \{[\s\S]*?if \(isCurrent\(\)\) \{\s*loadingOlderSessionsRef\.current = false;/);
  });

  test('the in-flight guard is still set before the read and checked on entry', () => {
    const body = loadOlderBody();
    expect(body).toContain('if (!client || loadingOlderSessionsRef.current) return;');
    expect(body).toContain('loadingOlderSessionsRef.current = true;');
    expect(body).toContain('setLoadingOlderSessions(true);');
  });
});
