// ─── The rejection chain when React Native's options are not in the bundle ──
// Hermes takes ONE rejection tracker: enabling ours overwrites React Native's
// own unhandled-rejection reporting. A variable `require` leaves the options
// module out of the production bundle, so the load fails at runtime. That is
// exactly the path this suite stands in for — and on it the only honest move
// is to leave the already-installed tracker alone (QUALITY-SCAN-2026-10-11
// L831), not to replace it with one forwarding to nothing.

const mockEnable = jest.fn();
let savedHermes: unknown;
let savedErrorUtils: unknown;
let uninstall: (() => void) | null = null;

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

// The module Metro cannot include when the specifier is not a string literal:
// requiring it throws in the shipped bundle.
jest.mock('react-native/Libraries/promiseRejectionTrackingOptions', () => {
  throw new Error('module not in the bundle');
});

import { installGlobalFailureHandlers } from '@/lib/diagnostics/failure-log';

const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  savedHermes = globals.HermesInternal;
  savedErrorUtils = globals.ErrorUtils;
  mockEnable.mockClear();
  globals.HermesInternal = { enablePromiseRejectionTracker: mockEnable };
  globals.ErrorUtils = undefined;
  uninstall = null;
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  globals.HermesInternal = savedHermes;
  globals.ErrorUtils = savedErrorUtils;
});

test('unloadable React Native options leave the installed tracker in place', () => {
  uninstall = installGlobalFailureHandlers();

  // Enabling ours would replace React Native's tracker with one that forwards
  // to a null options object, silencing the platform reporting the chain
  // exists to preserve.
  expect(mockEnable).not.toHaveBeenCalled();
});
