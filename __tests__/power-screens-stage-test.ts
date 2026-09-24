declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const fleetView = () =>
  readSource('src', 'components', 'fleet', 'constellation-view.tsx');
const fallbackCanvas = () =>
  readSource('src', 'components', 'fleet', 'constellation-canvas-fallback.tsx');
const nativeCanvas = () =>
  readSource('src', 'components', 'fleet', 'constellation-canvas.native.tsx');
const council = () => readSource('src', 'components', 'chat', 'council-compare-view.tsx');
const runs = () => readSource('src', 'app', 'runs.tsx');

const fleetCanvases: [string, () => string, string, string][] = [
  ['fallback', fallbackCanvas, 'Host threads first', 'Live halos first'],
  ['native', nativeCanvas, 'Host edges:', 'Routine arcs:'],
];

function hostEdgeChrome(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('power screens inherit the quiet violet stage', () => {
  test('fleet labels reserve the focus tint for live stars and the HUD keeps a cool hairline', () => {
    const source = fleetView();
    expect(source).toContain("color={node.live ? 'accentWarm' : 'tertiary'}");
    expect(source).toContain('borderTopColor: tokens.border');
    expect(source).not.toMatch(/borderTopColor: tokens\.(?:accentWarm|glassBorder)/);
  });

  test.each(fleetCanvases)(
    '%s fleet edges rest on the brand violet while live stars keep focus tint',
    (_label, read, start, end) => {
      const source = read();
      const hostEdges = hostEdgeChrome(source, start, end);
      expect(hostEdges).toContain('tokens.accent');
      expect(hostEdges).not.toMatch(/accentWarm/);
      expect(source).toContain('if (node.live)');
      expect(source).toMatch(/accentWarm/);
    },
  );

  test('council labels rest on the brand accent without changing column isolation', () => {
    const source = council();
    expect(source).toContain('<Text variant="micro" color="accent" numberOfLines={1}>');
    expect(source).not.toMatch(/accentWarm|accentWarmMuted/);
    expect(source).toContain("column.state === 'answered'");
    expect(source).toContain("column.state === 'failed'");
    expect(source).toContain('<ErrorCard');
  });

  test('runs rest on the brand accent while preserving lifecycle and refresh paths', () => {
    const source = runs();
    expect(source).toContain('<Text variant="caption" color="accent" style={styles.approvalEyebrow}>');
    expect(source).toContain('tintColor={tokens.accent}');
    expect(source).toContain('colors={[tokens.accent]}');
    expect(source).not.toMatch(/accentWarm|accentWarmMuted/);
    expect(source).toContain('await sendChatInput(`/run ${prompt}`)');
    expect(source).toContain('<RunCard run={item.run} onStop={stopActivityRun} />');
    expect(source).toContain('await Promise.all([refreshCapabilities(), refreshGateways()])');
  });
});
