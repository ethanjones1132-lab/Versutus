/**
 * Manifest builder for Versutus Gateway
 * Constructs the gateway's advertised capabilities and provider list
 */

export const MANIFEST_SPEC = 'versutus-gateway/v1';
export const GATE_KIND = 'versutus-gate';

/**
 * Build the gateway manifest
 * @param {Object} options
 * @param {string} options.name - Gateway name
 * @param {string} [options.version] - Gateway version
 * @param {Array<Object>} options.providers - Array of provider configurations
 * @returns {Object} Gateway manifest with advertised capabilities and providers
 */
export function buildManifest({ name, version, providers = [] }) {
  const manifest = {
    manifest: MANIFEST_SPEC,
    kind: GATE_KIND,
    name,
    transport: { primary: 'http' },
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    },
    capabilities: { chat: true, models: true },
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      basePath: `/p/${provider.id}`,
      models: provider.config.models,
      capabilities: provider.config.capabilities,
    })),
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
