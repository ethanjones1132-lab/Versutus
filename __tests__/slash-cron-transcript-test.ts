import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

function testContext(gatewayRequest: jest.Mock) {
  return {
    hello: null,
    gatewayRequest,
    runAgentCommand: jest.fn(),
  };
}

describe('/cron transcript routine run transcript', () => {
  test('/cron transcript sends cron.transcript with the run id, one line per turn', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      object: 'list',
      data: [
        { id: 't1', role: 'user', text: 'Run the backup' },
        { id: 't2', role: 'assistant', text: 'Backed up 4 files', toolName: 'backup' },
      ],
    });
    const result = await executeGatewaySlashCommand('/cron transcript run123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.transcript', { runId: 'run123' });
    expect(result.title).toBe('/cron transcript run123');
    expect(result.text).toContain('run123');
    expect(result.text).toContain('USER');
    expect(result.text).toContain('Run the backup');
    expect(result.text).toContain('backup');
    expect(result.text).toContain('Backed up 4 files');
  });

  test('a run with no turns says so instead of printing an empty transcript', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data: [] });
    const result = await executeGatewaySlashCommand('/cron transcript run123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.transcript', { runId: 'run123' });
    expect(result.text).toContain('No turns recorded for run123.');
  });

  test('a missing run id answers usage without touching the gateway', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/cron transcript', testContext(gatewayRequest));
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Usage: /cron transcript <runId>');
  });

  test('a refused transcript read names the failure instead of printing turns', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('Not a cron run id.'));
    const result = await executeGatewaySlashCommand('/cron transcript nope', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('cron.transcript', { runId: 'nope' });
    expect(result.text).toContain('could not be read');
    expect(result.text).toContain('Not a cron run id.');
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

  test('run, pause, resume, and create keep their wire calls', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    await executeGatewaySlashCommand('/cron run abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.run', { jobId: 'abc123' });
    await executeGatewaySlashCommand('/cron pause abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.pause', { jobId: 'abc123' });
    await executeGatewaySlashCommand('/cron resume abc123', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.resume', { jobId: 'abc123' });
    await executeGatewaySlashCommand(
      '/cron create Nightly | 0 2 * * * | Run the backup',
      testContext(gatewayRequest),
    );
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.create', {
      name: 'Nightly',
      schedule: '0 2 * * *',
      prompt: 'Run the backup',
    });
  });
});
