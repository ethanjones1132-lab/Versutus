declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaletteSource(): string {
  // slash-command-palette.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'slash-command-palette.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The command palette is the discovery surface (slash-command-palette.tsx:39-45
// comment): the composer strip only shows top matches for what is typed, so you
// cannot find a command you do not know. Each row's description was a plain
// <Text> clamped to two lines with no press target, so a description like
// "Write a file at the given path, overwriting any existing content" was
// unreadable at 360dp. Same expandable class as the provider readiness line
// (provider-card.tsx:58-61) and channel detail (channel-status-row.tsx): a
// PressableScale toggle clears the clamp, default collapsed to keep the list
// dense. Expansion is keyed per command so each row keeps its own state.
describe('slash command palette description expansion', () => {
  test('the description line is a press target carrying the kit hit slop', () => {
    const src = readPaletteSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    // The description <Text> must sit inside a PressableScale, not directly in
    // the row, so a tap reaches the toggle.
    const target = src.match(
      /<PressableScale[\s\S]*?\{item\.description\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{item.description}');
  });

  test('the description starts collapsed and a tap flips the expansion state', () => {
    const src = readPaletteSource();
    // Default collapsed keeps the list dense; the toggle flips it per command.
    expect(src).toMatch(/const \[expandedDescs, setExpandedDescs\] = useState<Record<string, boolean>>\(\{\}\);/);
    expect(src).toMatch(/setExpandedDescs\(\(prev\) =>/);
    expect(src).toMatch(/\[item\.value\]: !prev\[item\.value\]/);
  });

  test('expanding clears the two-line clamp so the full description is readable', () => {
    const src = readPaletteSource();
    // Collapsed keeps numberOfLines 2; expanded passes undefined so the clamp
    // is off entirely -- the spec's "clears numberOfLines".
    expect(src).toMatch(/numberOfLines=\{\s*descExpanded \? undefined : 2\s*\}/);
    const target = src.match(
      /<PressableScale[\s\S]*?\{item\.description\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toMatch(/numberOfLines=\{\s*descExpanded \? undefined : 2\s*\}/);
  });

  test('tapping the toggle stops the event from selecting the command', () => {
    const src = readPaletteSource();
    // The row Pressable selects the command and closes the palette on onPress;
    // the nested toggle must swallow the tap so expanding the description does
    // not also fire onSelect.
    expect(src).toMatch(/event\.stopPropagation\(\)/);
  });
});
