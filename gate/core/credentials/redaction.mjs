const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'password',
  'secret',
  'credential',
  'authorization',
  'client_secret',
]);

export function redactSensitive(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactSensitive(item);
    }
  }
  return out;
}
