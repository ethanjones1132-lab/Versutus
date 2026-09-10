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

export type OfflineQueueItem = {
  id: string;
  text: string;
  gatewayId: string;
  createdAt: number;
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
};

/** Where a queued line was typed for, when it was a reply to a notice. */
export type OfflineQueueDestination = Pick<OfflineQueueItem, 'botId' | 'sessionId'>;

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
 * The row as it must be held: the validated fields kept, and a destination
 * read the way this app reads every other id. An id it cannot read is not an
 * id, so it is dropped rather than steering a send somewhere the payload never
 * named — and the FIELD is what is dropped, not the row: the operator's words
 * are worth more than the destination beside them.
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
  const raw = await keyValueStorage.getItem(OFFLINE_QUEUE_KEY);
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
 * unresolved (the reconnect settle re-poll then learns its real fate);
 * only `local-` provisionals the gateway never saw restore as cancelled.
 */
export function normalizeRestoredRuns(runs: ActivityRun[]): ActivityRun[] {
  return runs.map((run) => {
    if (run.status === 'running' || run.status === 'waiting-approval') {
      return {
        ...run,
        status: (isLocalProvisionalRunId(run.id) ? 'cancelled' : 'unresolved') as ActivityRun['status'],
        finishedAt: run.finishedAt ?? Date.now(),
        summary: run.summary ?? 'Interrupted when the app closed',
      };
    }
    return run;
  });
}

export async function loadActivityRuns(): Promise<ActivityRun[]> {
  const raw = await keyValueStorage.getItem(ACTIVITY_RUNS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeRestoredRuns(parsed.filter(isActivityRun).slice(0, ACTIVITY_RUNS_PERSIST_CAP));
  } catch {
    return [];
  }
}

export async function saveActivityRuns(runs: ActivityRun[]): Promise<void> {
  const capped = runs.slice(0, ACTIVITY_RUNS_PERSIST_CAP);
  if (capped.length === 0) {
    await keyValueStorage.removeItem(ACTIVITY_RUNS_KEY);
    return;
  }
  await keyValueStorage.setItem(ACTIVITY_RUNS_KEY, JSON.stringify(capped));
}
