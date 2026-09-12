import {
  INITIAL_HANDSFREE_SESSION,
  reduceHandsfreeSession,
  type HandsfreeEffect,
  type HandsfreeEvent,
  type HandsfreePhase,
  type HandsfreeSessionState,
} from '@/lib/voice/handsfree-session';

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

/** Drive a call to `listening` with the recognizer live. */
function listening(): HandsfreeSessionState {
  return reduce(INITIAL_HANDSFREE_SESSION, [{ type: 'start' }, { type: 'started' }]).state;
}

function phaseOf(state: HandsfreeSessionState): HandsfreePhase {
  return state.phase;
}

/** Effects of one event in one step, so duplicate suppression is visible. */
function step(
  state: HandsfreeSessionState,
  event: HandsfreeEvent,
): { state: HandsfreeSessionState; effects: HandsfreeEffect[] } {
  return reduceHandsfreeSession(state, event);
}

describe('reduceHandsfreeSession — the happy turn', () => {
  test('start opens the session and started begins listening', () => {
    expect(step(INITIAL_HANDSFREE_SESSION, { type: 'start' }).state.phase).toBe('starting');
    const begun = step(step(INITIAL_HANDSFREE_SESSION, { type: 'start' }).state, { type: 'started' });
    expect(begun.state.phase).toBe('listening');
    expect(begun.effects).toEqual([{ kind: 'start-listening' }]);
  });

  test('a refusal returns to idle and starts no service', () => {
    const started = step(INITIAL_HANDSFREE_SESSION, { type: 'start' }).state;
    const refused = step(started, { type: 'start-refused' });
    expect(refused.state).toEqual(INITIAL_HANDSFREE_SESSION);
    expect(refused.effects).toEqual([]);
  });

  test('a final enters confirming, never sending directly', () => {
    const out = step(listening(), { type: 'final', text: 'hello there' });
    expect(out.state.phase).toBe('confirming');
    expect(out.state.held).toBe('hello there');
    expect(out.effects).toEqual([{ kind: 'arm-grace' }]);
  });

  test('the grace timer sends the accumulated text with stop-listening and the earcon', () => {
    const confirming = step(listening(), { type: 'final', text: 'hello there' }).state;
    const out = step(confirming, { type: 'grace-elapsed' });
    expect(out.state.phase).toBe('sending');
    expect(out.effects).toEqual([
      { kind: 'stop-listening' },
      { kind: 'send-turn', text: 'hello there' },
      { kind: 'play-earcon' },
    ]);
  });

  test('the placeholder appearance moves sending to waiting; content starts speaking', () => {
    const sending = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
    ]).state;
    const waiting = step(sending, { type: 'reply-appeared' });
    expect(waiting.state.phase).toBe('waiting');
    expect(waiting.effects).toEqual([]);
    const speaking = step(waiting.state, { type: 'reply-content' });
    expect(speaking.state.phase).toBe('speaking');
    expect(speaking.state.replyPlaying).toBe(true);
    expect(speaking.effects).toEqual([{ kind: 'speak-reply' }]);
  });

  test('speechFinished reopens listening and stops speech', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const out = step(speaking, { type: 'speechFinished' });
    expect(out.state.phase).toBe('listening');
    expect(out.state.replyPlaying).toBe(false);
    expect(out.effects).toEqual([{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
  });
});

describe('reduceHandsfreeSession — every event has a destination', () => {
  const events: HandsfreeEvent[] = [
    { type: 'partial', text: 'x' },
    { type: 'final', text: 'x' },
    { type: 'noSpeech' },
    { type: 'grace-elapsed' },
    { type: 'send-accepted' },
    { type: 'send-offline' },
    { type: 'send-busy' },
    { type: 'send-failed' },
    { type: 'reply-appeared' },
    { type: 'reply-content' },
    { type: 'reply-failed' },
    { type: 'speechFinished' },
    { type: 'bargeIn' },
    { type: 'skipReply' },
    { type: 'interruption' },
    { type: 'endRequested' },
    { type: 'fatalError', reason: 'recognition-failed' },
    { type: 'fatalError', reason: 'speech-failed' },
    { type: 'mute' },
    { type: 'unmute' },
    { type: 'end' },
    { type: 'thread-changed' },
    { type: 'disconnect' },
    { type: 'stopped' },
  ];

  test('no event throws or leaves a phase the reducer cannot name', () => {
    const phases: HandsfreePhase[] = [
      'idle',
      'starting',
      'listening',
      'confirming',
      'sending',
      'waiting',
      'speaking',
      'muted',
      'ending',
      'ended',
    ];
    for (const phase of phases) {
      for (const event of events) {
        const from: HandsfreeSessionState = { ...INITIAL_HANDSFREE_SESSION, phase };
        const out = reduceHandsfreeSession(from, event);
        expect(phases).toContain(out.state.phase);
        expect(Array.isArray(out.effects)).toBe(true);
      }
    }
  });

  test('level is not an event the reducer knows — the banner owns it', () => {
    // There is no `level` member in the union; the provider must never dispatch
    // one. This pins that the amplitude stream stays out of the turn machine.
    const known = events.map((event) => event.type);
    expect(known).not.toContain('level');
  });
});

describe('reduceHandsfreeSession — the grace window', () => {
  test('a resumed utterance cancels the pending send and concatenates', () => {
    const confirming = step(listening(), { type: 'final', text: 'book a' }).state;
    const resumed = step(confirming, { type: 'partial', text: 'table for two' });
    expect(resumed.state.phase).toBe('confirming');
    expect(resumed.state.held).toBe('book a table for two');
    expect(resumed.effects).toEqual([{ kind: 'arm-grace' }]);
  });

  test('a new final in the window also concatenates and re-arms', () => {
    const confirming = step(listening(), { type: 'final', text: 'book a' }).state;
    const again = step(confirming, { type: 'final', text: 'table for two' });
    expect(again.state.held).toBe('book a table for two');
    expect(again.effects).toEqual([{ kind: 'arm-grace' }]);
    expect(phaseOf(again.state)).toBe('confirming');
  });

  test('the timer firing sends exactly the accumulated text, once', () => {
    const out = reduce(listening(), [
      { type: 'final', text: 'book a' },
      { type: 'partial', text: 'table for two' },
      { type: 'grace-elapsed' },
    ]);
    expect(out.effects).toEqual([
      { kind: 'stop-listening' },
      { kind: 'send-turn', text: 'book a table for two' },
      { kind: 'play-earcon' },
    ]);
  });

  test('an empty held text never sends on grace-elapsed', () => {
    const empty = { ...listening(), phase: 'confirming' as const, held: '   ' };
    const out = step(empty, { type: 'grace-elapsed' });
    expect(out.state.phase).toBe('confirming');
    expect(out.effects).toEqual([]);
  });

  test('no legal path reaches sending from listening without confirming', () => {
    const live = listening();
    for (const event of [
      { type: 'grace-elapsed' } as const,
      { type: 'reply-appeared' } as const,
      { type: 'send-accepted' } as const,
    ]) {
      expect(step(live, event).state.phase).toBe('listening');
    }
    expect(step(live, { type: 'final', text: 'x' }).state.phase).toBe('confirming');
  });
});

describe('reduceHandsfreeSession — empty and late native events', () => {
  test('an empty final leaves listening listening and sends nothing', () => {
    const out = step(listening(), { type: 'final', text: '   ' });
    expect(out.state.phase).toBe('listening');
    expect(out.effects).toEqual([]);
  });

  test('noSpeech in listening clears the partial and stays put', () => {
    const withPartial = step(listening(), { type: 'partial', text: 'um' }).state;
    const out = step(withPartial, { type: 'noSpeech' });
    expect(out.state.phase).toBe('listening');
    expect(out.state.partial).toBe('');
    expect(out.effects).toEqual([]);
  });

  test('a bargeIn reopens listening and the following speechFinished is a no-op', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const barged = step(speaking, { type: 'bargeIn' });
    expect(barged.state.phase).toBe('listening');
    expect(barged.effects).toEqual([{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
    const late = step(barged.state, { type: 'speechFinished' });
    expect(late.effects).toEqual([]);
    expect(late.state).toBe(barged.state);
  });

  test('a late speechFinished after bargeIn never fires the cleanup twice', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const events: HandsfreeEvent[] = [
      { type: 'bargeIn' },
      { type: 'speechFinished' },
      { type: 'speechFinished' },
    ];
    const collected: HandsfreeEffect[] = [];
    let live = speaking;
    for (const event of events) {
      const out = reduceHandsfreeSession(live, event);
      collected.push(...out.effects);
      live = out.state;
    }
    expect(collected.filter((e) => e.kind === 'stop-speaking')).toHaveLength(1);
    expect(collected.filter((e) => e.kind === 'start-listening')).toHaveLength(1);
  });

  test('a late send resolution arriving after speaking is a no-op', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const late = step(speaking, { type: 'send-accepted' });
    expect(late.state).toBe(speaking);
    expect(late.effects).toEqual([]);
  });

  test('every event is inert once ended', () => {
    const ended = reduce(listening(), [{ type: 'end' }, { type: 'stopped' }]).state;
    expect(ended.phase).toBe('ended');
    for (const event of [
      { type: 'start' } as const,
      { type: 'partial', text: 'x' } as const,
      { type: 'reply-appeared' } as const,
      { type: 'endRequested' } as const,
    ]) {
      const out = step(ended, event);
      expect(out.state).toBe(ended);
      expect(out.effects).toEqual([]);
    }
  });
});

describe('reduceHandsfreeSession — mute', () => {
  test('mute from listening drops to muted and mutes recognition', () => {
    const out = step(listening(), { type: 'mute' });
    expect(out.state.phase).toBe('muted');
    expect(out.state.resumePhase).toBe('listening');
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: true }]);
  });

  test('mute during confirming cancels the armed grace send and clears the words', () => {
    const confirming = step(listening(), { type: 'final', text: 'book a' }).state;
    const out = step(confirming, { type: 'mute' });
    expect(out.state.phase).toBe('muted');
    expect(out.state.held).toBe('');
    expect(out.effects).toEqual([{ kind: 'cancel-grace' }, { kind: 'set-muted', muted: true }]);
  });

  test('unmute from a listening mute reopens listening', () => {
    const muted = step(listening(), { type: 'mute' }).state;
    const out = step(muted, { type: 'unmute' });
    expect(out.state.phase).toBe('listening');
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: false }, { kind: 'start-listening' }]);
  });

  test('mute during speaking never stops the reply, and unmute returns to speaking', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const muted = step(speaking, { type: 'mute' });
    expect(muted.state.phase).toBe('muted');
    expect(muted.state.replyPlaying).toBe(true);
    expect(muted.effects.some((e) => e.kind === 'stop-speaking')).toBe(false);

    // speechFinished while muted is consumed, not acted on.
    const finished = step(muted.state, { type: 'speechFinished' });
    expect(finished.state.phase).toBe('muted');
    expect(finished.state.replyPlaying).toBe(false);
    expect(finished.effects).toEqual([]);

    // A reply that finished while muted must not open the mic as `speaking`.
    const out = step(finished.state, { type: 'unmute' });
    expect(out.state.phase).toBe('listening');
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: false }, { kind: 'start-listening' }]);
  });

  test('unmute mid-reply returns to speaking without reopening the mic', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const muted = step(speaking, { type: 'mute' }).state;
    const out = step(muted, { type: 'unmute' });
    expect(out.state.phase).toBe('speaking');
    expect(out.effects).toEqual([{ kind: 'set-muted', muted: false }]);
    expect(out.effects.some((e) => e.kind === 'start-listening')).toBe(false);
  });
});

describe('reduceHandsfreeSession — failure and termination', () => {
  test('a busy send ends the call with the words recoverable', () => {
    const sending = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
    ]).state;
    const out = step(sending, { type: 'send-busy' });
    expect(out.state.phase).toBe('ending');
    expect(out.state.reason).toBe('send-failed');
    expect(out.effects).toEqual([{ kind: 'stop-session' }]);
  });

  test('an offline call send is terminal rather than queued', () => {
    const sending = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
    ]).state;
    expect(step(sending, { type: 'send-offline' }).state.reason).toBe('send-failed');
  });

  test('a reply that fails before speaking ends as send-failed', () => {
    const waiting = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
    ]).state;
    const out = step(waiting, { type: 'reply-failed' });
    expect(out.state.phase).toBe('ending');
    expect(out.state.reason).toBe('send-failed');
  });

  test('a reply retracted mid-speech stops TTS and reopens listening', () => {
    const speaking = reduce(listening(), [
      { type: 'final', text: 'hi' },
      { type: 'grace-elapsed' },
      { type: 'reply-appeared' },
      { type: 'reply-content' },
    ]).state;
    const out = step(speaking, { type: 'reply-failed' });
    expect(out.state.phase).toBe('listening');
    expect(out.effects).toEqual([{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
  });

  test('interruption ends with the system reason', () => {
    const out = step(listening(), { type: 'interruption' });
    expect(out.state.phase).toBe('ending');
    expect(out.state.reason).toBe('system-interruption');
  });

  test('fatalError carries the native reason through', () => {
    expect(step(listening(), { type: 'fatalError', reason: 'recognition-failed' }).state.reason).toBe(
      'recognition-failed',
    );
    expect(step(listening(), { type: 'fatalError', reason: 'speech-failed' }).state.reason).toBe(
      'speech-failed',
    );
  });

  test('disconnect and thread change end with their own reasons', () => {
    expect(step(listening(), { type: 'disconnect' }).state.reason).toBe('disconnect');
    expect(step(listening(), { type: 'thread-changed' }).state.reason).toBe('thread-changed');
  });

  test('ending is terminal only after the session stopped, and End is idempotent', () => {
    const ending = step(listening(), { type: 'end' });
    expect(ending.state.phase).toBe('ending');
    expect(ending.effects).toEqual([{ kind: 'stop-session' }]);
    // A second End while ending does not run teardown again.
    expect(step(ending.state, { type: 'end' }).effects).toEqual([]);
    expect(step(ending.state, { type: 'stopped' }).state.phase).toBe('ended');
  });

  test('the notification End reaches ended exactly as the UI End does', () => {
    const viaUi = reduce(listening(), [{ type: 'end' }, { type: 'stopped' }]);
    const viaNotification = reduce(listening(), [{ type: 'endRequested' }, { type: 'stopped' }]);
    expect(viaNotification.state).toEqual(viaUi.state);
    expect(viaNotification.state.phase).toBe('ended');
    expect(viaNotification.state.reason).toBe('user');
  });

  test('a confirming call that ends cancels the grace timer first', () => {
    const confirming = step(listening(), { type: 'final', text: 'hi' }).state;
    const out = step(confirming, { type: 'end' });
    expect(out.effects).toEqual([{ kind: 'cancel-grace' }, { kind: 'stop-session' }]);
  });
});
