import { executeGatewaySlashCommand, getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';

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

describe('slash command palette', () => {
  test('typing / surfaces local and registry suggestions', () => {
    const suggestions = getSlashCommandSuggestions('/', null, [], {});
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.value === '/help')).toBe(true);
  });

  test('filters by prefix', () => {
    const suggestions = getSlashCommandSuggestions('/model', null, [], {});
    expect(suggestions.every((s) => s.value.toLowerCase().includes('/model'))).toBe(true);
  });

  test('hides unavailable commands when live methods are known and prefix is short', () => {
    const methods = { channels: { available: false, reason: 'Not offered' } };
    const suggestions = getSlashCommandSuggestions('/ch', null, [], methods);
    expect(suggestions.every((s) => !s.unavailable)).toBe(true);
  });

  test('groups suggestions by family', () => {
    const suggestions = getSlashCommandSuggestions('/model', null, [], {});
    const families = new Set(suggestions.map((s) => s.family));
    expect(families.size).toBeGreaterThanOrEqual(1);
  });

  test('surfaces recent commands first', () => {
    const suggestions = getSlashCommandSuggestions('/', null, ['/model set foo'], {});
    expect(suggestions[0]?.value).toBe('/model set foo');
  });
});
