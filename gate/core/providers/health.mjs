import { classifyProviderError, ProviderErrorCodes } from './errors.mjs';

export function readinessFromAuthAndError({ enabled, authState, error, gateHealthy: _gateHealthy }) {
  const checkedAt = new Date().toISOString();
  if (!enabled) {
    return { state: 'disabled', code: ProviderErrorCodes.disabled, checkedAt };
  }
  const code = error ? classifyProviderError(error) : undefined;
  if (code === ProviderErrorCodes.credential_unreadable) {
    // Ahead of the plain "missing" branch below: `auth` is already `missing`
    // here, and the operator needs to know this is a stored key they must set
    // again on this machine, not one they never configured.
    return {
      state: 'unavailable',
      code,
      message: 'the stored credential cannot be decrypted on this machine (it is protected per Windows account) — set the key again',
      checkedAt,
    };
  }
  if (authState === 'missing') {
    return { state: 'unavailable', code: ProviderErrorCodes.missing_credentials, checkedAt };
  }
  if (error) {
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

/**
 * Whether a provider's models may be offered to a picker or pinned as a default.
 *
 * A disabled provider answers nothing, and one with no credential cannot
 * authenticate a single turn: offering its models only sends the composer to a
 * refusal it could have been told about. Both facts are already on the snapshot
 * (`readiness.state`, `auth.state`), so this reads the verdict rather than
 * asking the vendor again. A provider that genuinely needs no key -- a local
 * interface -- reports its credential present and is unaffected.
 */
export function providerOffersModels(snapshot) {
  if (!snapshot) return false;
  if (snapshot.readiness?.state === 'disabled') return false;
  if (snapshot.auth?.state === 'missing') return false;
  // A credential this machine holds but cannot decrypt reports `auth: missing`
  // above; the code check keeps a snapshot that carries only the readiness
  // verdict from being offered anyway.
  if (snapshot.readiness?.code === ProviderErrorCodes.credential_unreadable) return false;
  return true;
}
