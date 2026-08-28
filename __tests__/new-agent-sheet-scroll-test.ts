declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('new agent and create group sheets are scrollable on short phones', () => {
  test('new-agent-sheet wraps form in ScrollView so Create button stays reachable', () => {
    const src = readFile('src/components/chat/new-agent-sheet.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps=\"handled\"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.pad}');
    // Create/Save button must be inside the ScrollView, not outside.
    const scrollIdx = src.indexOf('<ScrollView');
    const createIdx = src.indexOf("label={busy ? (editing ? 'Saving");
    expect(createIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>');
    expect(createIdx).toBeLessThan(closeIdx);
  });

  test('new-agent-sheet imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/new-agent-sheet.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('create-group-sheet wraps form in ScrollView so Create room button stays reachable', () => {
    const src = readFile('src/components/chat/create-group-sheet.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps=\"handled\"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.pad}');
    const scrollIdx = src.indexOf('<ScrollView');
    const createIdx = src.indexOf("'Create room'");
    expect(createIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>');
    expect(createIdx).toBeLessThan(closeIdx);
  });

  test('create-group-sheet imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/create-group-sheet.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('both sheets keep header/eyebrow outside the ScrollView (fixed header)', () => {
    const newAgent = readFile('src/components/chat/new-agent-sheet.tsx');
    const createGroup = readFile('src/components/chat/create-group-sheet.tsx');
    // BaseSheet title/eyebrow are props to BaseSheet, not inside ScrollView
    expect(newAgent).toContain('eyebrow=\"BOTS\"');
    expect(createGroup).toContain('eyebrow=\"GROUP ROOMS\"');
    // ScrollView must be inside BaseSheet children, after BaseSheet open
    const baseIdx = newAgent.indexOf('<BaseSheet');
    const scrollIdx = newAgent.indexOf('<ScrollView');
    expect(scrollIdx).toBeGreaterThan(baseIdx);
  });
});
