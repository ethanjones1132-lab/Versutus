import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HERMES_MEMORY_FILES, readHermesMemory } from '../core/cli-environments/hermes-profiles.mjs';

async function profileHome(name, files = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-memory-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=def-key\n');
  const dir = name === 'default' ? home : join(home, 'profiles', name);
  await mkdir(join(dir, 'memories'), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await writeFile(join(dir, 'memories', file), text);
  }
  return home;
}

test('a Bot memory reads its whitelisted files', async () => {
  const home = await profileHome('researcher', {
    'MEMORY.md': '- user prefers primary sources\n',
    'USER.md': 'Ethan, in Sydney.\n',
  });
  const memory = await readHermesMemory(home, 'researcher');
  assert.deepEqual(memory.files, [
    { name: 'MEMORY.md', text: '- user prefers primary sources\n' },
    { name: 'USER.md', text: 'Ethan, in Sydney.\n' },
  ]);
});

test('the default profile reads from the home root', async () => {
  const home = await profileHome('default', { 'MEMORY.md': 'root memory\n' });
  const memory = await readHermesMemory(home, 'default');
  assert.deepEqual(memory.files, [{ name: 'MEMORY.md', text: 'root memory\n' }]);
});

test('a Bot with no memory is null, not an empty file list', async () => {
  const home = await profileHome('silent');
  assert.equal(await readHermesMemory(home, 'silent'), null);
});

test('a blank memory file does not count as memory', async () => {
  const home = await profileHome('blank', { 'MEMORY.md': '   \n' });
  assert.equal(await readHermesMemory(home, 'blank'), null);
});

test('only the whitelisted files are ever read', async () => {
  const home = await profileHome('leaky', {
    'MEMORY.md': 'safe\n',
    'SECRET.md': 'should-never-be-returned\n',
  });
  const memory = await readHermesMemory(home, 'leaky');
  assert.deepEqual(HERMES_MEMORY_FILES, ['MEMORY.md', 'USER.md']);
  assert.equal(JSON.stringify(memory).includes('should-never-be-returned'), false);
});
