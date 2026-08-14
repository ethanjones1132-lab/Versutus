import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyCatalogResult } from '../core/providers/catalog.mjs';

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
