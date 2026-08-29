declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readDashboardSource(): string {
  // gateway-home-dashboard.tsx is CRLF on disk; normalize so the matchers below
  // do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'gateway-home-dashboard.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// When a gateway will not connect the operator needs the reason it gave up
// (statusDetail, humanized by humanizeGatewayError) and the backoff schedule
// (describeAutoRetry) -- but gateway-home-dashboard.tsx:204 clips the first to
// three lines and :210 clips the second to two, both plain <Text> with no press
// target, so the actionable fix is unreachable on a phone. Same expandable class
// as the provider readiness line (provider-card.tsx:58), env config lines
// (environment-card.tsx:51) and channel detail (channel-status-row.tsx:62): a
// PressableScale toggle clears the clamp, default collapsed so the disconnected
// card stays compact. The ErrorCard path is separate and untouched.
describe('home connection detail expansion', () => {
  test('the statusDetail line carries the kit hit slop so a tap reaches the toggle', () => {
    const src = readDashboardSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    // The statusDetail <Text> must sit inside a PressableScale, not directly in
    // the card, so a tap reaches the expand toggle.
    const target = src.match(
      /<PressableScale[\s\S]*?\{statusDetail\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{statusDetail}');
  });

  test('the autoRetry line carries the kit hit slop so a tap reaches the toggle', () => {
    const src = readDashboardSource();
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    const target = src.match(
      /<PressableScale[\s\S]*?\{describeAutoRetry\(autoRetry\)\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{describeAutoRetry(autoRetry)}');
  });

  test('both lines start collapsed and a tap flips expansion state', () => {
    const src = readDashboardSource();
    // Default collapsed keeps the disconnected card slim; the toggles flip them.
    expect(src).toMatch(/const \[statusExpanded, setStatusExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setStatusExpanded\(\(prev\) => !prev\)/);
    expect(src).toMatch(/const \[retryExpanded, setRetryExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setRetryExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears each line clamp so the full text is readable', () => {
    const src = readDashboardSource();
    // statusDetail collapsed to 3, expanded undefined; autoRetry collapsed to 2.
    const statusTarget = src.match(
      /<PressableScale[\s\S]*?\{statusDetail\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(statusTarget).toBeDefined();
    expect(statusTarget).toMatch(/numberOfLines=\{\s*statusExpanded \? undefined : 3\s*\}/);
    const retryTarget = src.match(
      /<PressableScale[\s\S]*?\{describeAutoRetry\(autoRetry\)\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(retryTarget).toBeDefined();
    expect(retryTarget).toMatch(/numberOfLines=\{\s*retryExpanded \? undefined : 2\s*\}/);
  });
});
