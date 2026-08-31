import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('family list commands put the answer in the bubble text, not only in Raw', () => {
  test('/tools lists toolset names and descriptions as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      toolsets: [
        { name: 'web', description: 'browse and search the web' },
        { name: 'memory', description: '' },
      ],
    });
    const result = await executeGatewaySlashCommand('/tools', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('tools.list', {});
    expect(result.title).toBe('/tools');
    expect(result.text).toContain('Toolsets: 2');
    expect(result.text).toContain('web: browse and search the web');
    expect(result.text).toContain('- memory');
    expect(result.raw).toContain('"toolsets"');
  });

  test('/skills lists skill names as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      skills: [
        { name: 'codemod', description: 'apply a codemod' },
        { name: 'swe', description: '' },
      ],
    });
    const result = await executeGatewaySlashCommand('/skills', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toContain('Items: 2');
    expect(result.text).toContain('- codemod');
    expect(result.text).toContain('- swe');
  });

  test('/cron reports the runner state and job count as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      running: true,
      jobs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    const result = await executeGatewaySlashCommand('/cron', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.list', {});
    expect(result.text).toContain('Runner: running');
    expect(result.text).toContain('Jobs: 3');
  });

  test('/plugins lists plugin rows as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      plugins: [{ name: 'sketch', enabled: true, version: '1.0' }],
    });
    const result = await executeGatewaySlashCommand('/plugins', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('plugins.list', {});
    expect(result.text).toContain('Plugins: 1');
    expect(result.text).toContain('sketch (enabled: true, version: 1.0)');
  });

  test('/env lists environment rows as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      environments: [{ name: 'PGPASSWORD', status: 'set' }],
    });
    const result = await executeGatewaySlashCommand('/env', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('environments.list', {});
    expect(result.text).toContain('Environments');
    expect(result.text).toContain('PGPASSWORD (status: set)');
  });

  test('/agents lists agent rows as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      agents: [
        { name: 'default', model: 'grok-4' },
        { name: 'anvil', model: 'grok-4' },
      ],
    });
    const result = await executeGatewaySlashCommand('/agents', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('agents.list', {});
    expect(result.text).toContain('Agents: 2');
    expect(result.text).toContain('default (model: grok-4)');
  });

  test('/artifacts lists artifact rows as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      artifacts: [{ name: 'report.pdf', size: 2048 }],
    });
    const result = await executeGatewaySlashCommand('/artifacts', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('artifacts.list', {});
    expect(result.text).toContain('Artifacts: 1');
    expect(result.text).toContain('report.pdf (size: 2048)');
  });

  test('a rejecting /tools effective puts the error and the guidance into the text', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('HTTP 404'));
    const result = await executeGatewaySlashCommand('/tools effective', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('tools.effective', { id: 'effective' });
    expect(result.title).toBe('/tools');
    expect(result.text).toContain('Tools could not be read');
    expect(result.text).toContain('HTTP 404');
    expect(result.text).toContain('Use /tools for the toolsets catalog (GET /v1/toolsets)');
  });

  test('a rejecting /agents names the failure and the agents.list guidance', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('HTTP 500'));
    const result = await executeGatewaySlashCommand('/agents', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Agents could not be read');
    expect(result.text).toContain('HTTP 500');
    expect(result.text).toContain('Hermes has no remote agent registry');
  });

  test('/skills <name> keeps the legacy single-record read shape', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ name: 'codemod', description: 'apply a codemod' });
    const result = await executeGatewaySlashCommand('/skills codemod', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skill.get', { id: 'codemod' });
    expect(result.text).toBe('Skills');
    expect(result.raw).toContain('codemod');
  });

  test('/agents <id> keeps the legacy single-record read shape', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ id: 'alpha', name: 'Alpha' });
    const result = await executeGatewaySlashCommand('/agents alpha', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('agent.get', { id: 'alpha' });
    expect(result.text).toBe('Agent alpha');
  });

  test('an empty toolset catalog reports none instead of a bare name', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ toolsets: [] });
    const result = await executeGatewaySlashCommand('/tools', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Tools: none reported');
  });
});