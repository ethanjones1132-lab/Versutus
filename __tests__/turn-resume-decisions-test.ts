// The pure half of re-attaching to a turn the PC is still running.
//
// A turn belongs to the Gate: it keeps running while the phone is locked, the
// app is killed, or the connection drops. Every one of those returns lands on
// one of these decisions, so each case here is a way the phone used to get the
// thread wrong (design spec §4.2, §4.3).

import {
  decideTurnResume,
  turnResumeBackoffMs,
  TURN_RESUME_BACKOFF_MS,
} from '@/lib/gateway/turn-resume';
import { interruptedTurnCopy } from '@/lib/gateway/interrupted-copy';
import { turnFromMeta, turnSettlement, turnsFromListEnvelope, type TurnMeta } from '@/lib/gateway/turns';

function turn(overrides: Partial<TurnMeta> = {}): TurnMeta {
  return { turnId: 'turn-1', status: 'running', ...overrides };
}

describe('a running turn this process is not streaming is followed', () => {
  test('attached from the start, because a bubble that has seen nothing needs the whole replay', () => {
    const action = decideTurnResume({ turn: turn() });
    expect(action).toEqual({ kind: 'attach', turnId: 'turn-1', after: 0 });
  });

  test('and from the last seq THIS PROCESS rendered, never the journal lastSeq', () => {
    // The journal's own lastSeq is where the GATE got to. A process that has
    // rendered none of the turn must still be sent all of it, or the bubble it
    // rebuilds comes out empty.
    const action = decideTurnResume({
      turn: turn({ lastSeq: 42 }),
      lastSeqByTurnId: {},
    });
    expect(action).toEqual({ kind: 'attach', turnId: 'turn-1', after: 0 });
  });

  test('a dropped stream picks up after the seq it had already shown', () => {
    const action = decideTurnResume({
      turn: turn({ lastSeq: 42 }),
      lastSeqByTurnId: { 'turn-1': 17 },
    });
    expect(action).toEqual({ kind: 'attach', turnId: 'turn-1', after: 17 });
  });

  test('a turn already being streamed is left alone — a second subscriber duplicates every delta', () => {
    const action = decideTurnResume({ turn: turn(), streamingTurnIds: ['turn-1'] });
    expect(action).toEqual({ kind: 'nothing', turnId: 'turn-1' });
  });
});

describe('a turn that has ended is settled by identity', () => {
  test('done carries the reply the journal assembled', () => {
    const action = decideTurnResume({
      turn: turn({ status: 'done', text: 'The answer is 42.' }),
    });
    expect(action).toEqual({
      kind: 'settle',
      turnId: 'turn-1',
      settlement: { kind: 'done', text: 'The answer is 42.' },
    });
  });

  test('failed carries the turn\'s own error, not a generic one', () => {
    const action = decideTurnResume({
      turn: turn({ status: 'failed', error: 'hermes: 500 upstream refused' }),
    });
    expect(action).toEqual({
      kind: 'settle',
      turnId: 'turn-1',
      settlement: { kind: 'failed', message: 'hermes: 500 upstream refused' },
    });
  });

  test('a failed turn with no error text still says something', () => {
    const settlement = turnSettlement(turn({ status: 'failed' }));
    expect(settlement).toEqual({ kind: 'failed', message: 'The turn failed on your PC.' });
  });

  test('cancelled is the operator\'s stop, not a failure', () => {
    expect(decideTurnResume({ turn: turn({ status: 'cancelled' }) })).toEqual({
      kind: 'settle',
      turnId: 'turn-1',
      settlement: { kind: 'cancelled' },
    });
  });

  test('running is never a settlement: the turn is still the Gate\'s', () => {
    expect(turnSettlement(turn({ status: 'running' }))).toEqual({ kind: 'running' });
  });

  test('a status this build does not know is left alone rather than guessed into a finish', () => {
    const action = decideTurnResume({ turn: turn({ status: 'unknown' }) });
    expect(action).toEqual({ kind: 'nothing', turnId: 'turn-1' });
  });
});

describe('an interrupted turn says why, by the reason the Gate recorded', () => {
  test('a Gate restart names the restart', () => {
    const settlement = turnSettlement(turn({ status: 'interrupted', reason: 'gate_restart' }));
    expect(settlement).toEqual({
      kind: 'interrupted',
      reason: 'gate_restart',
      copy: 'The Gate restarted while this was running.',
    });
  });

  test('a stall and a ceiling read as the PC stopping the turn, and say so', () => {
    for (const reason of ['stalled', 'max_age']) {
      const settlement = turnSettlement(turn({ status: 'interrupted', reason }));
      expect(settlement).toEqual({
        kind: 'interrupted',
        reason,
        copy: 'The PC stopped this turn: it made no progress for a long time.',
      });
    }
  });

  test('a reason this build does not know still says the turn was cut short', () => {
    const settlement = turnSettlement(turn({ status: 'interrupted', reason: 'meteor' }));
    expect(settlement).toEqual({
      kind: 'interrupted',
      reason: 'unknown',
      copy: 'The PC stopped this turn before it finished.',
    });
  });

  test('no reason at all is still not a finished reply', () => {
    expect(turnSettlement(turn({ status: 'interrupted' }))).toEqual({
      kind: 'interrupted',
      reason: 'unknown',
      copy: 'The PC stopped this turn before it finished.',
    });
  });

  test('the copy is never a claim of completion', () => {
    for (const reason of ['gate_restart', 'stalled', 'max_age', undefined]) {
      expect(interruptedTurnCopy(reason)).not.toMatch(/\b(done|complete|completed|success)\b/i);
    }
  });
});

describe('the resume stands down when the thread it was armed for is gone', () => {
  test('a superseded resume does not attach to anything', () => {
    expect(decideTurnResume({ turn: turn(), stillCurrent: false })).toEqual({
      kind: 'stand-down',
      reason: 'thread-changed',
    });
  });

  test('a turn belonging to another thread is not this one\'s business', () => {
    const action = decideTurnResume({
      turn: turn({ sessionId: 'sess-other' }),
      threadSessionId: 'sess-live',
    });
    expect(action).toEqual({ kind: 'stand-down', reason: 'other-thread' });
  });

  test('a turn of this thread is followed even when the journal omits its session', () => {
    const action = decideTurnResume({ turn: turn(), threadSessionId: 'sess-live' });
    expect(action).toEqual({ kind: 'attach', turnId: 'turn-1', after: 0 });
  });
});

describe('a thread whose session the history read has not named yet', () => {
  test('the journal read went out unfiltered, so another thread\'s turn is not this one\'s to follow', () => {
    // Nothing here can say whose turn this is: there is no session to compare
    // it against, and `listTurns` answered for every thread the Gate is running.
    const action = decideTurnResume({
      turn: turn({ sessionId: 'sess-other' }),
      threadSessionPending: true,
      localTurnIds: [],
    });
    expect(action).toEqual({ kind: 'stand-down', reason: 'other-thread' });
  });

  test('a turn this app started is followed all the same — its id is on a bubble or an outbox row', () => {
    const action = decideTurnResume({
      turn: turn({ sessionId: 'sess-other' }),
      threadSessionPending: true,
      localTurnIds: ['turn-1'],
    });
    expect(action).toEqual({ kind: 'attach', turnId: 'turn-1', after: 0 });
  });

  test('a settled turn of another thread is not settled into this one either', () => {
    const action = decideTurnResume({
      turn: turn({ status: 'done', text: 'somebody else\'s answer' }),
      threadSessionPending: true,
      localTurnIds: [],
    });
    expect(action).toEqual({ kind: 'stand-down', reason: 'other-thread' });
  });

  test('once the thread has a session, every turn of that session is followed again', () => {
    const action = decideTurnResume({
      turn: turn({ sessionId: 'sess-live' }),
      threadSessionId: 'sess-live',
      threadSessionPending: false,
      localTurnIds: [],
    });
    expect(action).toEqual({ kind: 'attach', turnId: 'turn-1', after: 0 });
  });
});

describe('the backoff has no last window', () => {
  test('it widens through the ladder and then holds at the cap', () => {
    const waits = [0, 1, 2, 3, 4, 5, 6, 20].map(turnResumeBackoffMs);
    expect(waits).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 30_000]);
  });

  test('a detached turn can run for hours, so the ladder is not bounded by the old 20s', () => {
    // The old ladder was three timers at 2/8/20s and then gave up, which is how a
    // reply that landed in minute five was never picked up.
    expect(TURN_RESUME_BACKOFF_MS[TURN_RESUME_BACKOFF_MS.length - 1]).toBeGreaterThan(20_000);
    expect(turnResumeBackoffMs(50)).toBe(30_000);
  });

  test('a nonsense attempt count still means "look again now-ish", never a stall', () => {
    expect(turnResumeBackoffMs(-3)).toBe(1_000);
    expect(turnResumeBackoffMs(Number.NaN)).toBe(1_000);
  });
});

describe('reading the journal envelope', () => {
  test('the Gate\'s { object, data } list is read, and rows without an id are dropped', () => {
    const turns = turnsFromListEnvelope({
      object: 'list',
      data: [
        { turnId: 't-1', status: 'running', sessionId: 's1' },
        { status: 'running' },
        null,
        { id: 't-2', status: 'done' },
      ],
    });
    expect(turns.map((row) => row.turnId)).toEqual(['t-1', 't-2']);
    expect(turns[0].sessionId).toBe('s1');
  });

  test('a bare array is read too, and anything else is no turns', () => {
    expect(turnsFromListEnvelope([{ turnId: 't-1', status: 'running' }])).toHaveLength(1);
    expect(turnsFromListEnvelope({ object: 'list' })).toEqual([]);
    expect(turnsFromListEnvelope('nope')).toEqual([]);
  });

  test('a record that is not a turn is not one', () => {
    expect(turnFromMeta({ status: 'running' })).toBeNull();
    expect(turnFromMeta(null)).toBeNull();
  });

  test('a status this build does not know is kept as unknown, never guessed', () => {
    expect(turnFromMeta({ turnId: 't-1', status: 'queued' })?.status).toBe('unknown');
  });
});