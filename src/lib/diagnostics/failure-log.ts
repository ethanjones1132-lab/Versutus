// ─── The local failure log ────────────────────────────────────────────────
// A crash used to leave nothing. A render error in a provider above the Stack
// unmounted the app and the release build printed no redbox; an uncaught error
// in an event handler vanished the same way; a rejected promise nobody caught
// was invisible forever. Nothing in the suite could catch any of it either —
// every test runs in Node, where those shapes do not exist.
//
// This is the record, and it is deliberately LOCAL. No network reporting: the
// question this answers is "what did this phone do just before it went wrong",
// and the only honest way to answer it from a user's hands is the Diagnostics
// screen. So: newest 50, message and stack truncated, repeats collapsed into a
// count, and every storage error swallowed — a logger that throws turns one
// fault into a worse one.

import { keyValueStorage } from '@/lib/storage/key-value';

export const FAILURE_LOG_KEY = 'versutus:failure-log:v1';

const MAX_ENTRIES = 50;
const MESSAGE_LIMIT = 500;
const STACK_LIMIT = 2000;

const KINDS = ['render', 'js-error', 'unhandled-rejection', 'other'] as const;

export type FailureKind = (typeof KINDS)[number];

export type FailureRecord = {
  kind: FailureKind;
  message: string;
  stack?: string;
  fatal?: boolean;
};

export type FailureEntry = {
  at: number;
  kind: FailureKind;
  message: string;
  stack?: string;
  fatal?: boolean;
  /** How many identical consecutive occurrences this row stands for. */
  count: number;
};

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

type ErrorUtilsLike = {
  getGlobalHandler: () => GlobalErrorHandler;
  setGlobalHandler: (handler: GlobalErrorHandler) => void;
};

type RejectionTrackerOptions = {
  allRejections?: boolean;
  onHandled?: (id: number) => void;
  onUnhandled?: (id: number, rejection: unknown) => void;
};

type HermesInternalLike = {
  enablePromiseRejectionTracker?: (options: RejectionTrackerOptions) => void;
};

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function storedEntry(value: unknown): FailureEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<FailureEntry>;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return null;
  if (!isFailureKind(row.kind)) return null;
  if (typeof row.message !== 'string') return null;
  const entry: FailureEntry = {
    at: row.at,
    kind: row.kind,
    message: row.message,
    count: typeof row.count === 'number' && row.count > 0 ? Math.floor(row.count) : 1,
  };
  if (typeof row.stack === 'string') entry.stack = row.stack;
  if (typeof row.fatal === 'boolean') entry.fatal = row.fatal;
  return entry;
}

/**
 * The persisted log, newest first. A stored value is only believed entry by
 * entry: one unrecognised row is dropped, never the whole log — a crash log
 * that empties itself because of a shape it does not recognise is no log.
 */
async function readStored(): Promise<FailureEntry[]> {
  try {
    const raw = await keyValueStorage.getItem(FAILURE_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(storedEntry)
      .filter((entry): entry is FailureEntry => entry !== null)
      .slice(0, MAX_ENTRIES);
  } catch {
    // Unreadable storage is an empty log, never a throw.
    return [];
  }
}

async function writeStored(entries: FailureEntry[]): Promise<void> {
  try {
    await keyValueStorage.setItem(FAILURE_LOG_KEY, JSON.stringify(entries));
  } catch {
    // The failure happened whatever storage thinks of it; losing the record
    // is strictly better than throwing out of the thing that records failures.
  }
}

/**
 * Newest first, so keeping the newest 50 is a head slice. An identical repeat
 * of the row already on top folds into it and only its `count` moves — the
 * timestamp stays the one the failure started at, because "this began at 14:02
 * and has happened 57 times since" is the fact worth reading.
 */
function withRecord(entries: FailureEntry[], record: FailureRecord): FailureEntry[] {
  const now = Date.now();
  const entry: FailureEntry = {
    at: now,
    kind: record.kind,
    message: truncate(record.message, MESSAGE_LIMIT),
    count: 1,
  };
  if (record.stack) entry.stack = truncate(record.stack, STACK_LIMIT);
  if (record.fatal !== undefined) entry.fatal = record.fatal;

  const newest = entries[0];
  const repeated =
    newest !== undefined &&
    newest.kind === entry.kind &&
    newest.message === entry.message &&
    newest.fatal === entry.fatal;
  const next = repeated
    ? [{ ...newest, count: newest.count + 1 }, ...entries.slice(1)]
    : [entry, ...entries];
  return next.slice(0, MAX_ENTRIES);
}

/**
 * Every read-modify-write runs here, in call order.
 *
 * Two failures recorded in the same tick both read the log before either has
 * written it, and whichever write landed last would silently drop the other.
 * Chaining the whole cycle — not just the write — is what makes a burst of
 * failures land as a burst of rows.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  // `then(task, task)` rather than `then(task)`: a link that rejected must
  // not strand everything queued behind it.
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Record one failure. Never rejects: this is called from a crash path. */
export function recordFailure(record: FailureRecord): Promise<void> {
  return serialized(async () => {
    const stored = await readStored();
    await writeStored(withRecord(stored, record));
  });
}

/** The recorded failures, newest first. A failed read is an empty list. */
export async function loadFailures(): Promise<FailureEntry[]> {
  return serialized(readStored);
}

/** Forget everything recorded so far. */
export function clearFailures(): Promise<void> {
  return serialized(async () => {
    try {
      await keyValueStorage.removeItem(FAILURE_LOG_KEY);
    } catch {
      // The next record starts from whatever is still stored, so a failed
      // clear must not be allowed to escape and take the caller with it.
    }
  });
}

function describeThrown(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  try {
    return JSON.stringify(thrown) ?? 'Unknown failure';
  } catch {
    return 'Unknown failure';
  }
}

function stackOf(thrown: unknown): string | undefined {
  if (!(thrown instanceof Error)) return undefined;
  return typeof thrown.stack === 'string' ? thrown.stack : undefined;
}

/** React Native publishes ErrorUtils as a global; nothing else defines it. */
function globalErrorUtils(): ErrorUtilsLike | null {
  const candidate = (globalThis as Record<string, unknown>).ErrorUtils as
    | Partial<ErrorUtilsLike>
    | undefined;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.getGlobalHandler !== 'function') return null;
  if (typeof candidate.setGlobalHandler !== 'function') return null;
  return candidate as ErrorUtilsLike;
}

function hermesInternal(): HermesInternalLike | null {
  const candidate = (globalThis as Record<string, unknown>).HermesInternal as
    | Partial<HermesInternalLike>
    | undefined;
  return candidate && typeof candidate === 'object' ? (candidate as HermesInternalLike) : null;
}

/**
 * React Native's own rejection-tracking options.
 *
 * `Libraries/Core/polyfillPromise.js` wires Hermes' `enablePromiseRejectionTracker`
 * to this object, and it is the only way the platform's own unhandled-rejection
 * reporting is reached. It is a Flow module with no type declarations, so it
 * cannot be imported in a typed build; `require` is the seam, and a runtime
 * that does not ship it simply gets no chain.
 */
function reactNativeRejectionOptions(): RejectionTrackerOptions | null {
  try {
    const specifier = 'react-native/Libraries/promiseRejectionTrackingOptions';
    const module: unknown = require(specifier);
    const options =
      module && typeof module === 'object' && 'default' in module
        ? (module as { default: unknown }).default
        : module;
    return options && typeof options === 'object' ? (options as RejectionTrackerOptions) : null;
  } catch {
    return null;
  }
}

/**
 * Hermes takes ONE rejection tracker, and `enablePromiseRejectionTracker`
 * overwrites whatever was there. React Native installs its own from
 * `polyfillPromise.js`, so replacing it would silence exactly the reporting
 * this app relies on in development — the options are therefore forwarded to
 * rather than dropped.
 */
function chainRejectionTracking(hermes: HermesInternalLike): boolean {
  if (typeof hermes.enablePromiseRejectionTracker !== 'function') return false;
  const rnOptions = reactNativeRejectionOptions();
  try {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onHandled: (id) => {
        rnOptions?.onHandled?.(id);
      },
      onUnhandled: (id, rejection) => {
        void recordFailure({
          kind: 'unhandled-rejection',
          message: describeThrown(rejection),
          stack: stackOf(rejection),
        });
        rnOptions?.onUnhandled?.(id, rejection);
      },
    });
  } catch {
    return false;
  }
  return true;
}

let uninstall: (() => void) | null = null;

/**
 * Record every uncaught JavaScript error and every unhandled rejection, then
 * let the platform carry on handling them exactly as it did.
 *
 * Idempotent: a second call is a no-op returning the same uninstall, so a
 * second call site cannot wrap the handler twice. The returned function puts
 * the previous global handler back — it exists for tests, and for nothing else.
 */
export function installGlobalFailureHandlers(): () => void {
  if (uninstall) return uninstall;

  const restorers: (() => void)[] = [];
  const errorUtils = globalErrorUtils();
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      try {
        void recordFailure({
          kind: 'js-error',
          message: describeThrown(error),
          stack: stackOf(error),
          fatal: isFatal,
        });
      } finally {
        // The platform's own reporting is the app's crash reporting; the log
        // is additive and must never stand between an error and it.
        previous?.(error, isFatal);
      }
    });
    restorers.push(() => errorUtils.setGlobalHandler(previous));
  }

  const hermes = hermesInternal();
  if (hermes && chainRejectionTracking(hermes)) {
    restorers.push(() => {
      // Hermes has no way to switch the tracker off, so uninstalling puts
      // React Native's own options back rather than pretending it never ran.
      const rnOptions = reactNativeRejectionOptions();
      if (rnOptions) {
        try {
          hermes.enablePromiseRejectionTracker?.(rnOptions);
        } catch {
          // Nothing left to restore; the global handler is already back.
        }
      }
    });
  }

  let done = false;
  uninstall = () => {
    if (done) return;
    done = true;
    uninstall = null;
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch {
        // A restore that fails must not strand the others.
      }
    }
  };
  return uninstall;
}
