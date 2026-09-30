// ─── The local failure log ──────────────────────────────────────────────────
// Nothing recorded a crash. A render error in a provider above the Stack
// unmounted the app with no trace, an uncaught error in an event handler on a
// release build vanished, and a rejected promise nobody caught was invisible —
// the whole suite runs in Node, where none of those shapes can be observed.
// This is the local record: bounded, de-duplicated, and never itself a source
// of failures (every storage error is swallowed, because a logger that throws
// turns a fault into a worse one).

const mockBacking = new Map<string, string>();
let mockSetFails: Error | null = null;
const mockRnOnHandled = jest.fn();
const mockRnOnUnhandled = jest.fn();

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async (key: string) => mockBacking.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      if (mockSetFails) throw mockSetFails;
      mockBacking.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockBacking.delete(key);
    }),
  },
}));

// React Native's own rejection-tracking options, stood in so the chain to them
// is observable. Hermes takes ONE tracker and enabling ours overwrites the one
// polyfillPromise.js installed, so replacing it would silence the platform's
// own unhandled-rejection reporting.
jest.mock('react-native/Libraries/promiseRejectionTrackingOptions', () => ({
  __esModule: true,
  default: { allRejections: true, onHandled: mockRnOnHandled, onUnhandled: mockRnOnUnhandled },
}));

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  FAILURE_LOG_KEY,
  clearFailures,
  installGlobalFailureHandlers,
  loadFailures,
  recordFailure,
  type FailureKind,
} from '@/lib/diagnostics/failure-log';

const mockSet = keyValueStorage.setItem as jest.Mock;

function kindOf(index: number): FailureKind {
  return index % 2 === 0 ? 'render' : 'js-error';
}

beforeEach(async () => {
  mockSetFails = null;
  mockBacking.clear();
  mockSet.mockClear();
  // Start from a genuinely empty log: this is the only way to drop the
  // module's in-memory mirror between suites.
  await clearFailures();
});

describe('recordFailure / loadFailures', () => {
  test('a record survives the round trip through storage', async () => {
    await recordFailure({ kind: 'render', message: 'Cannot read property id of null', fatal: true });

    expect(mockSet).toHaveBeenCalledWith(FAILURE_LOG_KEY, expect.any(String));
    expect(FAILURE_LOG_KEY).toBe('versutus:failure-log:v1');

    const stored = await loadFailures();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: 'render',
      message: 'Cannot read property id of null',
      count: 1,
      fatal: true,
    });
    expect(typeof stored[0].at).toBe('number');
  });

  test('the newest entries win once the log is full', async () => {
    for (let index = 0; index < 60; index += 1) {
      await recordFailure({ kind: kindOf(index), message: `failure ${index}` });
    }

    const stored = await loadFailures();
    expect(stored).toHaveLength(50);
    // Newest first, and the ten oldest are the ones dropped.
    expect(stored[0].message).toBe('failure 59');
    expect(stored[49].message).toBe('failure 10');
  });

  test('identical consecutive records collapse into one counted entry', async () => {
    await recordFailure({ kind: 'unhandled-rejection', message: 'ECONNREFUSED' });
    await recordFailure({ kind: 'unhandled-rejection', message: 'ECONNREFUSED' });
    await recordFailure({ kind: 'unhandled-rejection', message: 'ECONNREFUSED' });
    // A different failure in between breaks the run, so the next repeat is its own entry.
    await recordFailure({ kind: 'js-error', message: 'socket closed' });
    await recordFailure({ kind: 'unhandled-rejection', message: 'ECONNREFUSED' });

    const stored = await loadFailures();
    expect(stored.map((entry) => [entry.message, entry.count])).toEqual([
      ['ECONNREFUSED', 1],
      ['socket closed', 1],
      ['ECONNREFUSED', 3],
    ]);
  });

  test('a collapsed entry keeps when it first happened and how often', async () => {
    const before = Date.now();
    await recordFailure({ kind: 'js-error', message: 'render loop' });
    const first = (await loadFailures())[0];
    await recordFailure({ kind: 'js-error', message: 'render loop' });
    const second = (await loadFailures())[0];

    expect(second.at).toBe(first.at);
    expect(first.at).toBeGreaterThanOrEqual(before);
    expect(second.count).toBe(2);
    expect((await loadFailures())).toHaveLength(1);
  });

  test('a very long message and stack are truncated, not dropped', async () => {
    await recordFailure({
      kind: 'js-error',
      message: 'm'.repeat(900),
      stack: 's'.repeat(4000),
    });

    const stored = await loadFailures();
    expect(stored[0].message).toHaveLength(500);
    expect(stored[0].stack).toHaveLength(2000);
  });

  test('a record without a stack or a fatal flag is still a record', async () => {
    await recordFailure({ kind: 'other', message: 'no stack here' });

    const stored = await loadFailures();
    expect(stored[0]).toMatchObject({ kind: 'other', message: 'no stack here', count: 1 });
    expect(stored[0].stack).toBeUndefined();
    expect(stored[0].fatal).toBeUndefined();
  });

  test('logging never throws when storage refuses the write', async () => {
    mockSetFails = new Error('storage full');

    await expect(
      recordFailure({ kind: 'render', message: 'disk said no' }),
    ).resolves.toBeUndefined();
    // And the log is readable again afterwards — a failed write is not a
    // wedged log.
    await expect(loadFailures()).resolves.toEqual([]);
    await expect(clearFailures()).resolves.toBeUndefined();
  });

  test('records land one after another instead of overwriting each other', async () => {
    await Promise.all([
      recordFailure({ kind: 'js-error', message: 'first' }),
      recordFailure({ kind: 'js-error', message: 'second' }),
      recordFailure({ kind: 'js-error', message: 'third' }),
    ]);

    const stored = await loadFailures();
    expect(stored.map((entry) => entry.message).sort()).toEqual(['first', 'second', 'third']);
  });

  test('a corrupt stored log reads as no failures, not as a throw', async () => {
    mockBacking.set(FAILURE_LOG_KEY, '{not json');
    await expect(loadFailures()).resolves.toEqual([]);
  });

  test('clearFailures empties the log and the key', async () => {
    await recordFailure({ kind: 'render', message: 'boom' });
    expect(await loadFailures()).toHaveLength(1);

    await clearFailures();

    expect(mockBacking.has(FAILURE_LOG_KEY)).toBe(false);
    expect(await loadFailures()).toEqual([]);
  });
});

describe('installGlobalFailureHandlers', () => {
  type Handler = (error: unknown, isFatal?: boolean) => void;
  const globals = globalThis as Record<string, unknown>;
  let previous: Handler;
  let current: Handler;
  let errorUtils: { getGlobalHandler: () => Handler; setGlobalHandler: (handler: Handler) => void };
  let savedErrorUtils: unknown;
  let uninstall: (() => void) | null;

  beforeEach(() => {
    previous = jest.fn();
    current = previous;
    errorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (handler: Handler) => {
        current = handler;
      },
    };
    savedErrorUtils = globals.ErrorUtils;
    globals.ErrorUtils = errorUtils;
    uninstall = null;
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    globals.ErrorUtils = savedErrorUtils;
  });

  test('an uncaught JS error is recorded and still reaches the previous handler', async () => {
    uninstall = installGlobalFailureHandlers();

    const thrown = new Error('event handler exploded');
    current(thrown, true);

    const stored = await loadFailures();
    expect(stored[0]).toMatchObject({ kind: 'js-error', message: 'event handler exploded', fatal: true });
    // The stack rides along, capped at what the log is willing to store.
    expect(stored[0].stack).toBe(thrown.stack?.slice(0, 2000));
    // The platform's own reporting is untouched: the wrapper is additive.
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(thrown, true);
  });

  test('a thrown non-Error is recorded by what it actually was', async () => {
    uninstall = installGlobalFailureHandlers();

    current('just a string', false);

    const stored = await loadFailures();
    expect(stored[0]).toMatchObject({ kind: 'js-error', message: 'just a string', fatal: false });
    expect(previous).toHaveBeenCalledWith('just a string', false);
  });

  test('uninstall puts the previous handler back', () => {
    const off = installGlobalFailureHandlers();
    expect(current).not.toBe(previous);

    off();

    expect(current).toBe(previous);
  });

  test('installing twice wraps once', async () => {
    const off = installGlobalFailureHandlers();
    // Same uninstall back: the second call site must not wrap the handler a
    // second time, or one crash would be recorded twice and forwarded twice.
    expect(installGlobalFailureHandlers()).toBe(off);

    current(new Error('only once'), true);

    expect(previous).toHaveBeenCalledTimes(1);
    const stored = await loadFailures();
    expect(stored).toHaveLength(1);
    expect(stored[0].count).toBe(1);
    off();
  });

  test('a runtime with no ErrorUtils global installs nothing and throws nothing', () => {
    globals.ErrorUtils = undefined;

    const off = installGlobalFailureHandlers();
    expect(typeof off).toBe('function');
    off();
  });
});

describe('installGlobalFailureHandlers and unhandled rejections', () => {
  const globals = globalThis as Record<string, unknown>;
  let enable: jest.Mock;
  let savedHermes: unknown;
  let savedErrorUtils: unknown;
  let uninstall: (() => void) | null;

  beforeEach(() => {
    enable = jest.fn();
    savedHermes = globals.HermesInternal;
    savedErrorUtils = globals.ErrorUtils;
    globals.HermesInternal = { enablePromiseRejectionTracker: enable };
    globals.ErrorUtils = undefined;
    mockRnOnHandled.mockClear();
    mockRnOnUnhandled.mockClear();
    uninstall = null;
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    globals.HermesInternal = savedHermes;
    globals.ErrorUtils = savedErrorUtils;
  });

  function trackerOptions(): {
    allRejections?: boolean;
    onHandled: (id: number) => void;
    onUnhandled: (id: number, rejection: unknown) => void;
  } {
    return enable.mock.calls[0][0];
  }

  test('tracking is enabled on the runtimes that offer it', () => {
    uninstall = installGlobalFailureHandlers();
    expect(enable).toHaveBeenCalledTimes(1);
    expect(trackerOptions().allRejections).toBe(true);
  });

  test('an unhandled rejection is recorded and still reaches React Native’s tracker', async () => {
    uninstall = installGlobalFailureHandlers();

    const rejection = new Error('gateway socket closed');
    trackerOptions().onUnhandled(3, rejection);

    const stored = await loadFailures();
    expect(stored[0]).toMatchObject({
      kind: 'unhandled-rejection',
      message: 'gateway socket closed',
    });
    // Hermes has no getter for the installed tracker, so the only way not to
    // replace React Native's is to call it from ours.
    expect(mockRnOnUnhandled).toHaveBeenCalledWith(3, rejection);
  });

  test('a rejection handled later still reaches React Native’s onHandled', () => {
    uninstall = installGlobalFailureHandlers();

    trackerOptions().onHandled(4);

    expect(mockRnOnHandled).toHaveBeenCalledWith(4);
  });

  test('a runtime with no tracker hook is left alone', () => {
    globals.HermesInternal = {};

    const off = installGlobalFailureHandlers();
    expect(enable).not.toHaveBeenCalled();
    off();
  });
});
