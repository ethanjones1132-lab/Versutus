declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readMessageBubbleSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'message-bubble.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

/** The body of a named StyleSheet entry, without its trailing brace. */
function styleBlock(src: string, name: string): string {
  const at = src.indexOf(`${name}: {`);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('},', at));
}

/** The largest maxHeight declared inside a style block, if any. */
function maxHeightOf(block: string): number {
  const match = block.match(/maxHeight:\s*(\d+)/);
  return match ? Number(match[1]) : Number.NaN;
}

// The activity card caps at 320px, but the tool cards were direct children of
// that card with no viewport of their own. React Native does not clip children
// by default, so a turn with many tool calls painted the extra cards over the
// answer text below. The tool list now lives in its own bounded, shrinkable
// ScrollView inside the card: long lists scroll, short lists look unchanged.
describe('MessageBubble keeps a long tool list inside its activity card', () => {
  test('the tool cards render inside a nested ScrollView viewport', () => {
    const src = readMessageBubbleSource();
    expect(src).toMatch(
      /<ScrollView\s+style=\{styles\.toolListScroll\}[\s\S]*?contentContainerStyle=\{styles\.toolListContent\}[\s\S]*?nestedScrollEnabled>[\s\S]*?<ToolCallCard/,
    );
    // One map over toolCalls, so exactly one ToolCallCard call site remains.
    expect((src.match(/<ToolCallCard/g) ?? [])).toHaveLength(1);
  });

  test('the tool list viewport is bounded and can shrink under the card cap', () => {
    const src = readMessageBubbleSource();
    const scroll = styleBlock(src, 'toolListScroll');
    const cap = maxHeightOf(scroll);
    // A numeric bound is what stops the list growing without limit; a shrink
    // factor lets it share the card with the reasoning block.
    expect(Number.isFinite(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(320);
    expect(scroll).toMatch(/flexShrink:\s*1,/);
    expect(scroll).toMatch(/flexGrow:\s*0,/);
  });

  test('the activity card keeps its 320px cap and its spacing', () => {
    const src = readMessageBubbleSource();
    const card = styleBlock(src, 'activityCard');
    expect(card).toMatch(/maxHeight:\s*320,/);
    expect(card).toMatch(/gap:\s*Spacing\.two,/);
    // The card spacing now lives on the scroll content, so the tool cards keep
    // the same visual rhythm they had as direct children.
    const content = styleBlock(src, 'toolListContent');
    expect(content).toMatch(/gap:\s*Spacing\.two,/);
  });

  test('the reasoning block keeps its own unchanged 200px bound', () => {
    const src = readMessageBubbleSource();
    expect(src).toContain('<ScrollView style={styles.reasoningScroll} nestedScrollEnabled>');
    expect(styleBlock(src, 'reasoningScroll')).toMatch(/maxHeight:\s*200,/);
    // Reasoning still renders before the tool list inside the open card.
    const reasoningAt = src.indexOf('styles.reasoningScroll');
    const toolsAt = src.indexOf('styles.toolListScroll');
    expect(reasoningAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeGreaterThan(reasoningAt);
  });

  test('the open-while-streaming and collapse-after behaviour is unchanged', () => {
    const src = readMessageBubbleSource();
    expect(src).toContain('const activitySettled = !!message.streaming;');
    expect(src).toContain('const isActivityOpen = activityUserOverride !== null ? activityUserOverride : activitySettled;');
    expect(src).toMatch(/\{isActivityOpen \? \([\s\S]*?styles\.activityCard/);
  });
});
