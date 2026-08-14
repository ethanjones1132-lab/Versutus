export function applyCatalogResult({ previous = {}, models, error, allowLastKnownGood = true, now = new Date() }) {
  if (!error) {
    return {
      source: 'live',
      state: 'fresh',
      generation: (previous.generation ?? 0) + 1,
      observedAt: now.toISOString(),
      models: models ?? [],
    };
  }

  const hadModels = Array.isArray(previous.models) && previous.models.length > 0;
  if (allowLastKnownGood && hadModels) {
    return {
      ...previous,
      source: previous.source === 'legacy_bootstrap' ? 'legacy_bootstrap' : 'last_known_good',
      state: 'stale',
    };
  }

  return {
    source: previous.source ?? 'legacy_bootstrap',
    state: 'unavailable',
    generation: previous.generation ?? 0,
    models: previous.models ?? [],
    observedAt: previous.observedAt,
  };
}

export function isCatalogFresh(catalog, ttlSeconds, now = Date.now()) {
  if (!catalog?.observedAt || catalog.source !== 'live' || catalog.state !== 'fresh') return false;
  const observed = Date.parse(catalog.observedAt);
  if (Number.isNaN(observed)) return false;
  return now - observed < ttlSeconds * 1000;
}
