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
 * @param {Object} options
 * @param {string} options.name
 * @param {string} [options.version]
 * @param {Array<Object>} [options.capabilityKinds] - wire-shaped, from describeKinds()
 * @param {Array<Object>} [options.capabilityInstances] - wire-shaped, from resolveManifestInstances()
 */
export function buildManifest({ name, version, backends = [], capabilityKinds = [], capabilityInstances = [] }) {
  const providers = capabilityInstances
    .filter((instance) => instance.kind === 'provider')
    .map((instance) => instance.manifestEntry);

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
      ...(hasBackend
        ? { sessions: '/v1/sessions', sessionMessages: '/v1/sessions/{id}/messages', backends: '/v1/backends' }
        : {}),
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
      ...(backendCan('sessions') ? { sessions: true } : {}),
      ...(backendCan('tools') ? { tools: true } : {}),
    },
    backends,
    providers,
    capabilityKinds,
    capabilityInstances,
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
