import {
  appendReasoningDelta,
  appendStreamDelta,
  appendToolCallDelta,
  isStoppedTurn,
  stopStreamedTurns,
} from '@/lib/gateway/message-reducer';
import type { ChatMessage, ChatToolCall } from '@/lib/gateway/types';

// Stop is not a failure and not an interruption nobody asked for: whatever had
// already streamed is text the operator can read. Throwing it away left an
// empty thread where an answer had been half-written — and marking the bubble
// `interrupted` made a deliberate stop look like a lost connection, so the
// foreground reconcile, the recovery ladder and the per-run status poll all went
// looking for work the operator had already ended.

function streaming(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'run-live',
    role: 'assistant',
    text: 'The answer is',
    timestamp: 1_000,
    streaming: true,
    ...overrides,
  };
}

describe('stopStreamedTurns', () => {
  test('keeps the partial reply, finalized and marked stopped', () => {
    const result = stopStreamedTurns([streaming()]);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('The answer is');
    expect(result[0].streaming).toBe(false);
    expect(isStoppedTurn(result[0])).toBe(true);
  });

  test('a stopped turn is not an interrupted one', () => {
    const result = stopStreamedTurns([streaming()]);

    // Every reader of `interrupted` treats the turn as unfinished work the
    // gateway may still be holding; a Stop has nothing left to fetch.
    expect(result[0].interrupted).toBeUndefined();
    expect(result[0].interruptedReason).toBeUndefined();
  });

  test('settles every placeholder, not just the one run a ref named', () => {
    const messages = [
      streaming({ id: 'run-one', text: 'first half' }),
      streaming({ id: 'run-two', text: 'second half' }),
      { ...streaming({ id: 'settled', streaming: false, text: 'already done' }) },
    ];

    const result = stopStreamedTurns(messages);

    expect(result.map((message) => [message.id, message.streaming, isStoppedTurn(message)])).toEqual([
      ['run-one', false, true],
      ['run-two', false, true],
      ['settled', false, false],
    ]);
  });

  test('finalizes a tool card that was still Running', () => {
    const tools: ChatToolCall[] = [{ name: 'read', status: 'running' }, { name: 'grep', status: 'complete' }];
    const result = stopStreamedTurns([streaming({ toolCalls: tools })]);

    expect(result[0].toolCalls).toEqual([
      { name: 'read', status: 'complete' },
      { name: 'grep', status: 'complete' },
    ]);
  });

  test('drops a placeholder that never produced any text', () => {
    const messages = [
      streaming({ id: 'run-one', text: 'half an answer' }),
      streaming({ id: 'run-two', text: '' }),
      { ...streaming({ id: 'user-1', role: 'user', text: 'hi', streaming: false }) },
    ];

    const result = stopStreamedTurns(messages);

    expect(result.map((message) => message.id)).toEqual(['run-one', 'user-1']);
  });

  test('treats a whitespace-only placeholder as nothing said', () => {
    expect(stopStreamedTurns([streaming({ text: '   \n' })])).toHaveLength(0);
  });

  test('keeps the reason the caller gives', () => {
    const result = stopStreamedTurns([streaming()], '  Stopped by the operator  ');

    expect((result[0] as { stoppedReason?: string }).stoppedReason).toBe('Stopped by the operator');
  });

  test('leaves a list with nothing streaming alone', () => {
    const messages = [streaming({ streaming: false })];

    const result = stopStreamedTurns(messages);

    expect(result).toEqual(messages);
    expect(result).not.toBe(messages);
  });

  test('does not mutate the list it was given', () => {
    const message = streaming();
    const messages = [message];
    stopStreamedTurns(messages);

    expect(message.streaming).toBe(true);
    expect(isStoppedTurn(message)).toBe(false);
    expect(messages).toHaveLength(1);
  });
});

describe('a delta that lands after Stop', () => {
  // The transport takes a tick to notice the abort, so a chunk can arrive
  // between `stopStreaming` settling the bubble and the send unwinding. Re-
  // streaming it put a live orb back on a turn the operator had already ended,
  // with nothing left in flight to ever settle it again.
  test('a late text delta keeps the text and leaves the orb stopped', () => {
    const stopped = stopStreamedTurns([streaming()]);

    const late = appendStreamDelta(stopped, 'live', ' — and the rest');

    expect(late[0].text).toBe('The answer is — and the rest');
    expect(late[0].streaming).toBe(false);
    expect(isStoppedTurn(late[0])).toBe(true);
  });

  test('a late reasoning delta does not restart it either', () => {
    const stopped = stopStreamedTurns([streaming()]);

    const late = appendReasoningDelta(stopped, 'live', 'still thinking');

    expect(late[0].reasoning).toBe('still thinking');
    expect(late[0].streaming).toBe(false);
    expect(isStoppedTurn(late[0])).toBe(true);
  });

  test('a late tool call does not restart it either', () => {
    const stopped = stopStreamedTurns([streaming()]);

    const late = appendToolCallDelta(stopped, 'live', { name: 'read', status: 'running' });

    expect(late[0].toolCalls).toHaveLength(1);
    expect(late[0].streaming).toBe(false);
    expect(isStoppedTurn(late[0])).toBe(true);
  });

  test('an ordinary turn in flight still streams', () => {
    const late = appendStreamDelta([streaming()], 'live', ' more');

    expect(late[0].streaming).toBe(true);
  });
});
