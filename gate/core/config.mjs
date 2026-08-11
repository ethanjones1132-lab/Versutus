export const FLAVORS = ['openai', 'anthropic', 'custom'];

/**
 * Validates a provider configuration object.
 * Returns { ok: true } on success or { ok: false, error: "provider "id": message" } on failure.
 * Error messages name the offending field to help self-correction.
 */
export function validateProviderConfig(id, config) {
  // Check that config is an object
  if (!config || typeof config !== 'object') {
    return { ok: false, error: `provider "${id}": config must be an object` };
  }

  // Check flavor is in FLAVORS
  if (!FLAVORS.includes(config.flavor)) {
    return {
      ok: false,
      error: `provider "${id}": flavor must be one of [${FLAVORS.join(', ')}], got ${config.flavor}`,
    };
  }

  // Check apiKeyEnv is present and apiKey is not present (no literal secrets in manifest)
  if (!config.apiKeyEnv || typeof config.apiKeyEnv !== 'string') {
    return {
      ok: false,
      error: `provider "${id}": apiKeyEnv must be a non-empty string naming the environment variable`,
    };
  }

  if (config.apiKey !== undefined) {
    return {
      ok: false,
      error: `provider "${id}": literal apiKey is not allowed; use apiKeyEnv instead`,
    };
  }

  // Check models is a non-empty array
  if (!Array.isArray(config.models) || config.models.length === 0) {
    return {
      ok: false,
      error: `provider "${id}": models must be a non-empty array`,
    };
  }

  // Check baseUrl is a valid URL (https for production, http allowed for localhost testing)
  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    return {
      ok: false,
      error: `provider "${id}": baseUrl must be a non-empty string`,
    };
  }

  const isLocalhost = config.baseUrl.includes('127.0.0.1') || config.baseUrl.includes('localhost');
  if (!config.baseUrl.startsWith('https://') && !isLocalhost) {
    return {
      ok: false,
      error: `provider "${id}": baseUrl must use https, not http`,
    };
  }

  return { ok: true };
}
