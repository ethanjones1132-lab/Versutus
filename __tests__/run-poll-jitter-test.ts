import {
  executeRun,
  jitteredPollDelay,
  POLL_JITTER_MS,
  type RunCapableClient,
} from '@/lib/gateway/runs';
import type { RunResponse, RunStatus } from '@/lib/gateway/types';

/**
 * A client that never reaches a terminal status, so every loop turn takes
 * the no-progress sleep path. `streamRunEvents` resolves immediately —
 * modelling the gateway closing the SSE stream while the run is in flight.
 */
function neverEndingClient(sleeps: number[]) {
  const client: RunCapableClient = {
    async startRun(): Promise<RunResponse> {
      return { run_id: 'run-1', status: 'running' };
    },
    async getRunStatus(): Promise<RunStatus> {
      return { run_id: 'run-1', status: 'running' };
    },
    async streamRunEvents() {},
    async resolveApproval() {},
    async stopRun() {},
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { client, sleep };
}

describe('jitteredPollDelay', () => {
  it('spans the full window at the sample edges', () => {
    expect(POLL_JITTER_MS).toBe(200);
    expect(jitteredPollDelay(1000, 0)).toBe(800);
    expect(jitteredPollDelay(1000, 0.5)).toBe(1000);
    expect(jitteredPollDelay(1000, 1)).toBe(1200);
  });

  it('never goes negative for small custom delays', () => {
    expect(jitteredPollDelay(50, 0)).toBe(0);
    expect(jitteredPollDelay(0, 0)).toBe(0);
  });

  it('centres on a custom base delay', () => {
    expect(jitteredPollDelay(500, 0)).toBe(300);
    expect(jitteredPollDelay(500, 1)).toBe(700);
  });
});

describe('executeRun poll jitter', () => {
  it('waits within the jitter window on every no-progress poll', async () => {
    const sleeps: number[] = [];
    const { client, sleep } = neverEndingClient(sleeps);

    const outcome = await executeRun(client, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep,
    });

    expect(outcome.unresolved).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(800);
      expect(ms).toBeLessThanOrEqual(1200);
    }
  });

  it('still routes an approval to completed with approved=true', async () => {
    let calls = 0;
    const { client } = neverEndingClient([]);
    const approving: RunCapableClient = {
      ...client,
      async getRunStatus(): Promise<RunStatus> {
        calls += 1;
        if (calls === 1) return { run_id: 'run-1', status: 'running' };
        if (calls === 2) return { run_id: 'run-1', status: 'waiting-approval' };
        return { run_id: 'run-1', status: 'completed', result: 'the answer' };
      },
    };

    const outcome = await executeRun(approving, 'do the thing', {
      onApprovalRequired: async () => ({ approved: true }),
      sleep: async () => {},
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.approved).toBe(true);
  });
});
