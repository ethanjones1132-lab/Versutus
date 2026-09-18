import { executeRun } from '@/lib/gateway/runs';

/**
 * A cancelled run used to report `cancelled: true` whether or not the gateway
 * accepted the stop — `stopRun(...).catch(() => undefined)` discarded the
 * failure. That tells the user the run is over while it keeps burning tokens
 * upstream, which is exactly the lie the Gate refuses to tell: the Hermes
 * backend leaves session abort throwing rather than fake a cancel.
 */

function clientWith(overrides: Partial<{
  startRun: () => Promise<{ run_id: string }>;
  getRunStatus: () => Promise<{ status: string }>;
  streamRunEvents: () => Promise<void>;
  resolveApproval: () => Promise<void>;
  stopRun: () => Promise<void>;
}> = {}) {
  return {
    startRun: overrides.startRun ?? (async () => ({ run_id: 'run_1' })),
    getRunStatus: overrides.getRunStatus ?? (async () => ({ status: 'running' })),
    streamRunEvents: overrides.streamRunEvents ?? (async () => undefined),
    resolveApproval: overrides.resolveApproval ?? (async () => undefined),
    stopRun: overrides.stopRun ?? (async () => undefined),
  } as unknown as Parameters<typeof executeRun>[0];
}

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

describe('cancelling a run', () => {
  test('reports a clean cancellation when the gateway accepts the stop', async () => {
    const outcome = await executeRun(clientWith({ stopRun: async () => undefined }), 'go', {
      signal: aborted(),
      onApprovalRequired: async () => ({ approved: true }),
      sleep: async () => undefined,
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.status).toBe('cancelled');
    expect(outcome.unresolved).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  test('does not claim the run stopped when the gateway refused', async () => {
    const outcome = await executeRun(
      clientWith({ stopRun: async () => { throw new Error('gateway unreachable'); } }),
      'go',
      { signal: aborted(), onApprovalRequired: async () => ({ approved: true }), sleep: async () => undefined },
    );

    // Still cancelled locally — the user did cancel — but the caller must not
    // present it as finished work.
    expect(outcome.cancelled).toBe(true);
    expect(outcome.unresolved).toBe(true);
    expect(outcome.error).toMatch(/did not confirm/i);
    expect(outcome.error).toMatch(/gateway unreachable/);
  });
});

describe('status read failure after run acceptance', () => {
  test('initial getRunStatus failure returns unresolved with the run id', async () => {
    const outcome = await executeRun(
      clientWith({ getRunStatus: async () => { throw new Error('network error'); } }),
      'go',
      { onApprovalRequired: async () => ({ approved: true }), sleep: async () => undefined },
    );

    expect(outcome.runId).toBe('run_1');
    expect(outcome.unresolved).toBe(true);
    expect(outcome.status).toBe('unknown');
    expect(outcome.error).toMatch(/network error/i);
  });

  test('intermediate getRunStatus failure during polling returns unresolved with the run id', async () => {
    let callCount = 0;
    const outcome = await executeRun(
      clientWith({
        getRunStatus: async () => {
          callCount += 1;
          if (callCount === 2) throw new Error('gateway timeout');
          return { status: 'running' };
        },
      }),
      'go',
      { onApprovalRequired: async () => ({ approved: true }), sleep: async () => undefined, pollDelayMs: 0 },
    );

    expect(outcome.runId).toBe('run_1');
    expect(outcome.unresolved).toBe(true);
    expect(outcome.status).toBe('unknown');
    expect(outcome.error).toMatch(/gateway timeout/i);
  });

  test('getRunStatus failure after approval resolution returns unresolved with the run id', async () => {
    let approvalResolved = false;
    const outcome = await executeRun(
      clientWith({
        getRunStatus: async () => {
          if (approvalResolved) throw new Error('post-approval read failed');
          return { status: 'waiting-approval' };
        },
        resolveApproval: async () => { approvalResolved = true; },
      }),
      'go',
      { onApprovalRequired: async () => ({ approved: true }), sleep: async () => undefined, pollDelayMs: 0 },
    );

    expect(outcome.runId).toBe('run_1');
    expect(outcome.unresolved).toBe(true);
    expect(outcome.status).toBe('unknown');
    expect(outcome.error).toMatch(/post-approval read failed/i);
  });

  test('real terminal failure status is still reported as failed', async () => {
    const outcome = await executeRun(
      clientWith({
        getRunStatus: async () => ({ status: 'failed', error: 'model oom' }),
      }),
      'go',
      { onApprovalRequired: async () => ({ approved: true }), sleep: async () => undefined },
    );

    expect(outcome.runId).toBe('run_1');
    expect(outcome.unresolved).toBeUndefined();
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('model oom');
  });
});
