import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';

test('accumulates a split OpenAI tool name then arguments', () => {
  const acc = createChatStreamAcc();
  const first = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'web_' } }] } }] },
    acc,
  );
  const second = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"q"' } }] } }] },
    acc,
  );
  const third = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
    acc,
  );
  expect(first.toolCalls[0]).toEqual({ name: 'web_', status: 'running', detail: undefined });
  expect(second.toolCalls[0]).toEqual({ name: 'web_search', status: 'running', detail: '{"q"' });
  expect(third.toolCalls[0]).toEqual({
    name: 'web_search',
    status: 'running',
    detail: '{"q":"x"}',
  });
});

test('accepts a top-level name on the tool object', () => {
  const acc = createChatStreamAcc();
  const result = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, name: 'read_file' }] } }] },
    acc,
  );
  expect(result.toolCalls[0].name).toBe('read_file');
});

test('forwards text deltas and error frames', () => {
  const acc = createChatStreamAcc();
  expect(interpretChatStreamChunk({ choices: [{ delta: { content: 'Hi' } }] }, acc).text).toBe('Hi');
  expect(
    interpretChatStreamChunk(
      { error: { message: 'opencode: Insufficient balance.', code: 'backend_error' } },
      acc,
    ).streamError,
  ).toMatch(/Insufficient balance/);
});

test('argument-only fragment with no name yet emits nothing', () => {
  const acc = createChatStreamAcc();
  const result = interpretChatStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] },
    acc,
  );
  expect(result.toolCalls).toEqual([]);
});
