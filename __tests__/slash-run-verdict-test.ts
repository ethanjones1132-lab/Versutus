import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/run`'s verdict line must read the outcome the same way the Activity tab
 * does — through outcomeToActivityStatus (via runSlashStatusWord) — not a
 * second hardcoded English guess over the raw status string. A run that
 * failed reads its verdict; a run that never reached a terminal state is
 * never presented as finished.
 */
describe('/run verdict classification', () => {
  const contextWith = (runTask: unknown) =>
    ({
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      runTask,
    }) as never;

  test('a failed outcome reads the failed verdict, not "Run <raw status>"', async () => {
    const runTask = jest.fn().mockResolvedValue({ runId: 'r1', status: 'error', error: 'boom' });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.text).toContain('Run failed');
    expect(result.text).not.toContain('Run error');
  });

  test('an unresolved outcome never reads as complete', async () => {
    const runTask = jest.fn().mockResolvedValue({ runId: 'r1', status: 'running', unresolved: true });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.text).not.toContain('Run complete');
    expect(result.text).toContain('Run running');
  });

  test('a completed outcome still reads "Run complete"', async () => {
    const runTask = jest.fn().mockResolvedValue({ runId: 'r1', status: 'completed', result: 'shipped' });
    const result = await executeGatewaySlashCommand('/run ship the release', contextWith(runTask));
    expect(result.text).toContain('Run complete');
  });
});
