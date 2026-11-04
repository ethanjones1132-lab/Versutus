import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../core/tokens.mjs';

test('corrupt token storage is quarantined once and replaced without accepting the old token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-token-quarantine-'));
  const path = join(dir, 'token.json');
  const corrupt = '{truncated';
  await writeFile(path, corrupt);
  const store = new TokenStore(path);
  const backupsBefore = (await readdir(dir)).filter((name) => name.includes('.corrupt-')).length;
  await store.verify('Bearer old-token');
  await store.verify('Bearer old-token');
  assert.equal((await readdir(dir)).filter((name) => name.includes('.corrupt-')).length, backupsBefore + 1);
  assert.equal(await readFile(join(dir, (await readdir(dir)).find((name) => name.includes('.corrupt-'))), 'utf8'), corrupt);
  const replacement = await store.ensureToken();
  assert.ok(replacement);
  assert.equal(await store.verify('Bearer old-token'), false);
});
