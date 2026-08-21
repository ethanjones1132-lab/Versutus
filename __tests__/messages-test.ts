import { extractToolCalls, historyToChatMessages } from '@/lib/gateway/messages';

describe('extractToolCalls', () => {
  test('reads OpenAI tool_calls arrays', () => {
    expect(
      extractToolCalls({
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ name: 'web_search', status: 'complete', detail: '{"q":"x"}' }),
    ]);
  });

  test('reads content blocks (tool_use / tool_call)', () => {
    expect(
      extractToolCalls({
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } },
        ],
      }),
    ).toEqual([expect.objectContaining({ name: 'read_file', status: 'complete' })]);
  });

  test('returns empty when no tools present', () => {
    expect(extractToolCalls({ content: 'plain' })).toEqual([]);
  });
});

describe('historyToChatMessages', () => {
  test('keeps tool-only assistant turns', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }],
        timestamp: 1,
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls?.[0].name).toBe('bash');
  });

  test('still skips empty non-tool messages', () => {
    expect(historyToChatMessages([{ role: 'assistant', content: '' }])).toEqual([]);
  });

  test('two history turns with the same timestamp still get unique ids', () => {
    const messages = historyToChatMessages([
      { role: 'user', content: 'a', timestamp: 1 },
      { role: 'assistant', content: 'b', timestamp: 1 },
      { role: 'user', content: 'c', timestamp: 1 },
    ]);
    const ids = messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.some((id) => id === 'user-1' || id === 'assistant-1')).toBe(false);
  });

  test('preserves an explicit OpenClaw id', () => {
    const messages = historyToChatMessages([
      { role: 'user', content: 'a', timestamp: 1, __openclaw: { id: 'oc-99' } },
    ]);
    expect(messages[0].id).toBe('oc-99');
  });
});
