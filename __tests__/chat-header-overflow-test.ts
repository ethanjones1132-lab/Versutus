declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatHeaderSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-header.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('chat header subtitle fits beside usage and controls', () => {
  test('the model button yields width to the session usage note and ellipsizes long names', () => {
    const src = readChatHeaderSource();
    const modelButton = src.match(/onPress=\{onModelPress\}[\s\S]*?<\/PressableScale>/)?.[0];
    const modelStyle = src.match(/subtitleRow:\s*\{([^}]+)\}/)?.[1];
    const spendStyle = src.match(/spend:\s*\{([^}]+)\}/)?.[1];

    expect(modelButton).toBeDefined();
    expect(modelButton).toContain('accessibilityLabel={showModel ? `Model: ${modelLabel}. Change model.` : undefined}');
    expect(modelButton).toContain('<Text variant="caption" color="secondary" numberOfLines={1} style={styles.subtitle}>');
    expect(modelStyle).toMatch(/flex:\s*1/);
    expect(modelStyle).toMatch(/minWidth:\s*0/);
    expect(modelStyle).toMatch(/flexShrink:\s*1/);
    expect(spendStyle).toMatch(/minWidth:\s*0/);
    expect(spendStyle).toMatch(/flexShrink:\s*1/);
    expect(src).toContain('<Text variant="caption" color="tertiary" numberOfLines={1} style={styles.spend}>');
  });

  test('the back and options controls keep their fixed hit targets and accessible labels', () => {
    const src = readChatHeaderSource();
    const controlStyle = src.match(/control:\s*\{([^}]+)\}/)?.[1];

    expect(controlStyle).toMatch(/width:\s*40/);
    expect(controlStyle).toMatch(/height:\s*40/);
    expect(src).toContain('accessibilityLabel="Back to roster"');
    expect(src).toContain('accessibilityLabel="Chat options"');
    expect(src).toContain('hitSlop={10}');
  });
});
