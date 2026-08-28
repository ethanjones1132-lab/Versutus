declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readRunCardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'activity', 'run-card.tsx'].join(SEP),
    'utf8',
  );
}

function readActionButtonBody(): string {
  const src = readRunCardSource();
  const m = src.match(/actionButton:\s*\{([^}]+)\}/);
  if (!m) throw new Error('actionButton style not found in run-card.tsx');
  return m[1];
}

test('run card action button meets the 44dp touch target', () => {
  // The row holds a 12px chevron + caption (lineHeight 18 per
  // tokens.ts:101); minHeight must cover the rest (run-card.tsx:172-177).
  const body = readActionButtonBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(44);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

test('the show-events toggle is the pressable that carries the action button style', () => {
  // During a live run the full event log is behind exactly this control;
  // guard the wiring, not just the style block.
  const src = readRunCardSource();
  expect(src).toMatch(
    /accessibilityLabel=\{expanded \? 'Hide event log' : 'Show event log'\}[\s\S]*?style=\{styles\.actionButton\}/,
  );
});