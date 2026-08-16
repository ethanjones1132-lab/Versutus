const FORBIDDEN = new Set([
  'tokens',
  'credentials',
  'catalog',
  'models',
  'apiKey',
  'apiKeyEnv',
  'access_token',
  'refresh_token',
  'credentialRef',
  'oauthProfileId',
]);

function validate(config) {
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: [{ field: 'config', message: 'must be an object' }] };
  }

  const errors = [];
  if (!config.endpoint || typeof config.endpoint !== 'string') {
    errors.push({ field: 'endpoint', message: 'must be a non-empty string' });
  }
  if (config.dependencies !== undefined) {
    if (!Array.isArray(config.dependencies)) {
      errors.push({ field: 'dependencies', message: 'must be an array' });
    } else {
      config.dependencies.forEach((dependency, index) => {
        if (!dependency?.providerId) {
          errors.push({ field: `dependencies[${index}].providerId`, message: 'must be a non-empty string' });
        }
        if (!dependency?.role) {
          errors.push({ field: `dependencies[${index}].role`, message: 'must be a non-empty string' });
        }
      });
    }
  }

  for (const key of Object.keys(config)) {
    if (FORBIDDEN.has(key)) {
      errors.push({ field: key, message: 'provider credentials and catalogs cannot live on an agent' });
    }
  }

  return { ok: errors.length === 0, errors };
}

function toManifestEntry(instance) {
  return {
    id: instance.id,
    label: instance.label,
    endpoint: instance.config.endpoint,
    dependencies: instance.config.dependencies ?? [],
  };
}

export default {
  kind: 'agent',
  label: 'Agent',
  family: 'agents',
  configFields: [
    { key: 'endpoint', label: 'Endpoint', type: 'string', required: true },
    { key: 'dependencies', label: 'Provider dependencies', type: 'json', required: false },
  ],
  validate,
  toManifestEntry,
  createHandlers: () => ({}),
};
