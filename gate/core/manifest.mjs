/**
 * Manifest builder for Versutus Gateway.
 * Assembles the gateway's advertised transport, capability kinds, and
 * capability instances. `providers[]` is derived from instances of kind
 * `provider` for backward compatibility with child-profile sync — see
 * docs/superpowers/specs/2026-08-12-gate-capability-registry-design.md §8.
 */

export const MANIFEST_SPEC = 'versutus-gateway/v1';
export const GATE_KIND = 'versutus-gate';

/**
 * A provider as a client needs to see it: enough state to decide whether it is
 * usable, and nothing that could be a credential. The manifest is served to any
 * paired device, so `credentialRef`, `baseUrl` and key material stay out.
 */
function providerEntryFromSnapshot(snapshot) {
  return {
    id: snapshot.id,
    label: snapshot.label,
    basePath: `/p/${snapshot.id}`,
    models: (snapshot.catalog?.models ?? []).map((model) => model.id),
    capabilities: { chat: true, streaming: true },
    readiness: {
      state: snapshot.readiness?.state ?? 'unavailable',
      ...(snapshot.readiness?.code ? { code: snapshot.readiness.code } : {}),
    },
    auth: { state: snapshot.auth?.state ?? 'missing' },
    catalog: {
      state: snapshot.catalog?.state ?? 'unavailable',
      source: snapshot.catalog?.source ?? 'legacy_bootstrap',
      count: (snapshot.catalog?.models ?? []).length,
    },
  };
}

const byId = (a, b) => a.id.localeCompare(b.id);

/**
 * @param {Object} options
 * @param {string} options.name
 * @param {string} [options.version]
 * @param {Array<Object>} [options.providerSnapshots] - v2 provider state, from ProviderService.toSnapshot()
 * @param {Array<Object>} [options.capabilityKinds] - wire-shaped, from describeKinds()
 * @param {Array<Object>} [options.capabilityInstances] - wire-shaped, from resolveManifestInstances()
 */
export function buildManifest({
  name,
  version,
  backends = [],
  providerSnapshots = [],
  capabilityKinds = [],
  capabilityInstances = [],
  rpcMethods = [],
}) {
  // v2 providers are owned by ProviderService and persist under Gate home;
  // legacy ones are registry files. Both are advertised, but a v2 record wins
  // on a collision — it is the one with live readiness and a real catalog.
  const v2Providers = providerSnapshots.map(providerEntryFromSnapshot).sort(byId);
  const v2Ids = new Set(v2Providers.map((entry) => entry.id));
  const legacyProviders = capabilityInstances
    .filter((instance) => instance.kind === 'provider')
    .map((instance) => instance.manifestEntry)
    .filter((entry) => entry && !v2Ids.has(entry.id))
    .sort(byId);
  const providers = [...v2Providers, ...legacyProviders];

  // A backend is a native environment that owns its own sessions, models and
  // tools. Their presence is what makes those capabilities real here.
  const hasBackend = backends.length > 0;
  const backendCan = (capability) =>
    backends.some((backend) => (backend.capabilities ?? []).includes(capability));

  const manifest = {
    manifest: MANIFEST_SPEC,
    kind: GATE_KIND,
    name,
    transport: { primary: 'http' },
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      providers: '/v1/providers',
      environments: '/v1/environments',
      capabilitiesRpc: '/v1/capabilities/rpc',
      // Unconditional: the shell is the Gate's own process, not a backend's,
      // so it needs no environment attached and no platform gate — the
      // implementation is child_process on every OS.
      terminal: '/v1/terminal/stream',
      ...(hasBackend
        ? { sessions: '/v1/sessions', sessionMessages: '/v1/sessions/{id}/messages', backends: '/v1/backends' }
        : {}),
      // Runs are advertised only when a backend actually implements them: the
      // CLI backends run a turn synchronously and have no run id to report.
      ...(backendCan('runs')
        ? {
            runs: '/v1/runs',
            runStatus: '/v1/runs/{run_id}',
            runEvents: '/v1/runs/{run_id}/events',
            runStop: '/v1/runs/{run_id}/stop',
            runApproval: '/v1/runs/{run_id}/approval',
          }
        : {}),
      // `capabilities.tools` was advertised from the adapter's declaration
      // alone, with no route and no backend method behind it. The endpoint is
      // what makes that claim checkable.
      ...(backendCan('tools') ? { toolsets: '/v1/toolsets' } : {}),
      ...(backendCan('skills') ? { skills: '/v1/skills' } : {}),
      ...(backendCan('diagnostics') ? { health_detailed: '/health/detailed' } : {}),
      ...(backendCan('cron') ? { jobs: '/v1/jobs' } : {}),
      ...(backendCan('bots') ? { bots: '/v1/bots' } : {}),
    },
    // Advertise exactly what the endpoints above serve. Under-claiming makes the
    // Gate render as featureless in the app; over-claiming (sessions, runs,
    // approvals, terminal — none of which the Gate implements) would make it
    // offer surfaces that cannot work.
    capabilities: {
      chat: true,
      streaming: true,
      models: true,
      providers: true,
      environments: true,
      capabilityRegistry: true,
      terminal: true,
      ...(backendCan('sessions') ? { sessions: true } : {}),
      ...(backendCan('tools') ? { tools: true } : {}),
      ...(backendCan('runs') ? { runs: true, approvals: true } : {}),
      // Hermes reports `jobs_admin: false` on its own /v1/capabilities while
      // answering the full jobs CRUD with 200. The Gate advertises from what it
      // observably fronts, so the app stops hiding cron on a gateway that has it.
      ...(backendCan('cron') ? { jobs_admin: true } : {}),
    },
    backends,
    providers,
    capabilityKinds,
    capabilityInstances,
    // Every method name /v1/capabilities/rpc will answer. The app filters its
    // command buttons on this instead of guessing from the gateway's kind, so
    // a button renders iff this gateway actually dispatches it.
    rpcMethods,
    auth: {
      grantPath: '/.well-known/gateway/access',
      schemes: ['bearer'],
    },
  };

  if (version) {
    manifest.version = version;
  }

  return manifest;
}
