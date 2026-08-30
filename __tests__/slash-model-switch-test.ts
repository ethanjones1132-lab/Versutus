import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * The bare form `/model <name>` should switch directly through the existing
 * `setModelOverride` path -- it does not require the `set` verb nor the
 * `--confirm` flag. Picking a model is not destructive; the ceremony
 * existed for no gain and is why the composer path is unused in favour
 * of the sheet. The legacy `set <name> --confirm` form must keep
 * parsing so anything that scripts it does not break.
 */
describe('/model <name> direct switch', () => {
  test('bare form with a Hermes setModelOverride dispatches the switch without --confirm', async () => {
    const setModelOverride = jest.fn().mockResolvedValue(undefined);
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('no catalog'));
    const result = await executeGatewaySlashCommand('/model grok-4', {
      hello: null,
      currentModel: 'gateway-default',
      gatewayRequest,
      runAgentCommand: jest.fn(),
      setModelOverride,
    });
    expect(setModelOverride).toHaveBeenCalledWith('grok-4');
    expect(result.text).toMatch(/session will reopen/i);
  });

  test('bare form without setModelOverride falls through to config.patch (OpenClaw path)', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      hash: 'h1',
      config: { agents: { defaults: { model: { primary: 'gateway-default' } } } },
    });
    gatewayRequest.mockImplementation((method: string) => {
      if (method === 'config.get') {
        return Promise.resolve({
          hash: 'h1',
          config: { agents: { defaults: { model: { primary: 'gateway-default' } } } },
        });
      }
      if (method === 'models.list') {
        return Promise.resolve({ models: [{ id: 'grok-4', name: 'grok-4' }] });
      }
      if (method === 'config.patch') {
        return Promise.resolve({ ok: true, hash: 'h2' });
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });
    const result = await executeGatewaySlashCommand('/model grok-4', {
      hello: null,
      currentModel: 'gateway-default',
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.patch', expect.objectContaining({
      baseHash: 'h1',
    }));
    expect(result.text).toContain('Default model updated to grok-4');
  });

  test('legacy /model set <name> --confirm still parses and dispatches', async () => {
    const setModelOverride = jest.fn().mockResolvedValue(undefined);
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('no catalog'));
    const result = await executeGatewaySlashCommand('/model set kimi-k3 --confirm', {
      hello: null,
      currentModel: 'gateway-default',
      gatewayRequest,
      runAgentCommand: jest.fn(),
      setModelOverride,
    });
    expect(setModelOverride).toHaveBeenCalledWith('kimi-k3');
    expect(result.text).toMatch(/session will reopen/i);
  });

  test('/model with no args still reports the active model', async () => {
    const result = await executeGatewaySlashCommand('/model', {
      hello: null,
      currentModel: 'hermes-agent',
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('hermes-agent');
  });

  test('a bare /model <name> reports progress when the catalog cannot be read', async () => {
    const setModelOverride = jest.fn().mockResolvedValue(undefined);
    const gatewayRequest = jest.fn().mockResolvedValue({ models: [] });
    const result = await executeGatewaySlashCommand('/model qwen-3', {
      hello: null,
      currentModel: 'gateway-default',
      gatewayRequest,
      runAgentCommand: jest.fn(),
      setModelOverride,
    });
    // Empty catalog is treated as unknown -- we still dispatch through
    // setModelOverride rather than refusing, because picking a model is
    // not destructive and the operator already typed the name.
    expect(setModelOverride).toHaveBeenCalledWith('qwen-3');
    expect(result.text).toMatch(/session will reopen|override/i);
  });
});