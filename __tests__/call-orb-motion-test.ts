// The call's light is driven by two pure functions: which of five behaviours a
// phase is, and how far a microphone level swells the orb. Both are pinned here
// without mounting anything, because "the animation does not play" was a
// numbers bug: the level of ordinary speech is a few hundredths, and drawn
// linearly that is a pixel.

import {
  CALL_ORB_CEILING_DB,
  CALL_ORB_FLOOR_DB,
  callOrbGain,
  callOrbMode,
} from '@/lib/voice/call-orb-motion';
import {
  handsfreeApprovalCopy,
  handsfreeCallClock,
  handsfreeEngineFallbackCopy,
  handsfreeEngineLine,
  handsfreePhaseHint,
  handsfreePhaseLabel,
  handsfreeTurnFailureCopy,
} from '@/lib/voice/handsfree-call-copy';

describe('which behaviour a phase is', () => {
  test('each state of a call looks different', () => {
    expect(callOrbMode('starting', false)).toBe('connecting');
    expect(callOrbMode('listening', false)).toBe('listening');
    expect(callOrbMode('confirming', false)).toBe('listening');
    expect(callOrbMode('sending', false)).toBe('thinking');
    expect(callOrbMode('waiting', false)).toBe('thinking');
    expect(callOrbMode('speaking', false)).toBe('speaking');
    expect(callOrbMode('muted', false)).toBe('muted');
  });

  test('a call that cannot hear yet is never drawn as listening', () => {
    for (const phase of ['idle', 'starting', 'ending', 'ended'] as const) {
      expect(callOrbMode(phase, false)).toBe('connecting');
    }
  });

  test('mute wins over whatever the turn is doing', () => {
    // Mute tapped while a turn is in flight: the words are still owed, but the
    // microphone is already off and the picture has to say so.
    expect(callOrbMode('sending', true)).toBe('muted');
    expect(callOrbMode('speaking', true)).toBe('muted');
    expect(callOrbMode('listening', true)).toBe('muted');
  });
});

describe('how far a voice swells the orb', () => {
  const rms = (db: number) => 10 ** (db / 20);

  test('silence and nonsense are nothing', () => {
    expect(callOrbGain(0)).toBe(0);
    expect(callOrbGain(-1)).toBe(0);
    expect(callOrbGain(Number.NaN)).toBe(0);
  });

  test('the room below the floor does not move it, and a raised voice fills it', () => {
    expect(callOrbGain(rms(CALL_ORB_FLOOR_DB - 6))).toBe(0);
    expect(callOrbGain(rms(CALL_ORB_CEILING_DB))).toBeCloseTo(1, 5);
    expect(callOrbGain(1)).toBe(1);
  });

  test('ordinary speech moves it most of the way, where the linear level moved it a pixel', () => {
    // RMS 0.05 of full scale is conversational speech at arm's length. The old
    // dot scaled by 0.55 + level × 0.45: a 2% change in radius.
    const speech = callOrbGain(0.05);
    expect(speech).toBeGreaterThan(0.6);
    expect(speech).toBeLessThan(0.75);
    // Quiet speech still registers clearly; it is not lost in the floor.
    expect(callOrbGain(0.015)).toBeGreaterThan(0.35);
  });

  test('louder is never drawn smaller', () => {
    let previous = 0;
    for (let db = -70; db <= 0; db += 2) {
      const gain = callOrbGain(rms(db));
      expect(gain).toBeGreaterThanOrEqual(previous);
      previous = gain;
    }
  });
});

describe('the words beside the light', () => {
  test('a state is named for what the person on the call is waiting for', () => {
    expect(handsfreePhaseLabel('starting')).toBe('Connecting');
    expect(handsfreePhaseLabel('listening')).toBe('Listening');
    expect(handsfreePhaseLabel('confirming')).toBe('Listening');
    expect(handsfreePhaseLabel('sending')).toBe('Thinking');
    expect(handsfreePhaseLabel('waiting')).toBe('Thinking');
    expect(handsfreePhaseLabel('speaking')).toBe('Speaking');
    expect(handsfreePhaseLabel('muted')).toBe('Muted');
  });

  test('the call clock counts from the first second', () => {
    expect(handsfreeCallClock(undefined, 5_000)).toBeNull();
    expect(handsfreeCallClock(1_000, 1_000)).toBe('0:00');
    expect(handsfreeCallClock(1_000, 8_400)).toBe('0:07');
    expect(handsfreeCallClock(0, 12 * 60_000 + 40_000)).toBe('12:40');
    expect(handsfreeCallClock(0, 3_600_000 + 2 * 60_000 + 5_000)).toBe('1:02:05');
    // A clock that ran backwards (a changed system time) shows zero, not a minus.
    expect(handsfreeCallClock(10_000, 4_000)).toBe('0:00');
  });

  test('the engine is named in the operator’s words, with a fallback’s reason beside it', () => {
    expect(handsfreeEngineLine('local')).toBe('voice on this PC');
    expect(handsfreeEngineLine('something-new')).toBeNull();
    expect(handsfreeEngineFallbackCopy('local', '  ')).toBeNull();
    expect(handsfreeEngineFallbackCopy('codex', 'not signed in')).toBe(
      'Voice is through ChatGPT: not signed in.',
    );
    expect(handsfreeEngineFallbackCopy('something-new', 'whatever')).toBeNull();
  });

  test('the hint is a line of its own, so the state above it is never cut short', () => {
    expect(handsfreePhaseHint('speaking')).toBe('Say something to interrupt.');
    expect(handsfreePhaseHint('confirming')).toBe('Finishing what you said…');
    expect(handsfreePhaseHint('listening')).toBeNull();
    expect(handsfreePhaseHint('sending')).toBeNull();
  });

  test('a failed turn is told in the Gate’s sentence, or in one built around a fragment', () => {
    expect(handsfreeTurnFailureCopy(null)).toBeNull();
    expect(handsfreeTurnFailureCopy('   ')).toBeNull();
    expect(handsfreeTurnFailureCopy('Claude Code stopped before it answered.')).toBe(
      'Claude Code stopped before it answered.',
    );
    expect(handsfreeTurnFailureCopy('backend_error')).toBe('That turn could not be completed: backend_error.');
  });

  test('an approval says what is needed, then what was decided', () => {
    expect(handsfreeApprovalCopy(null)).toBeNull();
    expect(handsfreeApprovalCopy({ summary: ' ' })).toBeNull();
    expect(handsfreeApprovalCopy({ summary: 'Run ls?' })).toBe('Needs your approval: Run ls?');
    expect(handsfreeApprovalCopy({ summary: 'Run ls?', state: 'pending' })).toBe('Needs your approval: Run ls?');
    expect(handsfreeApprovalCopy({ summary: 'Run ls?', state: 'approved' })).toBe('Approved once: Run ls?');
    expect(handsfreeApprovalCopy({ summary: 'Run ls?', state: 'denied' })).toBe('Denied: Run ls?');
    expect(handsfreeApprovalCopy({ summary: 'Run ls?', state: 'expired' })).toBe('Not approved in time: Run ls?');
  });
});
