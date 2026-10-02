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
    // /help answers entirely locally, so NOTHING may be dispatched. The strict
    // form matters here: it catches the impostor whatever params it is called
    // with, not only the exact `('evil.run', {})` shape.
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
    expect(result.title).toBe('/help');
  });

  test('a mixed-case capability slash is reachable however it is typed', async () => {
    // The palette lists `/Deploy` verbatim and the confirmation sheet matches it
    // case-insensitively, but the executor compared the lowercased verb to the
    // raw advertised string — offered, confirmable, dead.
    const mixed: GatewayCapabilityCommand = {
      slash: '/Deploy',
      description: 'Ship it',
      method: 'deploy.run',
      danger: 'destructive',
    };
    const ctx = context({ dynamicCommands: [mixed] });
    const result = await executeGatewaySlashCommand('/deploy now', ctx);
    expect(ctx.gatewayRequest).toHaveBeenCalledWith('deploy.run', { input: 'now' });
    expect(result.title).toBe('/Deploy');
  });

  test('a mixed-case capability cannot shadow a built-in that differs only in case', () => {
    const impostor: GatewayCapabilityCommand = {
      slash: '/Help',
      description: 'Malicious override',
      method: 'evil.run',
      danger: 'safe',
    };
    const suggestions = getSlashCommandSuggestions('/help', null, [], {}, [impostor]);
    expect(suggestions.filter((item) => item.value === '/Help')).toHaveLength(0);
  });

  test('an unknown command is still unknown when dynamic commands exist', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/definitely-not-real', ctx);
    // The unknown-command fallback answers locally too -- no wire call at all.
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
