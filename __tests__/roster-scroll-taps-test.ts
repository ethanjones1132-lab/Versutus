declare const __dirname: string;
const SEP = __dirname.includes('\\\\') ? '\\\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const file = [__dirname, '..', 'src', 'components', 'chat', 'chat-roster.tsx'].join(SEP);
const src = nodeFs.readFileSync(file, 'utf8');

describe('roster ScrollView tap handling', () => {
  test('ScrollView keeps keyboardShouldPersistTaps handled so first tap is not swallowed by IME', () => {
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
  });

  test('ScrollView has keyboardDismissMode interactive for drag-to-dismiss', () => {
    expect(src).toContain('keyboardDismissMode="interactive"');
  });

  test('both props sit on the same ScrollView props block', () => {
    // The ScrollView is the roster's main scroll container; its props block
    // opens with contentContainerStyle and the keyboard props must be on it,
    // not on some nested list.
    const idxContent = src.indexOf('contentContainerStyle');
    const idxTaps = src.indexOf('keyboardShouldPersistTaps="handled"');
    const idxDismiss = src.indexOf('keyboardDismissMode="interactive"');
    const idxRefresh = src.indexOf('refreshControl=');
    expect(idxContent).toBeGreaterThan(-1);
    expect(idxTaps).toBeGreaterThan(idxContent);
    expect(idxDismiss).toBeGreaterThan(idxTaps);
    expect(idxDismiss).toBeLessThan(idxRefresh);
  });
});