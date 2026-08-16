export const ProviderErrorCodes = {
  missing_credentials: 'missing_credentials',
  invalid_credentials: 'invalid_credentials',
  entitlement_denied: 'entitlement_denied',
  rate_limited: 'rate_limited',
  overloaded: 'overloaded',
  transient_network: 'transient_network',
  catalog_timeout: 'catalog_timeout',
  disabled: 'disabled',
};

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyProviderError(error = {}) {
  if (error.code === ProviderErrorCodes.catalog_timeout || error.code === 'catalog_timeout') {
    return ProviderErrorCodes.catalog_timeout;
  }
  if (error.status === 401 || error.statusCode === 401) return ProviderErrorCodes.invalid_credentials;
  if (error.status === 403 || error.statusCode === 403) return ProviderErrorCodes.entitlement_denied;
  if (error.status === 429 || error.statusCode === 429) return ProviderErrorCodes.rate_limited;
  if (error.status === 529 || error.statusCode === 529 || (error.status >= 500 && error.status <= 599)) {
    return ProviderErrorCodes.overloaded;
  }
  if (NETWORK_CODES.has(error.code)) return ProviderErrorCodes.transient_network;
  if (error.code && ProviderErrorCodes[error.code]) return error.code;
  return ProviderErrorCodes.transient_network;
}

export function authStateForCode(code, current = 'ready') {
  if (code === ProviderErrorCodes.missing_credentials) return 'missing';
  if (code === ProviderErrorCodes.invalid_credentials) return 'needs_reauth';
  if (code === ProviderErrorCodes.entitlement_denied) return 'denied';
  return current;
}
