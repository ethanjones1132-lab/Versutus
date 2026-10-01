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
// Pure selection, plus a router that owns the catalogue cache. A read that
// fails or hangs is "this environment serves nothing" and is cached like any
// other answer: a burst of turns must not re-read `/api/model/options` per
// turn, and a slow environment must not hold a turn open.
/** How long an environment's catalogue is trusted before it is read again. */
export const CATALOGUE_TTL_MS = 60_000;

/** How long one catalogue read may take before it counts as "serves nothing". */
export const CATALOGUE_READ_TIMEOUT_MS = 5_000;

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
  readTimeoutMs = CATALOGUE_READ_TIMEOUT_MS,
} = {}) {
  // backendId -> { at, models }. Survives an environment leaving, which is why
  // an id nobody lists is simply never read again.
  const cache = new Map();

  return { backendFor, forget };

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

  async function catalogueFor(entry) {
    const cached = cache.get(entry.id);
    if (cached && now() - cached.at < ttlMs) return cached.models;
    const models = await readCatalogue(entry);
    cache.set(entry.id, { at: now(), models });
    return models;
  }

  /**
   * One bounded read. A backend that will not start, an environment that
   * refuses `/api/model/options`, and one that takes longer than the bound all
   * land on the same answer: it lists nothing, so it serves nothing here.
   */
  async function readCatalogue(entry) {
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(() => resolve([]), readTimeoutMs);
      timer.unref?.();
    });
    try {
      const read = Promise.resolve(listModels(entry)).then(
        (models) => (Array.isArray(models) ? models : []),
        () => [],
      );
      return await Promise.race([read, bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop a cached catalogue, for a caller that knows the roster moved. */
  function forget() {
    cache.clear();
  }
}
