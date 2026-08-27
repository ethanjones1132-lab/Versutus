import { extractMessageText, extractReasoning, historyToChatMessages } from '@/lib/gateway/messages';

describe('extractReasoning', () => {
  test('reads thinking blocks with thinking field', () => {
    expect(extractReasoning([{ type: 'thinking', thinking: 'hmm' }])).toBe('hmm');
  });

  test('reads reasoning blocks', () => {
    expect(extractReasoning([{ type: 'reasoning', reasoning: 'deep thought' }])).toBe('deep thought');
  });

  test('reads reasoning_content blocks', () => {
    expect(extractReasoning([{ type: 'reasoning_content', reasoning_content: 'cot' }])).toBe('cot');
  });

  test('falls back to text field inside thinking blocks', () => {
    expect(extractReasoning([{ type: 'thinking', text: 'via text' }])).toBe('via text');
  });

  test('concatenates multiple reasoning blocks', () => {
    expect(
      extractReasoning([
        { type: 'thinking', thinking: 'a' },
        { type: 'reasoning', reasoning: 'b' },
      ]),
    ).toBe('ab');
  });

  test('ignores text blocks', () => {
    expect(extractReasoning([{ type: 'text', text: 'hello' }])).toBe('');
  });

  test('returns empty for string content or non-array', () => {
    expect(extractReasoning('plain')).toBe('');
    expect(extractReasoning(null)).toBe('');
  });
});

describe('historyToChatMessages with reasoning', () => {
  test('history entry with thinking block yields reasoning on ChatMessage', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'my reasoning' }],
        timestamp: 1,
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toBe('my reasoning');
    expect(messages[0].text).toBe('');
  });

  test('reasoning-only turn is kept, not discarded as empty', () => {
    const messages = historyToChatMessages([
      { role: 'assistant', content: [{ type: 'reasoning', reasoning: 'alone' }] },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toBe('alone');
  });

  test('text + thinking preserves both without mixing', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'think' },
          { type: 'text', text: 'answer' },
        ],
      },
    ]);
    expect(messages[0].text).toBe('answer');
    expect(messages[0].reasoning).toBe('think');
  });

  test('tool-only still kept, reasoning does not pollute text', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('');
    expect(messages[0].reasoning).toBeUndefined();
  });

  test('empty non-tool non-reasoning still skipped', () => {
    expect(historyToChatMessages([{ role: 'assistant', content: '' }])).toEqual([]);
    expect(historyToChatMessages([{ role: 'assistant', content: [{ type: 'text', text: '' }] }])).toEqual([]);
  });

  test('reasoning with tool_calls together keeps both', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'tool_use', name: 'web_search', input: { q: 'x' } },
        ],
      },
    ]);
    expect(messages[0].reasoning).toBe('plan');
    expect(messages[0].toolCalls?.[0].name).toBe('web_search');
  });
});
