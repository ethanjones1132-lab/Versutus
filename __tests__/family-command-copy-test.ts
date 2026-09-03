import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { METHOD_GUIDANCE, METHOD_TO_ROUTE } from '@/lib/gateway/rpc-routes';

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
    // The renderer now names each skill as the slash you would type and groups
    // by category, so a 92-entry Gate catalogue is readable on a phone. These
    // fixtures carry no category, so both land under 'Other'.
    expect(result.text).toContain('Skills: 2');
    expect(result.text).toContain('/codemod');
    expect(result.text).toContain('apply a codemod');
    expect(result.text).toContain('/swe');
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

  test('/cron reports the Gate { data: [...] } job count instead of dumping the envelope', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      data: [{ id: 'job-1' }, { id: 'job-2' }],
    });
    const result = await executeGatewaySlashCommand('/cron', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.list', {});
    expect(result.text).toContain('Jobs: 2');
    expect(result.text).not.toMatch(/^object: list/m);
  });

  test('/cron history <job> reads per-job runs through cron.runs instead of the guidance refusal', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      object: 'list',
      data: [
        { id: 'cron_nightly_1700000000000', jobId: 'nightly', at: '2026-09-01 02:00', status: 'completed', turnCount: 3 },
        { id: 'cron_nightly_1700086400000', jobId: 'nightly', at: '2026-09-02 02:00', status: 'running', turnCount: 1 },
      ],
    });
    const result = await executeGatewaySlashCommand('/cron history nightly', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.runs', { jobId: 'nightly' });
    expect(result.text).toContain('Cron history for nightly: 2');
    expect(result.text).toContain('2026-09-01 02:00 · completed · 3 turns');
    expect(result.text).toContain('2026-09-02 02:00 · running · 1 turns');
    expect(result.raw).toContain('"object"');
  });

  test('/cron history without a job id answers with the usage, not a gateway call', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/cron history', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toBe('Usage: /cron history <job>');
  });

  test('/cron history for an unknown job says no runs instead of printing an empty history', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ object: 'list', data: [] });
    const result = await executeGatewaySlashCommand('/cron history ghost', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.runs', { jobId: 'ghost' });
    expect(result.text).toBe('No runs recorded for ghost.');
  });

  test('a rejecting /cron history names the failure instead of the success title', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('HTTP 500'));
    const result = await executeGatewaySlashCommand('/cron history nightly', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.runs', { jobId: 'nightly' });
    expect(result.text).toContain('Cron history for nightly could not be read');
    expect(result.text).toContain('HTTP 500');
  });

  test('bare /cron still reads cron.list with the job count', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      data: [{ id: 'job-1' }],
    });
    const result = await executeGatewaySlashCommand('/cron', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('cron.list', {});
    expect(result.text).toContain('Jobs: 1');
  });
  test('cron.history guidance names the cron.runs read instead of denying per-job history', () => {
    expect(METHOD_TO_ROUTE['cron.history']).toBeUndefined();
    expect(METHOD_GUIDANCE['cron.history']).toMatch(/cron\.runs/);
    expect(METHOD_GUIDANCE['cron.history']).toMatch(/\/v1\/capabilities\/rpc/);
    expect(METHOD_GUIDANCE['cron.history']).not.toMatch(/no per-job run history/);
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

  test('/env <name> reads environments.check and renders the check state', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      id: 'opencode-local',
      state: 'ready',
      probe: { state: 'ready', cliVersion: '1.17.9', protocol: 'acp' },
    });
    const result = await executeGatewaySlashCommand('/env opencode-local', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('environments.check', { id: 'opencode-local' });
    expect(result.text).toContain('opencode-local');
    expect(result.text).toContain('ready');
    expect(result.text).toContain('1.17.9');
    expect(result.raw).toContain('"state"');
  });

  test('/env <unknown> names the failure instead of claiming no remote status exists', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('environment "ghost" not found'));
    const result = await executeGatewaySlashCommand('/env ghost', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('environments.check', { id: 'ghost' });
    expect(result.text).toContain('could not be read');
    expect(result.text).toContain('environment "ghost" not found');
    expect(result.text).not.toContain('no remote REST exists');
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

  test('/skills <name> answers from the skills.list read filtered by name', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      object: 'list',
      data: [
        { name: 'codemod', description: 'apply a codemod' },
        { name: 'swe', description: '' },
      ],
    });
    const result = await executeGatewaySlashCommand('/skills codemod', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.title).toBe('/skills codemod');
    expect(result.text).toContain('/codemod');
    expect(result.text).toContain('apply a codemod');
    expect(result.raw).toContain('codemod');
  });

  test('/skills <name> matches case-insensitively and strips a leading slash', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      skills: [{ name: 'codemod', description: 'apply a codemod' }],
    });
    const result = await executeGatewaySlashCommand('/skills /CODEMOD', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toContain('/codemod');
  });

  test('/skills <unknown> says no skill instead of printing the catalogue', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      object: 'list',
      data: [{ name: 'codemod', description: 'apply a codemod' }],
    });
    const result = await executeGatewaySlashCommand('/skills ghost', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toBe("No skill named 'ghost'.");
  });

  test('a rejecting /skills <name> names the skills.list failure', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('HTTP 500'));
    const result = await executeGatewaySlashCommand('/skills codemod', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('skills.list', {});
    expect(result.text).toContain('Skill codemod could not be read');
    expect(result.text).toContain('HTTP 500');
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