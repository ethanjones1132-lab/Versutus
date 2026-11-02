import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import {
  addStreamingPlaceholder,
  appendToolCallDelta,
  finalizeStreamingMessage,
} from '@/lib/gateway/message-reducer';

/**
 * A tool call can be reported across several frames, and only some of those
 * frames carry a status. A fragment that says nothing — or still says
 * `running` — must not put a card the turn already reported as `complete` or
 * `error` back into its running state. These tests pin both ends of that
 * journey: the delta interpreter that builds the call, and the reducer that
 * merges it into the bubble.
 */
describe('chat stream tool status is terminal-sticky', () => {
  test('a later fragment without a status keeps a completed tool complete', () => {
    const acc = createChatStreamAcc();
    const first = interpretChatStreamChunk(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-1', function: { name: 'read_file' }, status: 'complete' },
              ],
            },
          },
        ],
      },
      acc,
    );
    expect(first.toolCalls[0].status).toBe('complete');

    // The arguments arrive in a second fragment that reports no status at all.
    const second = interpretChatStreamChunk(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } },
        ],
      },
      acc,
    );
    expect(second.toolCalls[0]).toMatchObject({
      name: 'read_file',
      status: 'complete',
      detail: '{"path":"a"}',
    });
  });

  test('an explicit running fragment cannot reopen an errored tool', () => {
    const acc = createChatStreamAcc();
    interpretChatStreamChunk(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'write' }, status: 'error' }] } },
        ],
      },
      acc,
    );
    const later = interpretChatStreamChunk(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'write' }, status: 'running' }] } },
        ],
      },
      acc,
    );
    expect(later.toolCalls[0].status).toBe('error');
  });

  test('an array-form block reports the status the provider sent', () => {
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      {
        choices: [
          { delta: { content: [{ type: 'tool_use', name: 'read_file', status: 'complete' }] } },
        ],
      },
      acc,
    );
    expect(result.toolCalls).toEqual([{ name: 'read_file', status: 'complete' }]);
  });

  test('an array-form fragment after a terminal block keeps the terminal status', () => {
    const acc = createChatStreamAcc();
    interpretChatStreamChunk(
      {
        choices: [
          { delta: { content: [{ type: 'tool_use', name: 'read_file', status: 'complete' }] } },
        ],
      },
      acc,
    );
    const later = interpretChatStreamChunk(
      { choices: [{ delta: { content: [{ type: 'tool_use', name: 'read_file' }] } }] },
      acc,
    );
    expect(later.toolCalls).toEqual([{ name: 'read_file', status: 'complete' }]);
  });

  test('a running status still promotes to complete when the turn says so', () => {
    const acc = createChatStreamAcc();
    interpretChatStreamChunk(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'grep' }, status: 'running' }] } },
        ],
      },
      acc,
    );
    const done = interpretChatStreamChunk(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'grep' }, status: 'complete' }] } },
        ],
      },
      acc,
    );
    expect(done.toolCalls[0].status).toBe('complete');
  });

  test('a fresh accumulator still implies running for a statusless fragment', () => {
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'grep' } }] } }] },
      acc,
    );
    expect(result.toolCalls[0].status).toBe('running');
  });
});

describe('message reducer keeps a terminal tool status', () => {
  test('a running update with new detail does not downgrade a completed tool', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', {
      name: 'read',
      status: 'complete',
      detail: 'first',
    });
    messages = appendToolCallDelta(messages, 'r1', {
      name: 'read',
      status: 'running',
      detail: 'second',
    });
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
    expect(messages[0].toolCalls?.[0].detail).toBe('second');
  });

  test('a statusless fragment does not reopen an errored tool', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'write', status: 'error' });
    messages = appendToolCallDelta(messages, 'r1', { name: 'write', detail: 'denied' });
    expect(messages[0].toolCalls?.[0].status).toBe('error');
    expect(messages[0].toolCalls?.[0].detail).toBe('denied');
  });

  test('finalize still leaves a completed tool complete', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'complete' });
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running' });
    messages = finalizeStreamingMessage(messages, 'r1');
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
  });
});
