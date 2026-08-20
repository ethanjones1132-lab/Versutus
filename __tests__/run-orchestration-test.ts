import { executeRun } from '@/lib/gateway/runs';

/**
 * A cancelled run used to report `cancelled: true` whether or not the gateway
 * accepted the stop — `stopRun(...).catch(() => undefined)` discarded the
 * failure. That tells the user the run is over while it keeps burning tokens
 * upstream, which is exactly the lie the Gate refuses to tell: the Hermes
 * backend leaves session abort throwing rather than fake a cancel.
 */

function clientWith({ stopRun }: { stopRun: () => Promise<void> }) {
  return {
    startRun: async () => ({ run_id: 'run_1' }),
    getRunStatus: async () => ({ status: 'running' }),
    streamRunEvents: async () => undefined,
    resolveApproval: async () => undefined,
    stopRun,
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
