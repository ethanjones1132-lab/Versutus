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

function readToastSource(): string {
  return readSource(['src', 'components', 'connected-toast.tsx']);
}

test('the toast shadow is sourced from the Palette overlay token', () => {
  const src = readToastSource();
  // The shadow sits beside the other token colors in the same inline block.
  expect(src).toContain('shadowColor: tokens.overlay');
  expect(src).toContain('backgroundColor: tokens.backgroundRaised');
  expect(src).toContain('borderColor: tokens.statusConnectedMuted');
  // The hardcoded literal is gone from the whole file.
  expect(src).not.toContain("'#000'");
  expect(src).not.toContain('"#000"');
});

test('the slide/fade ceremony and the 2000ms hold are unchanged', () => {
  const src = readToastSource();
  expect(src).toContain('const HOLD_MS = 2000;');
  expect(src).toContain('setTimeout(() => setVisible(false), HOLD_MS)');
  expect(src).toContain('withTiming(visible ? 1 : 0');
  expect(src).toContain('withTiming(visible ? 0 : -16');
  expect(src).toContain('translateY: translateY.value');
});

test('the very first mount stays silent', () => {
  const src = readToastSource();
  // Launch itself is just app start, not a connection win worth punctuating.
  expect(src).toContain("if (previous === null || previous === 'connected') return;");
});

test('the ceremony moves on the Motion tokens with enter slower than exit', () => {
  const src = readToastSource();
  // Both the fade and the slide name the tokens; no private durations remain.
  expect(src).toContain('Motion.duration.normal');
  expect(src).toContain('Motion.duration.fast');
  expect(src).toContain('duration: visible ? Motion.duration.normal : Motion.duration.fast');
  expect(src).not.toContain('duration: visible ? 240 : 180');
  // Enter (normal 300) stays slower than exit (fast 150); the hold is untouched.
  const tokens = readSource(['src', 'constants', 'tokens.ts']);
  const fast = Number(tokens.match(/fast:\s*(\d+)/)?.[1]);
  const normal = Number(tokens.match(/normal:\s*(\d+)/)?.[1]);
  expect(Number.isFinite(fast)).toBe(true);
  expect(Number.isFinite(normal)).toBe(true);
  expect(normal).toBeGreaterThan(fast);
  expect(src).toContain('const HOLD_MS = 2000;');
});
