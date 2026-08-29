declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomSource(): string {
  // group-room-view.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group room plan line expansion', () => {
  test('the plan is a press target that toggles expansion', () => {
    // The plan names silent/unknown members plus the round count and
    // routinely exceeds one caption line at 360dp (group-room-view.tsx:411-417),
    // so the plan line itself is the expand target (approval-prompt idiom).
    const src = readGroupRoomSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    const planTarget = src.match(
      /<PressableScale[\s\S]*?roomPlanTarget[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(planTarget).toBeDefined();
    expect(planTarget).toContain('setPlanExpanded((prev) => !prev)');
    expect(planTarget).toMatch(/accessibilityRole="button"/);
    // The plan text sits inside the press target.
    expect(planTarget).toContain('describeRoomPlan(');
  });

  test('the plan starts collapsed and a tap flips the expansion state', () => {
    const src = readGroupRoomSource();
    // Default collapsed keeps the card compact; the toggle flips it.
    expect(src).toMatch(/const \[planExpanded, setPlanExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setPlanExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the one-line clamp so the full plan is readable', () => {
    const src = readGroupRoomSource();
    // Collapsed keeps numberOfLines 1; expanded passes undefined so the
    // clamp is off entirely -- the operator can read the whole plan.
    expect(src).toMatch(/numberOfLines=\{planExpanded \? undefined : 1\}/);
    const planTarget = src.match(
      /<PressableScale[\s\S]*?roomPlanTarget[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(planTarget).toBeDefined();
    expect(planTarget).toMatch(/numberOfLines=\{planExpanded \? undefined : 1\}/);
  });
});
