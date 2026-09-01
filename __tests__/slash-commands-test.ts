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
    // Help answers entirely locally -- no wire call at all.
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

  test('/models reads an OpenAI-shaped {data} catalog instead of claiming nothing matched', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      object: 'list',
      data: [
        { id: 'nous/poolside/laguna-xs-2.1:free', provider: 'Nous Portal' },
        { id: 'opencode-zen/laguna-s-2.1-free', provider: 'OpenCode Zen' },
      ],
    });
    const result = await executeGatewaySlashCommand('/models', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('laguna-xs-2.1:free');
    expect(result.text).not.toBe('No models matched.');
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

describe('/model set override', () => {
  test('confirmed override tells the operator the session will reopen', async () => {
    const setModelOverride = jest.fn();
    const result = await executeGatewaySlashCommand('/model set kimi-k3 --confirm', {
      hello: null,
      gatewayRequest: jest.fn().mockRejectedValue(new Error('no catalog')),
      runAgentCommand: jest.fn(),
      setModelOverride,
    });
    expect(setModelOverride).toHaveBeenCalledWith('kimi-k3');
    expect(result.text).toMatch(/session will reopen/i);
  });
});

const SPEND_LIST = {
  object: 'list',
  data: [
    { input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.5 },
    { input_tokens: 20, output_tokens: 5, estimated_cost_usd: 0.25 },
  ],
};

describe('/usage and /cost from session records', () => {
  test('/usage totals tokens and cost from sessions.list, never usage.status', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(SPEND_LIST);
    const result = await executeGatewaySlashCommand('/usage', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.list', expect.any(Object));
    expect(gatewayRequest).not.toHaveBeenCalledWith('usage.status', expect.anything());
    expect(result.title).toBe('/usage');
    expect(result.text).toContain('Sessions: 2');
    expect(result.text).toContain('Tokens: 175');
    expect(result.text).toContain('Cost: $0.75');
  });

  test('/cost uses the same session totals and never calls usage.cost', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(SPEND_LIST);
    const result = await executeGatewaySlashCommand('/cost', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.list', expect.any(Object));
    expect(gatewayRequest).not.toHaveBeenCalledWith('usage.cost', expect.anything());
    expect(result.title).toBe('/cost');
    expect(result.text).toContain('Cost: $0.75');
  });

  test('still reports spend when the snapshot says usage.status is not dispatched', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(SPEND_LIST);
    const result = await executeGatewaySlashCommand('/usage', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { usage: { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(gatewayRequest).toHaveBeenCalledWith('sessions.list', expect.any(Object));
    expect(result.text).toContain('Tokens: 175');
    expect(result.text).not.toContain('not available');
  });

  test('a refused sessions.list is a failed read, not zero spend', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('sessions.list is not supported'));
    const result = await executeGatewaySlashCommand('/usage', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Sessions could not be read.');
    expect(result.text).not.toMatch(/Tokens: 0/);
  });

  test('an unparseable list is a failed read, not zero spend', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ error: 'boom' });
    const result = await executeGatewaySlashCommand('/cost', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Sessions could not be read.');
  });

  test('an empty list is empty-ok, not a failed read', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ data: [] });
    const result = await executeGatewaySlashCommand('/usage', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Sessions: 0');
    expect(result.text).toContain('Tokens: 0');
    expect(result.text).toContain('Cost: —');
  });
});

const GATE_HEALTH = { status: 'ok', checks: { db: 'ok', cache: { status: 'degraded', detail: 'slow' } } };

describe('/status and /diagnostics name health checks', () => {
  test('/status prints named checks from status, not a JSON blob', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(GATE_HEALTH);
    const result = await executeGatewaySlashCommand('/status', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('status', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('diagnostics.stability', expect.anything());
    expect(result.title).toBe('/status');
    expect(result.text).toContain('Status: ok');
    expect(result.text).toContain('db: ok');
    expect(result.text).toContain('cache: degraded');
    expect(result.text).toContain('slow');
    expect(result.text).not.toMatch(/[{}\[\]]/);
    expect(result.raw).toBeUndefined();
  });

  test('/diagnostics prints the same named checks from diagnostics.full', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue(GATE_HEALTH);
    const result = await executeGatewaySlashCommand('/diagnostics', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('diagnostics.full', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('diagnostics.stability', expect.anything());
    expect(result.title).toBe('/diagnostics');
    expect(result.text).toContain('db: ok');
    expect(result.text).not.toBe('Diagnostics summary');
    expect(result.raw).toBeUndefined();
  });

  test('a refused health read is a failed read, never {} under a success title', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('diagnostics.full is not supported'));
    const status = await executeGatewaySlashCommand('/status', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(status.text).toBe('Health checks could not be read.');
    expect(status.text).not.toMatch(/online|\{\}/);
    expect(status.raw).toBeUndefined();

    const diagnostics = await executeGatewaySlashCommand('/diagnostics', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(diagnostics.text).toBe('Health checks could not be read.');
    expect(diagnostics.text).not.toBe('Diagnostics summary');
  });

  test('an unparseable payload is a failed read, not Status: online', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ error: 'boom' });
    const result = await executeGatewaySlashCommand('/status', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Health checks could not be read.');
    expect(result.text).not.toMatch(/online/);
  });

  test('an empty checks map is empty-ok, not a failed read', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ status: 'ok', checks: {} });
    const result = await executeGatewaySlashCommand('/diagnostics', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Status: ok');
    expect(result.text).toContain('No health checks.');
  });
});
