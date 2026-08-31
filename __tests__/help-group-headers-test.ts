import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: null,
    gatewayRequest: jest.fn().mockResolvedValue([]),
    runAgentCommand: jest.fn(),
    ...overrides,
  };
}

describe('/help renders registry groups as sections', () => {
  test('/help prints ### Gateway and ### Sessions headers with the pinned rows still present', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    expect(result.text).toContain('### Gateway');
    expect(result.text).toContain('### Sessions');
    // Row strings stay byte-identical under their headers.
    expect(result.text).toContain('/health (operator.read) — Gateway health check');
    expect(result.text).toContain('/sessions (operator.read) — Recent sessions');
    // Base and local rows keep today's text and position.
    expect(result.text).toContain('Available commands');
    expect(result.text).toContain('/model — Show active default model');
  });

  test('each header sits directly above its own group rows, in registry order', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    const gatewayHeader = result.text.indexOf('### Gateway');
    const healthRow = result.text.indexOf('/health (operator.read) — Gateway health check');
    const sessionsHeader = result.text.indexOf('### Sessions');
    const sessionsRow = result.text.indexOf('/sessions (operator.read) — Recent sessions');
    expect(gatewayHeader).toBeGreaterThan(-1);
    expect(healthRow).toBeGreaterThan(gatewayHeader);
    expect(sessionsHeader).toBeGreaterThan(healthRow);
    expect(sessionsRow).toBeGreaterThan(sessionsHeader);
  });

  test('a group header appears once and no registry row is duplicated', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    expect(result.text.split('### Sessions').length - 1).toBe(1);
    expect(result.text.split('/sessions (operator.read) — Recent sessions').length - 1).toBe(1);
  });

  test('/help models renders only the Models header', async () => {
    const result = await executeGatewaySlashCommand('/help models', context());
    expect(result.text).toContain('### Models');
    expect(result.text).not.toContain('### Sessions');
    expect(result.text).not.toContain('### Gateway');
    expect(result.text).toContain('/models (operator.read) — Available model catalog');
  });

  test('/help admin keeps write/destructive rows, each under its group header', async () => {
    const result = await executeGatewaySlashCommand('/help admin', context());
    expect(result.text).toContain('### Devices');
    expect(result.text).toContain('/device revoke [destructive] (operator.admin) — Revoke device token (high risk)');
    expect(result.text).not.toContain('/health (operator.read) — Gateway health check');
  });

  test('the unknown-command fallback renders group headers too', async () => {
    const result = await executeGatewaySlashCommand('/definitely-not-real', context());
    expect(result.text).toMatch(/Unknown command/);
    expect(result.text).toContain('### Sessions');
  });
});