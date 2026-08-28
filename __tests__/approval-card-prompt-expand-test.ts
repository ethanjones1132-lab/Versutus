declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readApprovalCardSource(): string {
  // approval-decision-card.tsx is CRLF on disk; normalize so the block
  // regexes below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'approval-decision-card.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('approval decision card prompt expansion', () => {
  test('the prompt is a press target carrying the kit hit slop', () => {
    // The run prompt is the ONLY task description before Approve/Deny
    // (approval-decision-card.tsx:69-71), so the prompt text itself is the
    // expand target, on the tool-call-card idiom (tool-call-card.tsx:58-68).
    const src = readApprovalCardSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{CHIP_HIT_SLOP\}/);
    const promptTarget = src.match(/<PressableScale[\s\S]*?<\/PressableScale>/)?.[0];
    expect(promptTarget).toBeDefined();
    expect(promptTarget).toContain('{prompt}');
  });

  test('the prompt starts collapsed and a tap flips the expansion state', () => {
    const src = readApprovalCardSource();
    // Default collapsed keeps the card compact; the toggle flips it.
    expect(src).toMatch(
      /const \[promptExpanded, setPromptExpanded\] = useState\(false\);/,
    );
    expect(src).toMatch(/setPromptExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the three-line clamp so the full prompt is readable', () => {
    const src = readApprovalCardSource();
    // Collapsed keeps numberOfLines 3; expanded passes undefined so the
    // clamp is off entirely -- the spec's "clears numberOfLines".
    expect(src).toMatch(/numberOfLines=\{promptExpanded \? undefined : 3\}/);
    const promptTarget = src.match(/<PressableScale[\s\S]*?<\/PressableScale>/)?.[0];
    expect(promptTarget).toBeDefined();
    expect(promptTarget).toMatch(
      /numberOfLines=\{promptExpanded \? undefined : 3\}/,
    );
  });
});