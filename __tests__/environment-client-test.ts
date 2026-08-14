import { createEnvironmentClient } from '@/lib/gateway/environment-client';

describe('environment client', () => {
  it('starts a run and lists commands without treating CLI output as catalog data', async () => {
    const client = createEnvironmentClient(async <T,>(method: string, params?: Record<string, unknown>) => {
      if (method === 'environments.commands.list') {
        return { status: { machineReadable: true, risk: 'read' } } as T;
      }
      if (method === 'environments.check') {
        return { id: params?.id, state: 'ready' } as T;
      }
      return { ok: true } as T;
    });
    const commands = await client.listCommands('codex-local');
    expect(commands.status.machineReadable).toBe(true);
    const checked = await client.check('codex-local');
    expect(checked.state).toBe('ready');
  });
});
