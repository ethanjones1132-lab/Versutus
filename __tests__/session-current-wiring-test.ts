declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/**
 * `/session current` answers from the app's active Session id, which only the
 * provider holds. These pins keep the wiring in place: the context carries
 * the id, and the provider hands its live ref to the slash-command context.
 * Without the provider half, the command silently falls back to the remote
 * `sessions.current` read no Gateway dispatches.
 */
describe('/session current provider wiring', () => {
  test('the slash-command context carries the active Session id', () => {
    const src = readSource(['src', 'lib', 'gateway', 'slash-commands.ts']);
    expect(src).toMatch(/currentSessionId\?: string/);
  });

  test('the provider hands its live Session ref to the slash-command context', () => {
    const src = readSource(['src', 'context', 'gateway-provider.tsx']);
    expect(src).toMatch(/currentSessionId: sessionIdRef\.current/);
  });
});
