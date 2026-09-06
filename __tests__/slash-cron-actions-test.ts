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
