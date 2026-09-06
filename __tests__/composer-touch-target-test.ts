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

function readComposerSource(): string {
  return readSource(['src', 'components', 'chat', 'chat-composer.tsx']);
}

// The quick-action chip is the PressableScale rendering
// `Quick action ${action.label}`; the browse-commands utility button is the
// one rendering `Browse commands`.
function readQuickChipBlock(): string {
  const src = readComposerSource();
  const labelAt = src.indexOf('Quick action ${action.label}');
  const openAt = src.lastIndexOf('<PressableScale', labelAt);
  return src.slice(openAt, labelAt);
}

function readQuickChipStyle(): string {
  const src = readComposerSource();
  const start = src.indexOf('quickChip: {');
  const end = src.indexOf('},', start) + 2;
  return src.slice(start, end);
}

test('the quick-action chip reaches the 44pt touch floor without moving the row', () => {
  const chip = readQuickChipBlock();
  const style = readQuickChipStyle();
  // Layout stays put: the visual chip keeps its 26pt height.
  expect(style).toMatch(/height: 26/);
  // Touch expands outside layout: 26 + 2 * 9 = 44.
  expect(chip).toContain('hitSlop={9}');
  const height = Number(style.match(/height: (\d+)/)?.[1]);
  const hitSlop = Number(chip.match(/hitSlop=\{(\d+)\}/)?.[1]);
  expect(height + hitSlop * 2).toBeGreaterThanOrEqual(44);
});

test('the sibling utility button still reaches exactly 44', () => {
  const src = readComposerSource();
  const labelAt = src.indexOf('Browse commands');
  const openAt = src.lastIndexOf('<PressableScale', labelAt);
  const button = src.slice(openAt, labelAt);
  expect(button).toContain('hitSlop={8}');
  const styleStart = src.indexOf('utilityButton: {');
  const style = src.slice(styleStart, src.indexOf('},', styleStart) + 2);
  expect(style).toMatch(/height: 28/);
  expect(28 + 8 * 2).toBe(44);
});

test('the chip grouping, layout, and selection haptics are unchanged', () => {
  const src = readComposerSource();
  expect(src).toContain('styles.utilityRow');
  expect(src).toContain('styles.chipGroup');
  expect(src).toContain('styles.quickChip');
  expect(src).toContain('Haptics.selectionAsync()');
});
