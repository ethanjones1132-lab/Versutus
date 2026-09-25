declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readBubbleSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'message-bubble.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

const bubble = readBubbleSource();

/**
 * CHARTER priority 1 (message layout) against docs/visual-direction-2026-09
 * and docs/ui-audit-claude-2026-09-24: the assistant's words are the hero.
 * Text sits on the stage, the user turns in a soft grey pill, and every tool /
 * thinking artefact collapses behind one quiet expandable line so the answer
 * is never the shortest thing in the transcript.
 */
describe('message layout: assistant unboxed, user soft grey, activity collapsed', () => {
  test('the assistant reply is full-width text on the stage', () => {
    expect(bubble).not.toMatch(/<Card\b/);
    expect(bubble).not.toContain('styles.monogram');
    expect(bubble).toMatch(/assistantBubble: \{[\s\S]*?padding: 0,/);
    expect(bubble).toMatch(/bubbleColumnAssistant: \{[\s\S]*?alignItems: 'stretch',[\s\S]*?flexGrow: 1,/);
    expect(bubble).not.toContain('bubbleMaxWidth(windowWidth, true)');
  });

  test('the user message is one soft grey pill with no border and no violet tint', () => {
    expect(bubble).toMatch(/userBubble: \{[\s\S]*?borderRadius: Radius\.xl,/);
    expect(bubble).toContain('{ backgroundColor: tokens.backgroundRaised }');
    expect(bubble).not.toContain('tokens.accentMuted');
    const keyAt = bubble.indexOf('userBubble: {');
    const userBlock = bubble.slice(keyAt, bubble.indexOf('},', keyAt));
    expect(userBlock).not.toMatch(/border(?:Width|Color)/);
    expect(bubble).not.toMatch(/backgroundColor: tokens\.accent/);
  });

  test('tools and thinking share one quiet expandable summary line', () => {
    expect(bubble).toContain("`Used ${toolCallCount} tools`");
    expect(bubble).toContain("if (hasReasoning) activityParts.push('Thinking')");
    expect(bubble).toContain("const activityLabel = activityParts.join(' · ')");
    expect(bubble).toContain('accessibilityLabel={activityLabel}');
    // Exactly one summary line, rendered above the answer.
    const summaryAt = bubble.indexOf('activityLabel}');
    const bodyAt = bubble.indexOf('{isCommand ? (\n            <MarkdownText');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(summaryAt);
  });

  test('the tool cards and reasoning only mount once the line is opened', () => {
    expect(bubble).toMatch(/\{isActivityOpen \? \([\s\S]*?styles\.activityCard[\s\S]*?<ToolCallCard/);
    const cardCount = (bubble.match(/<ToolCallCard/g) ?? []).length;
    expect(cardCount).toBe(1);
    // Default collapsed: the override starts unset and only a live turn with
    // no answer text yet opens the line by itself.
    expect(bubble).toMatch(/useState<boolean \| null>\(null\)/);
    expect(bubble).toContain('activityUserOverride !== null');
    expect(bubble).toContain('!!message.streaming && message.text.length === 0');
    expect(bubble).toMatch(/activityCard: \{[\s\S]*?maxHeight: 320,/);
  });

  test('the answer itself stays unpadded text rendered through markdown', () => {
    expect(bubble).toMatch(
      /\) : isUser \? \([\s\S]*?<Text color="primary" variant="body">[\s\S]*?\) : \(\s*<MarkdownText text=\{body\} streaming=\{!!message\.streaming\} \/>\s*\)\}/,
    );
  });
});
