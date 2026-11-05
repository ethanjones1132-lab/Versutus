import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionIndex } from '../core/session-index.mjs';

const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-session-index-rename-'));
  dirs.push(dir);
  return dir;
}

function row(id, title, preview) {
  return { id, source: 'hermes', title, preview, marker: `kept-${id}` };
}

test('rename updates only title-derived previews within its key and persists the result', async () => {
  const dir = await tempDir();
  const index = createSessionIndex({ dir, now: () => 4242, writeDelayMs: 60_000 });
  const key = 'hermes-local|atlas';
  const otherKey = 'hermes-local|';

  await index.refresh(key, async () => [
    row('derived', 'Old title', 'Old title'),
    row('null-preview', 'Null title', null),
    { id: 'undefined-preview', source: 'hermes', title: 'Undefined title', marker: 'kept-undefined-preview' },
    row('message-preview', 'Message title', 'Latest message text'),
    row('neighbor', 'Neighbor title', 'Neighbor preview'),
  ], { limit: 20 });
  await index.refresh(otherKey, async () => [row('derived', 'Other scope title', 'Other scope title')], { limit: 20 });

  await index.rename(key, 'derived', 'Renamed once');
  await index.rename(key, 'derived', 'Renamed twice');
  await index.rename(key, 'null-preview', 'Null renamed');
  await index.rename(key, 'undefined-preview', 'Undefined renamed');
  await index.rename(key, 'message-preview', 'Message renamed');

  const held = await index.get(key);
  assert.deepEqual(held.sessions.map(({ id }) => id), [
    'derived', 'null-preview', 'undefined-preview', 'message-preview', 'neighbor',
  ], 'renaming preserves each session position');
  assert.deepEqual(held.sessions[0], {
    ...row('derived', 'Renamed twice', 'Renamed twice'),
  }, 'a seeded old-title preview follows repeated renames and retains other fields');
  assert.equal(held.sessions[1].preview, 'Null renamed', 'null preview falls back to the new title');
  assert.equal(held.sessions[2].preview, 'Undefined renamed', 'missing preview falls back to the new title');
  assert.equal(held.sessions[3].preview, 'Latest message text', 'an independent message preview is retained');
  assert.deepEqual(held.sessions[4], row('neighbor', 'Neighbor title', 'Neighbor preview'));
  assert.deepEqual((await index.get(otherKey)).sessions, [row('derived', 'Other scope title', 'Other scope title')]);

  await index.flush();
  const reloaded = await createSessionIndex({ dir }).get(key);
  assert.deepEqual(reloaded.sessions, held.sessions, 'flush/reload preserves the rename and preview values');
  assert.equal(reloaded.fetchedLimit, 20);
  assert.equal(reloaded.refreshedAt, 4242);
});
