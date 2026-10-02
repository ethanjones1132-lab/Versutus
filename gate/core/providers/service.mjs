import { validateProviderRegistration } from './schema.mjs';
import { applyCatalogResult, isCatalogFresh, nextBackoff } from './catalog.mjs';
import { readinessFromAuthAndError } from './health.mjs';
import { authStateForCode, classifyProviderError, ProviderErrorCodes } from './errors.mjs';
import { nextAuthState, toSnapshot } from './runtime.mjs';
import { assertProviderDeletionAllowed } from './dependencies.mjs';

export class ProviderService {
  constructor({ store, vault, adapters = {}, createAdapter, agents = [] } = {}) {
    this.store = store;
    this.vault = vault;
    this.adapters = adapters;
    this.createAdapter = createAdapter;
    this.agents = agents;
    this.commitQueues = new Map();
    this.checkFlights = new Map();
    this.refreshFlights = new Map();
    this.outcomeSeq = 0;
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

  /**
   * Drop the cached adapter for `id`. An adapter closes over the base URL and
   * credential it was built with, so anything that changes either — an edit, a
   * key rotation, a delete-and-recreate — must force a rebuild. Without this an
   * edit saves to disk and then has no effect until the Gate restarts.
   */
  forgetAdapter(id) {
    delete this.adapters[id];
  }

  /**
   * Serialise every read-modify-write of one provider record.
   *
   * `check`, `refreshCatalog`, `noteChatOutcome`, `update` and `delete` each
   * read a record, decide, and write a whole new one. They used to sit under
   * two unrelated queues — and `check` under none at all — so a commit built
   * from a stale read landed on top of a newer fact: a failing turn's
   * `needs_reauth` erased by a slower successful check, or a catalog refresh
   * wiping the outcome that landed beside it. One queue per provider, and only
   * the read-decide-write step runs inside it; the slow parts (credential
   * probe, vendor `inspect`, `listModels`) stay outside so a hung vendor never
   * holds the queue.
   */
  commit(id, run) {
    const previous = this.commitQueues.get(id) ?? Promise.resolve();
    // A rejected entry must not poison the ones behind it.
    const entry = previous.catch(() => undefined).then(run);
    this.commitQueues.set(id, entry);
    return entry.finally(() => {
      if (this.commitQueues.get(id) === entry) this.commitQueues.delete(id);
    });
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
    return this.commit(id, async () => {
      const existing = await this.require(id);
      const next = { ...existing.config, ...input, id, schemaVersion: 2, kind: 'provider' };
      const validation = validateProviderRegistration(next);
      if (!validation.ok) {
        throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('; '));
      }
      await this.store.put(next, stateAfterUpdate(existing, next));
      this.forgetAdapter(id);
      return this.get(id);
    });
  }

  /**
   * What writing a credential does to the facts the Gate already holds.
   *
   * `providers.auth.setApiKey` wrote the vault entry, rebuilt the adapter and
   * returned, so the verdict kept everything the failures *before* it had
   * concluded: `auth.state: 'missing'` left the card reading "Not configured" /
   * "Set key" for a provider that now has a key, and the backoff those same
   * failures earned kept it saying "retrying at ..." for up to fifteen minutes
   * more. Presence is what this can answer without a vendor; whether the vendor
   * accepts the key is a probe's answer, so readiness reads as unchecked — the
   * same thing `stateAfterUpdate` does when a provider comes back on.
   */
  async noteCredentialSet(id) {
    return this.commit(id, async () => {
      const record = await this.store.get(id);
      if (!record) return null;
      const state = {
        ...record.state,
        auth: nextAuthState({
          mode: record.config.registration?.mode,
          present: true,
          // A freshly written key is not the previous credential. Passing
          // `needs_reauth` through as `previous` made `authStateForCode` keep
          // "Sign in again" for an api_key provider that has no sign-in.
        }),
        readiness: { state: 'unavailable', checkedAt: new Date().toISOString() },
      };
      delete state.backoff;
      delete state.lastError;
      await this.store.put(record.config, state);
      return toSnapshot(record.config, state);
    });
  }

  async delete(id, { resolve } = {}) {
    return this.commit(id, async () => {
      const record = await this.require(id);
      assertProviderDeletionAllowed(id, this.agents, { resolve });
      await this.store.delete(id);
      this.forgetAdapter(id);
      // The credential is the provider's, not the vault's: leaving it behind
      // strands a secret no surface can reach, name, or revoke.
      const ref = record.config.registration?.credentialRef;
      if (ref && this.vault) await this.vault.delete(ref).catch(() => undefined);
      return { deleted: true };
    });
  }

  async check(id) {
    // Two taps, or a tap beside a scheduled one, are one question to ask the
    // vendor: the second joins the probe already in flight.
    const inFlight = this.checkFlights.get(id);
    if (inFlight) return inFlight;
    const flight = this.runCheck(id);
    this.checkFlights.set(id, flight);
    try {
      return await flight;
    } finally {
      if (this.checkFlights.get(id) === flight) this.checkFlights.delete(id);
    }
  }

  async runCheck(id) {
    const probe = this.startProbe();
    const record = await this.require(id);
    const { auth, readiness, error } = await this.inspect(record);
    return this.commit(id, async () => {
      const fresh = await this.store.get(id);
      // Deleted while the probe was open, or a failed turn landed after the
      // probe started: either way this verdict is no longer the newest fact.
      if (!fresh || supersededByFailedTurn(fresh.state, probe)) {
        return toSnapshot((fresh ?? record).config, (fresh ?? record).state);
      }
      const nextState = {
        ...fresh.state,
        auth,
        readiness,
        lastError: error ? { code: readiness.code, message: error.message } : undefined,
      };
      // The failures this backoff records are the ones this probe has just
      // answered for. Only a successful catalog refresh used to clear it, so a
      // passing check left `nextRetryAt` behind and the next refresh — a
      // non-forced one — refused to ask the vendor for up to fifteen minutes
      // after the problem was gone.
      if (!error) delete nextState.backoff;
      await this.store.put(fresh.config, nextState);
      return toSnapshot(fresh.config, nextState, { auth, readiness });
    });
  }

  /**
   * Fold a real chat outcome into readiness.
   *
   * `inspect` probes the catalog endpoint, which for several providers is free
   * and answers 200 with no credits on the account -- so a provider that cannot
   * complete a single turn was still advertised as `ready`. Listing models is
   * not the thing the provider is for; completing a chat is. A failed turn is
   * therefore the most authoritative readiness signal available, and it costs
   * nothing extra to record.
   *
   * Resolves to `{ changed }` so a caller can tell whether this outcome moved
   * the verdict or only stamped the turn; existing callers ignore it.
   */
  async noteChatOutcome(id, error) {
    // Every chat outcome shares the provider's commit queue with checks and
    // catalog refreshes, so each one re-reads after the previous commit and
    // commits land in call order (see `commit`).
    return this.commit(id, () => this.noteChatOutcomeNow(id, error));
  }

  async noteChatOutcomeNow(id, error) {
    const record = await this.store.get(id);
    if (!record) return { changed: false };

    const outcome = { at: new Date().toISOString(), ok: !error, seq: this.outcomeSeq += 1 };
    const nextState = { ...record.state, lastChatOutcome: outcome };
    if (!error) {
      // A turn that succeeded proves more than any probe could. An
      // already-ready record with no failure to clear has no new verdict to
      // write, so only the turn itself is recorded.
      if (!(record.state.readiness?.state === 'ready' && !record.state.lastError)) {
        nextState.auth = { ...(record.state.auth ?? {}), state: 'ready' };
        nextState.readiness = { state: 'ready', checkedAt: outcome.at };
        nextState.lastError = undefined;
      }
    } else {
      const code = classifyProviderError(error);
      nextState.auth = {
        ...(record.state.auth ?? {}),
        state: authStateForCode(code, record.state.auth?.state ?? 'ready'),
      };
      nextState.readiness = readinessFromAuthAndError({
        enabled: record.config.enabled !== false,
        authState: record.state.auth?.state ?? 'ready',
        error,
      });
      nextState.lastError = { code, message: error.message ?? String(error) };
    }
    const changed = verdictChanged(record.state, nextState);
    await this.store.put(record.config, nextState);
    return { changed };
  }

  async refreshCatalog(id, { force = false } = {}) {
    // `force` is part of the key, not something read after the join: a forced
    // "ask again" landing inside an ordinary refresh used to return that
    // refresh's answer, TTL short-circuit and all, so the tap did nothing.
    const flightKey = `${id}:${force}`;
    const inFlight = this.refreshFlights.get(flightKey);
    if (inFlight) return inFlight;
    const flight = this.runRefreshCatalog(id, { force });
    this.refreshFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.refreshFlights.get(flightKey) === flight) this.refreshFlights.delete(flightKey);
    }
  }

  async runRefreshCatalog(id, { force }) {
    const probe = this.startProbe();
    const record = await this.require(id);
    if (!record.config.enabled) {
      // A disabled provider is asked nothing, so there is no catalog error and
      // no models to fetch -- and `applyCatalogResult` reads "no error" as
      // success, which would replace a good model list with an empty `live`
      // one and delete the backoff. Leave the catalog and the backoff alone.
      return toSnapshot(record.config, record.state, {
        readiness: readinessFromAuthAndError({
          enabled: false,
          authState: record.state.auth?.state ?? 'ready',
        }),
      });
    }
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
    if (auth.state !== 'missing' && !error) {
      try {
        models = await this.adapterFor(id, record.config).listModels();
      } catch (caught) {
        catalogError = caught;
      }
    }

    return this.commit(id, async () => {
      const fresh = await this.store.get(id);
      if (!fresh) return toSnapshot(record.config, record.state);
      const stale = supersededByFailedTurn(fresh.state, probe);
      const catalog = applyCatalogResult({
        previous: fresh.state.catalog,
        models,
        error: catalogError,
        allowLastKnownGood: fresh.config.catalogPolicy?.allowLastKnownGood !== false,
      });
      const nextState = { ...fresh.state, catalog };
      if (!stale) {
        nextState.auth = auth;
        nextState.readiness = catalogError
          ? readinessFromAuthAndError({
            enabled: fresh.config.enabled,
            authState: auth.state,
            error: catalogError,
          })
          : readiness;
      }
      if (catalogError) {
        nextState.backoff = nextBackoff(fresh.state.backoff);
      } else {
        delete nextState.backoff;
      }
      await this.store.put(fresh.config, nextState);
      return toSnapshot(fresh.config, nextState, stale ? { catalog } : { auth, catalog });
    });
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
    if (!record.config.enabled) {
      const error = new Error(`provider "${request.providerId}" is disabled`);
      error.code = ProviderErrorCodes.disabled;
      throw error;
    }
    // A turn with nothing to authenticate is not a turn: the profile would send
    // `Authorization: Bearer undefined`, and the vendor's 401 was recorded as
    // `needs_reauth` -- "Sign in again" for a provider whose only remedy is a
    // key. No status field, so the classification is this code and not one
    // derived from a status this error never had.
    if (record.config.registration?.mode !== 'local_interface'
      && !(await this.credentialPresent(record.config, record))) {
      const error = new Error('provider has no credential to send');
      error.code = ProviderErrorCodes.missing_credentials;
      throw error;
    }
    return this.adapterFor(request.providerId, record.config).chat(request, signal);
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

    const present = await this.credentialPresent(record.config, record);
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

    const unreadable = await this.unreadableCredential(record.config);
    if (unreadable) {
      return {
        auth: nextAuthState({ mode: record.config.registration.mode, present: false }),
        readiness: readinessFromAuthAndError({ enabled: true, authState: 'missing', error: unreadable }),
        error: unreadable,
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

  /**
   * Presence says the file exists; readability says this machine can decrypt it.
   * A DPAPI blob written under another Windows account (or a write that was
   * killed half way) is present and useless, and only the decrypt knows -- so
   * this asks the vault, and skips the vendor entirely when the answer is no.
   */
  async unreadableCredential(config) {
    const ref = credentialRefFor(config);
    if (!ref || !this.vault || typeof this.vault.inspect !== 'function') return null;
    const probe = await this.vault.inspect(ref);
    if (!probe?.present || probe.readable !== false) return null;
    return {
      code: ProviderErrorCodes.credential_unreadable,
      message: probe.error?.message ?? 'the stored credential could not be decrypted',
    };
  }

  /**
   * Whether this Gate can actually authenticate a turn for `config`.
   *
   * It has to agree with the adapter's own resolver: `factory.resolveCredential`
   * falls back to the environment variable the v1 migration recorded, so a
   * provider whose key lives there is usable with no vault entry at all. Asking
   * the vault alone reported it as missing, which hid a working provider, said
   * "Set key" and skipped its catalog forever.
   */
  async credentialPresent(config, record) {
    if (config.registration.mode === 'local_interface') return true;
    const ref = credentialRefFor(config);
    if (ref && this.vault) {
      if (typeof this.vault.has === 'function') {
        if (await this.vault.has(ref)) return true;
      } else if (await this.vault.get(ref)) {
        return true;
      }
    }
    const envName = record?.state?.legacyApiKeyEnv;
    return Boolean(envName && process.env[envName]);
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

  /**
   * When this probe went out, so a commit can tell whether a chat outcome landed
   * after it started. `seq` breaks same-millisecond ties in favour of the turn:
   * `Date.now()` does not tick finely enough to order two facts recorded in the
   * same millisecond, and the clock must not decide which one survives.
   */
  startProbe() {
    return { startedAt: Date.now(), seq: this.outcomeSeq };
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

/**
 * Did a probe that went out at `probe.startedAt` get overtaken by a real turn?
 *
 * A failed turn is the most authoritative readiness signal there is (see
 * `noteChatOutcome`), so a check or a catalog refresh that began before it
 * landed must not put its own, older verdict back on top of it.
 */
function supersededByFailedTurn(state, probe) {
  const outcome = state?.lastChatOutcome;
  if (!outcome || outcome.ok !== false) return false;
  const at = Date.parse(outcome.at ?? '');
  if (!Number.isFinite(at)) return false;
  return at > probe.startedAt || (at === probe.startedAt && (outcome.seq ?? 0) > probe.seq);
}

/**
 * Whether a commit moved the verdict a caller can see. The chat outcome's own
 * timestamp moves on every turn and must not report readiness churn.
 */
function verdictChanged(before, after) {
  return before.auth?.state !== after.auth?.state
    || before.readiness?.state !== after.readiness?.state
    || before.readiness?.code !== after.readiness?.code
    || before.lastError?.code !== after.lastError?.code
    || before.lastError?.message !== after.lastError?.message;
}

/**
 * What an edit does to the facts the Gate already holds, decided locally.
 *
 * Enabling and disabling are exactly what a probe would have concluded, and the
 * card has to show that the moment the tap lands -- without waiting on a
 * vendor. A new endpoint or key has nothing to do with the backoff and the
 * freshness the old one earned, so both are dropped with it: otherwise fixing a
 * typo in the base URL leaves the provider refusing to refresh for another
 * fifteen minutes with no way to say why.
 */
function stateAfterUpdate(before, next) {
  const state = { ...before.state };
  const wasEnabled = before.config.enabled !== false;

  if (wasEnabled && next.enabled === false) {
    state.readiness = readinessFromAuthAndError({
      enabled: false,
      authState: state.auth?.state ?? 'ready',
    });
  } else if (!wasEnabled && next.enabled !== false) {
    // Nothing has been checked since it came back on, so it reads as unknown
    // rather than as whatever the disabled card last said. The app renders this
    // state and offers "Check", instead of claiming the provider is ready.
    state.readiness = { state: 'unavailable', checkedAt: new Date().toISOString() };
  }

  if (reachesElsewhere(before.config, next)) {
    delete state.backoff;
    // `isCatalogFresh` only skips a live/fresh catalog, so stale is enough to
    // make the next refresh actually ask the new endpoint.
    if (state.catalog) state.catalog = { ...state.catalog, state: 'stale' };
  }
  return state;
}

function reachesElsewhere(before, next) {
  const previous = before.registration ?? {};
  const upcoming = next.registration ?? {};
  return before.providerType !== next.providerType
    || previous.baseUrl !== upcoming.baseUrl
    || previous.resourceBaseUrl !== upcoming.resourceBaseUrl
    || previous.credentialRef !== upcoming.credentialRef;
}

/**
 * The vault entry a provider's credential actually lives in.
 *
 * An `oauth` registration is forbidden a `credentialRef` and was asked the vault
 * about `registration.oauthProfileId`, which is not a vault ref at all -- while
 * `OAuthManager` writes and revokes `oauth/<providerId>`. The two halves could
 * never see each other's token, so a signed-in provider read as having no
 * credential and asked for a key it cannot use.
 */
function credentialRefFor(config) {
  if (config.registration?.mode === 'oauth') return `oauth/${config.id}`;
  return config.registration?.credentialRef;
}
