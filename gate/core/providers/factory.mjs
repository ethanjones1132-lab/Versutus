import { createProfileAdapter, getProfile } from './profiles/registry.mjs';
import { createLocalProviderAdapter } from './local/adapter.mjs';
import { isLoopbackHostname } from './local/ssrf-policy.mjs';

export function profileIdFor(providerType) {
  if (providerType === 'nvidia-nim') return 'nvidia-nim';
  if (providerType === 'anthropic') return 'anthropic';
  if (providerType === 'xai') return 'xai';
  if (providerType === 'openai-compatible') return 'openai-compatible';
  return 'openai';
}

// The shipped default for a registration that carries no `requestPolicy`.
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function createProviderAdapter(config, { vault, store, oauth } = {}) {
  return {
    authenticate: async () => (await materialize()).authenticate(),
    health: async () => (await materialize()).health(),
    listModels: async () => (await materialize()).listModels(),
    chat: async (request, signal) => (await materialize()).chat(request, signal),
    disconnect: async () => {
      const inner = await materialize().catch(() => null);
      return inner?.disconnect?.();
    },
  };

  async function materialize() {
    const registration = config.registration;
    if (registration.mode === 'local_interface') {
      let credential;
      if (registration.adapterCredentialRef && vault) {
        credential = await vault.get(registration.adapterCredentialRef);
      }
      return createLocalProviderAdapter({
        manifestUrl: registration.manifestUrl,
        providerId: config.id,
        credential,
        // The registration's own budget, for the same reason the remote path
        // reads it: a local server that accepts the connection and says nothing
        // used to hold this request — and every later "Check" on the provider —
        // for the life of the process.
        timeoutMs: config.requestPolicy?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });
    }

    const credential = await resolveCredential(config, vault, store, oauth);
    const profileId = profileIdFor(config.providerType);
    const profile = getProfile(profileId);
    const origin = new URL(registration.baseUrl || registration.resourceBaseUrl).origin;
    return createProfileAdapter({
      profileId,
      providerId: config.id,
      baseUrl: registration.baseUrl || registration.resourceBaseUrl,
      credential,
      // A profile that pins official origins is the boundary: its `origins` are
      // a safety net against a mistyped or hijacked base URL, and putting the
      // registration's own origin in the allowlist it is checked against made
      // that check vacuous for every provider. A profile that pins none
      // (`openai-compatible`) exists precisely to reach an endpoint the operator
      // chose, so there its own origin is the whole boundary.
      allowedOrigins: profile.origins.length > 0 ? profile.origins : [origin],
      // The registration's own budget, which nothing used to read: a vendor
      // that accepts the connection and never answers held a Gate socket for
      // minutes while the phone had already given up at 30s.
      timeoutMs: config.requestPolicy?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }
}

async function resolveCredential(config, vault, store, oauth) {
  const registration = config.registration;
  // An `oauth` registration is forbidden a `credentialRef` by the schema, so the
  // token a sign-in stored under `oauth/<id>` is the only credential it can
  // have — and asking the vault for a ref it does not have meant the adapter was
  // built with `Bearer undefined` on every turn. `getAccess` is the only reader
  // that refreshes an expired grant, and it had no caller outside its own class.
  if (registration.mode === 'oauth' && oauth) {
    // The profile map is keyed by `oauthProfileId` (its own schema field);
    // the instance id is only the vault key. Looking the profile up by the
    // instance id made a valid registration unable to refresh an expired grant.
    const tokens = await oauth.getAccess(config.id, {
      oauthProfileId: registration.oauthProfileId,
    });
    // `getAccess` returns `{accessToken, refreshToken, expiresAt, tokenType}`.
    // Profiles interpolate `Bearer ${credential}`, so handing the record
    // through sent `Bearer [object Object]` on every turn.
    if (tokens && typeof tokens === 'object' && typeof tokens.accessToken === 'string') {
      return tokens.accessToken;
    }
    return tokens;
  }
  const ref = registration.credentialRef;
  if (ref && vault) {
    const value = await vault.get(ref);
    if (value) return value;
    // Present but unreadable is not "no credential": the adapter would send
    // `Bearer undefined`, and the vendor's 401 was recorded as `needs_reauth` —
    // "Sign in again" for an api_key provider whose only remedy is a key. A
    // Windows sharing violation on the `.dpapi` file gets here routinely.
    if (typeof vault.inspect === 'function') {
      const probe = await vault.inspect(ref);
      if (probe?.present && probe.readable === false) {
        throw Object.assign(
          new Error(probe.error?.message ?? 'the stored credential could not be read'),
          { code: 'credential_unreadable' },
        );
      }
    }
  }
  const record = store ? await store.get(config.id) : null;
  const envName = record?.state?.legacyApiKeyEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return undefined;
}

export { isLoopbackHostname };
