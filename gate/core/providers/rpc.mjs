import { redactSensitive } from '../credentials/redaction.mjs';

export function createProviderRpc({ service, vault, oauth }) {
  async function status(fn) {
    try {
      await fn();
      return { ok: true };
    } catch (error) {
      const safe = redactSensitive({ message: error.message, code: error.code });
      const wrapped = new Error(safe.message || 'provider operation failed');
      wrapped.code = safe.code || 'provider_error';
      throw wrapped;
    }
  }

  return {
    'providers.create': async (input = {}) => status(() => service.create(input)),
    'providers.update': async ({ id, ...input } = {}) => status(() => service.update(id, input)),
    'providers.delete': async ({ id } = {}) => status(() => service.delete(id)),
    'providers.health.check': async ({ id } = {}) => service.check(id).then(sanitizeSnapshot),
    'providers.catalog.refresh': async ({ id } = {}) => service.refreshCatalog(id).then(sanitizeSnapshot),
    'providers.auth.setApiKey': async ({ id, value } = {}) => status(async () => {
      const snapshot = await service.get(id);
      if (snapshot.mode !== 'api_key') {
        throw new Error('provider is not in api_key mode');
      }
      const record = await service.store.get(id);
      const ref = record.config.registration.credentialRef;
      await vault.set(ref, value);
    }),
    'providers.auth.begin': async ({ id } = {}) => {
      if (!oauth) throw new Error('oauth is not configured');
      const attempt = await oauth.begin(id);
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
      if (oauth) await oauth.disconnect(id);
      const record = await service.store.get(id);
      if (record?.config.registration.credentialRef) {
        await vault.delete(record.config.registration.credentialRef);
      }
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
    readiness: snapshot.readiness,
    catalog: {
      state: snapshot.catalog?.state,
      source: snapshot.catalog?.source,
      observedAt: snapshot.catalog?.observedAt,
      generation: snapshot.catalog?.generation,
      models: snapshot.catalog?.models ?? [],
    },
  };
}
