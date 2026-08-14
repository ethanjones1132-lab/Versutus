import { createProviderClient } from '@/lib/gateway/provider-client';

describe('provider client', () => {
  it('lists sanitized snapshots and never sends token values back', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = createProviderClient(async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'providers.health.check') {
        return { id: 'openai-main', auth: { state: 'ready' }, catalog: { state: 'fresh', models: [] } } as T;
      }
      return { ok: true } as T;
    });
    await client.setApiKey('openai-main', 'sk-live-must-not-echo');
    expect(calls[0]).toEqual({
      method: 'providers.auth.setApiKey',
      params: { id: 'openai-main', value: 'sk-live-must-not-echo' },
    });
    const snapshot = await client.check('openai-main');
    expect(snapshot.auth.state).toBe('ready');
  });
});
