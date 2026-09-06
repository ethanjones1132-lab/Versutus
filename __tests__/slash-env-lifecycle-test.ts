import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

function testContext(gatewayRequest: jest.Mock) {
  return {
    hello: null,
    gatewayRequest,
    runAgentCommand: jest.fn(),
  };
}

describe('/env start|stop CLI environment lifecycle', () => {
  test('/env start sends environments.lifecycle.start with the id and names it', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/env start opencode-local', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('environments.lifecycle.start', { id: 'opencode-local' });
    expect(result.text).toContain('opencode-local');
    expect(result.text).toContain('started');
    expect(result.title).toBe('/env start opencode-local');
  });

  test('/env stop sends environments.lifecycle.stop with the id and names it', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/env stop opencode-local', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('environments.lifecycle.stop', { id: 'opencode-local' });
    expect(result.text).toContain('opencode-local');
    expect(result.text).toContain('stopped');
    expect(result.title).toBe('/env stop opencode-local');
  });

  test('a missing id answers usage without touching the gateway', async () => {
    const gatewayRequest = jest.fn();
    const started = await executeGatewaySlashCommand('/env start', testContext(gatewayRequest));
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(started.text).toContain('Usage: /env start <id>');
    const stopped = await executeGatewaySlashCommand('/env stop', testContext(gatewayRequest));
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(stopped.text).toContain('Usage: /env stop <id>');
  });

  test('a refused action names the failure instead of printing success', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('environment "ghost" not found'));
    const result = await executeGatewaySlashCommand('/env stop ghost', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('environments.lifecycle.stop', { id: 'ghost' });
    expect(result.text).toContain('could not be stopped');
    expect(result.text).toContain('environment "ghost" not found');
  });

  test('bare /env still reads the list and /env <name> still reads the check', async () => {
    const gatewayRequest = jest
      .fn()
      .mockResolvedValueOnce({ environments: [{ id: 'a', state: 'running' }] })
      .mockResolvedValueOnce({ id: 'opencode-local', state: 'running' });
    await executeGatewaySlashCommand('/env', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('environments.list', {});
    await executeGatewaySlashCommand('/env opencode-local', testContext(gatewayRequest));
    expect(gatewayRequest).toHaveBeenCalledWith('environments.check', { id: 'opencode-local' });
  });
});
