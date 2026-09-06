import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { resolveRoute } from '@/lib/gateway/rpc-routes';

function testContext(gatewayRequest: jest.Mock) {
  return {
    hello: null,
    gatewayRequest,
    runAgentCommand: jest.fn(),
  };
}

describe('/cron create files a routine', () => {
  test('/cron create sends jobs.create with the title, schedule, and prompt', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true, id: 'job-1' });
    const result = await executeGatewaySlashCommand(
      '/cron create Nightly check | 0 9 * * * | check the gate health',
      testContext(gatewayRequest),
    );
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.create', {
      name: 'Nightly check',
      schedule: '0 9 * * *',
      prompt: 'check the gate health',
    });
    expect(result.text).toContain('Nightly check');
    expect(result.title).toBe('/cron create Nightly check');
  });

  test('a pipe inside the prompt is kept, not treated as a separator', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    await executeGatewaySlashCommand(
      '/cron create Pipes | hourly | retry a | b then report',
      testContext(gatewayRequest),
    );
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.create', {
      name: 'Pipes',
      schedule: 'hourly',
      prompt: 'retry a | b then report',
    });
  });

  test('a missing segment answers usage without touching the gateway', async () => {
    const gatewayRequest = jest.fn();
    for (const input of [
      '/cron create',
      '/cron create Only a title',
      '/cron create Title | daily',
      '/cron create Title | | a prompt with no schedule',
      '/cron create | daily | prompt with no title',
    ]) {
      const result = await executeGatewaySlashCommand(input, testContext(gatewayRequest));
      expect(result.text).toContain('Usage: /cron create <title> | <schedule> | <prompt>');
    }
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  test('a refused create names the failure instead of printing success', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('schedule is invalid'));
    const result = await executeGatewaySlashCommand(
      '/cron create Nightly | nonsense | check things',
      testContext(gatewayRequest),
    );
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.create', {
      name: 'Nightly',
      schedule: 'nonsense',
      prompt: 'check things',
    });
    expect(result.text).toContain('could not be created');
    expect(result.text).toContain('schedule is invalid');
  });

  test('bare /cron, history, and run|pause|resume keep their reads', async () => {
    const gatewayRequest = jest
      .fn()
      .mockResolvedValueOnce({ object: 'list', data: [{ id: 'a' }] })
      .mockResolvedValueOnce({ object: 'list', data: [] })
      .mockResolvedValueOnce({ ok: true });
    await executeGatewaySlashCommand('/cron', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.list', {});
    await executeGatewaySlashCommand('/cron history abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.runs', { jobId: 'abc123' });
    await executeGatewaySlashCommand('/cron run abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.run', { jobId: 'abc123' });
  });

  test('jobs.create resolves to a POST on the Jobs API base', () => {
    const routed = resolveRoute('jobs.create', {
      name: 'Nightly',
      schedule: 'daily',
      prompt: 'check things',
    });
    expect(routed?.path).toBe('/api/jobs');
    expect(routed?.route.method).toBe('POST');
  });
});
