import { describe, it, test, expect } from '@jest/globals';

import {
  staleModelPin,
  stalePinNote,
  visibleModelRows,
} from '@/lib/gateway/model-selection';
import { modelLockFallback, modelLockNote } from '@/lib/gateway/run-failures';

// 2026-10-01: the Gate stopped offering a catalogue of everything an
// environment claims to serve and started curating it — a provider the host is
// not signed into, a built-in a configured provider has replaced, an image
// model, a model that failed its last two turns — flagging those rows `hidden`
// rather than dropping them.
//
// That last part is the whole contract on this side. The picker's rows are what
// the operator sees; `modelCatalog` is what the stale-pin repair reads, and it
// can only repair a pin it can FIND. So the phone hides a hidden row and keeps
// the row its own thread is pinned to, and never deletes anything.

type Row = { id: string; hidden?: boolean; hiddenReason?: string; available?: boolean };

const CATALOGUE: Row[] = [
  { id: 'kilo/kilo-auto/free', available: true },
  {
    id: 'kilocode/kilo-auto/free',
    available: false,
    hidden: true,
    hiddenReason: 'Replaced by your KiloCode provider',
  },
  {
    id: 'opencode-go/omen-alpha',
    available: false,
    hidden: true,
    hiddenReason: 'Failed its last 2 turns (HTTP 400: MissingSessionID) - hidden until 2026-10-01 18:00 UTC',
  },
  {
    id: 'kilo/google/gemini-3.1-flash-image',
    available: true,
    hidden: true,
    hiddenReason: 'Not a chat model',
  },
];

describe('visibleModelRows — what the picker offers', () => {
  it('drops every row the Gate flagged', () => {
    expect(visibleModelRows(CATALOGUE, 'kilo/kilo-auto/free').map((row) => row.id)).toEqual([
      'kilo/kilo-auto/free',
    ]);
  });

  it('keeps the thread’s own pinned row, whatever the Gate said about it', () => {
    // The operator has to be able to SEE what the thread is running on and why
    // it cannot be picked. Hiding it would leave a lock with nothing on screen.
    const offered = visibleModelRows(CATALOGUE, 'kilocode/kilo-auto/free');
    expect(offered.map((row) => row.id)).toContain('kilocode/kilo-auto/free');
    expect(offered.find((row) => row.id === 'kilocode/kilo-auto/free')?.hiddenReason).toBe(
      'Replaced by your KiloCode provider',
    );
  });

  it('matches the pin under qualification, the way the sheet and the repair do', () => {
    // The profile stores `omen-alpha`; the catalogue files it under a provider.
    expect(visibleModelRows(CATALOGUE, 'omen-alpha').map((row) => row.id)).toContain(
      'opencode-go/omen-alpha',
    );
    expect(visibleModelRows(CATALOGUE, 'opencode-go/omen-alpha').map((row) => row.id)).toContain(
      'opencode-go/omen-alpha',
    );
  });

  it('a thread with no pin yet sees only what runs', () => {
    expect(visibleModelRows(CATALOGUE, undefined).map((row) => row.id)).toEqual(['kilo/kilo-auto/free']);
    expect(visibleModelRows(CATALOGUE, '  ').map((row) => row.id)).toEqual(['kilo/kilo-auto/free']);
  });

  it('a catalogue the Gate flagged nothing comes back as the same array', () => {
    // Same reference, so a memoised picker does not re-render on every read.
    const rows: Row[] = [{ id: 'kilo/kilo-auto/free' }, { id: 'kilo/kilo-auto/thinking' }];
    expect(visibleModelRows(rows, undefined)).toBe(rows);
    expect(visibleModelRows([], undefined)).toEqual([]);
  });
});

describe('the stale-pin repair still sees a hidden row', () => {
  it('a hidden row with available:false is condemned and fallen back from', () => {
    // The picker hiding the row is not enough: the pin lives in the profile and
    // nothing else re-reads the catalogue, so the repair has to find the row.
    const stale = staleModelPin(CATALOGUE, 'kilocode/kilo-auto/free');
    expect(stale).toEqual({
      pinned: 'kilocode/kilo-auto/free',
      fallback: 'kilo/kilo-auto/free',
      reason: 'unavailable',
    });
    expect(stalePinNote(stale!)).toContain('kilo/kilo-auto/free');
  });

  it('a failing model is repaired exactly like a signed-out provider', () => {
    expect(staleModelPin(CATALOGUE, 'opencode-go/omen-alpha')?.reason).toBe('unavailable');
    expect(staleModelPin(CATALOGUE, 'omen-alpha')?.fallback).toBe('kilo/kilo-auto/free');
  });

  it('a hidden row that can still run is not condemned', () => {
    // `Not a chat model` sets hidden but leaves `available` alone, and the
    // repair reads availability, not hiddenness: the rule is about what a model
    // is, not about whether the host could run it.
    expect(staleModelPin(CATALOGUE, 'kilo/google/gemini-3.1-flash-image')).toBeNull();
  });

  it('a healthy pin is left alone', () => {
    expect(staleModelPin(CATALOGUE, 'kilo/kilo-auto/free')).toBeNull();
  });
});

describe('the repair never falls back onto a hidden row', () => {
  const PINNED = { id: 'opencode-go/omen-alpha', available: false, hidden: true };

  it('skips a hidden row the picker would not offer', () => {
    // `available: true` with `hidden` is the `Not a chat model` shape: it can
    // run, but the picker does not offer it. Switching the thread onto it moves
    // the pin from a lock the sheet explains to one it cannot.
    const catalogue: Row[] = [
      PINNED,
      { id: 'kilo/google/gemini-3.1-flash-image', available: true, hidden: true },
      { id: 'kilo/kilo-auto/free', available: true },
    ];
    expect(staleModelPin(catalogue, 'opencode-go/omen-alpha')?.fallback).toBe('kilo/kilo-auto/free');
  });

  it('reports no fallback when every other row is hidden', () => {
    const catalogue: Row[] = [
      PINNED,
      { id: 'kilocode/kilo-auto/free', available: false, hidden: true },
      { id: 'kilo/google/gemini-3.1-flash-image', available: true, hidden: true },
    ];
    const stale = staleModelPin(catalogue, 'opencode-go/omen-alpha');
    // The note then tells the operator there is nothing to switch to, which is
    // the truth: every other row is one the picker refuses to offer.
    expect(stale).toEqual({ pinned: 'opencode-go/omen-alpha', fallback: undefined, reason: 'unavailable' });
    expect(stalePinNote(stale!)).toContain('no signed-in model to switch to');
  });

  it('still condemns the hidden pin itself', () => {
    expect(staleModelPin([PINNED], 'opencode-go/omen-alpha')?.reason).toBe('unavailable');
  });
});

describe('the chat screen wiring', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const screen = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(
      __dirname.includes('\\') ? '\\' : '/',
    ),
    'utf8',
  );

  test('the picker rows are the curated ones, with the pinned model named', () => {
    expect(screen).toMatch(
      /visibleModelRows\(modelCatalog, threadModel\)\.map\(\(model: Record<string, unknown>\) => \(\{/,
    );
    expect(screen).toMatch(/\[modelCatalog, selectedBackendId, threadModel/);
  });

  test('the Gate’s reason rides the locked-row slot the sheet already renders', () => {
    // thread-config-sheet renders one reason for a locked row (modelLockNote),
    // and that is the design that exists: no new component, no new field, and no
    // edit to the sheet. The Gate's `hiddenReason` becomes that `reason` when
    // this device recorded no turn failure of its own.
    expect(screen).toMatch(
      /modelLock: catalogueLock\(model, modelLockFor\(activeGateway\?\.modelLocks, String\(/,
    );
    expect(screen).toMatch(/const reason = typeof model\.hiddenReason === 'string'/);
    // Marked as the Gate's, so the sheet shows the Gate's reason and offers no
    // Clear this device cannot honour.
    expect(screen).toMatch(
      /return \{\s*model: String\(model\.id[^}]*reason,\s*recordedAt: 0,\s*source: 'gate',?\s*\}/,
    );
  });

  test('the catalog itself is left whole for the stale-pin repair', () => {
    // `modelCatalog` is never filtered on its own: the repair reads it by id,
    // and a row it cannot find condemns nothing but also fixes nothing.
    expect(screen).not.toMatch(/const modelCatalog = \w+\.filter\(/);
    expect(screen).toMatch(/visibleModelRows\(modelCatalog, threadModel\)/);
  });
});

describe('a row the Gate hid, on the device-lock side', () => {
  test('a device-locked pin never falls back onto a hidden row', () => {
    // The other arm of the stale-pin repair: the thread's pin carries a lock
    // this device recorded. Its fallback used to skip only `available: false`,
    // so a hidden-but-runnable row (an image model) could become the thread's
    // model although the picker will not offer it.
    const locks = { 'kilo/kilo-auto/free': { model: 'kilo/kilo-auto/free', reason: '429', recordedAt: 1 } };
    const rows = [
      { id: 'kilo/kilo-auto/free', available: true, modelLocks: locks },
      { id: 'kilo/google/gemini-3.1-flash-image', available: true, hidden: true, modelLocks: locks },
      { id: 'kilo/kilo-auto/efficient', available: true, modelLocks: locks },
    ];
    expect(modelLockFallback(rows, 'kilo/kilo-auto/free')).toBe('kilo/kilo-auto/efficient');
  });

  test("the Gate's verdict reads as the Gate's, not as this device's lock", () => {
    const note = modelLockNote({ model: 'kilo/x', reason: 'Not a chat model', recordedAt: 0, source: 'gate' });
    expect(note).toBe('Not a chat model. Pick another model.');
    expect(note).not.toMatch(/on this device|clear the lock/i);
    // A device lock keeps exactly today's wording.
    expect(modelLockNote({ model: 'kilo/x', reason: '429', recordedAt: 1 })).toBe(
      'Locked on this device: kilo/x. Reason: 429 Pick another model or clear the lock.',
    );
  });

  test('the sheet offers Clear only for a lock this device can clear', () => {
    const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
    const sheet = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'thread-config-sheet.tsx'].join(
        __dirname.includes('\\') ? '\\' : '/',
      ),
      'utf8',
    );
    expect(sheet).toMatch(/\{onClearLock && item\.modelLock\?\.source !== 'gate' \? \(/);
  });
});
