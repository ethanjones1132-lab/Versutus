import { GatewayHttpError } from '@/lib/gateway/errors';
import {
  executeRun,
  isTerminalRunStatus,
  outcomeToActivityStatus,
  runNeedsApproval,
  runStatusToActivityStatus,
  settleUnresolvedRuns,
  type RunCapableClient,
} from '@/lib/gateway/runs';
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

/**
 * A client whose status read is scripted call by call: `reads` counts the
 * attempts, and a call whose index is in `fail` rejects with that attempt's
 * error instead. Everything else answers `status` — the state after a
 * transport failure on a phone that has not moved on.
 */
function countedStatusClient(plan: {
  fail: Record<number, unknown>;
  status: (reads: number) => string;
  stream?: () => Promise<void>;
}) {
  let reads = 0;
  const slept: number[] = [];
  const stops = { count: 0 };

  const client: RunCapableClient = {
    async startRun(): Promise<RunResponse> {
      return { run_id: 'run-1', status: plan.status(0) };
    },
    async getRunStatus(): Promise<RunStatus> {
      reads += 1;
      const failure = plan.fail[reads];
      if (failure) throw failure;
      const status = plan.status(reads);
      return {
        run_id: 'run-1',
        status,
        result: /complete/i.test(status) ? 'the answer' : undefined,
      };
    },
    streamRunEvents: plan.stream ?? (async () => {}),
    async resolveApproval() {},
    async stopRun() {
      stops.count += 1;
    },
  };

  const sleep = async (ms: number) => {
    slept.push(ms);
  };

  return { client, slept, sleep, stops, reads: () => reads };
}

/** The message a phone's fetch reports when the radio drops a request. */
const RADIO_BLIP = new Error('Network request failed');

describe('executeRun rides out a transient status failure', () => {
  it('completes the run instead of abandoning it when one read is lost', async () => {
    // The defect: a single dropped request ended the driver with
    // `{ status: 'unknown', unresolved: true }`, and only a full reconnect
    // (settleUnresolvedRuns) ever read the run again.
    const { client, slept, sleep, reads } = countedStatusClient({
      fail: { 1: RADIO_BLIP },
      status: (n) => (n === 1 ? 'running' : 'completed'),
    });

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep,
    });

    // The lost read, its retry, and the final read executeRun closes with.
    expect(reads()).toBe(3);
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toBe('the answer');
    expect(outcome.unresolved).toBeFalsy();
    // One backoff before the retry, inside the ±POLL_JITTER_MS window around
    // the first 500 ms beat.
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(300);
    expect(slept[0]).toBeLessThanOrEqual(700);
  });

  it('retries the read after an approval, not only at the loop head', async () => {
    const { client, sleep, reads } = countedStatusClient({
      // The read that follows resolveApproval is its own call site, and it drops
      // once like any other.
      fail: { 2: RADIO_BLIP },
      status: (n) => (n === 1 ? 'waiting-approval' : 'completed'),
    });

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep,
    });

    expect(reads()).toBe(4);
    expect(outcome.approved).toBe(true);
    expect(outcome.status).toBe('completed');
    expect(outcome.unresolved).toBeFalsy();
  });

  it('waits the first backoff after the event stream drops, then polls once', async () => {
    // The stream failure used to be swallowed and followed by exactly one poll
    // — reading straight into the gap the drop had just left.
    const { client, slept, sleep } = countedStatusClient({
      fail: {},
      status: () => 'running',
      stream: async () => {
        throw new Error('stream closed unexpectedly');
      },
    });

    await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep,
    });

    // The stream's backoff comes first, then the no-progress poll backoff — and
    // no retry of its own, because a read that answers is never repeated.
    expect(slept.length).toBeGreaterThanOrEqual(2);
    expect(slept[0]).toBeGreaterThanOrEqual(300);
    expect(slept[0]).toBeLessThanOrEqual(700);
    expect(slept[1]).toBeGreaterThanOrEqual(800);
    expect(slept[1]).toBeLessThanOrEqual(1200);
  });

  it('does not retry a 404 — the gateway answered, and will answer the same', async () => {
    const { client, slept, sleep, reads } = countedStatusClient({
      fail: { 1: new GatewayHttpError('run not found', 404) },
      status: () => 'running',
    });

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep,
    });

    expect(reads()).toBe(1);
    expect(slept).toHaveLength(0);
    expect(outcome.unresolved).toBe(true);
    expect(outcome.status).toBe('unknown');
    expect(outcome.error).toMatch(/run not found/);
  });

  it('gives up after three attempts and stays unresolved, exactly as before', async () => {
    const { client, slept, sleep, reads } = countedStatusClient({
      fail: { 1: RADIO_BLIP, 2: RADIO_BLIP, 3: RADIO_BLIP },
      status: () => 'running',
    });

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep,
    });

    expect(reads()).toBe(3);
    // 500 ms then 1500 ms, both inside the jitter window.
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThanOrEqual(1300);
    expect(slept[1]).toBeLessThanOrEqual(1700);
    expect(outcome.unresolved).toBe(true);
    expect(outcome.status).toBe('unknown');
    expect(outcome.error).toMatch(/Network request failed/);
  });

  it('still cancels when the abort lands during a retry backoff', async () => {
    const controller = new AbortController();
    // The loop's first read drops twice and succeeds on the retry, so the abort
    // lands inside the backoff between them.
    const { client, stops, reads } = countedStatusClient({
      fail: { 2: RADIO_BLIP, 3: RADIO_BLIP },
      status: () => 'running',
    });

    const outcome = await executeRun(client, 'do the thing', {
      signal: controller.signal,
      onApprovalRequired: async () => ({ approved: true }),
      sleep: async () => {
        controller.abort();
      },
    });

    // The retry is what carried the driver back to the top of the loop to see
    // the abort; without it the failed read would have returned unresolved.
    expect(reads()).toBe(4);
    expect(stops.count).toBe(1);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.status).toBe('cancelled');
    expect(outcome.unresolved).toBeFalsy();
  });
});

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

describe('A2 regression lock — outcome-to-activity mapping', () => {
  it('an unresolved outcome renders as unresolved, never complete', () => {
    expect(outcomeToActivityStatus({ runId: 'r1', status: 'running', unresolved: true })).toBe('unresolved');
  });

  it('a cancelled outcome renders as cancelled', () => {
    expect(outcomeToActivityStatus({ runId: 'r1', status: 'cancelled', cancelled: true })).toBe('cancelled');
  });

  it('a stop the gateway never confirms renders as unconfirmed, not cancelled', () => {
    // requestStop marks a refused stop unresolved precisely so this mapping
    // cannot present it as a finished cancellation — and so the run stays in
    // settleUnresolvedRuns' reconnect re-poll until the truth is known.
    expect(
      outcomeToActivityStatus({ runId: 'r1', status: 'cancelled', cancelled: true, unresolved: true }),
    ).toBe('unresolved');
  });

  it('a terminal success renders as complete', () => {
    expect(outcomeToActivityStatus({ runId: 'r1', status: 'completed' })).toBe('complete');
    expect(outcomeToActivityStatus({ runId: 'r1', status: 'succeeded' })).toBe('complete');
  });

  it('a terminal failure renders as failed', () => {
    expect(outcomeToActivityStatus({ runId: 'r1', status: 'failed' })).toBe('failed');
    expect(outcomeToActivityStatus({ runId: 'r1', status: 'error' })).toBe('failed');
  });
});

describe('C2 — settle unresolved runs on reconnect', () => {
  it('runStatusToActivityStatus maps terminal statuses correctly', () => {
    expect(runStatusToActivityStatus('completed')).toBe('complete');
    expect(runStatusToActivityStatus('failed')).toBe('failed');
    expect(runStatusToActivityStatus('cancelled')).toBe('cancelled');
    expect(runStatusToActivityStatus('running')).toBe('unresolved');
  });

  it('settleUnresolvedRuns updates unresolved runs to their terminal state', async () => {
    const client = {
      getRunStatus: jest.fn().mockResolvedValue({ run_id: 'run-1', status: 'completed', result: 'done' }),
    };
    const runs = [
      { id: 'run-1', prompt: 'test', status: 'unresolved' as const, startedAt: 1, events: [] },
      { id: 'run-2', prompt: 'other', status: 'complete' as const, startedAt: 2, events: [] },
    ];

    const { runs: settled, changed } = await settleUnresolvedRuns(client, runs);

    expect(settled[0].status).toBe('complete');
    expect(settled[0].summary).toBe('done');
    expect(changed).toHaveLength(1);
    expect(client.getRunStatus).toHaveBeenCalledWith('run-1');
  });

  it('settleUnresolvedRuns leaves still-unresolved runs alone', async () => {
    const client = {
      getRunStatus: jest.fn().mockResolvedValue({ run_id: 'run-1', status: 'running' }),
    };
    const runs = [{ id: 'run-1', prompt: 'test', status: 'unresolved' as const, startedAt: 1, events: [] }];

    const { runs: settled, changed } = await settleUnresolvedRuns(client, runs);

    expect(settled[0].status).toBe('unresolved');
    expect(changed).toHaveLength(0);
  });
});
