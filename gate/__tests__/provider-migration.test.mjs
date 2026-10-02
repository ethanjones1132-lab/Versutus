import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { providerMigrationFixture } from './fixtures/provider-migration.mjs';
import { migrateLegacyProviders } from '../core/providers/migrate-v1.mjs';
import { ProviderStore } from '../core/providers/store.mjs';

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

/**
 * A legacy record the v2 schema refuses: a hand-edited flavor names no shipped
 * profile, so `store.put` throws on the providerType check.
 */
async function writeLegacyRecord(sourceRoot, name, record) {
  await writeFile(join(sourceRoot, 'registry', name), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

test('one legacy record the schema rejects no longer decides whether the Gate starts', async () => {
  const created = await fixture();
  await writeLegacyRecord(created.sourceRoot, 'legacy.json', {
    kind: 'provider',
    label: 'Groq',
    config: { flavor: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
  });

  // Resolves rather than throwing: the bad record is skipped and the good one
  // beside it is still migrated, so `createGate` gets a usable store.
  const result = await migrateLegacyProviders(created);
  assert.deepEqual(result.providers.map((provider) => provider.id), ['nvidia']);

  // Left in place, named, so the operator can fix or delete it.
  await access(join(created.sourceRoot, 'registry', 'legacy.json'));
  // And the receipt exists, so the next start does not hit it again.
  const receipt = JSON.parse(
    await readFile(join(created.gateHome, 'state', 'migrations', 'provider-v2.json'), 'utf8'),
  );
  assert.deepEqual(receipt.providers, ['nvidia']);
});

test('a legacy record with no baseUrl is skipped instead of wedging the migration', async () => {
  const created = await fixture();
  await writeLegacyRecord(created.sourceRoot, 'nokey.json', {
    kind: 'provider',
    label: 'No endpoint',
    config: { flavor: 'openai' },
  });

  const result = await migrateLegacyProviders(created);
  assert.deepEqual(result.providers.map((provider) => provider.id), ['nvidia']);
});

test('a registry file added after the receipt is migrated on the next boot', async () => {
  const created = await fixture();
  const first = await migrateLegacyProviders(created);
  assert.deepEqual(first.providers.map((provider) => provider.id), ['nvidia']);

  // The receipt now short-circuited the whole migration, so a file added (or
  // corrected) after the first successful boot was read by nobody, ever -- while
  // the legacy half of the manifest kept advertising it with bootstrap facts.
  await writeLegacyRecord(created.sourceRoot, 'groq.json', {
    kind: 'provider',
    label: 'Groq',
    config: { flavor: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' },
  });

  const second = await migrateLegacyProviders(created);
  assert.deepEqual(second.providers.map((provider) => provider.id).sort(), ['groq', 'nvidia']);
});

test('a lost receipt cannot revert a provider the operator has since edited', async () => {
  const created = await fixture();
  await migrateLegacyProviders(created);
  const store = new ProviderStore(created.gateHome);

  // What the operator did after the migration: renamed it, re-pointed it, and
  // disabled it -- with the readiness and outcome the real turns earned.
  const { config } = await store.get('nvidia');
  await store.put(
    { ...config, label: 'Renamed', enabled: false, registration: { ...config.registration, baseUrl: 'http://127.0.0.1:9/v1' } },
    { ...(await store.get('nvidia')).state, auth: { state: 'ready' }, readiness: { state: 'ready' } },
  );

  // The receipt is truncated -- the exact shape a killed write leaves behind,
  // and `readReceipt` cannot tell it from one that was never written.
  const receiptPath = join(created.gateHome, 'state', 'migrations', 'provider-v2.json');
  await writeFile(receiptPath, '', 'utf8');
  await migrateLegacyProviders(created);

  const after = await store.get('nvidia');
  assert.equal(after.config.label, 'Renamed');
  assert.equal(after.config.enabled, false);
  assert.equal(after.config.registration.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(after.state.auth.state, 'ready');
  assert.equal(after.state.readiness.state, 'ready');
});

test('the receipt names every migrated id and no temp file survives it', async () => {
  const created = await fixture();
  await writeLegacyRecord(created.sourceRoot, 'groq.json', {
    kind: 'provider',
    label: 'Groq',
    config: { flavor: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' },
  });
  await migrateLegacyProviders(created);

  // The receipt is written through the Gate's `writeFileAtomic` (temp copy then
  // rename), so a kill leaves no half-written receipt and no debris beside it.
  assert.deepEqual(await readdir(join(created.gateHome, 'state', 'migrations')), ['provider-v2.json']);
  const receipt = JSON.parse(
    await readFile(join(created.gateHome, 'state', 'migrations', 'provider-v2.json'), 'utf8'),
  );
  assert.equal(receipt.id, 'provider-v2');
  assert.deepEqual(receipt.providers, ['groq', 'nvidia']);
});
