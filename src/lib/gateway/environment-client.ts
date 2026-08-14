import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

export type Rpc = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export function createEnvironmentClient(request: Rpc) {
  return {
    list: async () => {
      const result = await request<{ environments?: EnvironmentSnapshot[] } | EnvironmentSnapshot[]>('environments.list').catch(() => ({ environments: [] }));
      return Array.isArray(result) ? result : result.environments ?? [];
    },
    check: (id: string) => request<{ id: string; state: string }>('environments.check', { id }),
    start: (id: string) => request('environments.lifecycle.start', { id }),
    stop: (id: string) => request('environments.lifecycle.stop', { id }),
    listCommands: (id: string) => request<Record<string, { machineReadable: boolean; risk: string }>>('environments.commands.list', { id }),
    create: (input: Record<string, unknown>) => request('environments.create', input),
    remove: (id: string) => request('environments.delete', { id }),
  };
}
