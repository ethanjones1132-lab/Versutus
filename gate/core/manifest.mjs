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
export function buildManifest({ name, version, capabilityKinds = [], capabilityInstances = [] }) {
  const providers = capabilityInstances
    .filter((instance) => instance.kind === 'provider')
    .map((instance) => instance.manifestEntry);

  const manifest = {
    manifest: MANIFEST_SPEC,
    kind: GATE_KIND,
    name,
    transport: { primary: 'http' },
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      capabilitiesRpc: '/v1/capabilities/rpc',
    },
    capabilities: { chat: true, models: true },
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
