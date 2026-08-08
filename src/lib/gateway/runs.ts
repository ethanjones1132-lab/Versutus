// ─── Agentic run orchestration with approval gates ────────────────
// Hermes-only surface (ADR-0001): approvals are outbound — the app
// resolves approvals for runs it initiated. The gateway exposes no
// pending-approval list, so approval detection is defensive string
// matching across run statuses and event types.

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
};

export type RunTaskOptions = {
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  /** Called for non-approval events (streamed from the gateway). */
  onEvent?: (event: RunEvent) => void;
  /** Called when the gateway requests approval; resolves with the user's decision. */
  onApprovalRequired: (runId: string, prompt: string) => Promise<{ approved: boolean; feedback?: string }>;
};

export function runNeedsApproval(status: string): boolean {
  return /approv/i.test(status);
}

export function isTerminalRunStatus(status: string): boolean {
  return /(complete|succeeded|success|done|finished|failed|error|cancelled|canceled|aborted)/i.test(status);
}

const MAX_STATUS_POLLS = 120;

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

  let approved: boolean | undefined;
  let status = safeStatus(await client.getRunStatus(runId));
  let previousStatus = '';

  for (let iteration = 0; iteration < MAX_STATUS_POLLS; iteration += 1) {
    if (options.signal?.aborted) {
      await client.stopRun(runId).catch(() => undefined);
      return { runId, status: 'cancelled', cancelled: true, approved };
    }

    if (runNeedsApproval(status)) {
      const decision = await options.onApprovalRequired(runId, prompt);
      approved = decision.approved;
      await client.resolveApproval(runId, decision.approved, decision.feedback).catch(() => undefined);
      status = safeStatus(await client.getRunStatus(runId));
      continue;
    }

    if (isTerminalRunStatus(status)) break;

    let sawApprovalEvent = false;
    await client
      .streamRunEvents(
        runId,
        (event) => {
          const eventStatus = String((event.data as Record<string, unknown> | undefined)?.status ?? '');
          if (runNeedsApproval(event.type) || (eventStatus && runNeedsApproval(eventStatus))) {
            sawApprovalEvent = true;
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

    previousStatus = status;
    status = safeStatus(await client.getRunStatus(runId));

    // Guard against a run stuck mid-flight that keeps re-opening event
    // streams without progressing — surface it rather than spin forever.
    if (status === previousStatus && !runNeedsApproval(status)) break;
  }

  const final = await client.getRunStatus(runId).catch(() => null);
  return {
    runId,
    status: safeStatus(final),
    result: final?.result,
    error: final?.error,
    approved,
  };
}

function safeStatus(run: RunStatus | null): string {
  return run?.status ?? 'unknown';
}
