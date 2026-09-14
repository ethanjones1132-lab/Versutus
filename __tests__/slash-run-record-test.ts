import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/run`'s reply must carry the run's identity (its run id) and land in the
 * Activity tab's own verdict vocabulary — the words `runSlashStatusWord`
 * answers from `outcomeToActivityStatus` — so the slash result stops being
 * the run's only record and can be traced to the Activity row it produced.
 * Before this, the run id appeared only inside the raw transcript and the
 * verdict was re-derived slash-locally; the Activity tab row itself carries
 * the same facts, so nothing about how that row is written may change here.
 */
describe('/run run id and verdict vocabulary', () => {
  const contextWith = (runTask: unknown) =>
    ({
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      runTask,
    }) as never;

  test('a settled run carries its run id outside the raw transcript', async () => {
    const runTask = jest
      .fn()
      .mockResolvedValue({ runId: 'b3f2c9d4e5f6a7b8', status: 'completed', result: 'shipped' });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.runId).toBe('b3f2c9d4e5f6a7b8');
  });

  test('a failed run reads the Activity tab verdict in the summary line', async () => {
    const runTask = jest.fn().mockResolvedValue({ runId: 'r2', status: 'error', error: 'boom' });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.runId).toBe('r2');
    expect(result.text).toContain('Run failed');
  });

  test('an unresolved run carries its id without claiming completion', async () => {
    const runTask = jest
      .fn()
      .mockResolvedValue({ runId: 'r3', status: 'running', unresolved: true });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.runId).toBe('r3');
    expect(result.text).not.toContain('Run complete');
  });

  test('a cancelled run carries its id', async () => {
    const runTask = jest
      .fn()
      .mockResolvedValue({ runId: 'r4', status: 'cancelled', cancelled: true });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.runId).toBe('r4');
    expect(result.text).toContain('Run cancelled');
  });

  test('non-run commands carry no run id', async () => {
    const result = await executeGatewaySlashCommand('/agent', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn().mockResolvedValue('agent ok'),
    } as never);
    expect(result.runId).toBeUndefined();
  });
});
