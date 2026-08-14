import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyCatalogResult, isCatalogFresh, nextBackoff } from '../core/providers/catalog.mjs';

test('successful live list replaces LKG and marks the catalog fresh', () => {
  const next = applyCatalogResult({
    previous: { source: 'last_known_good', state: 'stale', generation: 1, models: [] },
    models: [{ providerId: 'nvidia', id: 'live-model', available: true }],
  });
  assert.equal(next.source, 'live');
  assert.equal(next.state, 'fresh');
  assert.equal(next.generation, 2);
  assert.equal(next.models[0].id, 'live-model');
});

test('fresh live catalogs are reused until TTL expires', () => {
  const now = Date.parse('2026-01-01T00:00:30.000Z');
  assert.equal(isCatalogFresh({
    source: 'live',
    state: 'fresh',
    observedAt: '2026-01-01T00:00:00.000Z',
  }, 300, now), true);
  assert.equal(isCatalogFresh({
    source: 'last_known_good',
    state: 'stale',
    observedAt: '2026-01-01T00:00:00.000Z',
  }, 300, now), false);
});

test('transient failures back off exponentially', () => {
  const first = nextBackoff(undefined, 1_000);
  const second = nextBackoff(first, first.nextRetryAt);
  assert.equal(first.failures, 1);
  assert.equal(first.nextRetryAt, 1_000 + 30_000);
  assert.equal(second.failures, 2);
  assert.equal(second.nextRetryAt - first.nextRetryAt, 60_000);
});

test('failure keeps last-known-good when the policy allows it', () => {
  const next = applyCatalogResult({
    previous: {
      source: 'live',
      state: 'fresh',
      generation: 4,
      models: [{ providerId: 'nvidia', id: 'kept', available: true }],
    },
    error: { code: 'catalog_timeout' },
    allowLastKnownGood: true,
  });
  assert.equal(next.source, 'last_known_good');
  assert.equal(next.state, 'stale');
  assert.equal(next.models[0].id, 'kept');
});
