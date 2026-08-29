declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChannelStatusRowSource(): string {
  // channel-status-row.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'channel-status-row.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The channel-status detail is the only channel-health surface on the dashboard
// (channel-status-row.tsx:44) and it carries the exact degraded-bridge verdict
// ("Degraded — 3 of 6 bridges down") the operator needs -- but it was a plain
// <Text> clamped to one line with no press target, so the verdict was unreachable
// on a phone. Same expandable class as the provider readiness line
// (provider-card.tsx:58-61) and the environment config lines (environment-card.tsx):
// a PressableScale toggle clears the clamp, default collapsed to keep the row slim.
// The row itself is a Pressable that opens chat, so the toggle stops the event
// from bubbling up to that onPress.
describe('channel status row detail expansion', () => {
  test('the detail line is a press target carrying the kit hit slop', () => {
    const src = readChannelStatusRowSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    // The detail <Text> must sit inside a PressableScale, not directly in the
    // row, so a tap reaches the toggle.
    const target = src.match(
      /<PressableScale[\s\S]*?\{model\.detail\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{model.detail}');
  });

  test('the detail line starts collapsed and a tap flips the expansion state', () => {
    const src = readChannelStatusRowSource();
    // Default collapsed keeps the row slim; the toggle flips it.
    expect(src).toMatch(/const \[detailExpanded, setDetailExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setDetailExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the one-line clamp so the full verdict is readable', () => {
    const src = readChannelStatusRowSource();
    // Collapsed keeps numberOfLines 1; expanded passes undefined so the clamp
    // is off entirely -- the spec's "clears numberOfLines".
    expect(src).toMatch(/numberOfLines=\{\s*detailExpanded \? undefined : 1\s*\}/);
    const target = src.match(
      /<PressableScale[\s\S]*?\{model\.detail\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toMatch(/numberOfLines=\{\s*detailExpanded \? undefined : 1\s*\}/);
  });

  test('tapping the toggle stops the event from opening chat', () => {
    const src = readChannelStatusRowSource();
    // The row Pressable opens chat on onPress; the nested toggle must swallow
    // the tap so expanding the verdict does not also navigate away.
    expect(src).toMatch(/event\.stopPropagation\(\)/);
  });
});
