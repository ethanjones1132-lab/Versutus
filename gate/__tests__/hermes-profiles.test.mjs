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
  parseMultiplexEnabled,
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
    routingIssue: 'listen_key_missing',
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

test('a profile copying the default listen key lists as refused, default keeps its own door', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-home-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=def-key\n');
  // `echo` was created by cloning default without the distinct-key fix: same
  // key. Multiplex refuses it on /p/echo/ (ADR 0005) — the roster must not
  // promise routing the listener will refuse.
  await mkdir(join(home, 'profiles', 'echo'), { recursive: true });
  await writeFile(join(home, 'profiles', 'echo', '.env'), 'API_SERVER_KEY=def-key\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-key\n');

  const bots = await listHermesBots(home);
  const defaultKey = bots.find((bot) => bot.id === 'default')?.listenKey ?? null;
  const byId = Object.fromEntries(bots.map((bot) => [bot.id, toPublicBot(bot, defaultKey)]));

  assert.equal(byId.echo.routable, false);
  assert.equal(byId.echo.routingIssue, 'default_key_refused');
  assert.equal(byId.researcher.routable, true);
  assert.equal(byId.researcher.routingIssue, null);
  // The default profile's key IS the unprefixed listener's — never flagged.
  assert.equal(byId.default.routable, true);
  assert.equal(byId.default.routingIssue, null);
  // The comparison happens behind the wire; keys still never travel.
  assert.equal(JSON.stringify(byId).includes('def-key'), false);
});

test('parseMultiplexEnabled reads what Hermes itself reads', () => {
  // Hermes: bool(cfg_get(cfg, "gateway", "multiplex_profiles", default=False)),
  // and hermes_cli/config.py accepts the top-level form alongside it.
  assert.equal(parseMultiplexEnabled('gateway:\n  multiplex_profiles: true\n'), true);
  assert.equal(parseMultiplexEnabled('gateway:\n  multiplex_profiles: on\n'), true);
  assert.equal(parseMultiplexEnabled('multiplex_profiles: true\n'), true);
  assert.equal(parseMultiplexEnabled('gateway:\n  multiplex_profiles: false\n'), false);
  // Absent is Hermes' own default: off.
  assert.equal(parseMultiplexEnabled('gateway:\n  strict: false\n'), false);
  // Nothing to read is unknown, not off — the caller must not block on a guess.
  assert.equal(parseMultiplexEnabled(''), null);
  assert.equal(parseMultiplexEnabled(undefined), null);
});

test('with multiplex off, a shared key is explained by multiplex, not by the key', async () => {
  // Both are true, but only one is the blocker the operator must clear first:
  // with gateway.multiplex_profiles off, /p/<name>/ is not an address at all,
  // so "give the profile its own API_SERVER_KEY" sends them to a fix that
  // changes nothing on its own.
  const home = await mkdtemp(join(tmpdir(), 'hermes-home-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=def-key\n');
  await mkdir(join(home, 'profiles', 'echo'), { recursive: true });
  await writeFile(join(home, 'profiles', 'echo', '.env'), 'API_SERVER_KEY=def-key\n');

  const bots = await listHermesBots(home);
  const defaultKey = bots.find((bot) => bot.id === 'default')?.listenKey ?? null;
  const echo = bots.find((bot) => bot.id === 'echo');

  assert.equal(toPublicBot(echo, defaultKey, false).routingIssue, 'multiplex_disabled');
  assert.equal(toPublicBot(echo, defaultKey, false).routable, false);
  // Multiplex on, or unknown, keeps the key verdict exactly as before.
  assert.equal(toPublicBot(echo, defaultKey, true).routingIssue, 'default_key_refused');
  assert.equal(toPublicBot(echo, defaultKey, null).routingIssue, 'default_key_refused');
  assert.equal(toPublicBot(echo, defaultKey).routingIssue, 'default_key_refused');
});

test('multiplex off never demotes a Bot that was already routable', async () => {
  // The verdict this adds is an explanation for an existing refusal, not a new
  // one: a profile with its own key keeps whatever it had, because proving
  // multiplex is off from config alone cannot account for the env override.
  const home = await mkdtemp(join(tmpdir(), 'hermes-home-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=def-key\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-key\n');

  const bots = await listHermesBots(home);
  const defaultKey = bots.find((bot) => bot.id === 'default')?.listenKey ?? null;
  const researcher = bots.find((bot) => bot.id === 'researcher');

  assert.equal(toPublicBot(researcher, defaultKey, false).routable, true);
  assert.equal(toPublicBot(researcher, defaultKey, false).routingIssue, null);
});
