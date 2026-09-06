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

function readMarkdownSource(): string {
  return readSource(['src', 'components', 'chat', 'markdown', 'markdown-text.tsx']);
}

// The HEADING_SIZES block that maps h1-h4 onto the type scale.
function readHeadingBlock(): string {
  const src = readMarkdownSource();
  const keyAt = src.indexOf('const HEADING_SIZES');
  const closeAt = src.indexOf('};', keyAt);
  return src.slice(keyAt, closeAt + 2);
}

// Typography metrics from src/constants/tokens.ts, parsed from source —
// importing the module pulls reanimated into jest, so read the numbers
// out of the file instead (see json-view-virtualized-test.ts:158).
function typographySizes(): Record<string, { fontSize: number; lineHeight: number }> {
  const tokens = readSource(['src', 'constants', 'tokens.ts']);
  const values: Record<string, { fontSize: number; lineHeight: number }> = {};
  for (const match of tokens.matchAll(/(\w+): \{ fontSize: (\d+), lineHeight: (\d+)/g)) {
    values[match[1]] = { fontSize: Number(match[2]), lineHeight: Number(match[3]) };
  }
  return values;
}

test('headings read from the Typography tokens, not hardcoded literals', () => {
  const block = readHeadingBlock();
  expect(block).toContain('Typography.title.fontSize');
  expect(block).toContain('Typography.headline.fontSize');
  expect(block).toContain('Typography.body.fontSize');
  expect(block).toContain('Typography.caption.fontSize');
  expect(block).not.toMatch(/fontSize: \d+/);
  expect(block).not.toMatch(/lineHeight: \d+/);
});

test('the four levels stay visually distinct and descend h1 to h4', () => {
  const block = readHeadingBlock();
  const levels = ['1', '2', '3', '4'].map((level) => {
    const match = block.match(new RegExp(`${level}: \\{ fontSize: Typography\\.(\\w+)\\.fontSize`))?.[1];
    expect(match).toBeDefined();
    return match as string;
  });
  // Each level names a different token so no two headings render alike.
  expect(new Set(levels).size).toBe(4);
  const sizes = typographySizes();
  const fonts = levels.map((name) => sizes[name].fontSize);
  expect(fonts).toEqual([...fonts].sort((a, b) => b - a));
});

test('the compact caption cap still lives beside the headings', () => {
  const src = readMarkdownSource();
  expect(src).toContain('maxFontSizeMultiplier ?? (compact ? 1.4 : undefined)');
});
