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

function readButtonSource(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

// Spacing values from src/constants/tokens.ts, parsed from source —
// importing the module pulls reanimated into jest, so read the numbers
// out of the file instead (see json-view-virtualized-test.ts:158).
function spacingValues(): Record<string, number> {
  const tokens = readSource(['src', 'constants', 'tokens.ts']);
  const block = tokens.slice(tokens.indexOf('export const Spacing = {'), tokens.indexOf('} as const', tokens.indexOf('export const Spacing')));
  const values: Record<string, number> = {};
  for (const match of block.matchAll(/(\w+): (\d+)/g)) {
    values[match[1]] = Number(match[2]);
  }
  return values;
}

test('the md button padding is derived from Spacing, not hardcoded literals', () => {
  const src = readButtonSource();
  // The base `button` style is the md size; sm overrides it below.
  const base = src.slice(src.indexOf('button: {'), src.indexOf('buttonSm: {'));
  expect(base).toMatch(/paddingVertical: Spacing\.\w+/);
  expect(base).toMatch(/paddingHorizontal: Spacing\.\w+/);
  expect(base).not.toMatch(/paddingVertical: \d+/);
  expect(base).not.toMatch(/paddingHorizontal: \d+/);
});

test('md stays visibly larger than sm on both axes', () => {
  const src = readButtonSource();
  const base = src.slice(src.indexOf('button: {'), src.indexOf('buttonSm: {'));
  const smStart = src.indexOf('buttonSm: {');
  const sm = src.slice(smStart, src.indexOf('},', smStart) + 2);
  // sm pads with Spacing.two vertical / Spacing.three horizontal; md must
  // name tokens that resolve larger on each axis.
  expect(sm).toContain('paddingVertical: Spacing.two');
  expect(sm).toContain('paddingHorizontal: Spacing.three');
  const mdVertical = base.match(/paddingVertical: Spacing\.(\w+)/)?.[1];
  const mdHorizontal = base.match(/paddingHorizontal: Spacing\.(\w+)/)?.[1];
  expect(mdVertical).toBeDefined();
  expect(mdHorizontal).toBeDefined();
  const spacing = spacingValues();
  expect(spacing[mdVertical as string]).toBeGreaterThan(spacing.two);
  expect(spacing[mdHorizontal as string]).toBeGreaterThan(spacing.three);
});

test('the label still stays on one line with bounded scaling', () => {
  const src = readButtonSource();
  expect(src).toContain('numberOfLines={1}');
  expect(src).toContain('maxFontSizeMultiplier={1.3}');
});
