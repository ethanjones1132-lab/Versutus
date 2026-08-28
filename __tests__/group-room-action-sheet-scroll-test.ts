declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('group room action sheet is scrollable on short phones', () => {
  test('removing branch wraps candidate chips and Remove action in a ScrollView', () => {
    const src = readFile('src/components/chat/group-room-action-sheet.tsx');
    const scrollIdx = src.indexOf('<ScrollView');
    const removeIdx = src.indexOf('Remove from room');
    expect(removeIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>');
    expect(removeIdx).toBeLessThan(closeIdx);
    const chipsIdx = src.indexOf('removeOptions.map');
    expect(chipsIdx).toBeGreaterThan(scrollIdx);
    expect(chipsIdx).toBeLessThan(closeIdx);
  });

  test('adding branch wraps candidate chips and Add action in a ScrollView', () => {
    const src = readFile('src/components/chat/group-room-action-sheet.tsx');
    const firstClose = src.indexOf('</ScrollView>');
    const scrollIdx = src.indexOf('<ScrollView', firstClose + 1);
    const addIdx = src.indexOf('Add to room');
    expect(addIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>', firstClose + 1);
    expect(addIdx).toBeLessThan(closeIdx);
    const chipsIdx = src.indexOf('candidates.map');
    expect(chipsIdx).toBeGreaterThan(scrollIdx);
    expect(chipsIdx).toBeLessThan(closeIdx);
  });

  test('every branch of the sheet scrolls with handled taps and no indicator', () => {
    const src = readFile('src/components/chat/group-room-action-sheet.tsx');
    const opens = src.split('<ScrollView').length - 1;
    expect(opens).toBeGreaterThanOrEqual(3);
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.facts}');
  });

  test('group-room-action-sheet imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/group-room-action-sheet.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('sheet header stays outside the ScrollView (fixed header)', () => {
    const src = readFile('src/components/chat/group-room-action-sheet.tsx');
    expect(src).toContain('eyebrow="GROUP ROOM"');
    const baseIdx = src.indexOf('<BaseSheet');
    const scrollIdx = src.indexOf('<ScrollView');
    expect(scrollIdx).toBeGreaterThan(baseIdx);
  });
});