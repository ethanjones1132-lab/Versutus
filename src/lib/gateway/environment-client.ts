import type {
  EnvironmentAdapter,
  EnvironmentRunEvent,
  EnvironmentSnapshot,
} from '@/lib/gateway/environment-types';
import { messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';

export type Rpc = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** Authenticated fetch against the gateway origin, for the non-RPC run routes. */
export type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type StartRunInput = {
  operation: string;
  input?: Record<string, unknown>;
  workspaceRoot?: string;
  providerRef?: { providerId: string; modelId?: string };
};

/** Same shape the Gate enforces on instance ids (gate/core/cli-helpers.mjs). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CreateEnvironmentInput = {
  id: string;
  label?: string;
  adapter: EnvironmentAdapter;
  executablePath: string;
  workspaceRoot: string;
  /** Gate providers this environment may route model calls through. */
  providerRefs?: string[];
};

/**
 * Build the CLI environment record from an adapter choice. Version policy and
 * protocol preference come from the adapter itself, so an operator never has to
 * copy a version range by hand into JSON.
 */
export function buildEnvironmentRecord(input: CreateEnvironmentInput): Record<string, unknown> {
  if (!ID_PATTERN.test(input.id)) {
    throw new Error(
      `Environment id "${input.id}" is not valid — use lowercase letters, numbers and hyphens.`,
    );
  }
  if (!input.executablePath.trim()) throw new Error('The CLI executable path is required.');
  if (!input.workspaceRoot.trim()) throw new Error('A workspace root is required.');

  const root = input.workspaceRoot.trim();
  return {
    schemaVersion: 1,
    kind: 'cli-environment',
    id: input.id,
    label: input.label?.trim() || input.id,
    adapterId: input.adapter.adapterId,
    executable: { path: input.executablePath.trim() },
    protocolPreference: input.adapter.protocols,
    versionPolicy: {
      supported: input.adapter.supportedCliVersions,
      adapterRevision: input.adapter.adapterRevision,
    },
    providerRefs: input.providerRefs ?? [],
    workspacePolicy: {
      roots: [root],
      defaultRoot: root,
      // Least privilege by default; widening is a deliberate edit.
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  };
}

export function createEnvironmentClient(
  request: Rpc,
  fetcher?: GatewayFetch,
  basePath = '/v1/environments',
) {
  /** Runs are plain HTTP + SSE, not RPC, so they need the gateway origin. */
  function runPath(environmentId: string, ...rest: string[]): string {
    const segments = [encodeURIComponent(environmentId), 'runs', ...rest.map(encodeURIComponent)];
    return `${basePath.replace(/\/+$/, '')}/${segments.join('/')}`;
  }

  function requireFetcher(): GatewayFetch {
    if (!fetcher) {
      throw new Error(
        'This gateway does not support CLI runs from the app — no authenticated transport is available.',
      );
    }
    return fetcher;
  }

  /** Turn a non-2xx into the gateway's own message rather than a bare status. */
  async function ensureOk(response: Response): Promise<Response> {
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    throw new Error(messageFromHttpErrorBody(text, response.status));
  }

  return {
    /** Begin a run. Resolves once the Gate has accepted it and assigned an id. */
    startRun: async (environmentId: string, input: StartRunInput): Promise<{ runId: string }> => {
      const response = await ensureOk(
        await requireFetcher()(runPath(environmentId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      return response.json();
    },

    /**
     * Read the run's event stream to completion, invoking `onEvent` per frame.
     * A malformed frame is skipped: one bad line must not end a live run.
     */
    streamRun: async (
      environmentId: string,
      runId: string,
      onEvent: (event: EnvironmentRunEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const response = await ensureOk(
        await requireFetcher()(runPath(environmentId, runId, 'events'), { signal }),
      );
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              onEvent(JSON.parse(data) as EnvironmentRunEvent);
            } catch {
              // a truncated or non-JSON frame is not a reason to drop the run
            }
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    },

    cancelRun: async (environmentId: string, runId: string) => {
      await ensureOk(await requireFetcher()(runPath(environmentId, runId, 'cancel'), { method: 'POST' }));
    },

    approveRun: async (
      environmentId: string,
      runId: string,
      approvalId: string,
      decision: 'approve' | 'deny',
    ) => {
      await ensureOk(
        await requireFetcher()(runPath(environmentId, runId, 'approve'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalId, decision }),
        }),
      );
    },

    listAdapters: async () => {
      const raw = await request<{ adapters?: EnvironmentAdapter[] } | EnvironmentAdapter[]>(
        'environments.adapters.list',
      );
      return Array.isArray(raw) ? raw : raw.adapters ?? [];
    },
    list: async () => {
      const result = await request<{ environments?: EnvironmentSnapshot[] } | EnvironmentSnapshot[]>('environments.list').catch(() => ({ environments: [] }));
      return Array.isArray(result) ? result : result.environments ?? [];
    },
    check: (id: string) => request<{ id: string; state: string }>('environments.check', { id }),
    start: (id: string) => request('environments.lifecycle.start', { id }),
    stop: (id: string) => request('environments.lifecycle.stop', { id }),
    listCommands: (id: string) => request<Record<string, { machineReadable: boolean; risk: string }>>('environments.commands.list', { id }),
    // async so a rejected id or path surfaces as a rejected promise.
    create: async (input: CreateEnvironmentInput) =>
      request('environments.create', buildEnvironmentRecord(input)),
    update: (id: string, patch: Record<string, unknown>) =>
      request('environments.update', { id, ...patch }),
    remove: (id: string) => request('environments.delete', { id }),
  };
}
