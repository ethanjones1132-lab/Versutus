// ─── Agentic run orchestration with approval gates ────────────────
// Hermes-only surface (ADR-0001): approvals are outbound — the app
// resolves approvals for runs it initiated. The gateway exposes no
// pending-approval list, so approval detection matches the typed
// `approval.required` contract first and only then falls back to loose
// string matching across run statuses and event types.

import { GatewayHttpError, isConnectionError } from '@/lib/gateway/errors';
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
  /**
   * Called when the gateway requests approval; resolves with the user's
   * decision. `commandClass` is the risk/action the gateway attached to the
   * approval event when it sent one — the policy engine's only input, never
   * the run prompt.
   */
  onApprovalRequired: (
    runId: string,
    prompt: string,
    commandClass?: string,
  ) => Promise<{ approved: boolean; feedback?: string }>;
  /** Delay between status polls after a stream closes without progress. */
  pollDelayMs?: number;
  /** Injectable for tests so no-progress backoff does not cost real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Wall-clock bound on the whole drive. Defaults to
   * MAX_RUN_WALL_CLOCK_MS; a test can shorten it rather than wait out the
   * production bound.
   */
  maxWallClockMs?: number;
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
  /**
   * The Bot this run was started for — the app's selected Bot scope when the
   * row was created. Absent on configurable chat and on every row persisted
   * before this field existed; those aggregate as unattributed and are never
   * guessed into a Bot (D3's step zero, FUTURE-ITEMS.md:792-797).
   */
  botId?: string;
  /**
   * The gateway this run was started on. Used to ensure stop/replay actions
   * target the correct gateway client. Absent on rows persisted before this
   * field existed; a run with no gatewayId can only be acted on when its
   * gateway is the active one (legacy behavior preserved).
   */
  gatewayId?: string;
};

export const ACTIVITY_EVENT_CAP = 50;

/**
 * Newest frames kept when replaying a finished run. The Gate archive is an
 * 8 MiB SSE file (backend-run-streams.mjs DEFAULT_MAX_BYTES_PER_RUN); holding
 * every frame in JS memory is what OOMs a mid-range phone. A few thousand of
 * the newest lines is still a long transcript and fits in a windowed list.
 */
export const RUN_TRANSCRIPT_EVENT_CAP = 4_000;

/** One replay page: the newest window, plus how many older frames were dropped. */
export type RunTranscriptPage = {
  events: RunEvent[];
  omitted: number;
};

/**
 * Fold one replay frame into a newest-window. Compacts in batches of `cap` so
 * a long stream is O(n) and peak memory is 2× the kept window, not the Gate's
 * 8 MiB archive.
 */
export function pushRunTranscriptEvent(
  page: RunTranscriptPage,
  event: RunEvent,
  cap: number = RUN_TRANSCRIPT_EVENT_CAP,
): void {
  page.events.push(event);
  if (page.events.length < cap * 2) return;
  page.omitted += page.events.length - cap;
  page.events = page.events.slice(-cap);
}

/** Drop leftover overflow after the stream closes. */
export function finishRunTranscript(
  page: RunTranscriptPage,
  cap: number = RUN_TRANSCRIPT_EVENT_CAP,
): RunTranscriptPage {
  if (page.events.length <= cap) return page;
  const extra = page.events.length - cap;
  return { events: page.events.slice(-cap), omitted: page.omitted + extra };
}

/**
 * The runs Home, Activity and the widget show for one gateway. A run saved
 * before `gatewayId` existed names no gateway; it stays visible under the
 * active one (the pre-scoping behaviour) instead of silently vanishing from
 * every screen, which is what a strict id match did to existing history.
 */
export function runsForGateway(runs: ActivityRun[], gatewayId: string | undefined): ActivityRun[] {
  if (!gatewayId) return [];
  return runs.filter((run) => !run.gatewayId || run.gatewayId === gatewayId);
}

/** Defensive one-line preview of a run event payload. */
export function runEventPreview(event: RunEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  // Precedence is intentional: streaming candidates (`deltaText`, `text`,
  // `message`) come first so a live `message.delta` event still shows its
  // text; `status` next because a status string is often enough on its own;
  // `error` / `errorMessage` ahead of `result` so a `run.failed` surfaces the
  // failure, not the partial answer the run had typed before it failed; and
  // `result` last so the common `run.completed` case reads as the final
  // answer (docs/opencode-backend-contract.md:216) without ever beating an
  // error or a status that explains why there is no result.
  const candidate =
    data?.deltaText ??
    data?.text ??
    data?.message ??
    data?.status ??
    data?.error ??
    data?.errorMessage ??
    data?.result;
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
  return /(?:^|[^a-z])(complete|completed|succeeded|success|done|finished|failed|error|cancelled|canceled|aborted)(?:$|[^a-z])/i.test(status);
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
  // A stop the gateway did not confirm arrives as both cancelled and
  // unresolved. Unresolved wins: the only honest thing that outcome says is
  // that the run's fate is unknown. Rendering it as a plain 'cancelled'
  // repeats the exact lie requestStop exists to prevent, and would exclude
  // the run from settleUnresolvedRuns' reconnect re-poll — the mechanism
  // that eventually learns the truth.
  if (outcome.unresolved) return 'unresolved';
  if (outcome.cancelled) return 'cancelled';
  return runStatusToActivityStatus(outcome.status);
}

const MAX_STATUS_POLLS = 120;
const DEFAULT_POLL_DELAY_MS = 1000;

/**
 * The wall-clock bound on one run's event streaming.
 *
 * The Gate's run-events relay sends a keepalive every 15 s and the transport's
 * idle watchdog is reset by any bytes, so a wedged-but-alive environment keeps
 * the socket looking healthy while the run never reaches a terminal status.
 * `MAX_STATUS_POLLS` cannot save it: the loop is parked inside one
 * `streamRunEvents` await, not counting polls. A run that outlives this bound
 * settles `unresolved` instead, and the reconnect path re-reads it.
 */
export const MAX_RUN_WALL_CLOCK_MS = 30 * 60 * 1000;

/** Sentinel for `raceDeadline`: the wall clock ran out before the work did. */
const RUN_DEADLINE = Symbol('run-deadline');

/**
 * Await `work`, but stop waiting after `remainingMs`. The work is not
 * cancelled, only abandoned; its own signal (if any) is the caller's to abort.
 * The timer is always cleared, so a settled race leaves none behind.
 */
async function raceDeadline<T>(
  work: Promise<T>,
  remainingMs: number,
): Promise<T | typeof RUN_DEADLINE> {
  if (remainingMs <= 0) return RUN_DEADLINE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof RUN_DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(RUN_DEADLINE), remainingMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Spread of the no-progress poll wait around its base delay, so runs that
 * started together do not poll the gateway in lockstep under load.
 */
export const POLL_JITTER_MS = 200;

/**
 * Offset a poll delay by up to ±POLL_JITTER_MS. The sample is injectable so
 * tests stay deterministic; production callers use the Math.random default.
 * Clamped at zero so small custom delays never go negative.
 */
export function jitteredPollDelay(baseMs: number, sample: number = Math.random()): number {
  return Math.max(0, baseMs + (sample * 2 - 1) * POLL_JITTER_MS);
}

/**
 * Backoff between status-read attempts: 500 ms, then 1500 ms. Two beats ride
 * out a dropped request on a mobile radio without turning a short outage into
 * a run that hangs for half a minute. Jittered like the poll delay, so runs
 * that lost their gateway at the same moment do not retry in lockstep.
 */
const STATUS_RETRY_DELAYS_MS = [500, 1500];

/**
 * Whether a failed status read is worth repeating. A transport failure or a
 * 5xx says the gateway never told us anything — the same read a moment later
 * may well succeed. A 4xx is the gateway's own considered answer, and asking
 * again only spends the backoff to be told the same thing.
 */
function isRetryableStatusError(error: unknown): boolean {
  if (error instanceof GatewayHttpError) return error.status >= 500;
  return isConnectionError(error);
}

/**
 * Read a run's status, riding out a transient failure.
 *
 * One lost request used to end the driver on the spot: `executeRun` returned
 * `{ status: 'unknown', unresolved: true }`, and only a full reconnect — the
 * provider's `settleUnresolvedRuns` — ever read the run again, so a blip that
 * never tripped the connection monitor left it unresolved for good. A 4xx is
 * still returned to the caller immediately.
 */
async function readStatusWithRetry(
  client: Pick<RunCapableClient, 'getRunStatus'>,
  runId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<RunStatus> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.getRunStatus(runId);
    } catch (error) {
      const backoff = STATUS_RETRY_DELAYS_MS[attempt];
      if (backoff === undefined || !isRetryableStatusError(error)) throw error;
      await sleep(jitteredPollDelay(backoff));
    }
  }
}

/**
 * Start a run and drive it to a terminal state, pausing for the user's
 * decision whenever the gateway requests approval.
 */
/**
 * Ask the gateway to stop a run, and say so honestly when it would not.
 *
 * Both call sites used `.catch(() => undefined)` and then returned
 * `cancelled: true` regardless — telling the user the run was over while it
 * kept burning tokens upstream. That is the same lie the Gate refuses to tell:
 * the Hermes backend leaves session abort throwing rather than fake a cancel,
 * precisely so a cancellation that never happened is not reported as one.
 *
 * `unresolved` already carries the right meaning for callers, so a failed stop
 * reuses it rather than inventing a second signal.
 */
async function requestStop(
  client: Parameters<typeof executeRun>[0],
  runId: string,
): Promise<{ unresolved?: true; error?: string }> {
  try {
    await client.stopRun(runId);
    return {};
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      unresolved: true,
      error: `Stop was requested but the gateway did not confirm it (${detail}). The run may still be going.`,
    };
  }
}

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
  const deadlineAt = Date.now() + (options.maxWallClockMs ?? MAX_RUN_WALL_CLOCK_MS);

  let approved: boolean | undefined;
  // The class the gateway attached to its approval event, if it sent one. The
  // status string alone names no class, so it stays undefined until an event
  // carries a `risk`/`action`/`class`, and the policy fails closed on it.
  let commandClass: string | undefined;

  // Initial status read after startRun — a failure here means we have an
  // accepted runId but cannot learn its state. Return unresolved so the
  // reconnect settle path can re-read it.
  let status: string;
  try {
    status = safeStatus(await readStatusWithRetry(client, runId, sleep));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      runId,
      status: 'unknown',
      error: message,
      approved,
      unresolved: true,
    };
  }
  let reachedTerminal = isTerminalRunStatus(status);

  for (let iteration = 0; iteration < MAX_STATUS_POLLS && !reachedTerminal; iteration += 1) {
    if (options.signal?.aborted) {
      const stop = await requestStop(client, runId);
      return { runId, status: 'cancelled', cancelled: true, approved, ...stop };
    }

    if (runNeedsApproval(status)) {
      const decision = await options.onApprovalRequired(runId, prompt, commandClass);
      approved = decision.approved;
      // A decision that arrived because the caller aborted is not a decision:
      // the prompt was dismissed, not answered. Posting it would tell the Gate
      // the run was denied for a run the operator merely stopped.
      if (options.signal?.aborted) {
        const stop = await requestStop(client, runId);
        return { runId, status: 'cancelled', cancelled: true, approved, ...stop };
      }
      // Deliberately non-fatal: the decision may well have registered even if
      // the response did not come back, so polling continues rather than
      // abandoning a run the user just approved. The status poll below decides.
      // Unlike a failed stop, this does not report an outcome that never happened.
      await client.resolveApproval(runId, decision.approved, decision.feedback).catch(() => undefined);
      try {
        status = safeStatus(await readStatusWithRetry(client, runId, sleep));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          runId,
          status: 'unknown',
          error: message,
          approved,
          unresolved: true,
        };
      }
      reachedTerminal = isTerminalRunStatus(status);
      continue;
    }

    // A stream that ends on a failure is a transport fact about the event
    // channel, not a verdict on the run: the status read below decides. The
    // failure is remembered rather than swallowed, because the read that
    // follows has to wait out the same first backoff a retry would — reading
    // straight into the gap the drop just left is how one lost request ended
    // the driver.
    let streamFailed = false;
    let streamTimedOut = false;
    try {
      const raced = await raceDeadline(
        client.streamRunEvents(
          runId,
          (event) => {
            const data = event.data as Record<string, unknown> | undefined;
            const eventStatus = String(data?.status ?? '');
            if (runNeedsApproval(event.type) || (eventStatus && runNeedsApproval(eventStatus))) {
              const klass = data?.risk ?? data?.action ?? data?.class;
              if (typeof klass === 'string' && klass) commandClass = klass;
              return;
            }
            options.onEvent?.(event);
          },
          options.signal,
        ),
        deadlineAt - Date.now(),
      );
      streamTimedOut = raced === RUN_DEADLINE;
    } catch {
      streamFailed = true;
    }

    // The wall clock ran out mid-stream: stop driving and report unresolved.
    // The run may still be going server-side, so `settleUnresolvedRuns` re-reads
    // it on the next reconnect instead of the row living as "Working" forever.
    if (streamTimedOut) break;

    if (options.signal?.aborted) {
      const stop = await requestStop(client, runId);
      return { runId, status: 'cancelled', cancelled: true, approved, ...stop };
    }

    // Asked after the abort check, so a run the user just stopped is never made
    // to wait out a backoff on its way to being cancelled.
    if (streamFailed) await sleep(jitteredPollDelay(STATUS_RETRY_DELAYS_MS[0]));

    const previousStatus = status;
    try {
      status = safeStatus(await readStatusWithRetry(client, runId, sleep));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        runId,
        status: 'unknown',
        error: message,
        approved,
        unresolved: true,
      };
    }
    reachedTerminal = isTerminalRunStatus(status);

    // The event stream closed while the run is still going. An unchanged
    // status is not a finish — back off briefly and poll again rather than
    // reporting mid-flight state as the final word.
    if (!reachedTerminal && status === previousStatus) {
      await sleep(jitteredPollDelay(pollDelayMs));
    }
  }

  const final = await readStatusWithRetry(client, runId, sleep).catch(() => null);
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
