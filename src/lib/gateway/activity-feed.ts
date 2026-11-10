/**
 * The Gate's universal activity and routine reads, parsed and folded without
 * tying their wire contract to a screen or transport.
 */

import { GatewayHttpError } from './errors';

export type ActivityBackendStatus = 'complete' | 'partial' | 'unavailable' | 'failed';

export type ActivityCoverage = {
  id: string;
  label: string;
  status: ActivityBackendStatus;
  error?: string;
};

export type ActivityMetrics = {
  turns?: number;
  tools?: number;
  tokens?: number;
  costUsd?: number;
};

export type ActivityItem = {
  id: string;
  backendId: string;
  botId?: string;
  kind: 'run' | 'session';
  sessionId?: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  title: string;
  metrics: ActivityMetrics;
};

export type ActivityFeed = {
  since: string;
  generatedAt: string;
  backends: ActivityCoverage[];
  items: ActivityItem[];
  truncated?: { window?: true; items?: true };
};

export type RoutineEntry = {
  id: string;
  backendId: string;
  botId?: string;
  name: string;
  schedule?: string;
  paused: boolean;
  lastRunAt?: string;
  lastStatus?: string;
  nextRunAt?: string;
};

export type RoutineFeed = {
  generatedAt: string;
  backends: ActivityCoverage[];
  routines: RoutineEntry[];
};

export class ActivityFeedParseError extends Error {
  constructor(route: string) {
    super(`Invalid response from ${route}.`);
    this.name = 'ActivityFeedParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseCoverage(value: unknown): ActivityCoverage | null {
  if (!isRecord(value)) return null;
  // A coverage row the app cannot match to an item or a chip is not a fact it
  // can show; an empty id would only ever collide with every other empty one.
  const id = nonEmptyString(value.id);
  if (!id) return null;
  if (
    value.status !== 'complete' &&
    value.status !== 'partial' &&
    value.status !== 'unavailable' &&
    value.status !== 'failed'
  ) {
    return null;
  }
  const coverage: ActivityCoverage = {
    id,
    // An unlabelled backend still needs a name on the chip: its id is the one
    // the Gate proved, which beats a blank row.
    label: nonEmptyString(value.label) ?? id,
    status: value.status,
  };
  const error = nonEmptyString(value.error);
  if (error) coverage.error = error;
  return coverage;
}

function parseMetrics(value: unknown): ActivityMetrics {
  if (!isRecord(value)) return {};
  const metrics: ActivityMetrics = {};
  for (const key of ['turns', 'tools', 'tokens'] as const) {
    const metric = value[key];
    if (typeof metric === 'number' && Number.isFinite(metric) && metric > 0) metrics[key] = metric;
  }
  const costUsd = value.costUsd;
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0) {
    metrics.costUsd = costUsd;
  }
  return metrics;
}

function parseActivityItem(value: unknown): ActivityItem | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const backendId = nonEmptyString(value.backendId);
  const title = nonEmptyString(value.title);
  const startedAt = nonEmptyString(value.startedAt);
  if (!id || !backendId || !title || !startedAt || !Number.isFinite(Date.parse(startedAt))) return null;
  if (value.kind !== 'run' && value.kind !== 'session') return null;
  const item: ActivityItem = {
    id,
    backendId,
    kind: value.kind,
    startedAt,
    status: stringOrEmpty(value.status),
    title,
    metrics: parseMetrics(value.metrics),
  };
  const botId = nonEmptyString(value.botId);
  const sessionId = nonEmptyString(value.sessionId);
  const finishedAt = nonEmptyString(value.finishedAt);
  if (botId) item.botId = botId;
  if (sessionId) item.sessionId = sessionId;
  if (finishedAt) item.finishedAt = finishedAt;
  return item;
}

function parseRoutine(value: unknown): RoutineEntry | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const backendId = nonEmptyString(value.backendId);
  const name = nonEmptyString(value.name);
  if (!id || !backendId || !name) return null;
  const routine: RoutineEntry = { id, backendId, name, paused: value.paused === true };
  const botId = nonEmptyString(value.botId);
  const schedule = nonEmptyString(value.schedule);
  const lastRunAt = nonEmptyString(value.lastRunAt);
  const lastStatus = nonEmptyString(value.lastStatus);
  const nextRunAt = nonEmptyString(value.nextRunAt);
  if (botId) routine.botId = botId;
  if (schedule) routine.schedule = schedule;
  if (lastRunAt) routine.lastRunAt = lastRunAt;
  if (lastStatus) routine.lastStatus = lastStatus;
  if (nextRunAt) routine.nextRunAt = nextRunAt;
  return routine;
}

export function parseActivityFeed(raw: unknown): ActivityFeed {
  if (!isRecord(raw) || typeof raw.since !== 'string' || typeof raw.generatedAt !== 'string') {
    throw new ActivityFeedParseError('/v1/activity');
  }
  const backends = rows(raw.backends).flatMap((backend) => {
    const parsed = parseCoverage(backend);
    return parsed ? [parsed] : [];
  });
  const items = rows(raw.items).flatMap((item) => {
    const parsed = parseActivityItem(item);
    return parsed ? [parsed] : [];
  });
  const truncatedRaw = isRecord(raw.truncated) ? raw.truncated : undefined;
  const truncated = truncatedRaw && (truncatedRaw.window === true || truncatedRaw.items === true)
    ? {
        ...(truncatedRaw.window === true ? { window: true as const } : {}),
        ...(truncatedRaw.items === true ? { items: true as const } : {}),
      }
    : undefined;
  return {
    since: stringOrEmpty(raw.since),
    generatedAt: stringOrEmpty(raw.generatedAt),
    backends,
    items,
    ...(truncated ? { truncated } : {}),
  };
}

export function parseRoutineFeed(raw: unknown): RoutineFeed {
  if (!isRecord(raw) || typeof raw.generatedAt !== 'string') throw new ActivityFeedParseError('/v1/routines');
  const backends = rows(raw.backends).flatMap((backend) => {
    const parsed = parseCoverage(backend);
    return parsed ? [parsed] : [];
  });
  const routines = rows(raw.routines).flatMap((routine) => {
    const parsed = parseRoutine(routine);
    return parsed ? [parsed] : [];
  });
  return { generatedAt: stringOrEmpty(raw.generatedAt), backends, routines };
}

export function todaySince(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

export function activityCounts(items: ActivityItem[]): { runs: number; sessions: number } {
  return items.reduce(
    (counts, item) => {
      if (item.kind === 'run') counts.runs += 1;
      else counts.sessions += 1;
      return counts;
    },
    { runs: 0, sessions: 0 },
  );
}

export function coverageNotice(coverage: ActivityCoverage): string | undefined {
  switch (coverage.status) {
    case 'complete':
      return undefined;
    case 'partial':
      return "Some of this backend's activity could not be read";
    case 'unavailable':
      return "Activity isn't supported by this backend";
    case 'failed':
      return "This backend's activity could not be read";
  }
}

export function readFailureKind(error: unknown): 'unsupported' | 'unauthorized' | 'offline' | 'failed' {
  if (error instanceof GatewayHttpError) {
    if (error.status === 404) return 'unsupported';
    if (error.status === 401 || error.status === 403) return 'unauthorized';
    return 'failed';
  }
  if (error instanceof TypeError) return 'offline';
  const message = error instanceof Error ? error.message : '';
  if (/network|fetch|timed out|abort/i.test(message)) return 'offline';
  return 'failed';
}

export type ActivityState = {
  feed?: ActivityFeed;
  loaded: boolean;
  failed: boolean;
  error?: string;
  updatedAt?: number;
};

export const EMPTY_ACTIVITY_STATE: ActivityState = { loaded: false, failed: false };

export function applyActivityRead(
  previous: ActivityState,
  read: { ok: true; feed: ActivityFeed } | { ok: false; error?: string },
  now?: number,
): ActivityState {
  if (read.ok) {
    const generatedAt = Date.parse(read.feed.generatedAt);
    return {
      feed: read.feed,
      loaded: true,
      failed: false,
      updatedAt: Number.isFinite(generatedAt) ? generatedAt : (now ?? Date.now()),
    };
  }
  if (previous.loaded) {
    return {
      feed: previous.feed,
      loaded: true,
      failed: true,
      error: read.error,
      updatedAt: previous.updatedAt,
    };
  }
  return { loaded: false, failed: true, error: read.error };
}

export type RoutineFeedState = {
  feed?: RoutineFeed;
  loaded: boolean;
  failed: boolean;
  error?: string;
  updatedAt?: number;
};

export const EMPTY_ROUTINE_FEED_STATE: RoutineFeedState = { loaded: false, failed: false };

export function applyRoutineFeedRead(
  previous: RoutineFeedState,
  read: { ok: true; feed: RoutineFeed } | { ok: false; error?: string },
  now?: number,
): RoutineFeedState {
  if (read.ok) {
    const generatedAt = Date.parse(read.feed.generatedAt);
    return {
      feed: read.feed,
      loaded: true,
      failed: false,
      updatedAt: Number.isFinite(generatedAt) ? generatedAt : (now ?? Date.now()),
    };
  }
  if (previous.loaded) {
    return {
      feed: previous.feed,
      loaded: true,
      failed: true,
      error: read.error,
      updatedAt: previous.updatedAt,
    };
  }
  return { loaded: false, failed: true, error: read.error };
}
