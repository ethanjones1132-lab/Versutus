// A mid-stream network blip does not interrupt the turn (INT-1): the Gate keeps
// running it and the phone re-attaches by turn id. The live stream records no
// journal seq, so the re-attach always starts at 0 and the replay carries every
// frame the turn has produced — which means the bubble the live send was
// already filling must be replaced by that replay, never appended to.

import {
  addStreamingPlaceholder,
  appendReasoningDelta,
  appendStreamDelta,
  appendToolCallDelta,
  markInterrupted,
  markTurnStreaming,
} from '@/lib/gateway/message-reducer';

describe('a re-attach from the journal start replaces what the live stream showed', () => {
  test('the replay ends as the journal text exactly once, with tools not duplicated', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendStreamDelta(messages, 'turn-1', 'partial');
    messages = appendReasoningDelta(messages, 'turn-1', 'thinking partial');
    messages = appendToolCallDelta(messages, 'turn-1', { id: 'tool-1', name: 'read_file', status: 'running' });
    messages = markInterrupted(messages, 'turn-1', 'fetch failed: network error');

    // The phone comes back and re-attaches from seq 0: the journal replays the
    // turn from its first frame, so the bubble starts over rather than keeping
    // the prefix the live stream had already shown.
    messages = markTurnStreaming(messages, 'turn-1', true);
    messages = appendStreamDelta(messages, 'turn-1', 'partial');
    messages = appendStreamDelta(messages, 'turn-1', ' and the rest');
    messages = appendReasoningDelta(messages, 'turn-1', 'thinking partial');
    messages = appendToolCallDelta(messages, 'turn-1', { id: 'tool-1', name: 'read_file', status: 'complete' });

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('partial and the rest');
    expect(messages[0].reasoning).toBe('thinking partial');
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].streaming).toBe(true);
  });

  test('a re-attach past the start keeps the text it already rendered', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendStreamDelta(messages, 'turn-1', 'The answer ');
    messages = markInterrupted(messages, 'turn-1', 'Connection lost');

    // Re-attaching after the last seq this process rendered sends only the tail:
    // the prefix already on the bubble is not part of the replay.
    messages = markTurnStreaming(messages, 'turn-1');
    messages = appendStreamDelta(messages, 'turn-1', 'is 42.');

    expect(messages[0].text).toBe('The answer is 42.');
  });
});

describe('one turn id never has two placeholders', () => {
  test('raising a placeholder for a turn that already has one resets and reuses it', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendStreamDelta(messages, 'turn-1', 'partial');
    messages = appendToolCallDelta(messages, 'turn-1', { id: 'tool-1', name: 'read_file', status: 'running' });
    messages = markInterrupted(messages, 'turn-1', 'connection lost');

    // An outbox resend is the same turn, answered as a replay from its first
    // frame — one bubble, cleared of the prefix the replay will send again.
    messages = addStreamingPlaceholder(messages, 'turn-1', 'turn-1');

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('run-turn-1');
    expect(messages[0].text).toBe('');
    expect(messages[0].toolCalls ?? []).toEqual([]);
    expect(messages[0].interrupted).toBeFalsy();
    expect(messages[0].streaming).toBe(true);
  });

  test('a genuinely new turn still raises its own placeholder', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendStreamDelta(messages, 'turn-1', 'first');

    messages = addStreamingPlaceholder(messages, 'turn-2', 'turn-2');

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('first');
    expect(messages[1].id).toBe('run-turn-2');
  });
});
