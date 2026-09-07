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

// The backend title PressableScale (chat-header.tsx:90-107) opens the backends
// section of the thread config sheet via handleHeaderBackendPress
// (chat-screen.tsx:430-432, setBackendPickerVisible(true)). The disabled half
// of its accessibilityState shipped in iter-144; this item threads the open
// flag through so VoiceOver/TalkBack can announce the expanded section.
describe('Chat header backend picker expanded state', () => {
  test('ChatHeaderProps declares an optional backendsExpanded boolean', () => {
    const src = readChatHeaderSource();
    expect(src).toContain('backendsExpanded?: boolean;');
  });

  test('the backend-title PressableScale announces expanded from backendsExpanded with a false default', () => {
    const src = readChatHeaderSource();
    const backendBlock = src.match(
      /onPress=\{onBackendPress\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(backendBlock).toBeDefined();
    expect(backendBlock).toMatch(
      /accessibilityState=\{\{\s*disabled:\s*!onBackendPress \|\| !backendLabel,\s*expanded:\s*backendsExpanded \?\? false\s*\}\}/,
    );
  });

  test('the disabled half stays byte-identical', () => {
    const src = readChatHeaderSource();
    expect(src).toContain('disabled={!onBackendPress || !backendLabel}');
    expect(src).toContain('disabled: !onBackendPress || !backendLabel');
  });

  test('the label and role ternaries stay byte-identical', () => {
    const src = readChatHeaderSource();
    expect(src).toContain(
      'accessibilityLabel={backendLabel ? `Chat backend: ${backendLabel}. Change backend.` : undefined}',
    );
    expect(src).toContain(
      'accessibilityRole={backendLabel && onBackendPress ? \'button\' : undefined}',
    );
  });

  test('both headline Text lines stay byte-identical', () => {
    const src = readChatHeaderSource();
    expect(src).toContain('<Text variant="headline" numberOfLines={1} style={styles.name}>');
    expect(src).toContain(
      "streaming\n          ? 'Streaming response…'\n          : backendLabel || groupName?.trim()\n            ? `via ${gatewayName}${statusDetail ? ` · ${statusDetail}` : ''}`\n            : statusDetail || 'Ready for chat and slash commands'",
    );
  });

  test('the chat-screen call site threads backendPickerVisible into backendsExpanded', () => {
    const src = readChatScreenSource();
    expect(src).toMatch(/<ChatHeader[\s\S]*?backendsExpanded=\{backendPickerVisible\}[\s\S]*?\/>/);
  });

  test('the expanded state lives on the backend title and the overflow, never on the back button', () => {
    const src = readChatHeaderSource();
    const allPressables = src.match(/<PressableScale[\s\S]*?\/>/g) ?? [];
    const stateCarriers = allPressables.filter((p) =>
      /accessibilityState=\{\{/.test(p),
    );
    // Backend title + Chat-options overflow: Back-to-roster (:78-91) is a
    // flat navigation button with no sheet to announce.
    expect(stateCarriers).toHaveLength(2);
    expect(stateCarriers[0]).toMatch(/onPress=\{onBackendPress\}/);
    expect(stateCarriers[1]).toMatch(/onPress=\{onOverflowPress\}/);
    const overflowBlock = src.match(
      /accessibilityLabel="Chat options"[\s\S]*?\/>/,
    )?.[0];
    expect(overflowBlock).toBeDefined();
    expect(overflowBlock).toMatch(
      /accessibilityState=\{\{\s*expanded:\s*overflowExpanded \?\? false\s*\}\}/,
    );
    const backBlock = src.match(
      /accessibilityLabel="Back to roster"[\s\S]*?\/>/,
    )?.[0];
    expect(backBlock).toBeDefined();
    expect(backBlock).not.toMatch(/accessibilityState/);
  });
});
