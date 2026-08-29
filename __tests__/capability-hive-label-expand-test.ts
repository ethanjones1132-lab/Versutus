declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCapabilityHiveSource(): string {
  // capability-hive.tsx is LF on disk (preserved); read as-is.
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'capability-hive.tsx'].join(SEP),
    'utf8',
  );
}

// Tapping a capability diamond is the only way to learn which capability it is,
// but the selected-group label (capability-hive.tsx:62-64) was a plain <Text>
// clamped to one line inside a 120dp max-width with no press target, so a label
// like "Capability registry" or "Terminal session" truncated and the operator
// still could not read the name on a phone. Same expandable class as the
// provider readiness line, the env config lines, and the channel-status-row
// detail: a PressableScale toggle clears the clamp, default collapsed to keep
// the summary slim. The summary is a plain View (not a row Pressable), so there
// is no navigation to stop -- no stopPropagation needed here.
describe('capability hive selected-label expansion', () => {
  test('the selected-group label is a press target carrying the kit hit slop', () => {
    const src = readCapabilityHiveSource();
    expect(src).toContain("from '@/lib/motion/chip-hit-slop'");
    expect(src).toMatch(/hitSlop=\{\s*CHIP_HIT_SLOP\s*\}/);
    // The label <Text> must sit inside a PressableScale, not directly in the
    // summary, so a tap reaches the toggle.
    const target = src.match(
      /<PressableScale[\s\S]*?\{selectedGroup \? selectedGroup\.label : status\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toContain('{selectedGroup ? selectedGroup.label : status}');
  });

  test('the label starts collapsed and a tap flips the expansion state', () => {
    const src = readCapabilityHiveSource();
    // Default collapsed keeps the summary slim; the toggle flips it.
    expect(src).toMatch(/const \[labelExpanded, setLabelExpanded\] = useState\(false\);/);
    expect(src).toMatch(/setLabelExpanded\(\(prev\) => !prev\)/);
  });

  test('expanding clears the one-line clamp so the full capability name is readable', () => {
    const src = readCapabilityHiveSource();
    // Collapsed keeps numberOfLines 1; expanded passes undefined so the clamp
    // is off entirely -- the spec's "clears numberOfLines".
    expect(src).toMatch(/numberOfLines=\{\s*labelExpanded \? undefined : 1\s*\}/);
    const target = src.match(
      /<PressableScale[\s\S]*?\{selectedGroup \? selectedGroup\.label : status\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toMatch(/numberOfLines=\{\s*labelExpanded \? undefined : 1\s*\}/);
  });

  test('the toggle carries an accessibility label and expanded state for screen readers', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/accessibilityRole="button"/);
    expect(src).toMatch(/accessibilityState=\{\{\s*expanded: labelExpanded\s*\}\}/);
    expect(src).toMatch(
      /accessibilityLabel=\{\s*labelExpanded \? 'Collapse capability name' : 'Expand capability name'\s*\}/,
    );
  });
});
