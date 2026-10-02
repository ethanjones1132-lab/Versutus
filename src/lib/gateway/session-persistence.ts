// ─── Durable offline outbox + recent activity runs ────────────────
// Survives app kill so queued chat and run history are not purely
// in-memory. Secrets never go here — only message text and run metadata.

import type { ActivityRun } from '@/lib/gateway/runs';
import { isLocalProvisionalRunId } from '@/lib/gateway/cancel';
import { keyValueStorage } from '@/lib/storage/key-value';

const OFFLINE_QUEUE_KEY = 'versutus:offline-queue';
const ACTIVITY_RUNS_KEY = 'versutus:activity-runs';

/** Cap so a long-lived install does not grow unbounded. */
export const ACTIVITY_RUNS_PERSIST_CAP = 40;

/** What a refused read is named by, so a swallowed throw still says itself. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type OfflineQueueItem = {
  id: string;
  text: string;
  gatewayId: string;
  createdAt: number;
  /**
   * Present exactly when the text is a run typed against a gateway that was
   * not connected (D8 slice 1): the flush re-sends it through the run
   * dispatch instead of ordinary chat, so the row parks a RUN, not a reply.
   * Absent on every chat line — queued or not — and on every row written
   * before this field existed; never answered from the TEXT, because a chat
   * line that begins `/run` is still a chat line.
   */
  run?: QueuedRunShape;
  /**
   * The Bot whose canonical Bot Chat the text was typed for, when it was a
   * reply to a notice rather than a composer line (ADR 0012). Absent on a
   * composer send and on every row written before this field existed, and an
   * absent destination flushes exactly as it always did.
   */
  botId?: string;
  /**
   * The session the notice was about. Carried as the row's own record: the Bot
   * is what steers the flush, because the destination is that Bot's canonical
   * Bot Chat rather than whichever session the payload happened to name.
   */
  sessionId?: string;
  /**
   * The CLI environment the line was typed under, decided once at queue time.
   *
   * A queued line has no model of its own: `runTask` and
   * `executeGatewaySlashCommand` resolve the environment from the live
   * selection when the flush dispatches them, so `/run` typed under
   * `claude-local` started under whatever was selected by the time the tailnet
   * link came back — and a Hermes session's model pin is immutable, so the work
   * ran where the operator did not type it. Absent on a row written before this
   * field existed, which flushes exactly as it always did.
   */
  backendId?: string;
  /**
   * The Gate turn this line is sent as, minted once when the row was written.
   *
   * Without it every resend of the same words is a NEW turn: a process killed
   * mid-flush came back to a row whose first send was still running on the PC
   * and sent it again, so the agent did the work twice. Reusing the id makes the
   * Gate answer a retry with the existing turn (`X-Versutus-Turn-Resumed`) —
   * the resend is exactly-once. Absent on a run row (a run carries its own run
   * id) and on every row written before this field existed; a resend without one
   * still mints a fresh id, which is exactly what it used to do.
   */
  turnId?: string;
};

/**
 * The run a queued row re-sends when the gateway is back: the destination the
 * composer held when the line was typed (the Bot scope the run would have
 * started under). The flush hands it to the run dispatch verbatim — the app's
 * own flush never invents a destination the operator did not choose.
 */
export type QueuedRunShape = {
  /** The Bot the run would have been scoped to, when one was selected. */
  bot?: string;
};

function isQueuedRunShape(value: unknown): value is QueuedRunShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // The one field this fold reads a present string for; anything else inside
  // rides as it is, and a shape the app cannot read is dropped by the caller.
  return true;
}

/** A row whose text a flush re-sends as a run, decided by the row's own shape. */
export function isRunQueuedRow(item: OfflineQueueItem): boolean {
  return isQueuedRunShape(item.run);
}

/** Where a queued line was typed for, when it was a reply to a notice. */
export type OfflineQueueDestination = Pick<OfflineQueueItem, 'botId' | 'sessionId' | 'backendId'>;

function isOfflineQueueItem(value: unknown): value is OfflineQueueItem {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    typeof raw.text === 'string' &&
    typeof raw.gatewayId === 'string' &&
    typeof raw.createdAt === 'number'
  );
}

/** An id is an id only when it is present and not empty — anything else is not one. */
function destinationId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The row as it is held: the validated fields kept, a destination read the way
 * this app reads every other id, and the run shape kept only when it is an
 * object the flush could hand to the run dispatch (an unusable one is dropped,
 * the words kept — the words are worth more than the shape, exactly as a
 * destination is).
 */
function normalizeOfflineQueueItem(item: OfflineQueueItem): OfflineQueueItem {
  const next: OfflineQueueItem = {
    id: item.id,
    text: item.text,
    gatewayId: item.gatewayId,
    createdAt: item.createdAt,
  };
  const botId = destinationId(item.botId);
  if (botId) next.botId = botId;
  const sessionId = destinationId(item.sessionId);
  if (sessionId) next.sessionId = sessionId;
  const backendId = destinationId(item.backendId);
  if (backendId) next.backendId = backendId;
  const turnId = destinationId(item.turnId);
  if (turnId) next.turnId = turnId;
  const run = isQueuedRunShape(item.run) ? item.run : undefined;
  if (run) {
    const bot = destinationId(run.bot);
    next.run = bot ? { bot } : {};
  }
  return next;
}

function isActivityRun(value: unknown): value is ActivityRun {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    typeof raw.prompt === 'string' &&
    typeof raw.status === 'string' &&
    typeof raw.startedAt === 'number' &&
    Array.isArray(raw.events)
  );
}

export async function loadOfflineQueue(): Promise<OfflineQueueItem[]> {
  let raw: string | null;
  try {
    raw = await keyValueStorage.getItem(OFFLINE_QUEUE_KEY);
  } catch (error) {
    // AsyncStorage can refuse a read (an Android row-size or SQLite fault), and
    // this load is one of the four in the provider's `Promise.all` — a throw
    // here fails the whole bootstrap rather than starting with an empty outbox.
    console.warn(`[session-persistence] Could not read the offline queue: ${errorText(error)}`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOfflineQueueItem).map(normalizeOfflineQueueItem);
  } catch {
    return [];
  }
}

export async function saveOfflineQueue(items: OfflineQueueItem[]): Promise<void> {
  if (items.length === 0) {
    await keyValueStorage.removeItem(OFFLINE_QUEUE_KEY);
    return;
  }
  await keyValueStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
}

/**
 * The rows the durable copy must hold. A flush takes its batch off the queue so
 * no second flush can pick it up, but those rows are still the operator's unsent
 * words: the copy on disk is the queue PLUS every row the flush still owes, so a
 * process the OS reclaims mid-flush (a streamed reply is seconds long) comes back
 * to exactly the rows whose sends never returned instead of losing them.
 *
 * A row is written once. The flush's own put-back can leave a row on the queue
 * while the flush still lists it as owed, and the operator's line must not grow a
 * second copy in the outbox over that bookkeeping order. The queue's own rows keep
 * their order and the still-owed rows follow them.
 *
 * Nothing owed hands back the queue itself, so a write with no flush in flight is
 * the one this file always made.
 */
export function durableQueueRows(
  queue: OfflineQueueItem[],
  stillOwed: Iterable<OfflineQueueItem>,
): OfflineQueueItem[] {
  const owed = [...stillOwed];
  if (owed.length === 0) return queue;
  const onQueue = new Set(queue.map((item) => item.id));
  return [...queue, ...owed.filter((item) => !onQueue.has(item.id))];
}

/** The thread a history reload painted: its gateway, and the Bot Chat it shows. */
export type OfflineQueueScope = Pick<OfflineQueueItem, 'gatewayId' | 'botId'>;

/**
 * The queued rows that belong on the thread a reload just painted. A row that
 * names no Bot Chat — a composer line, and every legacy row — shows wherever
 * the operator is, exactly as it always has. A row that names one shows only in
 * that Bot Chat: the text was parked for one conversation, and a reload that
 * opened another must not push it under that thread's transcript.
 */
export function resurfaceOfflineQueue(
  items: OfflineQueueItem[],
  scope: OfflineQueueScope,
): OfflineQueueItem[] {
  return items.filter(
    (item) =>
      item.gatewayId === scope.gatewayId &&
      (item.botId === undefined || item.botId === scope.botId),
  );
}

/**
 * Runs interrupted mid-flight are re-marked on load — the app process is
 * gone, so local drivers and approval resolvers cannot resume them. A run
 * the gateway accepted may still have finished upstream, so it restores as
 * unresolved (the reconnect settle re-poll then learns its real fate) and
 * keeps whatever finish it already had — none, if it had none. A load time is
 * not an end: stamping one here is what let Home call work the gateway is
 * still executing a finished run.
 *
 * Only `local-` provisionals the gateway never saw restore as cancelled, and
 * those do carry the load stamp — the app closing genuinely ended them.
 */
export function normalizeRestoredRuns(runs: ActivityRun[]): ActivityRun[] {
  return runs.map((run) => {
    if (run.status !== 'running' && run.status !== 'waiting-approval') return run;
    const summary = run.summary ?? 'Interrupted when the app closed';
    if (isLocalProvisionalRunId(run.id)) {
      return {
        ...run,
        status: 'cancelled' as ActivityRun['status'],
        finishedAt: run.finishedAt ?? Date.now(),
        summary,
      };
    }
    return { ...run, status: 'unresolved' as ActivityRun['status'], summary };
  });
}

/**
 * A roster load. `read` is whether the store answered — a genuine empty
 * roster is `{ read: true, runs: [] }`. A refused getItem is `{ read: false }`
 * and must not be persisted: writing that empty list deletes the on-disk key.
 */
export type ActivityRunsLoad =
  | { read: true; runs: ActivityRun[] }
  | { read: false; runs: [] };

export async function loadActivityRuns(): Promise<ActivityRun[]> {
  return (await loadActivityRunsFromStore()).runs;
}

export async function loadActivityRunsFromStore(): Promise<ActivityRunsLoad> {
  let raw: string | null;
  try {
    raw = await keyValueStorage.getItem(ACTIVITY_RUNS_KEY);
  } catch (error) {
    // The other half of the same `Promise.all`: an unreadable run history is an
    // empty Activity tab, not a bootstrap that never settles. The caller must
    // not persist this empty stand-in — that would erase the on-disk roster.
    console.warn(`[session-persistence] Could not read activity runs: ${errorText(error)}`);
    return { read: false, runs: [] };
  }
  if (!raw) return { read: true, runs: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { read: true, runs: [] };
    return {
      read: true,
      runs: normalizeRestoredRuns(parsed.filter(isActivityRun).slice(0, ACTIVITY_RUNS_PERSIST_CAP)),
    };
  } catch {
    return { read: true, runs: [] };
  }
}

// Activity-run saves are whole-list writes to one key, each carrying the state
// it was called with. Two overlapping saves enqueue in call order and the last
// one holds the newest runs; without ordering a slow older write can land after
// a newer one and leave stale runs on disk. Serialize through a single promise
// chain so each save writes in enqueue order — the newest enqueued list is
// always the last one written. Reads stay off the queue: a load racing a write
// may observe the pre-write state, which is acceptable, while keeping
// loadActivityRuns off the queue avoids adding latency to the Activity restore.
//
// The queue also COALESCES, because a save is not one event but one per event:
// a long agentic run calls `patchActivityRuns` for every tool event it streams,
// and ordering alone turned 500 events into 500 whole-list serializes queued
// against the store — competing with the Activity screen's own reads for it, and
// growing without bound while the run streams. `transcript.ts` solves the twin of
// this (a write per `/agent` delta) with a trailing debounce; here the store's
// own round trip IS the window, so the newest list is simply held until the
// write in flight drains it. Nothing is lost: the holder is drained whatever the
// write did, and the last list always lands.
let activityRunsWriteTail: Promise<void> = Promise.resolve();
let activityRunsHeld: ActivityRun[] | null = null;
let activityRunsDrain: Promise<void> | null = null;

function enqueueActivityRunsWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = activityRunsWriteTail.then(task);
  // A failed write must reject its own caller without poisoning the queue:
  // the tail always settles resolved so the next save still runs.
  activityRunsWriteTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function writeActivityRuns(runs: ActivityRun[]): Promise<void> {
  const capped = runs.slice(0, ACTIVITY_RUNS_PERSIST_CAP);
  if (capped.length === 0) {
    return keyValueStorage.removeItem(ACTIVITY_RUNS_KEY);
  }
  return keyValueStorage.setItem(ACTIVITY_RUNS_KEY, JSON.stringify(capped));
}

/**
 * Write the newest list this device has, collapsing everything that arrived
 * while a write was in flight. One refused write is reported once its own
 * caller has had the answer; the tail still settles resolved so a later save
 * runs.
 */
function drainActivityRuns(): Promise<void> {
  const drain = (async () => {
    let failure: unknown;
    try {
      for (;;) {
        const next = activityRunsHeld;
        if (!next) break;
        activityRunsHeld = null;
        try {
          await enqueueActivityRunsWrite(() => writeActivityRuns(next));
        } catch (error) {
          failure ??= error;
        }
      }
    } finally {
      activityRunsDrain = null;
    }
    if (failure !== undefined) throw failure;
  })();
  activityRunsDrain = drain;
  return drain;
}

export function saveActivityRuns(runs: ActivityRun[]): Promise<void> {
  // The newest list wins: a superseded one is never written, and the promise a
  // caller holds settles when the drain that carries its list is done — so
  // `await saveActivityRuns(...)` still means "the store holds this".
  activityRunsHeld = runs;
  return activityRunsDrain ?? drainActivityRuns();
}
