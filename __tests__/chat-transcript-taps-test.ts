declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const file = [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP);
const src = nodeFs.readFileSync(file, 'utf8');

describe('chat transcript FlatList tap handling', () => {
  test('FlatList has keyboardShouldPersistTaps handled so first tap is not swallowed by IME', () => {
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
    // Must be on the transcript FlatList, not just any nested ScrollView — the
    // FlatList is the main scroll container at ~1170; verify it sits near onScroll.
    const idxTaps = src.indexOf('keyboardShouldPersistTaps="handled"');
    const idxScroll = src.indexOf('onScroll={handleScroll}');
    expect(idxTaps).toBeGreaterThan(idxScroll);
    // Should be before renderItem, confirming it is on same FlatList props block.
    const idxRenderItem = src.indexOf('renderItem={renderMessage}');
    expect(idxTaps).toBeLessThan(idxRenderItem);
  });

  test('FlatList has keyboardDismissMode interactive for drag-to-dismiss', () => {
    expect(src).toContain('keyboardDismissMode="interactive"');
  });

  test('matches sibling surfaces that already handle taps (roster, composer, onboarding)', () => {
    // These were already correct; transcript should now join them.
    const roster = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-roster.tsx'].join(SEP),
      'utf8',
    );
    const composer = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
      'utf8',
    );
    const onboarding = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'onboarding', 'onboarding-screen.tsx'].join(SEP),
      'utf8',
    );
    expect(roster).toContain('keyboardShouldPersistTaps');
    expect(composer).toContain('keyboardShouldPersistTaps');
    expect(onboarding).toContain('keyboardShouldPersistTaps');
  });
});
