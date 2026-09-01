import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/config diff`, `/config rollback` and `/config last-good` swallow a
 * rejected RPC into `{}` and print the success title ("Config diff",
 * "Config rolled back", "Last good config") as if the read happened — the
 * same failure class sessionActionResult was built to kill. A caught
 * rejection must carry the failure into the bubble text, with the
 * METHOD_GUIDANCE next step when the error does not already name it;
 * resolved reads keep today's title and Raw byte-identical.
 */
describe('/config diff, /config rollback and /config last-good honesty', () => {
  test('a rejecting config.diff RPC names the failure, not "Config diff"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('config.diff is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/config diff', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.diff', {});
    expect(result.text).toContain('Config diff could not be read');
    expect(result.text).toContain('config.diff is not supported');
    expect(result.text).not.toBe('Config diff');
  });

  test('a rejecting config.rollback RPC names the failure, not "Config rolled back"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('config.rollback is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/config rollback', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.rollback', {});
    expect(result.text).toContain('Config rollback failed');
    expect(result.text).not.toContain('Config rolled back could not be read');
    expect(result.text).toContain('config.rollback is not supported');
    expect(result.text).not.toBe('Config rolled back');
  });

  test('a rejecting config.last-good RPC names the failure, not "Last good config"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('config.last-good is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/config last-good', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.last-good', {});
    expect(result.text).toContain('Last good config could not be read');
    expect(result.text).toContain('config.last-good is not supported');
    expect(result.text).not.toBe('Last good config');
  });

  test('a rejecting config.diff RPC with a bare error still carries the METHOD_GUIDANCE next step', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/config diff', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Config diff could not be read');
    expect(result.text).toContain('Hermes configuration is host-side — no remote config REST exists.');
  });

  test('the guidance is not appended twice when the error already carries it', async () => {
    const guidance = 'Hermes configuration is host-side — no remote config REST exists.';
    const gatewayRequest = jest.fn().mockRejectedValue(new Error(`${guidance} boom`));
    const result = await executeGatewaySlashCommand('/config rollback', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text.match(/no remote config REST exists/g) ?? []).toHaveLength(1);
  });

  test('a resolving config.diff RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ diff: 'd1' });
    const result = await executeGatewaySlashCommand('/config diff', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.diff', {});
    expect(result.text).toBe('Config diff');
    expect(result.raw).toBe('{\n  "diff": "d1"\n}');
  });

  test('a resolving config.rollback RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ rolledBack: { path: 'none' } });
    const result = await executeGatewaySlashCommand('/config rollback', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Config rolled back');
    expect(result.raw).toBe('{\n  "rolledBack": {\n    "path": "none"\n  }\n}');
  });

  test('a resolving config.last-good RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ path: 'agents.defaults', value: 'v' });
    const result = await executeGatewaySlashCommand('/config last-good', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Last good config');
    expect(result.raw).toBe('{\n  "path": "agents.defaults",\n  "value": "v"\n}');
  });

  test('the /config <path> read fallback stays untouched when nothing blocks it', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ config: { agents: { defaults: { model: 'grok' } } } });
    const result = await executeGatewaySlashCommand('/config agents.defaults', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.get', {});
    expect(result.text).toContain('Config agents.defaults');
  });
});