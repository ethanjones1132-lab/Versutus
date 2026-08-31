import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import type { GatewayHelloOk } from '@/lib/gateway/types';

const HELLO: GatewayHelloOk = {
  type: 'hello-ok',
  protocol: 3,
  server: { version: '0.5.2', connId: 'c1' },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: HELLO,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
    ...overrides,
  } as any;
}

describe('/help advertises fetched skills', () => {
  test('/help with a resolving skills.list mock lists each skill slash and its description', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue([
      { name: 'weather', description: 'Look up the forecast' },
      { name: 'github-pr-workflow', description: 'Full PR lifecycle' },
    ]);
    const result = await executeGatewaySlashCommand('/help', context({ gatewayRequest }));
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toMatch(/Skills/);
    expect(result.text).toContain('/weather — Look up the forecast');
    expect(result.text).toContain('/github-pr-workflow — Full PR lifecycle');
  });

  test('/help degrades to today output when skills.list fails', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/help', context({ gatewayRequest }));
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toContain('Available commands');
    expect(result.text).not.toContain('/weather — Look up the forecast');
  });

  test('/help all keeps today rows without the skills section', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue([{ name: 'weather', description: 'Look up the forecast' }]);
    const result = await executeGatewaySlashCommand('/help all', context({ gatewayRequest }));
    expect(result.text).not.toContain('/weather — Look up the forecast');
  });

  test('/help admin does not show the skills section', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue([{ name: 'weather', description: 'Look up the forecast' }]);
    const result = await executeGatewaySlashCommand('/help admin', context({ gatewayRequest }));
    expect(result.text).not.toContain('/weather — Look up the forecast');
  });

  test('/help <family> does not show the skills section', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue([{ name: 'weather', description: 'Look up the forecast' }]);
    const result = await executeGatewaySlashCommand('/help models', context({ gatewayRequest }));
    expect(result.text).not.toContain('/weather — Look up the forecast');
  });
});
