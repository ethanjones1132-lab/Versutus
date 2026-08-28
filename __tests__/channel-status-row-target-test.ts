declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChannelStatusRowSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'channel-status-row.tsx'].join(SEP),
    'utf8',
  );
}

function readRowStyleBody(): string {
  const src = readChannelStatusRowSource();
  const m = src.match(/row:\s*\{([^}]+)\}/);
  if (!m) throw new Error('row style not found in channel-status-row.tsx');
  return m[1];
}

test('home channel status row meets the 44dp touch target', () => {
  // The row holds caption (lineHeight 18 per tokens.ts:101) + paddingVertical
  // Spacing.one x2 = 26, so minHeight is the binding floor
  // (channel-status-row.tsx:56-68); 40 < 44 and the row is the first thing
  // tapped on a declaring gateway with degraded bridges.
  const body = readRowStyleBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(44);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

test('the channel-health pressable carries the row style', () => {
  // Guard the wiring, not just the style block: the accessibilityRole button
  // opening /chat must be the element the raised target applies to.
  const src = readChannelStatusRowSource();
  expect(src).toMatch(
    /<Pressable[\s\S]*?accessibilityRole="button"[\s\S]*?style=\{\[styles\.row/,
  );
});