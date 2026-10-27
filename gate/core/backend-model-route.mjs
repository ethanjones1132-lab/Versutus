// ─── Which environment serves a model the Gate has no provider for ───
//
// A phone whose client lost this thread's scope sends `providerId` with no
// `backendId` and no `bot` (2026-10-01: `Unknown provider "kilo"` for
// `kilo/kilo-auto/free`, on a Gate with no kilo provider at all — it is a Hermes
// provider). `/v1/chat/completions` handed that straight to `dispatchChat`,
// which answered 404, although `/v1/models` has always aggregated every
// environment's `listModels()` and Hermes files its catalogue as
// `${providerId}/${modelId}`.
//
// So the Gate asks its own environments before refusing. It asks only for a
// provider it does not own: an id that IS a provider record of the Gate's is
// that provider's business, and guessing at a second meaning here is how an
// ambiguity that belongs to the client's scope ends up decided by string
// matching.
//
// Pure selection, plus the router that owns the one catalogue cache. A read
// that fails or hangs never replaces a copy already held — "this environment
// serves nothing" is only remembered when there was nothing to remember — so a
// burst of turns must not re-read `/api/model/options` per turn, and neither a
// slow environment nor an unreachable one may hold a turn open or blank the
// picker.
/** How long an environment's catalogue is trusted before it is read again. */
export const CATALOGUE_TTL_MS = 60_000;

/**
 * How long a copy may be answered from once it has gone stale.
 *
 * Stale-but-young is the shape a slow environment takes: `/api/model/options`
 * alone costs Hermes 3.9 s, so a catalogue read that waits for it makes every
 * open of the picker wait too. Answering the copy and refreshing behind it
 * keeps that cost off the request. Past this age the copy is not a summary of
 * anything the operator would recognise, so the read blocks again.
 */
export const CATALOGUE_STALE_MS = 30 * 60_000;

/**
 * How long a ROUTING lookup waits for one catalogue read.
 *
 * Routing answers 404 or asks the next environment, so a bound that keeps a
 * turn from hanging on an unresponsive environment is the right shape here and
 * the wrong one for a catalogue response.
 */
export const CATALOGUE_READ_TIMEOUT_MS = 5_000;

/**
 * How long a catalogue RESPONSE waits for a cold read.
 *
 * Generous on purpose. Hermes's `/api/model/options` measures 3.9 s on the live
 * host, and a read that overruns a tighter bound used to be remembered as "this
 * environment serves nothing" — blanking the picker for a minute over a read
 * that was merely slow, with no error anywhere. A read that overruns this one
 * is answered as the failure it is (see `cataloguesFor`), never as an answer.
 */
export const CATALOGUE_RESPONSE_TIMEOUT_MS = 60_000;

/**
 * The catalogue id a model is filed under for a provider.
 *
 * Hermes and friends list `kilo/kilo-auto/free`; a turn may name the same model
 * either qualified or as `kilo-auto/free` under `providerId: 'kilo'`.
 */
export function qualifiedModelId(model, providerId) {
  if (typeof model !== 'string' || !model) return undefined;
  if (!providerId) return model;
  return model.startsWith(`${providerId}/`) ? model : `${providerId}/${model}`;
}

/**
 * Which environment should run a turn for `qualified`, or null.
 *
 * Order: an available row beats an unavailable one (Hermes marks a provider it
 * is not signed into `available: false`, and a model behind one cannot answer),
 * then Hermes itself (a Bot-capable environment is the one a provider string
 * like `kilo` belongs to), then the order `backendManager.list()` returned —
 * which is what `Array#sort` preserves for equal ranks.
 *
 * @param backends the environment records, in `backendManager.list()` order.
 * @param catalogues `Map<backendId, rows>` — what each one last listed.
 */
export function pickBackendForModel(backends, catalogues, qualified) {
  if (!qualified) return null;
  const ranked = [];
  for (const entry of backends ?? []) {
    const row = (catalogues?.get(entry?.id) ?? []).find((model) => model?.id === qualified);
    if (!row) continue;
    const hermes = entry.adapterId === 'hermes' || entry.kind === 'hermes';
    ranked.push({ id: entry.id, rank: (row.available === false ? 1 : 0) * 2 + (hermes ? 0 : 1) });
  }
  if (ranked.length === 0) return null;
  return ranked.sort((a, b) => a.rank - b.rank)[0].id;
}

/**
 * The clock a catalogue deadline is measured on.
 *
 * A bound is a race against wall-clock time, which is the one thing a test
 * cannot take from a machine busy with the rest of the suite: a healthy read
 * that loses a short race is indistinguishable from a slot that was never
 * released. These two functions are `setTimeout` and `clearTimeout` — the
 * production behavior, unchanged — and `createBackendModelRouter` reads the
 * methods at call time, so a test can take the deadline over (see
 * `__tests__/model-catalogue-curation.test.mjs`). Nothing else belongs here:
 * the deadline is the whole seam.
 */
export const catalogueBoundTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * One catalogue read, given up on after `timeoutMs`.
 *
 * The same bound every waiter applies, as a helper: a read that never settles
 * has to become the same answer as one that refused, or it holds whatever slot
 * it was filed in for the life of the process. The deadline itself is measured
 * on `timers`, and the timer is cleared as the read settles either way.
 */
function bounded(read, timeoutMs, timers = catalogueBoundTimers) {
  let timer;
  const bound = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve({ ok: false, models: [] }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([read, bound]).finally(() => timers.clearTimeout(timer));
}

/**
 * A model-to-environment lookup over the Gate's attached environments.
 *
 * `listBackends` is the manager's roster; `listModels(backend)` is that one
 * environment's catalogue. Neither is called when the cache is warm.
 */
export function createBackendModelRouter({
  listBackends,
  listModels,
  now = Date.now,
  ttlMs = CATALOGUE_TTL_MS,
  staleMs = CATALOGUE_STALE_MS,
  readTimeoutMs = CATALOGUE_READ_TIMEOUT_MS,
  responseTimeoutMs = CATALOGUE_RESPONSE_TIMEOUT_MS,
  // The clock the two bounds are measured on. Real timers unless a test hands
  // over its own, so a router built with no options behaves exactly as before.
  timers = catalogueBoundTimers,
} = {}) {
  // backendId -> { at, models }. A copy only: a read that failed is never filed
  // here as an answer. Survives an environment leaving, which is why an id
  // nobody lists is simply never read again.
  const cache = new Map();
  // backendId -> { live, waiters }: the read in flight for it right now, and
  // how many callers are still waiting on it. One live read per environment
  // however many callers find nothing to answer from: a burst of picker opens,
  // or a cold `backendFor` and a cold `/v1/models` at the same moment, costs one
  // read between them. The deadline lives with each waiter, not with this slot
  // (see `readCatalogue`).
  const inflight = new Map();
  // backendId -> when a ROUTING read last came back unusable. Routing asks on
  // every turn, so it needs to remember; a catalogue response deliberately does
  // not read this, because "the lookup timed out" must not become "this
  // environment serves nothing" for the picker.
  const unreadable = new Map();

  return { backendFor, cataloguesFor, forget };

  /** The environment that serves `model` under `providerId`, or null. */
  async function backendFor(model, providerId) {
    const qualified = qualifiedModelId(model, providerId);
    if (!qualified) return null;
    const backends = await listBackends().catch(() => []);
    if (!backends.length) return null;
    const catalogues = new Map();
    await Promise.all(backends.map(async (entry) => {
      catalogues.set(entry.id, await catalogueFor(entry));
    }));
    return pickBackendForModel(backends, catalogues, qualified);
  }

  /**
   * What every named environment currently lists, for a catalogue response.
   *
   * Same cache the router reads, so a catalogue open warms the routing lookup
   * and a turn does not re-read what the picker already showed. A copy younger
   * than `ttlMs` is returned as it is; an older one is still younger than
   * `staleMs`, so it is returned AND refreshed behind the caller (one read per
   * environment, however many callers arrive while it runs); past that, or with
   * nothing cached, the read is the answer's only option and it waits.
   *
   * A backend whose read FAILS is left out of the returned map rather than
   * answered with an empty list: `catalogues.get(id)` is then undefined and the
   * caller decides what a missing environment means — the scoped branch answers
   * 502 the way `/v1/models` did before the cache existed, the aggregate omits
   * it the way its per-descriptor try/catch did. Nothing is cached as an empty
   * catalogue, so the next read tries again.
   *
   * `refresh: true` is the caller saying "I asked for it now" (`?refresh=1`) —
   * every environment is read live, because asking for a fresh read and being
   * handed a cached one is the one answer that cannot be reasoned about.
   */
  async function cataloguesFor(backends, { refresh = false } = {}) {
    const catalogues = new Map();
    await Promise.all((backends ?? []).map(async (entry) => {
      const cached = cache.get(entry.id);
      const age = cached ? now() - cached.at : Infinity;
      if (!refresh && cached && age < ttlMs) {
        catalogues.set(entry.id, cached.models);
        return;
      }
      if (!refresh && cached && age < staleMs) {
        catalogues.set(entry.id, cached.models);
        // A catalogue refresh, so it gets the catalogue's bound: under the
        // routing bound a ~4 s Hermes read would time out every time and the
        // copy would never move past its first generation.
        void loadCatalogue(entry, { response: true });
        return;
      }
      const models = await loadCatalogue(entry, { response: true });
      if (models) catalogues.set(entry.id, models);
    }));
    return catalogues;
  }

  async function catalogueFor(entry) {
    const cached = cache.get(entry.id);
    if (cached && now() - cached.at < ttlMs) return cached.models;
    // An environment whose read came back unusable a moment ago is not read
    // again on the next turn: routing asks on every turn, and re-parking on the
    // same dead read is what the short bound was for.
    const failedAt = unreadable.get(entry.id);
    if (failedAt !== undefined && now() - failedAt < ttlMs) return [];
    return loadCatalogue(entry) ?? [];
  }

  /**
   * One read, single-flighted, and what it leaves behind.
   *
   * `response: true` is a catalogue read (`/v1/models`), which waits on the
   * generous `responseTimeoutMs` and is answered honestly when the read fails:
   * null, so the caller can report the failure. A routing read waits on the
   * short bound instead and remembers an unusable environment in `unreadable`,
   * so a turn is not re-parks on the same dead read every time.
   *
   * Either way a read that fails or times out keeps the copy already held: an
   * environment that is briefly unreachable must not blank the picker or
   * un-serve the models a turn is already being routed to.
   */
  function loadCatalogue(entry, { response = false } = {}) {
    return readCatalogue(entry, response ? responseTimeoutMs : readTimeoutMs).then((outcome) => {
      if (outcome.ok) {
        cache.set(entry.id, { at: now(), models: outcome.models });
        unreadable.delete(entry.id);
        return outcome.models;
      }
      if (cache.has(entry.id)) return cache.get(entry.id).models;
      unreadable.set(entry.id, now());
      return null;
    });
  }

  /**
   * One read, shared by every caller that arrives while it runs, and each
   * caller's OWN deadline on how long it waits for it.
   *
   * The slot holds the live read itself — never one caller's bounded view of
   * it. Filing the bounded promise (what this did before) made the deadline a
   * property of whoever STARTED the read: a routing lookup that gave up after
   * 5 s settled the shared promise as a failure, so a `/v1/models` request that
   * arrived a moment later, entitled to wait a minute, joined that promise and
   * inherited the 5 s failure 55 s early. Each waiter now races the one live
   * read against its own bound, so a shorter deadline fails at its own deadline
   * while a longer one keeps waiting for the same result.
   *
   * The read remains single-flight: waiters see one `listModels` call, not one
   * each. Releasing the slot takes two forms, both finite: the live read
   * settling (the next request starts fresh rather than joining an answer), and
   * the last waiter leaving (a `listModels` that never settles must not hold
   * the slot for the life of the process just because every caller gave up).
   */
  function readCatalogue(entry, timeoutMs) {
    let slot = inflight.get(entry.id);
    if (!slot) {
      // `Promise.resolve().then(...)` so a `listModels` that THROWS is the same
      // answer as one that refuses: the catalogue is read for many environments
      // at once, and one that will not start must not blank the rest.
      // An entry may bring its own read (a Bot's catalogue, read through the
      // Bot's backend); an environment-roster entry is read by `listModels`.
      const live = Promise.resolve().then(() => (typeof entry.read === 'function' ? entry.read() : listModels(entry))).then(
        (models) => ({ ok: true, models: Array.isArray(models) ? models : [] }),
        () => ({ ok: false, models: [] }),
      );
      slot = { live, waiters: 0 };
      inflight.set(entry.id, slot);
      // Settled — answered or refused — so nothing joins it again.
      live.then(() => { if (inflight.get(entry.id) === slot) inflight.delete(entry.id); });
    }
    slot.waiters += 1;
    const waiter = bounded(slot.live, timeoutMs, timers);
    waiter.then(() => {
      slot.waiters -= 1;
      // Every waiter has stopped waiting, so the slot is holding a read nobody
      // can be answered from. Guarded by identity: the slot may already have
      // been released on settle and replaced by a newer read.
      if (slot.waiters <= 0 && inflight.get(entry.id) === slot) inflight.delete(entry.id);
    });
    return waiter;
  }

  /** Drop a cached catalogue, for a caller that knows the roster moved. */
  function forget() {
    cache.clear();
    unreadable.clear();
  }
}
