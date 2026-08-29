declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProviderCardSource(): string {
  // provider-card.tsx is CRLF on disk; normalize so the block regexes below
  // do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'provider-card.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The readiness line is the only place the operator reads WHY a provider is
// not ready (provider-card.tsx:58-61) -- a multi-sentence blocker (missing
// scope, auth step, rate limit) that three caption lines truncate on a phone.
// Same expandable class as the approval prompt (approval-decision-card.tsx:69-71)
// and tool-call detail (tool-call-card.tsx): a PressableScale toggle clears the
// clamp, default collapsed to keep the card compact.
describe('provider card readiness message expansion', () => {
  test('the readiness line is a press target carrying the kit hit slop', () => {
    const src = readProviderCardSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    // The readiness <Text> must sit inside a PressableScale, not directly in
    // the card, so a tap reaches the toggle.
    const target = src.match(
      /\{snapshot\.readiness\.message \? \([\s\S]*?<\/PressableScale>\s*\) : null\}/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{snapshot.readiness.message}');
  });

  test('the readiness line starts collapsed and a tap flips the expansion state', () => {
    const src = readProviderCardSource();
    // Default collapsed keeps the card compact; the toggle flips it.
    expect(src).toMatch(/const \[readyExpanded, setReadyExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setReadyExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the three-line clamp so the full reason is readable', () => {
    const src = readProviderCardSource();
    // Collapsed keeps numberOfLines 3; expanded passes undefined so the clamp
    // is off entirely -- the spec's "clears numberOfLines".
    expect(src).toMatch(
      /numberOfLines=\{\s*readyExpanded \? undefined : 3\s*\}/,
    );
    const target = src.match(
      /\{snapshot\.readiness\.message \? \([\s\S]*?<\/PressableScale>\s*\) : null\}/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toMatch(/numberOfLines=\{\s*readyExpanded \? undefined : 3\s*\}/);
  });
});
