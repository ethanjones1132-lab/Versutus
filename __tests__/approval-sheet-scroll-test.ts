declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('approval sheet is scrollable on short phones', () => {
  test('approval-sheet wraps body in ScrollView so Approve/Deny stays reachable', () => {
    const src = readFile('src/components/chat/approval-sheet.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.scroll}');
    const scrollIdx = src.indexOf('<ScrollView');
    const approveIdx = src.indexOf('label="Approve"');
    expect(approveIdx).toBeGreaterThan(scrollIdx);
    const closeIdx = src.indexOf('</ScrollView>');
    expect(approveIdx).toBeLessThan(closeIdx);
    const denyIdx = src.indexOf('label="Deny"');
    expect(denyIdx).toBeGreaterThan(scrollIdx);
    expect(denyIdx).toBeLessThan(closeIdx);
  });

  test('approval-sheet imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/approval-sheet.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('approval-sheet keeps header/eyebrow outside the ScrollView (fixed header)', () => {
    const src = readFile('src/components/chat/approval-sheet.tsx');
    expect(src).toContain('eyebrow="APPROVAL REQUIRED"');
    const baseIdx = src.indexOf('<BaseSheet');
    const scrollIdx = src.indexOf('<ScrollView');
    expect(scrollIdx).toBeGreaterThan(baseIdx);
  });
});
