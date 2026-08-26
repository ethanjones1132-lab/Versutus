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

test('a model frame reports what actually answered', () => {
  // The Gate emits this once a turn resolves. Hermes substitutes silently —
  // ask for longcat-2.0 and `fallback_providers` can answer as something else
  // entirely — so the frame carries both names and the UI can stop repeating
  // the operator's own pick back at them.
  const acc = createChatStreamAcc();
  const out = interpretChatStreamChunk(
    { model: 'deepseek-v4-flash', requested_model: 'longcat-2.0', provider: 'opencode-go', choices: [] },
    acc,
  );
  expect(out.ranModel).toBe('deepseek-v4-flash');
  expect(out.requestedModel).toBe('longcat-2.0');
  expect(out.provider).toBe('opencode-go');
  // It is not content, and it is not an error.
  expect(out.text).toBeUndefined();
  expect(out.streamError).toBeUndefined();
  expect(out.toolCalls).toEqual([]);
});

test('an ordinary delta carries no model claim', () => {
  const acc = createChatStreamAcc();
  const out = interpretChatStreamChunk({ choices: [{ delta: { content: 'hi' } }] }, acc);
  expect(out.text).toBe('hi');
  expect(out.ranModel).toBeUndefined();
  expect(out.requestedModel).toBeUndefined();
});
