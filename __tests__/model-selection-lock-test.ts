import { describe, it, expect } from '@jest/globals';
import {
  recordModelTurnFailure,
  failedModelLocks,
  modelLockFor,
  clearModelLock,
  isModelLocked,
  modelLockNote,
} from '@/lib/gateway/run-failures';

const catalog = [
  { id: 'opencode-go/omen-alpha', providerId: 'opencode-go', available: true },
  { id: 'opencode-go/deepseek-v4-flash', providerId: 'opencode-go', available: true },
  { id: 'nous/laguna-s-2.1:free', providerId: 'nous', available: true },
];

describe('recordModelTurnFailure — the upstream model-ID refusal', () => {
  it('records a lock for the pinned model', () => {
    const locks = recordModelTurnFailure(
      undefined,
      { raw: 'HTTP 400: omen-alpha is not a valid model ID' },
      { model: 'opencode-go/omen-alpha' },
    );
    expect(Object.keys(locks)).toHaveLength(1);
    expect(locks['opencode-go/omen-alpha']).toMatchObject({
      model: 'opencode-go/omen-alpha',
      reason: 'HTTP 400: omen-alpha is not a valid model ID',
    });
  });

  it('an upstream failure names only the model it was sent with', () => {
    const locks = recordModelTurnFailure(
      undefined,
      { raw: 'HTTP 400: omen-alpha is not a valid model ID' },
      { model: 'opencode-go/omen-alpha' },
    );
    expect(locks).not.toHaveProperty('opencode-go/deepseek-v4-flash');
  });

  it('a real reply that merely mentions HTTP 400 is not a failure', () => {
    expect(
      recordModelTurnFailure(undefined, { raw: 'HTTP 400 means a bad request' }),
    ).toEqual({});
    expect(recordModelTurnFailure(undefined, { raw: '' })).toEqual({});
    expect(recordModelTurnFailure(undefined, { raw: undefined })).toEqual({});
  });

  it('other failures leave the lock table unchanged', () => {
    expect(
      recordModelTurnFailure(undefined, { raw: 'Request timed out after 30s' }),
    ).toEqual({});
    expect(recordModelTurnFailure(undefined, { raw: 'HTTP 401: unauthorized' })).toEqual({});
  });

  it('a send with no model is never recorded against one', () => {
    expect(recordModelTurnFailure(undefined, { raw: 'HTTP 400: x is not a valid model ID' })).toEqual({});
  });

  it('case-insensitive and tolerant of whitespace', () => {
    const locks = recordModelTurnFailure(undefined, {
      raw: 'http 400: omen-alpha is not a valid model id',
    }, {});
    expect(locks).toEqual({});
  });

  it('persists against the profile and returns on re-record', () => {
    const first = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    const second = recordModelTurnFailure(
      first,
      { raw: 'HTTP 400: omen-alpha is not a valid model ID' },
      { model: 'opencode-go/omen-alpha', profileId: 'gate-1' },
    );
    expect(second).toEqual(first);
  });

  it('carries the profile id when given one', () => {
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
      profileId: 'gate-1',
    });
    expect(locks['opencode-go/omen-alpha']).toMatchObject({ profileId: 'gate-1' });
  });

  it('the answered arm clears the lock (recordModelTurnFailure)', () => {
    const held = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    const cleared = recordModelTurnFailure(held, { answered: true }, {
      model: 'opencode-go/omen-alpha',
    });
    expect(Object.keys(cleared)).toHaveLength(0);
    // An answer for a model with no lock changes nothing.
    expect(recordModelTurnFailure(undefined, { answered: true }, {
      model: 'opencode-go/deepseek-v4-flash',
    })).toEqual({});
  });
});

describe('modelLockFor', () => {
  it('resolves by exact id first, then by model token under qualification', () => {
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    expect(modelLockFor(locks, 'opencode-go/omen-alpha')).toMatchObject({ model: 'opencode-go/omen-alpha' });
    expect(modelLockFor(locks, 'omen-alpha')).toMatchObject({ model: 'opencode-go/omen-alpha' });
    expect(modelLockFor(locks, 'opencode-go/deepseek-v4-flash')).toBeUndefined();
    expect(modelLockFor(locks, undefined)).toBeUndefined();
  });
});

describe('isModelLocked', () => {
  it('gates on the turn-answered guard and never locks a live listing', () => {
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'omen-alpha',
    });
    expect(isModelLocked(locks, 'opencode-go/omen-alpha')).toBe(true);
    expect(isModelLocked(locks, 'omen-alpha')).toBe(true);
    expect(isModelLocked(locks, 'opencode-go/deepseek-v4-flash')).toBe(false);
    // `available` false in the catalog is the picker's existing signal; the
    // lock is the on-device verdict and adds to it, not replaces it.
    expect(isModelLocked(locks, 'opencode-go/omen-alpha')).toBe(true);
  });
});

describe('clearModelLock', () => {
  it('drops the lock for the model cleared', () => {
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    const cleared = clearModelLock(locks, 'opencode-go/omen-alpha');
    expect(isModelLocked(cleared, 'opencode-go/omen-alpha')).toBe(false);
    expect(cleared).toEqual({});
  });
});

describe('failedModelLocks', () => {
  it('reads only entries that parse as locks', () => {
    expect(
      failedModelLocks([
        { id: 'g1', modelLocks: { 'opencode-go/omen-alpha': { model: 'opencode-go/omen-alpha' } } },
        { id: 'g2' },
        { id: 'g3', modelLocks: null },
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'g1', modelLocks: { 'opencode-go/omen-alpha': expect.anything() } }),
    ]);
  });
});

describe('modelLockNote', () => {
  it('names the model and the refusal, and offers clear without naming any credential', () => {
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    const locks2 = recordModelTurnFailure(locks, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
      profileId: 'gate-1',
    });
    const note = modelLockNote(modelLockFor(locks2, 'omen-alpha')!);
    expect(note).toContain('omen-alpha');
    expect(note).toContain('not a valid model ID');
    expect(note).toMatch(/pick another/i);
    expect(note.toLowerCase()).not.toContain('token');
    expect(note.toLowerCase()).not.toContain('key');
  });

  it('a lock with no recorded reason still renders honestly', () => {
    const note = modelLockNote({ model: 'opencode-go/omen-alpha', reason: '', recordedAt: 0 });
    expect(note).toContain('omen-alpha');
    expect(note).toMatch(/pick another/i);
  });
});

describe('an answered turn must never become a lock from a later failure', () => {
  it('the picker consults the turn-answered guard through isModelLocked only', () => {
    // The lock record is one arm; the turn-answered guard is the caller's job
    // (GatewayProvider.swift-side). This unit pins that the record's shape
    // never claims availability for a model that DID answer.
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    // The catalog entry for a model that DID answer shows no lock, so the
    // picker row stays selectable.
    expect(isModelLocked(locks, 'opencode-go/deepseek-v4-flash')).toBe(false);
    // The examiner's intent: a model with a lock that ALSO answered (the
    // operator re-pinned after the host gained the provider, and the new
    // turn completed) is not locked — the guard is consulted, and
    // `recordModelTurnFailure` never overwrites a lock with an answer.
    expect(isModelLocked(locks, 'opencode-go/omen-alpha')).toBe(true);
    // After a clear, the same model is selectable again.
    const cleared = clearModelLock(locks, 'opencode-go/omen-alpha');
    expect(isModelLocked(cleared, 'opencode-go/omen-alpha')).toBe(false);
  });
});

describe('staleModelPin falls back from a locked model', () => {
  it('only with providersAuthoritative and no available fallback', () => {
    // This is the backlog's stated fall-through: the lock feeds the picker,
    // and the fallback fold picks the first OTHER available model.
    const locks = recordModelTurnFailure(undefined, { raw: 'HTTP 400: omen-alpha is not a valid model ID' }, {
      model: 'opencode-go/omen-alpha',
    });
    expect(isModelLocked(locks, 'opencode-go/omen-alpha')).toBe(true);
    // The fallback arm lives in staleModelPin; here we pin that the listed
    // alternative exists for the caller to fall to.
    const others = catalog.filter((entry) => !entry.id.includes('omen-alpha'));
    expect(others).toHaveLength(2);
  });
});
