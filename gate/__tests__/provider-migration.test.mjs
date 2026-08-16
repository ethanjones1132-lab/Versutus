import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { providerMigrationFixture } from './fixtures/provider-migration.mjs';
import { migrateLegacyProviders } from '../core/providers/migrate-v1.mjs';

const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.tempRoot, { recursive: true, force: true })));
});

async function fixture() {
  const created = await providerMigrationFixture();
  fixtures.push(created);
  return created;
}

test('legacy NVIDIA models are marked bootstrap, not live', async () => {
  const created = await fixture();
  const result = await migrateLegacyProviders(created);
  assert.equal(result.providers[0].catalog.source, 'legacy_bootstrap');
  assert.notEqual(result.providers[0].catalog.source, 'live');
});

test('migration is idempotent and leaves the source file in place', async () => {
  const created = await fixture();
  const first = await migrateLegacyProviders(created);
  const second = await migrateLegacyProviders(created);
  assert.equal(first.providers.length, 1);
  assert.equal(second.providers.length, 1);
  assert.equal(first.providers[0].id, second.providers[0].id);
  await access(join(created.sourceRoot, 'registry', 'nvidia.json'));
});
