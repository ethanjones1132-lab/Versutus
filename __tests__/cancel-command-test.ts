import { serverSideCancelForCommand, type CancellableClient } from '@/lib/gateway/cancel';

describe('serverSideCancelForCommand', () => {
  it('calls stopRun for a non-local run id', async () => {
    const stops: string[] = [];
    const client: CancellableClient = {
      stopRun: async (runId) => {
        stops.push(runId);
      },
    };

    const promise = serverSideCancelForCommand(client, 'run-123');
    await promise;

    expect(stops).toEqual(['run-123']);
  });

  it('swallows stopRun rejections best-effort', async () => {
    const client: CancellableClient = {
      stopRun: async () => {
        throw new Error('gateway gone');
      },
    };

    await expect(serverSideCancelForCommand(client, 'run-123')).resolves.toBeUndefined();
  });

  it('does nothing when the run id is a local placeholder', () => {
    const client: CancellableClient = {
      stopRun: async () => {},
    };

    expect(serverSideCancelForCommand(client, 'local-abc')).toBeUndefined();
  });

  it('does nothing when the client has no stopRun', () => {
    const client: CancellableClient = {};

    expect(serverSideCancelForCommand(client, 'run-123')).toBeUndefined();
  });

  it('does nothing when there is no active run id', () => {
    const client: CancellableClient = {
      stopRun: async () => {},
    };

    expect(serverSideCancelForCommand(client, null)).toBeUndefined();
  });
});
