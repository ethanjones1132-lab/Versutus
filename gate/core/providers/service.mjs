import { validateProviderRegistration } from './schema.mjs';
import { applyCatalogResult, isCatalogFresh, nextBackoff } from './catalog.mjs';
import { readinessFromAuthAndError } from './health.mjs';
import { classifyProviderError, ProviderErrorCodes } from './errors.mjs';
import { nextAuthState, toSnapshot } from './runtime.mjs';
import { assertProviderDeletionAllowed } from './dependencies.mjs';

export class ProviderService {
  constructor({ store, vault, adapters = {}, createAdapter, agents = [] } = {}) {
    this.store = store;
    this.vault = vault;
    this.adapters = adapters;
    this.createAdapter = createAdapter;
    this.agents = agents;
  }

  adapterFor(id, config) {
    if (this.adapters[id]) return this.adapters[id];
    if (this.createAdapter) {
      const adapter = this.createAdapter(config);
      this.adapters[id] = adapter;
      return adapter;
    }
    throw new Error(`no adapter registered for provider "${id}"`);
  }

  async list() {
    const records = await this.store.list();
    return records.map((record) => toSnapshot(record.config, record.state));
  }

  async get(id) {
    const record = await this.require(id);
    return toSnapshot(record.config, record.state);
  }

  async create(input) {
    const validation = validateProviderRegistration(input);
    if (!validation.ok) {
      throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
    }
    await this.store.put(input, {
      catalog: { source: 'legacy_bootstrap', state: 'unavailable', generation: 0, models: [] },
    });
    return this.get(input.id);
  }

  async update(id, input) {
    const existing = await this.require(id);
    const next = { ...existing.config, ...input, id, schemaVersion: 2, kind: 'provider' };
    const validation = validateProviderRegistration(next);
    if (!validation.ok) {
      throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
    }
    await this.store.put(next, existing.state);
    return this.get(id);
  }

  async delete(id, { resolve } = {}) {
    await this.require(id);
    assertProviderDeletionAllowed(id, this.agents, { resolve });
    await this.store.delete(id);
    return { deleted: true };
  }

  async check(id) {
    const record = await this.require(id);
    const { auth, readiness, error } = await this.inspect(record);
    const nextState = {
      ...record.state,
      auth,
      readiness,
      lastError: error ? { code: readiness.code, message: error.message } : undefined,
    };
    await this.store.put(record.config, nextState);
    return toSnapshot(record.config, nextState, { auth, readiness });
  }

  async refreshCatalog(id, { force = false } = {}) {
    const record = await this.require(id);
    const ttl = record.config.catalogPolicy?.ttlSeconds ?? 300;
    if (!force && isCatalogFresh(record.state.catalog, ttl)) {
      return toSnapshot(record.config, record.state);
    }
    if (!force && record.state.backoff?.nextRetryAt && Date.now() < record.state.backoff.nextRetryAt) {
      return toSnapshot(record.config, record.state);
    }
    const { auth, readiness, error } = await this.inspect(record);
    let catalogError = error;
    let models;
    if (record.config.enabled && auth.state !== 'missing' && !error) {
      try {
        models = await this.adapterFor(id, record.config).listModels();
      } catch (caught) {
        catalogError = caught;
      }
    }

    const catalog = applyCatalogResult({
      previous: record.state.catalog,
      models,
      error: catalogError,
      allowLastKnownGood: record.config.catalogPolicy?.allowLastKnownGood !== false,
    });
    const nextReadiness = catalogError
      ? readinessFromAuthAndError({
        enabled: record.config.enabled,
        authState: auth.state,
        error: catalogError,
      })
      : readiness;

    const nextState = { ...record.state, auth, readiness: nextReadiness, catalog };
    if (catalogError) {
      nextState.backoff = nextBackoff(record.state.backoff);
    } else {
      delete nextState.backoff;
    }
    await this.store.put(record.config, nextState);
    return toSnapshot(record.config, nextState, { auth, readiness: nextReadiness, catalog });
  }

  async resolveModel(providerId, modelId) {
    const snapshot = await this.get(providerId);
    const model = snapshot.catalog.models.find((entry) => entry.id === modelId);
    if (!model) {
      const error = new Error(`model "${modelId}" not found on provider "${providerId}"`);
      error.code = 'model_not_found';
      throw error;
    }
    return { providerId, model };
  }

  async chat(request, signal) {
    const record = await this.require(request.providerId);
    const adapter = this.adapterFor(request.providerId, record.config);
    return adapter.chat(request, signal);
  }

  async inspect(record) {
    if (!record.config.enabled) {
      const auth = nextAuthState({
        mode: record.config.registration.mode,
        present: true,
        previous: record.state.auth?.state,
      });
      return {
        auth,
        readiness: readinessFromAuthAndError({ enabled: false, authState: auth.state }),
      };
    }

    const present = await this.credentialPresent(record.config);
    const auth = nextAuthState({
      mode: record.config.registration.mode,
      present,
      previous: record.state.auth?.state,
    });
    if (!present) {
      return {
        auth,
        readiness: readinessFromAuthAndError({ enabled: true, authState: 'missing' }),
        error: { code: ProviderErrorCodes.missing_credentials, message: 'credential missing' },
      };
    }

    try {
      const adapter = this.adapterFor(record.config.id, record.config);
      if (adapter.authenticate) await adapter.authenticate();
      if (adapter.health) await adapter.health();
      return {
        auth: { ...auth, state: 'ready' },
        readiness: readinessFromAuthAndError({ enabled: true, authState: 'ready' }),
      };
    } catch (error) {
      const code = classifyProviderError(error);
      const nextAuth = nextAuthState({
        mode: record.config.registration.mode,
        present: true,
        errorCode: code,
        previous: auth.state,
      });
      return {
        auth: nextAuth,
        readiness: readinessFromAuthAndError({ enabled: true, authState: nextAuth.state, error }),
        error,
      };
    }
  }

  async credentialPresent(config) {
    if (config.registration.mode === 'local_interface') return true;
    const ref = config.registration.credentialRef || config.registration.oauthProfileId;
    if (!ref || !this.vault) return false;
    if (typeof this.vault.has === 'function') return this.vault.has(ref);
    return Boolean(await this.vault.get(ref));
  }

  async require(id) {
    const record = await this.store.get(id);
    if (!record) {
      const error = new Error(`provider "${id}" not found`);
      error.code = 'provider_not_found';
      throw error;
    }
    return record;
  }
}

export function assertCliProviderBinding(snapshot, { consumeGateProxy } = {}) {
  if (consumeGateProxy) return snapshot;
  const local = snapshot.mode === 'local_interface';
  const external = snapshot.auth?.credentialCustodian === 'external';
  if (!local || !external) {
    const error = new Error('provider_cli_binding_unsupported');
    error.code = 'provider_cli_binding_unsupported';
    throw error;
  }
  return snapshot;
}
