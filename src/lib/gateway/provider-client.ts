import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

export type Rpc = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export function createProviderClient(request: Rpc) {
  return {
    list: () => request<{ providers: ProviderSnapshot[] }>('providers.list').catch(async () => {
      const raw = await request<{ providers?: ProviderSnapshot[] } | ProviderSnapshot[]>('GET /v1/providers');
      return Array.isArray(raw) ? raw : raw.providers ?? [];
    }),
    get: (id: string) => request<ProviderSnapshot>('providers.get', { id }),
    check: (id: string) => request<ProviderSnapshot>('providers.health.check', { id }),
    refreshCatalog: (id: string) => request<ProviderSnapshot>('providers.catalog.refresh', { id }),
    setApiKey: (id: string, value: string) => request<{ ok: boolean }>('providers.auth.setApiKey', { id, value }),
    beginAuth: (id: string) => request('providers.auth.begin', { id }),
    disconnect: (id: string) => request('providers.auth.disconnect', { id }),
    remove: (id: string) => request('providers.delete', { id }),
  };
}
