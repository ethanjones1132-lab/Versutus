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

/** The declaration of one StyleSheet key, from its name to its closing brace. */
function styleBlock(src: string, key: string): string {
  const start = src.indexOf(`${key}: {`);
  if (start === -1) throw new Error(`${key} style not found in chat-composer.tsx`);
  return src.slice(start, src.indexOf('},', start) + 2);
}

/** The `+` PressableScale — the one that carries the Add image or command label. */
function readPlusBlock(): string {
  const src = readComposerSource();
  const labelAt = src.indexOf('accessibilityLabel="Add image or command"');
  const openAt = src.lastIndexOf('<PressableScale', labelAt);
  return src.slice(openAt, labelAt);
}

// The pill replaced the boxed attach/call/mic/send cluster: three controls on
// the composer now carry a touch floor of their own — the borderless `+` on
// the left, every row of the menu it opens, and the mic in the trailing slot.
test('the `+` control reaches the 44pt touch floor without growing a box', () => {
  const plus = readPlusBlock();
  const style = styleBlock(readComposerSource(), 'plusButton');
  // Layout: a 36pt-wide, 48pt-tall target — the height is already the floor,
  // and the hitSlop widens it past 44 without moving the pill's row.
  expect(style).toMatch(/width: 36/);
  expect(style).toMatch(/minHeight: 48/);
  expect(style).not.toMatch(/borderWidth/);
  expect(plus).toContain('hitSlop={6}');
  const width = Number(style.match(/width: (\d+)/)?.[1]);
  const hitSlop = Number(plus.match(/hitSlop=\{(\d+)\}/)?.[1]);
  expect(width + hitSlop * 2).toBeGreaterThanOrEqual(44);
});

test('every `+` menu row reaches the 44pt floor', () => {
  const src = readComposerSource();
  const row = styleBlock(src, 'menuRow');
  expect(row).toMatch(/minHeight: 44/);
  // The four rows the menu can draw — attach, hands-free call, the one-tap
  // commands, browse — all mount through that one style.
  expect((src.match(/styles\.menuRow/g) ?? []).length).toBeGreaterThanOrEqual(4);
});

test('the mic keeps the touch floor now that it is the only trailing control', () => {
  const style = styleBlock(readComposerSource(), 'micButton');
  expect(style).toMatch(/width: 44/);
  expect(style).toMatch(/minHeight: 48/);
});

test('the chip row, the boxed utility button and their styles are gone', () => {
  const src = readComposerSource();
  expect(src).not.toContain('styles.utilityRow');
  expect(src).not.toContain('styles.chipGroup');
  expect(src).not.toContain('styles.quickChip');
  expect(src).not.toContain('styles.utilityButton');
  expect(src).toContain('styles.pill');
  // Selection haptics survive: every `+` menu row still taps through the
  // safe vocabulary on selection.
  expect(src).toContain('Haptics.selectionAsync()');
});
