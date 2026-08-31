import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: null,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
    ...overrides,
  };
}

describe('/help advertises the local /model family', () => {
  test('/help lists /model and /model set', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    expect(result.text).toContain('/model — Show active default model');
    expect(result.text).toContain('/model set — Preview and update default model');
  });

  test('/help lists the whole local family: agent, routing, compress', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    expect(result.text).toContain('/model agent — Show per-agent model config');
    expect(result.text).toContain('/model routing — Show model routing policy');
    expect(result.text).toContain('/compress — Show conversation size (compaction is local only)');
  });

  test('local suggestions already covered by the base rows are not duplicated', async () => {
    const result = await executeGatewaySlashCommand('/help', context());
    // The base block already prints /help, /context, /version, /reset rows;
    // the LOCAL_SUGGESTIONS entries for those slashes must not appear again.
    expect(result.text).not.toContain('/help — Show chat commands');
    expect(result.text).not.toContain('/context — Show conversation size\n');
    expect(result.text).toContain('Available commands');
  });

  test('/help all includes the local family too', async () => {
    const result = await executeGatewaySlashCommand('/help all', context());
    expect(result.text).toContain('/model set — Preview and update default model');
  });

  test('/help admin stays write/destructive-only, without the local rows', async () => {
    const result = await executeGatewaySlashCommand('/help admin', context());
    expect(result.text).not.toContain('/model — Show active default model');
    expect(result.text).not.toContain('/compress — Show conversation size');
  });

  test('/help <family> keeps today\'s registry rows without the local rows', async () => {
    const result = await executeGatewaySlashCommand('/help models', context());
    expect(result.text).toContain('/models (operator.read) — Available model catalog');
    expect(result.text).not.toContain('/model set — Preview and update default model');
  });

  test('the unknown-command fallback still prints help, now with /model', async () => {
    const result = await executeGatewaySlashCommand('/definitely-not-real', context());
    expect(result.text).toMatch(/Unknown command/);
    expect(result.text).toContain('/model — Show active default model');
  });
});