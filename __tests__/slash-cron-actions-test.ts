import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { resolveRoute } from '@/lib/gateway/rpc-routes';

function testContext(gatewayRequest: jest.Mock) {
  return {
    hello: null,
    gatewayRequest,
    runAgentCommand: jest.fn(),
  };
}

describe('/cron run|pause|resume routine actions', () => {
  test('/cron run sends jobs.run with the job id and names the routine', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/cron run abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.run', { jobId: 'abc123' });
    expect(result.text).toContain('abc123');
    expect(result.title).toBe('/cron run abc123');
  });

  test('/cron pause and resume send jobs.pause and jobs.resume', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const paused = await executeGatewaySlashCommand('/cron pause abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.pause', { jobId: 'abc123' });
    expect(paused.text).toContain('abc123');
    const resumed = await executeGatewaySlashCommand('/cron resume abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.resume', { jobId: 'abc123' });
    expect(resumed.text).toContain('abc123');
  });

  test('a missing job id answers usage without touching the gateway', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/cron run', testContext(gatewayRequest));
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Usage: /cron run <job>');
  });

  test('a refused action names the failure instead of printing success', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('No routine "nope" on file.'));
    const result = await executeGatewaySlashCommand('/cron pause nope', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.pause', { jobId: 'nope' });
    expect(result.text).toContain('could not be');
    expect(result.text).toContain('No routine "nope" on file.');
  });

  test('bare /cron still reads the list and history still reads the runs', async () => {
    const gatewayRequest = jest
      .fn()
      .mockResolvedValueOnce({ object: 'list', data: [{ id: 'a' }] })
      .mockResolvedValueOnce({ object: 'list', data: [] });
    await executeGatewaySlashCommand('/cron', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.list', {});
    await executeGatewaySlashCommand('/cron history abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.runs', { jobId: 'abc123' });
  });

  test('jobs.pause and jobs.resume resolve to the Jobs API pause and resume paths', () => {
    const pause = resolveRoute('jobs.pause', { jobId: 'abc123' });
    expect(pause?.path).toBe('/api/jobs/abc123/pause');
    expect(pause?.route.method).toBe('POST');
    const resume = resolveRoute('jobs.resume', { jobId: 'abc123' });
    expect(resume?.path).toBe('/api/jobs/abc123/resume');
    expect(resume?.route.method).toBe('POST');
  });
});

describe('/cron history reports an errored run as failed', () => {
  const runs = (extra: Record<string, unknown>) => ({
    object: 'list',
    data: [{ id: 'cron:abc123:2026-10-10T09:00', at: '2026-10-10T09:00', status: 'completed', turnCount: 3, ...extra }],
  });

  test('a run the Gate marks with an error renders failed, not completed', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(runs({ error: 'error' }));
    const result = await executeGatewaySlashCommand('/cron history abc123', testContext(gatewayRequest));
    const [line] = result.text.split('\n').slice(1);
    expect(line).toContain('failed');
    expect(line).not.toContain('completed');
    // The bare 'error' end reason adds nothing to the status word.
    expect(line).not.toContain('(error)');
  });

  test('the error text is shown, truncated, when it says more than the end reason', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(runs({ error: `provider timeout ${'x'.repeat(200)}` }));
    const result = await executeGatewaySlashCommand('/cron history abc123', testContext(gatewayRequest));
    const [line] = result.text.split('\n').slice(1);
    expect(line).toContain('failed (provider timeout');
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(200);
  });

  test('a run without an error still renders completed', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(runs({}));
    const result = await executeGatewaySlashCommand('/cron history abc123', testContext(gatewayRequest));
    const [line] = result.text.split('\n').slice(1);
    expect(line).toContain('completed');
    expect(line).not.toContain('failed');
  });
});
