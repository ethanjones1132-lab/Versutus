import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('family commands with a registered subcommand slash', () => {
  test('/skills status calls the registry method skills.status, never skill.get', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ status: 'ready', loaded: 4 });
    const result = await executeGatewaySlashCommand('/skills status', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.status', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('skill.get', expect.anything());
    expect(result.title).toBe('/skills status');
  });

  test('/skills status with extra args still resolves the registered subcommand', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ status: 'ready' });
    await executeGatewaySlashCommand('/skills status now', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.status', {});
  });

  test('/plugins ui keeps its registry precedence over the family guess', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ portals: [] });
    await executeGatewaySlashCommand('/plugins ui', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('plugins.uiDescriptors', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('plugin.get', expect.anything());
  });

  test('/cron list runs the registered cron.list route', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ jobs: [] });
    await executeGatewaySlashCommand('/cron list', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.list', {});
  });

  test('/env list runs the registered environments.list route', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ environments: [] });
    await executeGatewaySlashCommand('/env list', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('environments.list', {});
  });

  test('/tools effective answers from the tools.list catalog instead of a guessed method', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({});
    const result = await executeGatewaySlashCommand('/tools effective', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('tools.list', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('tools.effective', expect.anything());
    expect(result.title).toBe('/tools');
  });

  test('families with no registered subcommand keep the family switch', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({});
    await executeGatewaySlashCommand('/agents alpha', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('agent.get', { id: 'alpha' });
  });

  test('bare /skills still lists via skills.list', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ skills: [] });
    await executeGatewaySlashCommand('/skills', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
  });

  test('/skills <name> answers from the skills.list read', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ skills: [{ name: 'weather', description: 'Look up the forecast' }] });
    const result = await executeGatewaySlashCommand('/skills weather', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toContain('/weather');
  });
});