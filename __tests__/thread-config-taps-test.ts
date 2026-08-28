declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const file = [__dirname, '..', 'src', 'components', 'chat', 'thread-config-sheet.tsx'].join(SEP);
const src = nodeFs.readFileSync(file, 'utf8');

describe('thread config sheet tap handling', () => {
  test('sessions FlatList has keyboardShouldPersistTaps handled', () => {
    const count = (src.match(/keyboardShouldPersistTaps="handled"/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('models SectionList has keyboardShouldPersistTaps handled', () => {
    // Should appear on SectionList (models) as well as both FlatLists
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    const sectionIdx = src.indexOf('<SectionList');
    const afterSection = src.slice(sectionIdx, sectionIdx + 800);
    expect(afterSection).toContain('keyboardShouldPersistTaps="handled"');
  });

  test('backends FlatList has keyboardShouldPersistTaps handled', () => {
    const backendsIdx = src.indexOf('data={backends}');
    const afterBackends = src.slice(backendsIdx, backendsIdx + 400);
    expect(afterBackends).toContain('keyboardShouldPersistTaps="handled"');
  });

  test('each list also has keyboardDismissMode interactive', () => {
    const count = (src.match(/keyboardDismissMode="interactive"/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('sessions list keyboardDismissMode sits on same FlatList as data={visibleSessions}', () => {
    const sessionsIdx = src.indexOf('data={visibleSessions}');
    const afterSessions = src.slice(sessionsIdx, sessionsIdx + 600);
    expect(afterSessions).toContain('keyboardShouldPersistTaps="handled"');
    expect(afterSessions).toContain('keyboardDismissMode="interactive"');
  });

  test('matches transcript fix at chat-screen.tsx:1183', () => {
    const chatScreen = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP),
      'utf8',
    );
    expect(chatScreen).toContain('keyboardShouldPersistTaps="handled"');
    expect(chatScreen).toContain('keyboardDismissMode="interactive"');
  });
});
