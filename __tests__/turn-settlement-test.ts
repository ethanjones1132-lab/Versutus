// Settling a bubble that carries a Gate turn id.
//
// Before the journal, the only way an interrupted bubble could be settled was a
// text-prefix match against reloaded history: the placeholder's id was a local
// `run-<uuid>`, so nothing could ask "what happened to turn X". These are the
// rules that settlement now follows instead — and, just as importantly, the
// ones it must not break: a cut-off turn never reads as a finished reply, and
// its running tool cards are never promoted to done.

import {
  addStreamingPlaceholder,
  appendStreamDelta,
  appendToolCallDelta,
  finalizeStreamingMessage,
  interruptedTurnIds,
  isStoppedTurn,
  markInterrupted,
  markTurnStreaming,
  preserveTurnBubbleAfterReload,
  settleInterruptedFromTurns,
} from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

function bubble(overrides: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    { id: 'user-1', role: 'user', text: 'what is it?', timestamp: 1_000 },
    {
      id: 'run-turn-1',
      role: 'assistant',
      text: 'The answer is',
      timestamp: 1_001,
      streaming: true,
      turnId: 'turn-1',
      ...overrides,
    },
  ];
}

describe('an interrupted bubble knows which turn it was the reply to', () => {
  test('the interrupted bubbles\' turn ids come back out', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');
    expect(interruptedTurnIds(messages)).toEqual(['turn-1']);
  });

  test('a bubble with no turn id contributes none — it is settled by history instead', () => {
    const legacy = markInterrupted(
      [{ id: 'run-legacy', role: 'assistant', text: 'half', streaming: true }],
      'legacy',
    );
    expect(interruptedTurnIds(legacy)).toEqual(['legacy']);
    const noRunKey = [
      { id: 'hist-1', role: 'assistant', text: 'half', interrupted: true } as ChatMessage,
    ];
    expect(interruptedTurnIds(noRunKey)).toEqual([]);
  });

  test('each bubble is named once, however it was interrupted', () => {
    const messages = [
      ...markInterrupted(bubble(), 'turn-1'),
      { ...markInterrupted(bubble({ id: 'run-turn-2', turnId: 'turn-2' }), 'turn-2')[1] },
    ];
    expect(interruptedTurnIds(messages)).toEqual(['turn-1', 'turn-2']);
  });
});

describe('a running turn is re-attached to the bubble it already had', () => {
  test('an interrupted bubble becomes streaming again instead of a second bubble appearing', () => {
    const interrupted = markInterrupted(bubble(), 'turn-1', 'Connection lost');

    const resumed = markTurnStreaming(interrupted, 'turn-1');

    expect(resumed).toHaveLength(2);
    expect(resumed[1].id).toBe('run-turn-1');
    expect(resumed[1].streaming).toBe(true);
    // The turn is demonstrably not over any more, so it is not interrupted.
    expect(resumed[1].interrupted).toBe(false);
    expect(resumed[1].interruptedReason).toBeUndefined();
    // The text the operator could already read is kept.
    expect(resumed[1].text).toBe('The answer is');
  });

  test('a thread with no bubble for the turn gets one, keyed by the turn id', () => {
    const raised = markTurnStreaming([{ id: 'user-1', role: 'user', text: 'hi' }], 'turn-9');
    expect(raised[1]).toMatchObject({ id: 'run-turn-9', turnId: 'turn-9', streaming: true });
  });

  test('a bubble the operator stopped is not re-opened by a late re-attach', () => {
    const stopped = markInterrupted(bubble(), 'turn-1', 'Connection lost').map((message) =>
      message.turnId === 'turn-1' ? { ...message, stopped: true, stoppedReason: 'Stopped' } : message,
    );
    const resumed = markTurnStreaming(stopped, 'turn-1');
    expect(resumed[1].streaming).toBe(false);
    expect(isStoppedTurn(resumed[1])).toBe(true);
  });
});

describe('settlement by identity', () => {
  test('done becomes the final text the journal assembled', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');

    const settled = settleInterruptedFromTurns(messages, [
      { turnId: 'turn-1', settlement: { kind: 'done', text: 'The answer is 42.' } },
    ]);

    expect(settled[1].text).toBe('The answer is 42.');
    expect(settled[1].interrupted).toBe(false);
    expect(settled[1].interruptedReason).toBeUndefined();
    expect(settled[1].streaming).toBe(false);
  });

  test('a done with no assembled text leaves the bubble alone — blanking it would be worse', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');

    const settled = settleInterruptedFromTurns(messages, [
      { turnId: 'turn-1', settlement: { kind: 'done', text: '' } },
    ]);

    expect(settled[1].text).toBe('The answer is');
    expect(settled[1].interrupted).toBe(true);
  });

  test('failed keeps what streamed and says why in the reason, not a red card', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');

    const settled = settleInterruptedFromTurns(messages, [
      { turnId: 'turn-1', settlement: { kind: 'failed', message: 'hermes: 500 upstream refused' } },
    ]);

    expect(settled[1].text).toBe('The answer is');
    expect(settled[1].interrupted).toBe(true);
    expect(settled[1].interruptedReason).toBe('hermes: 500 upstream refused');
    expect(settled[1].text).not.toMatch(/^Error:/);
  });

  test('cancelled is marked stopped, the way the operator\'s own Stop marks a turn', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');

    const settled = settleInterruptedFromTurns(messages, [
      { turnId: 'turn-1', settlement: { kind: 'cancelled' } },
    ]);

    expect(settled[1].interrupted).toBe(false);
    expect(settled[1].streaming).toBe(false);
    expect(isStoppedTurn(settled[1])).toBe(true);
  });

  test('interrupted keeps the marker and names the reason the Gate recorded', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');

    const settled = settleInterruptedFromTurns(messages, [
      {
        turnId: 'turn-1',
        settlement: { kind: 'interrupted', reason: 'gate_restart', copy: 'The Gate restarted while this was running.' },
      },
    ]);

    expect(settled[1].interrupted).toBe(true);
    expect(settled[1].interruptedReason).toBe('The Gate restarted while this was running.');
    expect(settled[1].text).toBe('The answer is');
  });

  test('a turn the journal says nothing about is left exactly as it was', () => {
    const messages = markInterrupted(bubble(), 'turn-1', 'Connection lost');
    expect(settleInterruptedFromTurns(messages, [])).toEqual(messages);
    expect(
      settleInterruptedFromTurns(messages, [
        { turnId: 'turn-2', settlement: { kind: 'cancelled' } },
      ])[1],
    ).toEqual(messages[1]);
  });

  test('a bubble the operator stopped is not settled again by a late journal verdict', () => {
    const stopped = markInterrupted(bubble(), 'turn-1', 'Connection lost').map((message) =>
      message.turnId === 'turn-1' ? { ...message, stopped: true } : message,
    );
    const settled = settleInterruptedFromTurns(stopped, [
      { turnId: 'turn-1', settlement: { kind: 'done', text: 'something else entirely' } },
    ]);
    expect(settled[1].text).toBe('The answer is');
    expect(isStoppedTurn(settled[1])).toBe(true);
  });
});

describe('a settled turn survives the history reload it triggers', () => {
  // A `done` verdict re-reads the thread the way a recovered turn always has,
  // and that read replaces the message list wholesale — so the bubble the
  // verdict is about has to be carried across, or the answer goes with it.
  const history: ChatMessage[] = [
    { id: 'user-1', role: 'user', text: 'what is it?', timestamp: 1_000 },
    { id: 'hist-1', role: 'assistant', text: 'unrelated', timestamp: 1_002 },
  ];

  test('a bubble the reload dropped comes back', () => {
    const followed = markTurnStreaming(bubble(), 'turn-1');

    const carried = preserveTurnBubbleAfterReload(history, followed, 'turn-1');

    expect(carried).toHaveLength(3);
    expect(carried[1].text).toBe('The answer is');
  });

  test('history that already shows the same answer wins — the Gate\'s record, not a second bubble', () => {
    const followed = markTurnStreaming(bubble(), 'turn-1');
    const caughtUp: ChatMessage[] = [
      ...history,
      { id: 'hist-2', role: 'assistant', text: 'The answer is 42.', timestamp: 1_003 },
    ];

    expect(preserveTurnBubbleAfterReload(caughtUp, followed, 'turn-1')).toEqual(caughtUp);
  });

  test('a bubble already on screen is not added twice, and an unknown turn changes nothing', () => {
    const followed = markTurnStreaming(bubble(), 'turn-1');
    const carried = preserveTurnBubbleAfterReload(history, followed, 'turn-1');

    expect(preserveTurnBubbleAfterReload(carried, followed, 'turn-1')).toEqual(carried);
    expect(preserveTurnBubbleAfterReload(history, followed, 'turn-9')).toEqual(history);
  });
});

describe('a cut-off turn never claims its work finished', () => {
  test('an interrupted turn\'s running tool calls stay running', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendToolCallDelta(messages, 'turn-1', { name: 'read_file', status: 'running' });
    messages = markInterrupted(messages, 'turn-1', 'The Gate restarted while this was running.');

    const settled = settleInterruptedFromTurns(messages, [
      {
        turnId: 'turn-1',
        settlement: {
          kind: 'interrupted',
          reason: 'gate_restart',
          copy: 'The Gate restarted while this was running.',
        },
      },
    ]);

    expect(settled[0].toolCalls?.[0].status).toBe('running');
  });

  test('and finishing one never promotes them either', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendToolCallDelta(messages, 'turn-1', { name: 'read_file', status: 'running' });
    messages = markInterrupted(messages, 'turn-1', 'Connection lost');

    const finalized = finalizeStreamingMessage(messages, 'turn-1');

    // The turn did not finish; a `[DONE]` on an interrupted bubble is not a
    // licence to claim its tools did.
    expect(finalized[0].toolCalls?.[0].status).toBe('running');
    expect(finalized[0].interrupted).toBe(true);
  });

  test('a genuinely finished turn still promotes its tool calls', () => {
    let messages = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = appendToolCallDelta(messages, 'turn-1', { name: 'read_file', status: 'running' });

    const finalized = finalizeStreamingMessage(messages, 'turn-1');

    expect(finalized[0].toolCalls?.[0].status).toBe('complete');
    expect(finalized[0].streaming).toBe(false);
  });

  test('the deltas of a re-attached turn land in the same bubble', () => {
    const resumed = markTurnStreaming(markInterrupted(bubble(), 'turn-1', 'Connection lost'), 'turn-1');

    const grown = appendStreamDelta(resumed, 'turn-1', ' 42.');

    expect(grown).toHaveLength(2);
    expect(grown[1].text).toBe('The answer is 42.');
  });
});