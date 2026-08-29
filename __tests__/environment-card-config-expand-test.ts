declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readEnvironmentCardSource(): string {
  // environment-card.tsx is CRLF on disk; normalize so the block regexes below
  // do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'environment-card.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The workspace-policy line (sandbox · root) and the bound-providers line are
// the config the operator verifies before a run (environment-card.tsx:42-49),
// but both are plain <Text> with a hard numberOfLines clamp and no press
// target -- a long root path or provider list is unreachable on a phone. Same
// clamp-with-no-expand class as the provider readiness line
// (provider-card.tsx:58-61, fixed in iter-057) and the group-room plan line
// (group-room-view.tsx:416-429). A PressableScale toggle clears the clamp,
// default collapsed to keep the card compact.
describe('environment card config expansion', () => {
  test('both config lines are press targets carrying the chip hit slop', () => {
    const src = readEnvironmentCardSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    // Both the workspace-policy Text and the bound-providers Text must sit
    // inside a PressableScale, not directly in the card, so a tap reaches the
    // toggle. Expect exactly two uses of the shared hit slop.
    const hits = src.match(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/g) ?? [];
    expect(hits.length).toBe(2);
  });

  test('both lines start collapsed and a tap flips each expansion state', () => {
    const src = readEnvironmentCardSource();
    expect(src).toMatch(/const \[policyExpanded, setPolicyExpanded\] = useState\(false\);/);
    expect(src).toMatch(/const \[providersExpanded, setProvidersExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setPolicyExpanded\(\(prev\) => !prev\)/);
    expect(src).toMatch(/setProvidersExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the clamp so the full sandbox/root and providers text is readable', () => {
    const src = readEnvironmentCardSource();
    // Workspace-policy Text: collapsed keeps numberOfLines 2, expanded clears it.
    expect(src).toMatch(/numberOfLines=\{\s*policyExpanded \? undefined : 2\s*\}/);
    // Bound-providers Text: collapsed keeps numberOfLines 1, expanded clears it.
    expect(src).toMatch(/numberOfLines=\{\s*providersExpanded \? undefined : 1\s*\}/);
  });
});
