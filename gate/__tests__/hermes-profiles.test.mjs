import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseListenKey,
  parseDisplayName,
  listHermesBots,
  getHermesBot,
  toPublicBot,
} from '../core/cli-environments/hermes-profiles.mjs';

test('parseListenKey takes only API_SERVER_KEY', () => {
  const env = [
    '# comment',
    'OPENAI_API_KEY=sk-never-copy-this',
    'API_SERVER_KEY=listen-me',
    'TELEGRAM_BOT_TOKEN=123:abc',
  ].join('\n');
  assert.equal(parseListenKey(env), 'listen-me');
  assert.equal(parseListenKey('OPENAI_API_KEY=sk-x\n'), null);
  assert.equal(parseListenKey('API_SERVER_KEY="quoted"\n'), 'quoted');
});

test('parseDisplayName reads the presentation name only', () => {
  assert.equal(parseDisplayName('display_name: Harumesu\n'), 'Harumesu');
  assert.equal(parseDisplayName('model: foo\n'), null);
});

test('listHermesBots includes default and every profiles/ directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-home-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=def-key\nOPENAI_API_KEY=sk-nope\n');
  await writeFile(join(home, 'profile.yaml'), 'display_name: Harumesu\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-key\n');
  await mkdir(join(home, 'profiles', 'silent'), { recursive: true });
  await writeFile(join(home, 'profiles', 'silent', '.env'), 'OPENAI_API_KEY=sk-still-nope\n');

  const bots = await listHermesBots(home);
  const byId = Object.fromEntries(bots.map((b) => [b.id, b]));
  assert.equal(byId.default.displayName, 'Harumesu');
  assert.equal(byId.default.listenKey, 'def-key');
  assert.equal(byId.researcher.listenKey, 'res-key');
  assert.equal(byId.silent.listenKey, null);
  assert.deepEqual(toPublicBot(byId.silent), { id: 'silent', displayName: 'silent', routable: false });
  assert.equal(JSON.stringify(toPublicBot(byId.default)).includes('def-key'), false);
  assert.equal(await getHermesBot(home, 'researcher').then((b) => b.listenKey), 'res-key');
  assert.equal(await getHermesBot(home, 'nope'), null);
});
