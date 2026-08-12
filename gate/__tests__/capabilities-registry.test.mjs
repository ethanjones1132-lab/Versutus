import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKinds } from '../core/capabilities/registry.mjs';

async function kindsDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-kinds-'));
  for (const [id, source] of Object.entries(entries)) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'kind.mjs'), source, 'utf8');
  }
  return root;
}

const goodKind = (id) => `
export default {
  kind: '${id}',
  label: '${id}',
  family: '${id}',
  configFields: [],
  validate(config) { return { ok: true, errors: [] }; },
  toManifestEntry(instance) { return { id: instance.id }; },
  createHandlers(instance) { return {}; },
};
`;

test('loads a valid kind', async () => {
  const root = await kindsDir({ cron: goodKind('cron') });
  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 1);
  assert.equal(kinds.get('cron').label, 'cron');
  assert.deepEqual(skipped, []);
});

test('skips a kind that throws on import, without losing the others', async () => {
  const root = await kindsDir({
    cron: goodKind('cron'),
    exploding: `throw new Error('boom');`,
  });

  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 1);
  assert.ok(kinds.has('cron'));
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'exploding');
  assert.match(skipped[0].reason, /boom/);
});

test('skips a kind missing a required export', async () => {
  const root = await kindsDir({
    broken: `export default { kind: 'broken', label: 'Broken' };`,
  });

  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /missing/);
});

test('returns empty rather than throwing when there are no kinds', async () => {
  const root = await kindsDir({});
  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 0);
  assert.deepEqual(skipped, []);
});
