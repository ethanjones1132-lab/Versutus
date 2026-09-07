declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCapabilityHiveSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'capability-hive.tsx'].join(SEP),
    'utf8',
  );
}

// Each hive cell (capability-hive.tsx:114-119) is a Pressable with a real
// selection boolean (`selected === group.id` passed at :54, toggled at :58)
// that already drives the visible `selected && styles.cellSelected` highlight
// at :125. A sighted operator sees the highlight; a screen-reader user heard
// identical labels on every cell because no accessibilityState was declared.
describe('capability hive cells announce their selected state', () => {
  test('the cell Pressable carries accessibilityState={{ selected }}', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/accessibilityState=\{\{\s*selected\s*\}\}/);
  });

  test('the cell role stays a button', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/accessibilityRole="button"/);
  });

  test('the cell label stays group label plus status', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/accessibilityLabel=\{`?\$\{group\.label\} — \$\{group\.status\}`?\}/);
  });

  test('the selected highlight still drives off the same boolean', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/selected && styles\.cellSelected/);
  });

  test('the parent still passes selected === group.id and toggles it', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/selected=\{selected === group\.id\}/);
    expect(src).toMatch(/setSelected\(\(current\) => \(current === group\.id \? null : group\.id\)\)/);
  });

  test('the 28ms stagger and 280ms duration are byte-identical', () => {
    const src = readCapabilityHiveSource();
    expect(src).toMatch(/entering\.fadeIn\.delay\(index \* 28\)\.duration\(280\)/);
  });

  test('exactly one accessibilityState in the cell pressable, none on the summary toggle beyond its expanded one', () => {
    const src = readCapabilityHiveSource();
    const states = src.match(/accessibilityState=\{/g) ?? [];
    // Cell selected + summary-toggle expanded.
    expect(states.length).toBe(2);
    expect(src).toMatch(/accessibilityState=\{\{\s*expanded: labelExpanded\s*\}\}/);
  });
});
