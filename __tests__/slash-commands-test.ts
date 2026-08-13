import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('slash commands', () => {
  test('executes local help without a gateway RPC', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/help', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Available commands');
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  test('passes JSON parameters through /rpc', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/rpc models.list {"limit":5}', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('models.list', { limit: 5 });
    expect(result.title).toBe('/rpc models.list');
  });

  test('shows the active Hermes model without unsupported config RPC', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/model', {
      hello: null,
      currentModel: 'hermes-agent',
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('hermes-agent');
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  test('short-circuits commands the capability snapshot marks unavailable', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/channels', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { channels: { available: false, reason: 'Not offered by this gateway' } },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('not available');
    expect(result.title).toBe('/channels');
  });

  test('still routes /channels when the snapshot is empty', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ channels: [] });
    await executeGatewaySlashCommand('/channels', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('channels.status', {});
  });
});
