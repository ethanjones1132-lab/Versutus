import { executeRun, isTerminalRunStatus, runNeedsApproval, type RunCapableClient } from '@/lib/gateway/runs';
import type { RunResponse, RunStatus } from '@/lib/gateway/types';

/**
 * A client whose run status walks a scripted sequence, holding on the last
 * entry forever. `streamRunEvents` resolves immediately — modelling the
 * gateway closing the SSE stream while the run is still in flight.
 */
function scriptedClient(statuses: string[], overrides: Partial<RunCapableClient> = {}) {
  let index = 0;
  const calls = { status: 0, stop: 0, stream: 0 };

  const client: RunCapableClient = {
    async startRun(): Promise<RunResponse> {
      return { run_id: 'run-1', status: statuses[0] ?? 'running' };
    },
    async getRunStatus(): Promise<RunStatus> {
      calls.status += 1;
      const status = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      return {
        run_id: 'run-1',
        status,
        result: /complete/i.test(status) ? 'the answer' : undefined,
      };
    },
    async streamRunEvents() {
      calls.stream += 1;
    },
    async resolveApproval() {},
    async stopRun() {
      calls.stop += 1;
    },
    ...overrides,
  };

  return { client, calls };
}

const noSleep = async () => {};

describe('runNeedsApproval', () => {
  it('recognises the typed approval event from the normalized contract', () => {
    expect(runNeedsApproval('approval.required')).toBe(true);
  });

  it('recognises typed waiting-for-approval statuses', () => {
    expect(runNeedsApproval('waiting-approval')).toBe(true);
    expect(runNeedsApproval('approval_required')).toBe(true);
  });

  it('does not treat a resolved approval as a new request', () => {
    // The gateway reports these *after* the user has already decided. Matching
    // them re-opens the approval prompt for a decision that was made.
    expect(runNeedsApproval('approved')).toBe(false);
    expect(runNeedsApproval('approval.resolved')).toBe(false);
    expect(runNeedsApproval('auto-approved')).toBe(false);
    expect(runNeedsApproval('denied')).toBe(false);
  });

  it('still falls back to loose matching for untyped gateway wording', () => {
    expect(runNeedsApproval('awaiting_approval_from_user')).toBe(true);
  });

  it('ignores unrelated statuses', () => {
    expect(runNeedsApproval('running')).toBe(false);
    expect(runNeedsApproval('')).toBe(false);
  });
});

describe('executeRun terminal-state handling', () => {
  it('keeps polling when the stream closes on a still-running run', async () => {
    const { client } = scriptedClient(['running', 'running', 'running', 'completed']);

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep: noSleep,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toBe('the answer');
    expect(outcome.unresolved).toBeFalsy();
  });

  it('marks a run unresolved rather than reporting a non-terminal status as final', async () => {
    const { client } = scriptedClient(['running']);

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep: noSleep,
    });

    expect(outcome.unresolved).toBe(true);
    expect(outcome.status).toBe('running');
    expect(outcome.error).toMatch(/terminal/i);
  });

  it('returns immediately once the gateway reports a terminal status', async () => {
    const { client, calls } = scriptedClient(['completed']);

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep: noSleep,
    });

    expect(outcome.status).toBe('completed');
    expect(calls.stream).toBe(0);
  });

  it('stops the run and reports cancellation when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = scriptedClient(['running']);

    const outcome = await executeRun(client, 'do the thing', {
      signal: controller.signal,
      onApprovalRequired: async () => ({ approved: true }),
      sleep: noSleep,
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.status).toBe('cancelled');
    expect(calls.stop).toBe(1);
  });
});

describe('A2 regression lock — the terminal-status classifier (isTerminalRunStatus)', () => {
  // The run reducer decides "is this done?" purely through this classifier.
  // A heuristic widening it into in-flight states (running/pending/unknown)
  // would present a half-finished run as complete — the exact silent trust
  // break A2 exists to stop. Pin both directions.

  it('treats every gateway terminal word as terminal', () => {
    for (const status of [
      'complete',
      'completed',
      'succeeded',
      'success',
      'done',
      'finished',
      'failed',
      'error',
      'cancelled',
      'canceled',
      'aborted',
    ]) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it('never treats in-flight or unknown states as terminal', () => {
    for (const status of [
      'running',
      'waiting-approval',
      'waiting',
      'approved',
      'queued',
      'pending',
      'unresolved',
      'unknown',
    ]) {
      expect(isTerminalRunStatus(status)).toBe(false);
    }
  });

  it('an unresolved outcome carries a status that can never render as complete', async () => {
    const { client } = scriptedClient(['running']);

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep: noSleep,
    });

    // Card contract: the gateway never reached a terminal state, so this run
    // must never surface as complete/succeeded — even if the classifier drifts.
    expect(outcome.unresolved).toBe(true);
    expect(isTerminalRunStatus(outcome.status)).toBe(false);
    expect(outcome.status).not.toMatch(/^complete/i);
  });

  it('a status query that collapses to unknown stays unresolved (never complete)', async () => {
    const { client } = scriptedClient(['running', 'running', 'unknown']);

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep: noSleep,
    });

    expect(outcome.status).toBe('unknown');
    expect(outcome.unresolved).toBe(true);
    expect(isTerminalRunStatus(outcome.status)).toBe(false);
  });
});
