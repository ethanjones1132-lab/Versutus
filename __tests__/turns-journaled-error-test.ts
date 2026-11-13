// The failure a restored turn says it hit.
//
// A turn belongs to the Gate, so a phone that reconnects reads its outcome from
// the journal rather than the stream it lost. The current Gate journals that
// failure as `error: { message, code }`; older journals wrote a bare string.
// Both shapes must reach the settled turn intact, because the generic copy is
// only the last resort when the record names neither.

import { decideTurnResume } from '@/lib/gateway/turn-resume';
import { turnFromMeta, turnSettlement } from '@/lib/gateway/turns';

const GENERIC = 'The turn failed on your PC.';

describe('reading the journaled error', () => {
  test('the current { message, code } shape keeps both fields', () => {
    const turn = turnFromMeta({
      turnId: 'turn-1',
      status: 'failed',
      error: { message: 'upstream refused the turn', code: 'backend_error' },
    });
    expect(turn?.error).toBe('upstream refused the turn');
    expect(turn?.errorCode).toBe('backend_error');
  });

  test('an older string-only journal still reads as the message', () => {
    const turn = turnFromMeta({
      turnId: 'turn-1',
      status: 'failed',
      error: 'hermes: 500 upstream refused',
    });
    expect(turn?.error).toBe('hermes: 500 upstream refused');
    expect(turn?.errorCode).toBeUndefined();
  });

  test('a code with no message is kept, and the message stays absent', () => {
    const turn = turnFromMeta({
      turnId: 'turn-1',
      status: 'failed',
      error: { code: 'rate_limited' },
    });
    expect(turn?.error).toBeUndefined();
    expect(turn?.errorCode).toBe('rate_limited');
  });

  test('fields that name nothing are dropped rather than stored blank', () => {
    const turn = turnFromMeta({
      turnId: 'turn-1',
      status: 'failed',
      error: { message: '   ', code: '  ' },
    });
    expect(turn?.error).toBeUndefined();
    expect(turn?.errorCode).toBeUndefined();
  });

  test('a malformed error object is not guessed into a failure', () => {
    const turn = turnFromMeta({
      turnId: 'turn-1',
      status: 'failed',
      error: { message: 42, code: 17 },
    });
    expect(turn?.error).toBeUndefined();
    expect(turn?.errorCode).toBeUndefined();
  });

  test('an empty or null journal error names nothing, exactly as before', () => {
    expect(turnFromMeta({ turnId: 'turn-1', status: 'failed', error: '' })?.error).toBeUndefined();
    expect(turnFromMeta({ turnId: 'turn-1', status: 'failed', error: null })?.error).toBeUndefined();
    expect(turnFromMeta({ turnId: 'turn-1', status: 'failed', error: 42 })?.error).toBeUndefined();
  });
});

describe('settling a failed turn says what actually failed', () => {
  test('the message and code both reach the caller', () => {
    const settlement = turnSettlement({
      turnId: 'turn-1',
      status: 'failed',
      error: 'upstream refused the turn',
      errorCode: 'backend_error',
    });
    expect(settlement).toStrictEqual({
      kind: 'failed',
      message: 'upstream refused the turn',
      code: 'backend_error',
    });
  });

  test('a journal record settles with its own message and code end to end', () => {
    const settlement = turnSettlement(
      turnFromMeta({
        turnId: 'turn-1',
        status: 'failed',
        error: { message: 'provider quota exhausted', code: 'rate_limited' },
      })!,
    );
    expect(settlement).toStrictEqual({
      kind: 'failed',
      message: 'provider quota exhausted',
      code: 'rate_limited',
    });
  });

  test('the old string-only shape keeps its shape, with no invented code', () => {
    const settlement = turnSettlement({
      turnId: 'turn-1',
      status: 'failed',
      error: 'hermes: 500 upstream refused',
    });
    expect(settlement).toStrictEqual({
      kind: 'failed',
      message: 'hermes: 500 upstream refused',
    });
  });

  test('the generic copy is the fallback when neither field is present', () => {
    expect(turnSettlement({ turnId: 'turn-1', status: 'failed' })).toStrictEqual({
      kind: 'failed',
      message: GENERIC,
    });
  });

  test('a code with no message still says the code, over the generic copy', () => {
    const settlement = turnSettlement({
      turnId: 'turn-1',
      status: 'failed',
      errorCode: 'backend_error',
    });
    expect(settlement).toStrictEqual({
      kind: 'failed',
      message: GENERIC,
      code: 'backend_error',
    });
  });

  test('a blank message falls back to the generic copy but keeps the code', () => {
    const settlement = turnSettlement({
      turnId: 'turn-1',
      status: 'failed',
      error: '   ',
      errorCode: 'backend_error',
    });
    expect(settlement).toStrictEqual({
      kind: 'failed',
      message: GENERIC,
      code: 'backend_error',
    });
  });
});

describe('a resume settles a reconnected turn with the failure it recorded', () => {
  test('the journaled message and code ride on the settle action', () => {
    const action = decideTurnResume({
      turn: {
        turnId: 'turn-1',
        status: 'failed',
        error: 'upstream refused the turn',
        errorCode: 'backend_error',
      },
    });
    expect(action).toStrictEqual({
      kind: 'settle',
      turnId: 'turn-1',
      settlement: {
        kind: 'failed',
        message: 'upstream refused the turn',
        code: 'backend_error',
      },
    });
  });

  test('an older journal settles with its string message alone', () => {
    const action = decideTurnResume({
      turn: { turnId: 'turn-1', status: 'failed', error: 'hermes: 500 upstream refused' },
    });
    expect(action).toStrictEqual({
      kind: 'settle',
      turnId: 'turn-1',
      settlement: { kind: 'failed', message: 'hermes: 500 upstream refused' },
    });
  });

  test('a failed record with no detail still settles rather than hanging', () => {
    const action = decideTurnResume({ turn: { turnId: 'turn-1', status: 'failed' } });
    expect(action).toStrictEqual({
      kind: 'settle',
      turnId: 'turn-1',
      settlement: { kind: 'failed', message: GENERIC },
    });
  });
});
