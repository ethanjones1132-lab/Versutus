import {
  addStreamingPlaceholder,
  appendToolCallDelta,
  convertStreamError,
  finalizeStreamingMessage,
} from '@/lib/gateway/message-reducer';

describe('message-reducer tool status', () => {
  test('running tool finalized to complete', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running' });
    expect(messages[0].toolCalls?.[0].status).toBe('running');

    messages = finalizeStreamingMessage(messages, 'r1');
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
  });

  test('tool-only completion finalizes without text delta', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'search', status: 'running' });
    // No appendStreamDelta — turn ended with finish_reason tool_calls and no further text.
    // finalize must still promote the card so it does not stay Running.
    messages = finalizeStreamingMessage(messages, 'r1');
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
    expect(messages[0].streaming).toBe(false);
  });

  test('second update can promote a running tool to error', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running', detail: 'args' });
    messages = appendToolCallDelta(messages, 'r1', {
      name: 'read',
      status: 'error',
      detail: 'permission denied',
    });
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls?.[0].status).toBe('error');
    expect(messages[0].toolCalls?.[0].detail).toBe('permission denied');
  });

  test('finalize preserves error and complete statuses', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'a', status: 'running' });
    messages = appendToolCallDelta(messages, 'r1', { name: 'b', status: 'error' });
    messages = appendToolCallDelta(messages, 'r1', { name: 'c', status: 'complete' });
    messages = finalizeStreamingMessage(messages, 'r1');
    const byName = Object.fromEntries(messages[0].toolCalls!.map((t) => [t.name, t.status]));
    expect(byName.a).toBe('complete');
    expect(byName.b).toBe('error');
    expect(byName.c).toBe('complete');
  });

  test('finalize is a no-op when run id is unknown', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running' });
    const next = finalizeStreamingMessage(messages, 'missing');
    expect(next[0].toolCalls?.[0].status).toBe('running');
  });

  test('stream error promotes a running tool to error instead of leaving it Running', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running' });
    messages = convertStreamError(messages, 'r1', 'Gateway timed out', false);
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].toolCalls?.[0].status).toBe('error');
    expect(messages[0].text).toBe('Error: Gateway timed out');
  });

  test('stream error preserves an already-complete tool', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'complete' });
    messages = convertStreamError(messages, 'r1', 'Gateway timed out', false);
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
  });
});
