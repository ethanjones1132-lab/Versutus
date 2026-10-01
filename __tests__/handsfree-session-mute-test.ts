import {
  INITIAL_HANDSFREE_SESSION,
  reduceHandsfreeSession,
  type HandsfreeEffect,
  type HandsfreeEvent,
  type HandsfreeSessionState,
} from '@/lib/voice/handsfree-session';
import { handsfreeEndReasonCopy } from '@/lib/voice/handsfree-call-copy';

// Mute in the two phases where a lossy path spends tens of seconds. The banner
// has always drawn the control and the reducer has always ignored it there, so
// the tap was a silent no-op exactly when the operator was most likely to reach
// for it. The turn is not cancelled by a mute — the words were said and the
// reply is still owed — so the intent is recorded and honoured on the way back.

function reduce(
  state: HandsfreeSessionState,
  events: HandsfreeEvent[],
): { state: HandsfreeSessionState; effects: HandsfreeEffect[] } {
  return events.reduce(
    (acc, event) => reduceHandsfreeSession(acc.state, event),
    { state, effects: [] as HandsfreeEffect[] } as {
      state: HandsfreeSessionState;
      effects: HandsfreeEffect[];
    },
  );
}

function step(
  state: HandsfreeSessionState,
  event: HandsfreeEvent,
): { state: HandsfreeSessionState; effects: HandsfreeEffect[] } {
  return reduceHandsfreeSession(state, event);
}

function listening(): HandsfreeSessionState {
  return reduce(INITIAL_HANDSFREE_SESSION, [{ type: 'start' }, { type: 'started' }]).state;
}

/** A turn that has been said and sent, waiting for the reply row. */
function waiting(): HandsfreeSessionState {
  return reduce(listening(), [
    { type: 'final', text: 'book a table' },
    { type: 'grace-elapsed' },
    { type: 'reply-appeared' },
  ]).state;
}

/** A turn whose reply is being read aloud. */
function speaking(): HandsfreeSessionState {
  return step(waiting(), { type: 'reply-content' }).state;
}

describe('mute while the turn is in flight', () => {
  test('mute while sending records the intent, mutes, and leaves the turn running', () => {
    const sending = step(listening(), { type: 'final', text: 'book a table' }).state;
    const out = step(step(sending, { type: 'grace-elapsed' }).state, { type: 'mute' });
    expect(out.state.phase).toBe('sending');
    expect(out.state.muteIntent).toBe(true);
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: true }]);
    // The turn is not cancelled: the recognizer is already stopped and the
    // words are already gone.
    expect(out.effects.some((effect) => effect.kind === 'stop-listening')).toBe(false);
    // And the turn still completes normally.
    const arrived = step(out.state, { type: 'reply-appeared' });
    expect(arrived.state.phase).toBe('waiting');
    expect(arrived.state.muteIntent).toBe(true);
  });

  test('mute while waiting mutes now and asks for the microphone to stay shut', () => {
    const out = step(waiting(), { type: 'mute' });
    expect(out.state.phase).toBe('waiting');
    expect(out.state.muteIntent).toBe(true);
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: true }]);
  });

  test('unmute while waiting clears the intent and unmutes the microphone', () => {
    const muted = step(waiting(), { type: 'mute' }).state;
    const out = step(muted, { type: 'unmute' });
    expect(out.state.phase).toBe('waiting');
    expect(out.state.muteIntent).toBeUndefined();
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: false }]);
    // And the reply that arrives afterwards reopens recognition as it always did.
    const finished = reduce(out.state, [
      { type: 'reply-content' },
      { type: 'speechFinished' },
    ]);
    expect(finished.state.phase).toBe('listening');
    expect(finished.effects).toEqual([{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
  });

  test('unmute with no intent in a phase that never took one changes nothing', () => {
    const live = waiting();
    const out = step(live, { type: 'unmute' });
    expect(out.state).toBe(live);
    expect(out.effects).toEqual([]);
  });

  // The reply is still owed: this feature mutes the microphone, not the
  // speaker. So the words are spoken, shown, and only then does the call settle
  // into the mute the operator asked for.
  test('a reply that arrives while muted is spoken, and the call ends muted', () => {
    const muted = step(waiting(), { type: 'mute' }).state;
    const spoken = step(muted, { type: 'reply-content' });
    expect(spoken.state.phase).toBe('speaking');
    expect(spoken.state.replyPlaying).toBe(true);
    expect(spoken.effects).toEqual([{ kind: 'speak-reply' }]);

    const done = step(spoken.state, { type: 'speechFinished' });
    expect(done.state.phase).toBe('muted');
    expect(done.state.resumePhase).toBe('listening');
    expect(done.state.muteIntent).toBeUndefined();
    expect(done.effects).toEqual([{ kind: 'stop-speaking' }]);
    expect(done.effects.some((effect) => effect.kind === 'start-listening')).toBe(false);

    // Unmute from there is the ordinary listening mute.
    const back = step(done.state, { type: 'unmute' });
    expect(back.state.phase).toBe('listening');
    expect(back.effects).toEqual([{ kind: 'set-muted', muted: false }, { kind: 'start-listening' }]);
  });

  test('a barge-in while muted reopens nothing, and unmute listens', () => {
    const muted = step(waiting(), { type: 'mute' }).state;
    const spoken = step(muted, { type: 'reply-content' }).state;
    const barged = step(spoken, { type: 'bargeIn' });
    expect(barged.state.phase).toBe('muted');
    expect(barged.state.replyPlaying).toBe(false);
    expect(barged.effects).toEqual([{ kind: 'stop-speaking' }]);
    expect(step(barged.state, { type: 'unmute' }).state.phase).toBe('listening');
  });

  test('a reply that fails while muted leaves the call muted, not listening', () => {
    const muted = step(waiting(), { type: 'mute' }).state;
    const failed = step(muted, { type: 'reply-failed' });
    expect(failed.state.phase).toBe('muted');
    expect(failed.effects).toEqual([{ kind: 'stop-speaking' }]);
    expect(failed.effects.some((effect) => effect.kind === 'start-listening')).toBe(false);
  });

  test('a send failure while muted still ends the call with the words recoverable', () => {
    const sending = step(listening(), { type: 'final', text: 'hi' }).state;
    const busy = step(step(sending, { type: 'grace-elapsed' }).state, { type: 'mute' }).state;
    const out = step(busy, { type: 'send-busy' });
    expect(out.state.phase).toBe('ending');
    expect(out.state.reason).toBe('send-failed');
    expect(out.state.muteIntent).toBeUndefined();
  });

  test('a mute taken while sending is honoured by the phase it lands in', () => {
    const sending = step(listening(), { type: 'final', text: 'hi' }).state;
    const sent = step(sending, { type: 'grace-elapsed' }).state;
    const muted = step(sent, { type: 'mute' }).state;
    const arrived = step(muted, { type: 'reply-appeared' }).state;
    const spoken = step(arrived, { type: 'reply-content' }).state;
    const done = step(spoken, { type: 'speechFinished' });
    expect(done.state.phase).toBe('muted');
    expect(done.effects.some((effect) => effect.kind === 'start-listening')).toBe(false);
  });

  // Reaching `muted` has honoured the intent, so the operator lifting the mute
  // must hand the microphone back for good. A surviving intent would end the
  // NEXT turn in `muted` too, with the microphone already unmuted — a call that
  // goes deaf because of a mute that was undone.
  test('unmuting from the mute the intent earned clears it for the next turn', () => {
    const muted = step(waiting(), { type: 'mute' }).state;
    const speaking = step(muted, { type: 'reply-content' }).state;
    // A second tap, this time while the reply is being read aloud, takes the
    // phase to `muted` on its own — and the in-flight intent is still on the state.
    const again = step(speaking, { type: 'mute' }).state;
    expect(again.phase).toBe('muted');
    expect(again.muteIntent).toBe(true);

    const finished = step(again, { type: 'speechFinished' }).state;
    expect(finished.replyPlaying).toBe(false);
    const back = step(finished, { type: 'unmute' });
    expect(back.state.phase).toBe('listening');
    expect(back.state.muteIntent).toBeUndefined();

    // The next turn is spoken and then reopens the microphone, as any other does.
    const next = reduce(
      back.state,
      [{ type: 'final', text: 'again' }, { type: 'grace-elapsed' }, { type: 'reply-appeared' }, { type: 'reply-content' }, { type: 'speechFinished' }],
    );
    expect(next.state.phase).toBe('listening');
    expect(next.effects).toContainEqual({ kind: 'start-listening' });
  });
});

describe('the phases that already took a mute are unchanged', () => {
  test('mute from listening still drops straight into muted', () => {
    const out = step(listening(), { type: 'mute' });
    expect(out.state.phase).toBe('muted');
    expect(out.state.resumePhase).toBe('listening');
    expect(out.state.muteIntent).toBeUndefined();
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: true }]);
  });

  test('mute while speaking still lets the reply finish and returns to speaking', () => {
    const out = step(speaking(), { type: 'mute' });
    expect(out.state.phase).toBe('muted');
    expect(out.state.resumePhase).toBe('speaking');
    expect(out.state.replyPlaying).toBe(true);
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: true }]);
    expect(step(out.state, { type: 'unmute' }).state.phase).toBe('speaking');
  });

  // The mute tapped in `waiting` lands in `speaking`, still owed on the state,
  // and the banner reads Unmute for the whole of the reply. A control that says
  // Unmute and waits for the reply to end is the gap this closes: the intent is
  // lifted and the microphone handed back, while the reply finishes being spoken.
  test('unmute while a mute taken mid-turn is still pending takes effect at once', () => {
    const muted = step(waiting(), { type: 'mute' }).state;
    const spoken = step(muted, { type: 'reply-content' }).state;
    expect(spoken.muteIntent).toBe(true);

    const out = step(spoken, { type: 'unmute' });
    expect(out.state.phase).toBe('speaking');
    expect(out.state.muteIntent).toBeUndefined();
    // The reply is still playing, so nothing is stopped and the microphone goes
    // back — the same effect the `muted` → `speaking` unmute emits.
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: false }]);
    expect(out.state.replyPlaying).toBe(true);

    // And the turn ends the way a turn with no mute in it always does.
    const done = step(out.state, { type: 'speechFinished' });
    expect(done.state.phase).toBe('listening');
    expect(done.effects).toEqual([{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
  });

  test('unmute with no pending intent while speaking changes nothing', () => {
    const live = speaking();
    const out = step(live, { type: 'unmute' });
    expect(out.state).toBe(live);
    expect(out.effects).toEqual([]);
  });

  test('mute while confirming still cancels the armed grace send', () => {
    const confirming = step(listening(), { type: 'final', text: 'book a' }).state;
    const out = step(confirming, { type: 'mute' });
    expect(out.state.phase).toBe('muted');
    expect(out.state.held).toBe('');
    expect(out.effects).toEqual([{ kind: 'cancel-grace' }, { kind: 'set-muted', muted: true }]);
  });

  test('a turn with no mute in it reopens listening exactly as before', () => {
    const done = reduce(waiting(), [{ type: 'reply-content' }, { type: 'speechFinished' }]);
    expect(done.state.phase).toBe('listening');
    expect(done.state.muteIntent).toBeUndefined();
    expect(done.effects).toEqual([{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
  });

  test('mute is inert in a phase that has no microphone to mute', () => {
    for (const phase of ['idle', 'starting', 'ending', 'ended'] as const) {
      const from = { ...INITIAL_HANDSFREE_SESSION, phase };
      const out = step(from, { type: 'mute' });
      expect(out.state).toBe(from);
      expect(out.effects).toEqual([]);
    }
  });
});

// An end the platform asks for on its own. `app-killed` is what the foreground
// service reports when it dies under a live JS runtime; until the reason was
// carried into the terminal state the sentence explaining it was dead code and
// the call kept its audio.
describe('endRequested carries the reason the platform gives it', () => {
  test('the notification End is still the operator’s own', () => {
    const out = step(listening(), { type: 'endRequested' });
    expect(out.state.phase).toBe('ending');
    expect(out.state.reason).toBe('user');
    expect(out.effects).toEqual([{ kind: 'stop-session' }]);
  });

  test('a service that died under a live runtime ends as app-killed', () => {
    const out = step(speaking(), { type: 'endRequested', reason: 'app-killed' });
    expect(out.state.phase).toBe('ending');
    expect(out.state.reason).toBe('app-killed');
    // The same terminal path as any other end: the session is stopped, which is
    // what releases the call's audio.
    expect(out.effects).toEqual([{ kind: 'stop-session' }]);

    // And the finished call remembers why, which is what the screen names.
    const over = step(out.state, { type: 'stopped' }).state;
    expect(over.phase).toBe('idle');
    expect(over.callsEnded).toBe(1);
    expect(over.lastEndReason).toBe('app-killed');
    expect(handsfreeEndReasonCopy(over.lastEndReason!)).toBe(
      'The call ended when Versutus was closed.',
    );
  });

  test('the reason is terminal from every live phase, like any end', () => {
    for (const phase of ['starting', 'listening', 'confirming', 'sending', 'waiting', 'speaking', 'muted'] as const) {
      const from: HandsfreeSessionState = { ...listening(), phase };
      const out = step(from, { type: 'endRequested', reason: 'app-killed' });
      expect(out.state.phase).toBe('ending');
      expect(out.state.reason).toBe('app-killed');
    }
  });

  test('every terminal reason the copy module names is reachable from a live call', () => {
    const sending = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
    ]).state;
    const terminal: [HandsfreeEvent, string][] = [
      [{ type: 'end' }, 'user'],
      [{ type: 'endRequested' }, 'user'],
      [{ type: 'endRequested', reason: 'app-killed' }, 'app-killed'],
      [{ type: 'disconnect' }, 'disconnect'],
      [{ type: 'thread-changed' }, 'thread-changed'],
      [{ type: 'interruption' }, 'system-interruption'],
      [{ type: 'fatalError', reason: 'recognition-failed' }, 'recognition-failed'],
      [{ type: 'fatalError', reason: 'speech-failed' }, 'speech-failed'],
      [{ type: 'send-failed' }, 'send-failed'],
    ];
    const reached = new Set<string>();
    for (const [event, reason] of terminal) {
      const out = step(sending, event);
      expect(out.state.reason).toBe(reason);
      reached.add(reason);
    }
    // Nothing the copy module has a sentence for is unreachable any more.
    for (const copy of [
      'disconnect',
      'system-interruption',
      'app-killed',
      'recognition-failed',
      'send-failed',
      'speech-failed',
    ] as const) {
      expect(reached.has(copy)).toBe(true);
      expect(handsfreeEndReasonCopy(copy)).toBeTruthy();
    }
  });
});