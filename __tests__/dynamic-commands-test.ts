import { getSlashCommandSuggestions, executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';

const STANDUP: GatewayCapabilityCommand = {
  slash: '/standup',
  description: 'Run the standup job now',
  method: 'standup.run',
  danger: 'write',
};

describe('dynamic commands in the palette', () => {
  test('an instance-contributed command is suggested', () => {
    const suggestions = getSlashCommandSuggestions('/stand', null, [], {}, [STANDUP]);
    const match = suggestions.find((item) => item.value === '/standup');
    expect(match).toBeDefined();
    expect(match!.description).toBe('Run the standup job now');
    expect(match!.unavailable).toBe(false);
  });

  test('dynamic commands are absent when the gateway contributes none', () => {
    const suggestions = getSlashCommandSuggestions('/stand', null, [], {}, []);
    expect(suggestions.find((item) => item.value === '/standup')).toBeUndefined();
  });

  test('a dynamic command cannot shadow a built-in slash', () => {
    const impostor: GatewayCapabilityCommand = {
      slash: '/help',
      description: 'Malicious override',
      method: 'evil.run',
      danger: 'safe',
    };
    const suggestions = getSlashCommandSuggestions('/help', null, [], {}, [impostor]);
    const help = suggestions.filter((item) => item.value === '/help');
    expect(help).toHaveLength(1);
    expect(help[0].description).not.toBe('Malicious override');
  });
});

describe('dynamic command execution', () => {
  function context(overrides: Record<string, unknown> = {}) {
    return {
      hello: null,
      gatewayRequest: jest.fn().mockResolvedValue({ ranInstance: 'standup' }),
      runAgentCommand: jest.fn(),
      dynamicCommands: [STANDUP],
      ...overrides,
    } as any;
  }

  test('dispatches through gatewayRequest with the declared method', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/standup', ctx);
    expect(ctx.gatewayRequest).toHaveBeenCalledWith('standup.run', {});
    expect(result.title).toBe('/standup');
  });

  test('passes declared params, and free text as `input`', async () => {
    const ctx = context({
      dynamicCommands: [{ ...STANDUP, params: { dryRun: true } }],
    });
    await executeGatewaySlashCommand('/standup now please', ctx);
    expect(ctx.gatewayRequest).toHaveBeenCalledWith('standup.run', { dryRun: true, input: 'now please' });
  });

  test('a built-in still wins when a dynamic command claims its slash', async () => {
    const ctx = context({
      dynamicCommands: [{ slash: '/help', description: 'x', method: 'evil.run', danger: 'safe' }],
    });
    const result = await executeGatewaySlashCommand('/help', ctx);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
    expect(result.title).toBe('/help');
  });

  test('an unknown command is still unknown when dynamic commands exist', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/definitely-not-real', ctx);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toMatch(/Unknown command/);
  });

  test('a failing dynamic command surfaces the gateway error, not a crash', async () => {
    const ctx = context({
      gatewayRequest: jest.fn().mockRejectedValue(new Error('instance is unhealthy')),
    });
    await expect(executeGatewaySlashCommand('/standup', ctx)).rejects.toThrow('instance is unhealthy');
  });
});
