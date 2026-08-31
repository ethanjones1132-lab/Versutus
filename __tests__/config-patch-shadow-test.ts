import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/config patch {"key":"value"}` is advertised by the registry
 * (dashboard.ts config-patch, danger write) and by the slash palette, but
 * runConfigCommand only knows schema/diff/rollback/last-good and path reads,
 * so the write form dead-ends in "Config path not found: patch" — the
 * registered entry is unreachable from chat. The patch subcommand must
 * forward into the registry entry so the operator's JSON reaches
 * config.patch and honest RPC failures surface instead of a fake path read.
 */
describe('/config patch forwards to the registered config-patch entry', () => {
  test('a JSON payload reaches config.patch with the parsed object', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true, hash: 'h2' });
    const result = await executeGatewaySlashCommand('/config patch {"agents":{}}', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.patch', { agents: {} });
    expect(result.text).toContain('Write config');
    expect(result.text).not.toContain('Config path not found');
  });

  test('a gateway with no config REST reports the real failure instead of a path read', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(
      new Error(
        'config.patch is not supported by this gateway. Hermes configuration is host-side (config.yaml) — no remote config writes exist. Per-request model override is the supported path (model picker).',
      ),
    );
    await expect(
      executeGatewaySlashCommand('/config patch {"agents":{}}', {
        hello: null,
        gatewayRequest,
        runAgentCommand: jest.fn(),
      }),
    ).rejects.toThrow(/no remote config writes exist/);
    expect(gatewayRequest).toHaveBeenCalledWith('config.patch', { agents: {} });
  });

  test('a bare /config patch prints the usage without calling any RPC', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/config patch', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('/config patch {"key":"value"}');
  });

  test('a malformed JSON payload is refused locally with the expected shape named', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/config patch not-json', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('/config patch {"key":"value"}');
  });

  test('/config <path> path reads keep working', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      hash: 'h1',
      config: { agents: { defaults: { model: { primary: 'gateway-default' } } } },
    });
    const result = await executeGatewaySlashCommand('/config agents.defaults', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('config.get', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('config.patch', expect.anything());
    expect(result.text).toContain('Config agents.defaults');
    expect(result.raw).toContain('gateway-default');
  });

  test('a snapshot blocking the config family answers with guidance before any RPC', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/config patch {"agents":{}}', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: {
        config: { available: false, reason: 'not dispatched by this gateway' },
        'config-patch': { available: false, reason: 'not dispatched by this gateway' },
      },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('no config REST');
    expect(result.text).toContain('Use /help to see what is.');
    expect(result.text).not.toContain('Config path not found');
  });
});