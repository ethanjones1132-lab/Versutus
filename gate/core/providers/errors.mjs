export const ProviderErrorCodes = {
  missing_credentials: 'missing_credentials',
  invalid_credentials: 'invalid_credentials',
  entitlement_denied: 'entitlement_denied',
  rate_limited: 'rate_limited',
  overloaded: 'overloaded',
  transient_network: 'transient_network',
  catalog_timeout: 'catalog_timeout',
  disabled: 'disabled',
  // The file is there and the Gate cannot decrypt it: a DPAPI blob written by
  // another Windows account, or a write that was killed half way. It is not a
  // network fault, and calling it one left the card reading "Degraded/stale"
  // with `auth: ready` and nothing telling the operator to set the key again.
  credential_unreadable: 'credential_unreadable',
};

const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyProviderError(error = {}) {
  if (error.code === ProviderErrorCodes.catalog_timeout || error.code === 'catalog_timeout') {
    return ProviderErrorCodes.catalog_timeout;
  }
  // Ahead of the status branches: this is a local decrypt failure, so a status
  // field on the same error describes nothing and must not reclassify it.
  if (error.code === ProviderErrorCodes.credential_unreadable) {
    return ProviderErrorCodes.credential_unreadable;
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
  // The remedy for a key this machine cannot read is to set it again, not to
  // sign in again — an api_key provider has no sign-in step at all.
  if (code === ProviderErrorCodes.credential_unreadable) return 'missing';
  if (code === ProviderErrorCodes.invalid_credentials) return 'needs_reauth';
  if (code === ProviderErrorCodes.entitlement_denied) return 'denied';
  return current;
}
