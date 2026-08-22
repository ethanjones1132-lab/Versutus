import type {
  EnvironmentAdapter,
  EnvironmentRunEvent,
  EnvironmentRunSummary,
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
  /**
   * Environment variable → credential-vault reference (e.g.
   * `provider/anthropic-main/api-key`). References only — the secret VALUE
   * lives in the Gate's vault and is set once from the Providers screen, then
   * resolved into the CLI's environment at run start. Absent means this form
   * says nothing about bindings: an older Gate's snapshot carries none, and a
   * save must not wipe mappings it cannot see.
   */
  credentialBindings?: Record<string, string>;
  /**
   * Per-run time budget in seconds; when set, the Gate itself stops a task
   * that has been running longer than this instead of letting one hung CLI
   * hold the run slot forever. Absent/empty means no limit — the historical
   * behavior. The one lifecycle knob this form owns: startup mode, idle
   * timeout and concurrency stay Gate-side settings that an edit preserves.
   */
  maxRunSeconds?: number;
};

/** The CLI environment record shape this app builds — what the Gate's schema validates. */
export type EnvironmentRecord = {
  schemaVersion: number;
  kind: 'cli-environment';
  id: string;
  label: string;
  adapterId: string;
  executable: { path: string };
  protocolPreference: string[];
  versionPolicy: { supported: string; adapterRevision: string };
  providerRefs: string[];
  workspacePolicy: {
    roots: string[];
    defaultRoot: string;
    defaultSandbox: string;
    allowAdditionalRoots: boolean;
  };
  lifecycle: { startup: string; idleTimeoutSeconds: number; maxConcurrentRuns: number; maxRunSeconds?: number };
  enabled: boolean;
  credentialBindings: Record<string, string>;
};

/**
 * Env-var name → vault reference, validated the way the Gate's schema is:
 * structural only. Both sides must be non-empty after trimming; a half-filled
 * binding would silently resolve to nothing at run start.
 */
function normalizeCredentialBindings(bindings?: Record<string, string>): Record<string, string> {
  if (!bindings) return {};
  const normalized: Record<string, string> = {};
  for (const [envName, ref] of Object.entries(bindings)) {
    const name = envName.trim();
    const target = typeof ref === 'string' ? ref.trim() : '';
    if (!name || !target) {
      throw new Error(
        'A credential binding needs both an environment variable name and a vault reference.',
      );
    }
    normalized[name] = target;
  }
  return normalized;
}

/**
 * Build the CLI environment record from an adapter choice. Version policy and
 * protocol preference come from the adapter itself, so an operator never has to
 * copy a version range by hand into JSON.
 */
export function buildEnvironmentRecord(input: CreateEnvironmentInput): EnvironmentRecord {
  if (!ID_PATTERN.test(input.id)) {
    throw new Error(
      `Environment id "${input.id}" is not valid — use lowercase letters, numbers and hyphens.`,
    );
  }
  if (!input.executablePath.trim()) throw new Error('The CLI executable path is required.');
  if (!input.workspaceRoot.trim()) throw new Error('A workspace root is required.');
  if (
    input.maxRunSeconds !== undefined &&
    (!Number.isInteger(input.maxRunSeconds) || input.maxRunSeconds < 1)
  ) {
    // Same rule the Gate's schema enforces — fail here with a name, not as a
    // remote validation error after the save is refused.
    throw new Error('The run time limit must be a positive whole number of seconds.');
  }

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
    lifecycle: {
      startup: 'on_demand',
      idleTimeoutSeconds: 300,
      maxConcurrentRuns: 1,
      // Absent unless the operator set a budget — "no limit" stays expressible
      // on the wire, matching the Gate's schema where the key is optional.
      ...(input.maxRunSeconds !== undefined ? { maxRunSeconds: input.maxRunSeconds } : {}),
    },
    enabled: true,
    credentialBindings: normalizeCredentialBindings(input.credentialBindings),
  };
}

/**
 * Prefill an edit form from the environment as the Gate reports it. The
 * adapter is synthesized from the snapshot's own advertised protocols and
 * version policy, so editing works even when the Gate's adapter catalog is
 * unavailable — the record already carries everything the form needs.
 */
export function snapshotToEditInput(environment: EnvironmentSnapshot): CreateEnvironmentInput {
  return {
    id: environment.id,
    label: environment.label,
    adapter: {
      adapterId: environment.adapterId,
      adapterRevision: environment.versionPolicy?.adapterRevision ?? '',
      supportedCliVersions: environment.versionPolicy?.supported ?? '',
      protocols: [...environment.protocolPreference],
      capabilities: [],
      operations: [],
    },
    executablePath: environment.executable.path,
    workspaceRoot: environment.workspacePolicy.defaultRoot,
    providerRefs: [...environment.providerRefs],
    // Only when the snapshot actually reports bindings. An older Gate omits
    // the field entirely — prefilling "no bindings" there would let the next
    // save wipe mappings the form never saw.
    ...(environment.credentialBindings
      ? { credentialBindings: { ...environment.credentialBindings } }
      : {}),
    // Prefill the run budget when the record carries one; absence means "no
    // limit", which is a real value here, not an unknown — the field stays
    // editable so a no-limit environment can gain a budget from the phone.
    ...(environment.lifecycle.maxRunSeconds !== undefined
      ? { maxRunSeconds: environment.lifecycle.maxRunSeconds }
      : {}),
  };
}

/**
 * Fields the edit form owns, expressed as an `environments.update` patch. The
 * Gate shallow-merges this over the stored record, so everything else —
 * sandbox level, additional-roots flag, enabled — survives untouched: fixing
 * a typo'd executable path must not silently reset a workspace policy an
 * operator deliberately widened on the Gate machine.
 *
 * Lifecycle travels as a COMPLETE object built from the live snapshot with
 * only maxRunSeconds swapped for the form's value (a shallow merge replaces
 * the whole object, so a partial one would drop startup/idle/concurrency).
 * Clearing the field sends lifecycle without the key, which removes the
 * budget; every other lifecycle field round-trips exactly as stored.
 */
export function buildEnvironmentUpdatePatch(
  input: CreateEnvironmentInput,
  existing: Pick<EnvironmentSnapshot, 'workspacePolicy' | 'lifecycle'>,
): Record<string, unknown> {
  const record = buildEnvironmentRecord(input);
  const preservedLifecycle: Record<string, unknown> = { ...existing.lifecycle };
  // The form's value wins in both directions — set or removed. Spreading
  // existing.lifecycle alone would resurrect a budget the operator cleared.
  delete preservedLifecycle.maxRunSeconds;
  if (record.lifecycle.maxRunSeconds !== undefined) {
    preservedLifecycle.maxRunSeconds = record.lifecycle.maxRunSeconds;
  }
  const patch: Record<string, unknown> = {
    label: record.label,
    adapterId: record.adapterId,
    executable: record.executable,
    protocolPreference: record.protocolPreference,
    versionPolicy: record.versionPolicy,
    providerRefs: record.providerRefs,
    workspacePolicy: {
      ...existing.workspacePolicy,
      roots: record.workspacePolicy.roots,
      defaultRoot: record.workspacePolicy.defaultRoot,
    },
    lifecycle: preservedLifecycle,
  };
  // Bindings travel only when the form actually saw them. The Gate
  // shallow-merges the patch, so omitting the key preserves whatever an
  // operator bound by hand on a Gate that does not report bindings yet.
  if (input.credentialBindings !== undefined) {
    patch.credentialBindings = record.credentialBindings;
  }
  return patch;
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

  /**
   * Runs kept by the Gate for this environment, newest first. Feeds the
   * recovery affordance: after a dropped stream or an app restart, the run id
   * is discoverable again and the event stream replays the whole run.
   */
  const listRuns = async (environmentId: string): Promise<EnvironmentRunSummary[]> => {
    const response = await ensureOk(await requireFetcher()(runPath(environmentId)));
    const body = (await response.json()) as { runs?: EnvironmentRunSummary[] };
    return Array.isArray(body.runs) ? body.runs : [];
  };

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
    listRuns,

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
