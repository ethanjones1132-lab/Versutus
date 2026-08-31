import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: null,
    gatewayRequest: jest.fn().mockResolvedValue([]),
    runAgentCommand: jest.fn(),
    ...overrides,
  };
}

describe('/help hides rows the gateway snapshot marks unavailable', () => {
  test('/help omits the unavailable rows and keeps working ones', async () => {
    const result = await executeGatewaySlashCommand(
      '/help',
      context({
        methods: {
          config: { available: false, reason: 'not dispatched by this gateway' },
          device: { available: false, reason: 'not dispatched by this gateway' },
          approvals: { available: false, reason: 'not dispatched by this gateway' },
        },
      }),
    );
    expect(result.text).not.toContain('/config (operator.read) — Read gateway config');
    expect(result.text).not.toContain('/device (operator.read) — Local device identity, roles, scopes, token state');
    expect(result.text).not.toContain('/approvals (operator.admin) — Execution approval policy');
    expect(result.text).toContain('/sessions (operator.read) — Recent sessions');
    expect(result.text).toContain('/models (operator.read) — Available model catalog');
    expect(result.text).toContain('/model — Show active default model');
  });

  test('a row with its own id is kept even when its family head is marked unavailable', async () => {
    const result = await executeGatewaySlashCommand(
      '/help',
      context({
        methods: {
          config: { available: false, reason: 'not dispatched by this gateway' },
          device: { available: false, reason: 'not dispatched by this gateway' },
          approvals: { available: false, reason: 'not dispatched by this gateway' },
        },
      }),
    );
    // The palette keys availability by command id, not by family: only the
    // exact ids marked unavailable are hidden.
    expect(result.text).toContain('/config patch [write] (operator.write) — Write one or more config keys (JSON)');
    expect(result.text).toContain('/device revoke [destructive] (operator.admin) — Revoke device token (high risk)');
    expect(result.text).toContain('/approvals pending (operator.admin) — List pending approvals');
  });

  test('/help keeps every row when no methods snapshot is supplied', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    expect(result.text).toContain('/config (operator.read) — Read gateway config');
    expect(result.text).toContain('/device (operator.read) — Local device identity, roles, scopes, token state');
    expect(result.text).toContain('/approvals (operator.admin) — Execution approval policy');
  });

  test('/help all stays the everything view even with the snapshot', async () => {
    const result = await executeGatewaySlashCommand(
      '/help all',
      context({
        methods: {
          config: { available: false },
          device: { available: false },
          approvals: { available: false },
        },
      }),
    );
    expect(result.text).toContain('/config (operator.read) — Read gateway config');
    expect(result.text).toContain('/device (operator.read) — Local device identity, roles, scopes, token state');
    expect(result.text).toContain('/approvals (operator.admin) — Execution approval policy');
  });

  test('/help admin keeps today rows even with the snapshot', async () => {
    const result = await executeGatewaySlashCommand(
      '/help admin',
      context({
        methods: {
          config: { available: false },
          device: { available: false },
          approvals: { available: false },
        },
      }),
    );
    expect(result.text).toContain('/config patch [write] (operator.write) — Write one or more config keys (JSON)');
    expect(result.text).toContain('/device revoke [destructive] (operator.admin) — Revoke device token (high risk)');
  });

  test('the unknown-command fallback hides the unavailable rows too', async () => {
    const result = await executeGatewaySlashCommand(
      '/definitely-not-real',
      context({
        methods: {
          config: { available: false, reason: 'not dispatched by this gateway' },
          device: { available: false, reason: 'not dispatched by this gateway' },
          approvals: { available: false, reason: 'not dispatched by this gateway' },
        },
      }),
    );
    expect(result.text).toMatch(/Unknown command/);
    expect(result.text).not.toContain('/config (operator.read) — Read gateway config');
    expect(result.text).toContain('/sessions (operator.read) — Recent sessions');
  });
});