declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('skills and routines panes are bounded and scrollable on phones', () => {
  test('skills pane wraps the open body in a ScrollView with a maxHeight bound', () => {
    const src = readFile('src/components/chat/skills-pane.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.body}');
    expect(src).toContain('maxHeight: SKILLS_PANE_MAX_HEIGHT');
    // The skill rows must be inside the ScrollView, not outside it.
    const scrollIdx = src.indexOf('<ScrollView');
    const rowIdx = src.indexOf('key={skill.name}');
    expect(rowIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>');
    expect(rowIdx).toBeLessThan(closeIdx);
  });

  test('skills pane imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/skills-pane.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('skills pane keeps the toggle button fixed outside the scroll body', () => {
    const src = readFile('src/components/chat/skills-pane.tsx');
    const toggleIdx = src.indexOf('<Button');
    const scrollIdx = src.indexOf('<ScrollView');
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeLessThan(scrollIdx);
  });

  test('routines pane wraps jobs and the create form in a ScrollView with a maxHeight bound', () => {
    const src = readFile('src/components/chat/routines-pane.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.body}');
    expect(src).toContain('maxHeight: ROUTINES_PANE_MAX_HEIGHT');
    // The Add button (tail of the create form) must be inside the ScrollView.
    const scrollIdx = src.indexOf('<ScrollView');
    const addIdx = src.indexOf("label={creating ? 'Adding…' : 'Add'}");
    expect(addIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>');
    expect(addIdx).toBeLessThan(closeIdx);
  });

  test('routines pane imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/routines-pane.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('routines pane keeps the toggle button fixed outside the scroll body', () => {
    const src = readFile('src/components/chat/routines-pane.tsx');
    const toggleIdx = src.indexOf('<Button');
    const scrollIdx = src.indexOf('<ScrollView');
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeLessThan(scrollIdx);
  });

  test('both lib modules carry the same bounded-pane constant as the tools idiom', () => {
    const skillsSrc = readFile('src/lib/gateway/skills.ts');
    expect(skillsSrc).toContain('SKILLS_PANE_MAX_HEIGHT = 280');
    const routinesSrc = readFile('src/lib/gateway/routines.ts');
    expect(routinesSrc).toContain('ROUTINES_PANE_MAX_HEIGHT = 280');
  });
});