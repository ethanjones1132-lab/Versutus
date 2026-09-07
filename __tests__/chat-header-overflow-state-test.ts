declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatHeaderSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-header.tsx'].join(SEP),
    'utf8',
  );
}

function readChatScreenSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP),
    'utf8',
  );
}

// The Chat-options overflow PressableScale (chat-header.tsx:130-144) opens the
// overflow sheet via handleHeaderOverflowPress (chat-screen.tsx:426-428,
// setOverflowVisible(true)). The sheet renders visible={overflowVisible} with
// onClose clearing it. This item threads the open flag through so
// VoiceOver/TalkBack can announce the expanded sheet.
describe('Chat header overflow sheet expanded state', () => {
  test('ChatHeaderProps declares an optional overflowExpanded boolean', () => {
    const src = readChatHeaderSource();
    expect(src).toContain('overflowExpanded?: boolean;');
  });

  test('the overflow PressableScale announces expanded from overflowExpanded with a false default', () => {
    const src = readChatHeaderSource();
    const overflowBlock = src.match(
      /onPress=\{onOverflowPress\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*overflowExpanded \?\? false\s*\}\}/,
    );
  });

  test('the Chat-options label and role stay byte-identical', () => {
    const src = readChatHeaderSource();
    expect(src).toContain('accessibilityLabel="Chat options"');
    expect(src).toContain('accessibilityRole="button"');
  });

  test('the chat-screen call site threads overflowVisible into overflowExpanded', () => {
    const src = readChatScreenSource();
    expect(src).toMatch(/<ChatHeader[\s\S]*?overflowExpanded=\{overflowVisible\}[\s\S]*?\/>/);
  });

  test('the overflow sheet renders visible from overflowVisible with an onClose that clears it', () => {
    const src = readChatScreenSource();
    expect(src).toContain('visible={overflowVisible}');
    expect(src).toContain('onClose={() => setOverflowVisible(false)}');
  });

  test('the Back-to-roster pressable never announces state', () => {
    const src = readChatHeaderSource();
    const backBlock = src.match(
      /onPress=\{onRosterPress\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(backBlock).toBeDefined();
    expect(backBlock).toContain('accessibilityLabel="Back to roster"');
    expect(backBlock).not.toMatch(/accessibilityState=\{\{/);
  });
});
