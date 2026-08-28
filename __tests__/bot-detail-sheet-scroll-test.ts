declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readFile(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', ...relative.split('/')].join(SEP), 'utf8');
}

describe('bot detail sheet is scrollable on short phones', () => {
  test('bot-detail-sheet wraps body in ScrollView so soul and actions stay reachable', () => {
    const src = readFile('src/components/chat/bot-detail-sheet.tsx');
    expect(src).toContain('ScrollView');
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    expect(src).toContain('showsVerticalScrollIndicator={false}');
    expect(src).toContain('contentContainerStyle={styles.scroll}');
    // Description and soul must be inside the ScrollView
    const scrollIdx = src.indexOf('<ScrollView');
    const descIdx = src.indexOf('detail.description');
    const soulIdx = src.indexOf('            SOUL');
    const copyIdx = src.indexOf('Copy profile id');
    const closeIdx = src.indexOf('</ScrollView>');
    expect(descIdx).toBeGreaterThan(scrollIdx);
    expect(soulIdx).toBeGreaterThan(scrollIdx);
    expect(copyIdx).toBeGreaterThan(scrollIdx);
    expect(copyIdx).toBeLessThan(closeIdx);
    // Edit row also inside when present
    const editIdx = src.indexOf('Edit agent');
    expect(editIdx).toBeGreaterThan(scrollIdx);
    expect(editIdx).toBeLessThan(closeIdx);
  });

  test('bot-detail-sheet imports ScrollView from react-native', () => {
    const src = readFile('src/components/chat/bot-detail-sheet.tsx');
    expect(src).toMatch(/import[^;]*ScrollView[^;]*from 'react-native'/);
  });

  test('bot-detail-sheet keeps header/eyebrow outside ScrollView (fixed header)', () => {
    const src = readFile('src/components/chat/bot-detail-sheet.tsx');
    expect(src).toContain('eyebrow="AGENT"');
    const baseIdx = src.indexOf('<BaseSheet');
    const scrollIdx = src.indexOf('<ScrollView');
    expect(scrollIdx).toBeGreaterThan(baseIdx);
  });
});
