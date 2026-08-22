import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseListenKey,
  parseDisplayName,
  parseDescription,
  parseModelPin,
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

test('parseDescription folds the CLI multi-line scalar into one string', () => {
  // Real on-disk shape: CRLF, folded continuation line, followed by other keys.
  assert.equal(
    parseDescription(
      'description: Proves the Versutus phone-to-Gate-to-Hermes acceptance journey end\r\n  end.\r\ndescription_auto: false\r\n',
    ),
    'Proves the Versutus phone-to-Gate-to-Hermes acceptance journey end end.',
  );
  assert.equal(parseDescription('description: "quoted value"\n'), 'quoted value');
  assert.equal(parseDescription('description:\ndescription_auto: false\n'), null);
  assert.equal(parseDescription('display_name: x\n'), null);
  // A deeper block after another key must not be folded into the description.
  assert.equal(parseDescription('ui_meta:\n  hermes-bots:\n    title: Relay\n'), null);
});

test('parseModelPin reads only model.default and model.provider', () => {
  const config = [
    'model:',
    '  auth_mode: api_key',
    '  default: dots-studio/dots-3-note-preview:free',
    '  provider: kilo',
    '  base_url: https://api.kilo.ai/api/gateway',
    'providers:',
    '  kilo:',
    '    api_key: sk-secret-must-not-leak',
    '',
  ].join('\n');
  assert.deepEqual(parseModelPin(config), {
    default: 'dots-studio/dots-3-note-preview:free',
    provider: 'kilo',
  });
  assert.deepEqual(parseModelPin('chat:\n  context: bounded\n'), { default: null, provider: null });
  assert.deepEqual(parseModelPin(null), { default: null, provider: null });
});

test('listHermesBots includes default and every profiles/ directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-home-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=def-key\nOPENAI_API_KEY=sk-nope\n');
  await writeFile(join(home, 'profile.yaml'), 'display_name: Harumesu\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-key\n');
  // Pinned exactly like `hermes -p researcher config set model.default/provider` writes it.
  await writeFile(
    join(home, 'profiles', 'researcher', 'config.yaml'),
    'model:\n  default: anthropic/claude-sonnet-4\n  provider: kilo\nproviders:\n  kilo:\n    api_key: sk-vault-secret\n',
  );
  await writeFile(
    join(home, 'profiles', 'researcher', 'profile.yaml'),
    'description: Deep research\r\n  runs.\r\ndescription_auto: false\n',
  );
  await mkdir(join(home, 'profiles', 'silent'), { recursive: true });
  await writeFile(join(home, 'profiles', 'silent', '.env'), 'OPENAI_API_KEY=«redacted:sk-…»\n');

  const bots = await listHermesBots(home);
  const byId = Object.fromEntries(bots.map((b) => [b.id, b]));
  assert.equal(byId.default.displayName, 'Harumesu');
  assert.equal(byId.default.listenKey, 'def-key');
  assert.equal(byId.researcher.listenKey, 'res-key');
  assert.equal(byId.silent.listenKey, null);
  assert.deepEqual(toPublicBot(byId.silent), {
    id: 'silent',
    displayName: 'silent',
    routable: false,
    description: null,
    model: null,
  });
  const publicResearcher = toPublicBot(byId.researcher);
  assert.deepEqual(publicResearcher.model, { default: 'anthropic/claude-sonnet-4', provider: 'kilo' });
  assert.equal(publicResearcher.description, 'Deep research runs.');
  // The pin/description travel; the config.yaml provider keys never do.
  const wire = JSON.stringify(publicResearcher);
  assert.equal(wire.includes('sk-vault-secret'), false);
  assert.equal(JSON.stringify(toPublicBot(byId.default)).includes('def-key'), false);
  assert.equal(await getHermesBot(home, 'researcher').then((b) => b.listenKey), 'res-key');
  assert.equal(await getHermesBot(home, 'nope'), null);
});
