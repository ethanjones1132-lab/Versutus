import {
  addStreamingPlaceholder,
  appendStreamDelta,
  markInterrupted,
  reconcileInterruptedMessages,
  settleInterruptedFromRuns,
} from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'run-r1',
    role: 'assistant',
    text: 'partial',
    timestamp: 1_000,
    streaming: true,
    ...overrides,
  };
}

describe('markInterrupted with cause', () => {
  test('stores the disconnect cause as secondary text on the bubble', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendStreamDelta(messages, 'r1', 'Hello ');
    messages = markInterrupted(messages, 'r1', 'fetch failed: network error');

    expect(messages[0].interrupted).toBe(true);
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].interruptedReason).toBe('fetch failed: network error');
    expect(messages[0].text).toBe('Hello ');
  });

  test('trims the reason and drops blank reasons', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = markInterrupted(messages, 'r1', '  Connection lost  ');
    expect(messages[0].interruptedReason).toBe('Connection lost');

    let messages2 = addStreamingPlaceholder([], 'r2');
    messages2 = markInterrupted(messages2, 'r2', '   ');
    expect(messages2[0].interruptedReason).toBeUndefined();

    let messages3 = addStreamingPlaceholder([], 'r3');
    messages3 = markInterrupted(messages3, 'r3');
    expect(messages3[0].interruptedReason).toBeUndefined();
  });

  test('reconciliation still replaces an interrupted bubble that carries a reason', () => {
    let current = addStreamingPlaceholder([], 'r1');
    current = appendStreamDelta(current, 'r1', 'Partial answer');
    current = markInterrupted(current, 'r1', 'network timeout');

    const history: ChatMessage[] = [
      { id: 'hist-1', role: 'assistant', text: 'Partial answer that continued to completion' },
    ];

    const result = reconcileInterruptedMessages(current, history);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('hist-1');
    expect(result[0].interrupted).toBeFalsy();
  });

  test('settle clears the interruption reason once the run resolves', () => {
    let messages = addStreamingPlaceholder([], 'a');
    messages = markInterrupted(messages, 'a', 'connection closed unexpectedly');
    expect(messages[0].interruptedReason).toBe('connection closed unexpectedly');

    const settled = settleInterruptedFromRuns(messages, [{ runId: 'a', text: 'the full answer' }]);
    expect(settled[0].interrupted).toBe(false);
    expect(settled[0].interruptedReason).toBeUndefined();
    expect(settled[0].text).toBe('the full answer');
  });

  test('is a no-op when the run id is not present, even with a reason', () => {
    const messages = [message({ id: 'other', text: 'hi' })];
    const result = markInterrupted(messages, 'missing', 'network error');
    expect(result[0].interrupted).toBeUndefined();
    expect(result[0].interruptedReason).toBeUndefined();
  });
});
