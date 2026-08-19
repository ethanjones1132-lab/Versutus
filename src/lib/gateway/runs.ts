// ─── Agentic run orchestration with approval gates ────────────────
// Hermes-only surface (ADR-0001): approvals are outbound — the app
// resolves approvals for runs it initiated. The gateway exposes no
// pending-approval list, so approval detection matches the typed
// `approval.required` contract first and only then falls back to loose
// string matching across run statuses and event types.

import type { RunEvent, RunResponse, RunStatus } from '@/lib/gateway/types';

export type RunCapableClient = {
  startRun(prompt: string, options?: { sessionId?: string; model?: string }): Promise<RunResponse>;
  getRunStatus(runId: string): Promise<RunStatus>;
  streamRunEvents(runId: string, onEvent: (event: RunEvent) => void, signal?: AbortSignal): Promise<void>;
  resolveApproval(runId: string, approved: boolean, feedback?: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
};

export type RunOutcome = {
  runId: string;
  status: string;
  result?: string;
  error?: string;
  approved?: boolean;
  cancelled?: boolean;
  /**
   * The run never reached a terminal status before the client stopped
   * polling. The work may still be going server-side — callers must not
   * present this as a finished run.
   */
  unresolved?: boolean;
};

export type RunTaskOptions = {
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  /** Called once the gateway accepts the run and returns its id. */
  onStarted?: (runId: string) => void;
  /** Called for non-approval events (streamed from the gateway). */
  onEvent?: (event: RunEvent) => void;
  /** Called when the gateway requests approval; resolves with the user's decision. */
  onApprovalRequired: (runId: string, prompt: string) => Promise<{ approved: boolean; feedback?: string }>;
  /** Delay between status polls after a stream closes without progress. */
  pollDelayMs?: number;
  /** Injectable for tests so no-progress backoff does not cost real time. */
  sleep?: (ms: number) => Promise<void>;
};

/** App-side view of a run for activity surfaces (in-memory, per app session). */
export type ActivityRun = {
  id: string;
  prompt: string;
  status: 'running' | 'waiting-approval' | 'complete' | 'failed' | 'cancelled' | 'unresolved';
  startedAt: number;
  finishedAt?: number;
  /** Result or error excerpt. */
  summary?: string;
  /** Recent event previews, capped (newest last). */
  events: { type: string; preview: string; timestamp?: number }[];
  approved?: boolean;
};

export const ACTIVITY_EVENT_CAP = 50;

/** Defensive one-line preview of a run event payload. */
export function runEventPreview(event: RunEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  const candidate =
    data?.deltaText ?? data?.text ?? data?.message ?? data?.status ?? data?.error ?? data?.errorMessage;
  const raw = typeof candidate === 'string' && candidate ? candidate : JSON.stringify(data ?? {});
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

// ─── Approval signals ─────────────────────────────────────────────
// The normalized CLI-environment contract emits a typed `approval.required`
// event (see docs/opencode-backend-contract.md). Typed signals are matched
// first; the loose fallback exists only for gateways predating that contract.

/** Typed approval request from the normalized event contract. */
export const APPROVAL_REQUIRED_EVENT = 'approval.required';

const APPROVAL_REQUIRED_SIGNALS = new Set([
  APPROVAL_REQUIRED_EVENT,
  'approval-required',
  'approval_required',
  'waiting-approval',
  'waiting_approval',
  'pending-approval',
  'pending_approval',
  'needs-approval',
  'needs_approval',
]);

/** Mentions approval, but reports a decision that has already been made. */
const APPROVAL_RESOLVED = /(approved|denied|rejected|resolved|granted)/;

/**
 * Whether a run status or event type is asking the user to approve something.
 *
 * Resolved decisions are explicitly excluded: a bare `/approv/` test also
 * matches `approved` and `approval.resolved`, which re-opens the prompt for a
 * decision the user already made and can loop the run against the poll cap.
 */
export function runNeedsApproval(signal: string): boolean {
  const normalized = signal.trim().toLowerCase();
  if (!normalized) return false;
  if (APPROVAL_REQUIRED_SIGNALS.has(normalized)) return true;
  if (!normalized.includes('approv')) return false;
  return !APPROVAL_RESOLVED.test(normalized);
}

export function isTerminalRunStatus(status: string): boolean {
  return /(complete|succeeded|success|done|finished|failed|error|cancelled|canceled|aborted)/i.test(status);
}

function isTerminalSuccessStatus(status: string): boolean {
  return /(complete|succeeded|success|done|finished)/i.test(status);
}

/**
 * Map a gateway run status string to the activity-run status the UI renders.
 */
export function runStatusToActivityStatus(status: string): ActivityRun['status'] {
  if (!isTerminalRunStatus(status)) return 'unresolved';
  if (/cancelled|canceled|aborted/i.test(status)) return 'cancelled';
  return isTerminalSuccessStatus(status) ? 'complete' : 'failed';
}

/**
 * Map a run outcome to the activity-run status the UI renders.
 * Keeps `unresolved` distinct from `complete` — a run that never reached a
 * terminal state must not be presented as finished.
 */
export function outcomeToActivityStatus(outcome: RunOutcome): ActivityRun['status'] {
  if (outcome.cancelled) return 'cancelled';
  if (outcome.unresolved) return 'unresolved';
  return runStatusToActivityStatus(outcome.status);
}

const MAX_STATUS_POLLS = 120;
const DEFAULT_POLL_DELAY_MS = 1000;

/**
 * Start a run and drive it to a terminal state, pausing for the user's
 * decision whenever the gateway requests approval.
 */
export async function executeRun(
  client: RunCapableClient,
  prompt: string,
  options: RunTaskOptions,
): Promise<RunOutcome> {
  const { run_id: runId } = await client.startRun(prompt, {
    sessionId: options.sessionId,
    model: options.model,
  });
  options.onStarted?.(runId);

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;

  let approved: boolean | undefined;
  let status = safeStatus(await client.getRunStatus(runId));
  let reachedTerminal = isTerminalRunStatus(status);

  for (let iteration = 0; iteration < MAX_STATUS_POLLS && !reachedTerminal; iteration += 1) {
    if (options.signal?.aborted) {
      await client.stopRun(runId).catch(() => undefined);
      return { runId, status: 'cancelled', cancelled: true, approved };
    }

    if (runNeedsApproval(status)) {
      const decision = await options.onApprovalRequired(runId, prompt);
      approved = decision.approved;
      await client.resolveApproval(runId, decision.approved, decision.feedback).catch(() => undefined);
      status = safeStatus(await client.getRunStatus(runId));
      reachedTerminal = isTerminalRunStatus(status);
      continue;
    }

    await client
      .streamRunEvents(
        runId,
        (event) => {
          const eventStatus = String((event.data as Record<string, unknown> | undefined)?.status ?? '');
          if (runNeedsApproval(event.type) || (eventStatus && runNeedsApproval(eventStatus))) {
            return;
          }
          options.onEvent?.(event);
        },
        options.signal,
      )
      .catch(() => undefined);

    if (options.signal?.aborted) {
      await client.stopRun(runId).catch(() => undefined);
      return { runId, status: 'cancelled', cancelled: true, approved };
    }

    const previousStatus = status;
    status = safeStatus(await client.getRunStatus(runId));
    reachedTerminal = isTerminalRunStatus(status);

    // The event stream closed while the run is still going. An unchanged
    // status is not a finish — back off briefly and poll again rather than
    // reporting mid-flight state as the final word.
    if (!reachedTerminal && status === previousStatus) {
      await sleep(pollDelayMs);
    }
  }

  const final = await client.getRunStatus(runId).catch(() => null);
  const finalStatus = safeStatus(final);
  const unresolved = !isTerminalRunStatus(finalStatus);

  return {
    runId,
    status: finalStatus,
    result: final?.result,
    error:
      final?.error ??
      (unresolved
        ? 'The run never reached a terminal state; it may still be running on the gateway.'
        : undefined),
    approved,
    ...(unresolved ? { unresolved: true } : {}),
  };
}

function safeStatus(run: RunStatus | null): string {
  return run?.status ?? 'unknown';
}

/**
 * Re-poll unresolved runs after a reconnect and settle them to their real
 * terminal state. Returns the updated runs and which ones changed.
 */
export async function settleUnresolvedRuns(
  client: Pick<RunCapableClient, 'getRunStatus'>,
  runs: ActivityRun[],
): Promise<{ runs: ActivityRun[]; changed: ActivityRun[] }> {
  const next: ActivityRun[] = [];
  const changed: ActivityRun[] = [];

  for (const run of runs) {
    if (run.status !== 'unresolved') {
      next.push(run);
      continue;
    }

    const status = await client.getRunStatus(run.id).catch(() => null);
    const settled = status ? runStatusToActivityStatus(safeStatus(status)) : 'unresolved';
    if (settled !== 'unresolved') {
      const updated: ActivityRun = {
        ...run,
        status: settled,
        finishedAt: Date.now(),
        summary: status?.result ?? status?.error ?? run.summary,
      };
      next.push(updated);
      changed.push(updated);
    } else {
      next.push(run);
    }
  }

  return { runs: next, changed };
}
