// ─── Durable offline outbox + recent activity runs ────────────────
// Survives app kill so queued chat and run history are not purely
// in-memory. Secrets never go here — only message text and run metadata.

import type { ActivityRun } from '@/lib/gateway/runs';
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
};

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
    return parsed.filter(isOfflineQueueItem);
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
 * Runs interrupted mid-flight are marked cancelled on load — the app process
 * is gone, so local drivers and approval resolvers cannot resume them.
 */
export function normalizeRestoredRuns(runs: ActivityRun[]): ActivityRun[] {
  return runs.map((run) => {
    if (run.status === 'running' || run.status === 'waiting-approval') {
      return {
        ...run,
        status: 'cancelled' as const,
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
