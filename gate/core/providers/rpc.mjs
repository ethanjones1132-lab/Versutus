import { redactSensitive, redactSensitiveText } from '../credentials/redaction.mjs';
import { releaseProfiles } from './profiles/registry.mjs';

/**
 * @param {Object} deps
 * @param {() => Promise<unknown>} [deps.onChanged] - refresh derived state (the
 *   manifest advertises providers, so registering one must update it; otherwise
 *   a newly created provider stays invisible until the Gate restarts).
 */
export function createProviderRpc({ service, vault, oauth, onChanged }) {
  async function status(fn) {
    try {
      await fn();
      return { ok: true };
    } catch (error) {
      // A vendor is free to quote what it was sent in its own error text, and
      // that text is what the RPC route puts in the response body.
      const safe = redactSensitive({ message: error.message, code: error.code });
      const wrapped = new Error(redactSensitiveText(safe.message) || 'provider operation failed');
      wrapped.code = safe.code || 'provider_error';
      throw wrapped;
    }
  }

  // create/update/delete change which providers exist, and the manifest
  // advertises providers — without this a registration stays invisible until
  // the Gate restarts.
  async function statusAndReload(fn) {
    const result = await status(fn);
    await onChanged?.().catch(() => undefined);
    return result;
  }

  // A check and a catalog refresh move exactly what the manifest advertises --
  // auth, readiness and models -- so they reload it too. Without this the
  // manifest kept telling a freshly connected phone that a provider which just
  // failed its check was ready, and still offered its models.
  async function snapshotAndReload(run) {
    const snapshot = sanitizeSnapshot(await run());
    await onChanged?.().catch(() => undefined);
    return snapshot;
  }

  return {
    /**
     * The provider types this Gate can actually reach, with enough detail for a
     * client to prefill a registration form. Without this a client has to
     * hardcode the vendor list or the operator has to hand-write the JSON.
     */
    'providers.profiles.list': async () => ({
      profiles: [...releaseProfiles.values()].map((profile) => ({
        id: profile.id,
        label: profile.label,
        providerType: profile.providerType,
        mode: profile.mode,
        protocol: profile.protocol,
        defaultBaseUrl: profile.defaultBaseUrl,
        origins: profile.origins,
      })),
    }),
    'providers.list': async () => {
      const snapshots = await service.list();
      return { providers: snapshots.map(sanitizeSnapshot) };
    },
    'providers.get': async ({ id } = {}) => sanitizeSnapshot(await service.get(id)),
    'providers.create': async (input = {}) => statusAndReload(() => service.create(input)),
    'providers.update': async ({ id, ...input } = {}) => statusAndReload(() => service.update(id, input)),
    'providers.delete': async ({ id } = {}) => statusAndReload(() => service.delete(id)),
    'providers.health.check': async ({ id } = {}) => snapshotAndReload(() => service.check(id)),
    // The only client of this method is the explicit "Refresh catalog" control,
    // so it forces: a tap that lands inside the TTL or inside a failure backoff
    // is exactly the tap that means "I do not believe you, ask again".
    'providers.catalog.refresh': async ({ id } = {}) => snapshotAndReload(() => service.refreshCatalog(id, { force: true })),
    // The key is what the card's verdict is about, so writing one has to move
    // it — and the manifest advertises providers, so it is reloaded with it.
    // Without both, a client other than the shipped app (which self-heals with
    // an immediate `check`) reads "Not configured" / "Set key" for a provider
    // that now has a working key, and keeps the old failure backoff on top.
    'providers.auth.setApiKey': async ({ id, value } = {}) => statusAndReload(async () => {
      const snapshot = await service.get(id);
      if (snapshot.mode !== 'api_key') {
        throw new Error('provider is not in api_key mode');
      }
      const record = await service.store.get(id);
      const ref = record.config.registration.credentialRef;
      await vault.set(ref, value);
      // The adapter closed over the previous credential — rebuild it.
      service.forgetAdapter(id);
      await service.noteCredentialSet(id);
    }),
    'providers.auth.begin': async ({ id } = {}) => {
      if (!oauth) throw new Error('oauth is not configured');
      const record = await service.store.get(id);
      if (!record) throw new Error(`unknown provider "${id}"`);
      // The shipped profile lives under `registration.oauthProfileId`. Passing
      // the instance id looked up a map that production keys by profile id, so
      // a valid oauth registration could not start a sign-in.
      const attempt = await oauth.begin(id, {
        oauthProfileId: record.config.registration?.oauthProfileId,
      });
      return {
        attemptId: attempt.id,
        redirectUri: attempt.redirectUri,
        authorizationUrl: attempt.authorizationUrl,
      };
    },
    'providers.auth.attempt.get': async ({ attemptId } = {}) => {
      if (!oauth) throw new Error('oauth is not configured');
      const attempt = oauth.getAttempt(attemptId);
      if (!attempt) throw new Error('unknown attempt');
      return { id: attempt.id, providerId: attempt.providerId, expiresAt: attempt.expiresAt };
    },
    'providers.auth.disconnect': async ({ id } = {}) => status(async () => {
      const record = await service.store.get(id);
      if (oauth) {
        await oauth.disconnect(id, {
          oauthProfileId: record?.config.registration?.oauthProfileId,
        });
      }
      if (record?.config.registration.credentialRef) {
        await vault.delete(record.config.registration.credentialRef);
      }
      service.forgetAdapter(id);
    }),
  };
}

export function sanitizeSnapshot(snapshot) {
  return {
    id: snapshot.id,
    label: snapshot.label,
    providerType: snapshot.providerType,
    mode: snapshot.mode,
    auth: {
      state: snapshot.auth?.state,
      expiresAt: snapshot.auth?.expiresAt,
      scopes: snapshot.auth?.scopes,
      credentialCustodian: snapshot.auth?.credentialCustodian,
    },
    readiness: {
      ...snapshot.readiness,
      // A vendor quotes the key it was given in its own words often enough that
      // the reason on the card has to be scrubbed before it leaves the Gate.
      ...(snapshot.readiness?.message ? { message: redactSensitiveText(snapshot.readiness.message) } : {}),
    },
    catalog: {
      state: snapshot.catalog?.state,
      source: snapshot.catalog?.source,
      observedAt: snapshot.catalog?.observedAt,
      generation: snapshot.catalog?.generation,
      models: snapshot.catalog?.models ?? [],
    },
    // Only while a failure backoff is running, so the client can say "retrying
    // at ..." instead of handing back an unchanged card that looks ignored.
    ...(snapshot.backoff?.nextRetryAt ? { backoff: { nextRetryAt: snapshot.backoff.nextRetryAt } } : {}),
  };
}
