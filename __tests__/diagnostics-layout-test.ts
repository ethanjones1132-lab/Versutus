// ─── Runtime environment screen gutters ────────────────────────────────────
// The Runtime environment screen shares the peer gateway screens' content
// gutters and rhythm (Settings, Capabilities, Spend, Setup all pad
// Spacing.four / gap Spacing.three; Screen adds no gutters of its own, so
// the ScrollView owns them). Pinned off the source so a restyle that drops
// the padding back to a tighter grid fails here, not on the phone.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const diagnostics = () => readSource('src', 'app', 'gateway', 'diagnostics.tsx');

test('diagnostics content sits in the same gutters and rhythm as its peers', () => {
  const src = diagnostics();
  const contentBlock = src.match(/content:\s*\{[^}]*\}/);
  expect(contentBlock).not.toBeNull();
  expect(contentBlock?.[0]).toContain('padding: Spacing.four');
  expect(contentBlock?.[0]).toContain('gap: Spacing.three');
});

test('the screen still draws its checks, badges, and live-check wiring', () => {
  const src = diagnostics();
  expect(src).toContain('contentContainerStyle={styles.content}');
  expect(src).toContain('brokenCritical');
  expect(src).toContain('Run live check');
  expect(src).toContain('busy={running}');
  expect(src).toContain('disabled={!healthUrl || running}');
  expect(src).toContain('probeRuntimeGlobals');
  expect(src).toContain('probeStreamingFetch');
});
