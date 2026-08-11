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

  // Check baseUrl is https, except for the local loopback interface (the
  // Gate's own manifest documents 127.0.0.1 as the trust boundary for local
  // testing — see docs/superpowers/specs/2026-08-10-versutus-gate-design.md §9).
  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    return {
      ok: false,
      error: `provider "${id}": baseUrl must be a non-empty string`,
    };
  }

  let hostname;
  try {
    hostname = new URL(config.baseUrl).hostname;
  } catch {
    return {
      ok: false,
      error: `provider "${id}": baseUrl must be a valid URL`,
    };
  }

  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!config.baseUrl.startsWith('https://') && !isLoopback) {
    return {
      ok: false,
      error: `provider "${id}": baseUrl must use https, not http`,
    };
  }

  return { ok: true };
}
