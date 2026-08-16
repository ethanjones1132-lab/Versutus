import { classifyProviderError, ProviderErrorCodes } from './errors.mjs';

export function readinessFromAuthAndError({ enabled, authState, error, gateHealthy: _gateHealthy }) {
  const checkedAt = new Date().toISOString();
  if (!enabled) {
    return { state: 'disabled', code: ProviderErrorCodes.disabled, checkedAt };
  }
  if (authState === 'missing') {
    return { state: 'unavailable', code: ProviderErrorCodes.missing_credentials, checkedAt };
  }
  if (error) {
    const code = classifyProviderError(error);
    const degraded = code === ProviderErrorCodes.rate_limited
      || code === ProviderErrorCodes.overloaded
      || code === ProviderErrorCodes.transient_network
      || code === ProviderErrorCodes.catalog_timeout;
    return {
      state: degraded ? 'degraded' : 'unavailable',
      code,
      message: error.message,
      checkedAt,
    };
  }
  return { state: 'ready', checkedAt };
}
