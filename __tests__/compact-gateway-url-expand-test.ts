declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCompactGatewayListSource(): string {
  // compact-gateway-list.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'compact-gateway-list.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The gateway URL is the address the operator reads to debug a bad connection
// (gateway-home-dashboard.tsx:188 renders statusDetail) but it clips to a single
// mono line with no way to read it (compact-gateway-list.tsx:104-106). Same
// clamp-with-no-expand class as the provider readiness line (provider-card.tsx:58-61):
// a PressableScale toggles the clamp, default collapsed to keep the row slim.
describe('compact gateway list URL expansion', () => {
  test('the gateway URL is a press target carrying the kit hit slop', () => {
    const src = readCompactGatewayListSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    // The URL <Text> must sit inside a PressableScale, not directly in the row,
    // so a tap reaches the toggle.
    const target = src.match(
      /<PressableScale[\s\S]*?\{gateway\.url\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{gateway.url}');
  });

  test('the URL starts collapsed and a tap flips the expansion state', () => {
    const src = readCompactGatewayListSource();
    // Default collapsed keeps the row slim; the toggle flips it.
    expect(src).toMatch(/const \[urlExpanded, setUrlExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setUrlExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the one-line clamp so the full URL is readable', () => {
    const src = readCompactGatewayListSource();
    // Collapsed keeps numberOfLines 1; expanded passes undefined so the clamp
    // is off entirely -- the spec's "clears numberOfLines".
    expect(src).toMatch(
      /numberOfLines=\{\s*urlExpanded \? undefined : 1\s*\}/,
    );
    const target = src.match(
      /<PressableScale[\s\S]*?\{gateway\.url\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toMatch(/numberOfLines=\{\s*urlExpanded \? undefined : 1\s*\}/);
  });
});
