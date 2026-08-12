const FLAVORS = ['openai', 'anthropic', 'custom'];

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function validate(config) {
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: [{ field: 'config', message: 'must be an object' }] };
  }

  const errors = [];

  if (!FLAVORS.includes(config.flavor)) {
    errors.push({ field: 'flavor', message: `must be one of [${FLAVORS.join(', ')}], got ${config.flavor}` });
  }

  if (!config.apiKeyEnv || typeof config.apiKeyEnv !== 'string') {
    errors.push({ field: 'apiKeyEnv', message: 'must be a non-empty string naming the environment variable' });
  }

  if (config.apiKey !== undefined) {
    errors.push({ field: 'apiKey', message: 'literal apiKey is not allowed; use apiKeyEnv instead' });
  }

  if (!Array.isArray(config.models) || config.models.length === 0) {
    errors.push({ field: 'models', message: 'must be a non-empty array' });
  }

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push({ field: 'baseUrl', message: 'must be a non-empty string' });
  } else {
    let hostname;
    try {
      hostname = new URL(config.baseUrl).hostname;
    } catch {
      errors.push({ field: 'baseUrl', message: 'must be a valid URL' });
      hostname = undefined;
    }
    if (hostname !== undefined && !config.baseUrl.startsWith('https://') && !isLoopback(hostname)) {
      errors.push({ field: 'baseUrl', message: 'must use https, not http' });
    }
  }

  return { ok: errors.length === 0, errors };
}

function toManifestEntry(instance) {
  return {
    id: instance.id,
    label: instance.label,
    basePath: `/p/${instance.id}`,
    models: instance.config.models,
    capabilities: { chat: true, streaming: instance.config.streaming !== false },
  };
}

function createHandlers() {
  return {};
}

export default {
  kind: 'provider',
  label: 'Model provider',
  family: 'provider',
  configFields: [
    { key: 'flavor', label: 'Flavor', type: 'enum', required: true, options: FLAVORS },
    { key: 'baseUrl', label: 'Base URL', type: 'string', required: true },
    { key: 'apiKeyEnv', label: 'API key environment variable', type: 'secret-ref', required: true },
    { key: 'models', label: 'Models', type: 'string-list', required: true },
    { key: 'streaming', label: 'Supports streaming', type: 'boolean', default: true },
  ],
  validate,
  toManifestEntry,
  createHandlers,
};
