declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('group room rename sheet is scrollable on short phones', () => {
  test('rename sheet wraps form in ScrollView so Rename stays reachable with error', () => {
    const src = readFile('src/components/chat/group-room-view.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps=\"handled\"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.sheetScroll}');
    // Rename sheet is the last ScrollView (transcript is first); find by sheetScroll
    const scrollIdx = src.indexOf('contentContainerStyle={styles.sheetScroll}');
    expect(scrollIdx).toBeGreaterThan(0);
    // Use the specific rename button label inside that sheet
    const renameIdx = src.indexOf("label={renaming ? 'Renaming");
    expect(renameIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>', scrollIdx);
    expect(renameIdx).toBeLessThan(closeIdx);
    // error Text also inside same ScrollView
    const sheetErrorIdx = src.indexOf('styles.sheetError');
    expect(sheetErrorIdx).toBeGreaterThan(scrollIdx);
    expect(sheetErrorIdx).toBeLessThan(closeIdx);
  });

  test('group-room-view imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/group-room-view.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('rename sheet keeps header/eyebrow outside ScrollView (fixed header)', () => {
    const src = readFile('src/components/chat/group-room-view.tsx');
    expect(src).toContain('eyebrow=\"GROUP ROOMS\"');
    const scrollIdx = src.indexOf('contentContainerStyle={styles.sheetScroll}');
    // rename BaseSheet is the (only) BaseSheet in this file now
    const baseIdx = src.indexOf('<BaseSheet');
    expect(scrollIdx).toBeGreaterThan(baseIdx);
    // title prop is on BaseSheet, not inside ScrollView — header stays fixed
    expect(src.indexOf('visible={renameVisible}')).toBeLessThan(scrollIdx);
  });

  test('sheetScroll style provides padding so action row clears nav bar', () => {
    const src = readFile('src/components/chat/group-room-view.tsx');
    expect(src).toContain('sheetScroll');
    expect(src).toContain('paddingBottom');
  });
});
