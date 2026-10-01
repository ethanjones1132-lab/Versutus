import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  NOT_A_CHAT_MODEL,
  NOT_SIGNED_IN,
  curateModels,
  healthKeyOf,
  shadowedProviders,
} from '../core/model-curation.mjs';
import { createModelHealth } from '../core/model-health.mjs';

// 2026-10-01, live host: `GET /v1/models?backendId=hermes-local` answered 759
// rows from 13 providers in 172 KB. 42 of Hermes' 55 providers are
// `authenticated: false`, the operator's own `kilo` sits beside the built-in
// `kilocode` it replaced, `opencode-go-session` sits beside the built-in
// `opencode-go` that now refuses every turn without the session header only the
// configured provider sends, and the image and audio models are offered as if
// they could hold a conversation.

/**
 * A Hermes row as `/api/model/options` is flattened by the backend, and as
 * `/v1/models` serves it: tagged with the environment that answers for it.
 * That `backendId` is what scopes rule b — a provider id is only unique inside
 * one environment's list.
 */
function row(providerId, modelId, {
  name,
  source = 'built-in',
  aliases,
  available = true,
  current = false,
  backendId = 'hermes-local',
} = {}) {
  const provider = name ?? providerId;
  return {
    id: `${providerId}/${modelId}`,
    providerId,
    modelId,
    provider,
    label: `${provider} · ${modelId}`,
    available,
    ...(backendId ? { backendId } : {}),
    providerSource: source,
    providerUserDefined: source === 'user-config',
    providerAliases: aliases ?? [],
    providerCurrent: current,
  };
}

/** Health stub: what `createModelHealth` answers, without the file. */
function healthOf(verdicts) {
  return { verdict: (key) => verdicts[key] ?? null };
}

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

const KILO = row('kilo', 'kilo-auto/free', {
  name: 'KiloCode',
  source: 'user-config',
  current: true,
  aliases: ['custom:kilo', 'custom:kilocode', 'kilo', 'kilocode'],
});
const KILOCODE = row('kilocode', 'kilo-auto/free', { name: 'KiloCode (built-in)' });
const GO_SESSION = row('opencode-go-session', 'deepseek-v4.1-flash', {
  name: 'OpenCode Go session header',
  source: 'user-config',
  current: true,
});
const GO_BUILTIN = row('opencode-go', 'deepseek-v4.1-flash');
const GO_BUILTIN_2 = row('opencode-go', 'omen-alpha');
const ANTHROPIC = row('anthropic', 'claude-sonnet-4-5');

test('a provider the host is not signed into is hidden, and locked', () => {
  // Hermes marks 42 providers `authenticated: false`; a turn on one of their
  // models completes with no assistant content.
  const unsigned = row('nous', 'poolside/laguna-xs-2.1:free', { name: 'Nous Portal', available: false });
  const [curated] = curateModels([unsigned]);

  assert.equal(curated.hidden, true);
  assert.equal(curated.hiddenReason, NOT_SIGNED_IN);
  assert.equal(curated.available, false);
});

test('a configured provider hides the built-in it replaces, by alias', () => {
  const curated = curateModels([KILO, KILOCODE]);
  const byId = new Map(curated.map((entry) => [entry.id, entry]));

  assert.equal(byId.get('kilocode/kilo-auto/free').hiddenReason, 'Replaced by your KiloCode provider');
  assert.equal(byId.get('kilocode/kilo-auto/free').available, false);
  // The configured provider is the one the operator meant: it stays.
  assert.equal(byId.get('kilo/kilo-auto/free').hidden, undefined);
  assert.equal(byId.get('kilo/kilo-auto/free').available, true);
});

test('a configured provider named after the twin it replaces hides that twin', () => {
  // `opencode-go-session` (30 models, the only one sending x-opencode-session)
  // over `opencode-go` (42, 30 overlapping) — the exact shape of the operator's
  // "opencode-go/deepseek-v4.1-flash refused it (400)" screenshot.
  const curated = curateModels([GO_BUILTIN, GO_BUILTIN_2, GO_SESSION]);
  const byId = new Map(curated.map((entry) => [entry.id, entry]));

  for (const id of ['opencode-go/deepseek-v4.1-flash', 'opencode-go/omen-alpha']) {
    assert.equal(byId.get(id).hidden, true, id);
    assert.equal(byId.get(id).available, false, id);
    assert.equal(byId.get(id).hiddenReason, 'Replaced by your OpenCode Go session header provider');
  }
  assert.equal(byId.get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
});

test('the alias comparison ignores case and a `custom:` prefix', () => {
  const rows = [
    row('kilo', 'kilo-auto/free', { name: 'KiloCode', source: 'user-config', aliases: ['custom:KiloCode'] }),
    row('KiloCode', 'kilo-auto/free', { name: 'KiloCode (built-in)' }),
  ];
  assert.equal(
    curateModels(rows)[1].hiddenReason,
    'Replaced by your KiloCode provider',
  );
});

test('the merge rule never reaches across environments', () => {
  // The aggregate catalogue carries the Gate's own provider rows (no backendId)
  // beside every environment's. `opencode-go` is a provider id the Gate can
  // legitimately own AND a Hermes built-in, and Hermes's configured
  // `opencode-go-session` says nothing about the Gate's provider of that name.
  // Indexing both provider lists together would hide the Gate's rows.
  const rows = [
    { id: 'opencode-go/deepseek-v4.1-flash', provider: 'OpenCode Go', providerId: 'opencode-go', label: 'opencode-go' },
    { id: 'opencode-go/kilo-auto/free', provider: 'OpenCode Go', providerId: 'opencode-go', label: 'opencode-go' },
    row('opencode-go-session', 'deepseek-v4.1-flash', {
      name: 'OpenCode Go session header', source: 'user-config', aliases: ['opencode-go'],
    }),
    row('opencode-go', 'omen-alpha'),
  ];
  const curated = curateModels(rows);

  // The Gate's rows are untouched: rules c and d only, and neither fires here.
  assert.equal(curated[0], rows[0]);
  assert.equal(curated[1], rows[1]);
  // Only the Hermes built-in is condemned, and by the Hermes provider.
  assert.equal(curated[3].hidden, true);
  assert.equal(curated[3].hiddenReason, 'Replaced by your OpenCode Go session header provider');
  assert.equal(curated[2].hidden, undefined);
  assert.equal(shadowedProviders(rows).size, 1);
});

test('two environments shadowing the same provider id do not merge', () => {
  // Two environments both ship a built-in `opencode-go` and both have a
  // configured provider named after it. Each is merged inside its own
  // environment; neither twin escapes the other one's verdict.
  const rows = [
    row('opencode-go', 'omen-alpha', { backendId: 'hermes-local' }),
    row('opencode-go-session', 'deepseek-v4.1-flash', { backendId: 'hermes-local', source: 'user-config' }),
    row('opencode-go', 'laguna-xs-2.1', { backendId: 'other-local' }),
    row('opencode-go-session', 'grok-4.6', { backendId: 'other-local', source: 'user-config' }),
  ];
  const byId = new Map(curateModels(rows).map((entry) => [entry.id, entry]));

  assert.equal(byId.get('opencode-go/omen-alpha').hiddenReason, 'Replaced by your opencode-go-session provider');
  assert.equal(byId.get('opencode-go/laguna-xs-2.1').hiddenReason, 'Replaced by your opencode-go-session provider');
  assert.equal(byId.get('opencode-go-session/deepseek-v4.1-flash').hidden, undefined);
  assert.equal(byId.get('opencode-go-session/grok-4.6').hidden, undefined);
});

test('a configured provider is never hidden by another configured provider', () => {
  // Rule b is about merging the operator's provider with the built-in it
  // replaced. Two providers the operator configured are both deliberate, so
  // neither may condemn the other.
  const rows = [
    row('opencode-go', 'omen-alpha', { name: 'OpenCode Go (mine)', source: 'user-config', aliases: ['custom:opencode-go'] }),
    row('opencode-go-session', 'deepseek-v4.1-flash', {
      name: 'OpenCode Go session header', source: 'user-config', aliases: ['opencode-go'],
    }),
  ];
  assert.deepEqual(curateModels(rows).map((entry) => entry.hidden), [undefined, undefined]);
  assert.equal(shadowedProviders(rows).size, 0);
});

test('image, audio and embedding models are hidden, keeping the availability they had', () => {
  const rows = [
    row('kilo', 'google/gemini-3.1-flash-image'),
    row('kilo', 'openai/gpt-5.4-image-2'),
    row('kilo', 'openai/gpt-audio'),
    row('kilo', 'openai/gpt-audio-mini'),
    row('kilo', 'openai/gpt-5-image-mini'),
    row('kilo', 'google/gemini-2.5-flash-image'),
    row('kilo', 'text-embedding-3-large'),
  ];
  const curated = curateModels(rows);

  for (const entry of curated) {
    assert.equal(entry.hidden, true, entry.id);
    assert.equal(entry.hiddenReason, NOT_A_CHAT_MODEL, entry.id);
    // Rule c is about what the model IS, not whether it can run: a hidden
    // non-chat model behind a signed-in provider keeps `available: true`.
    assert.equal(entry.available, true, entry.id);
  }
});

test('a chat model with vision, and the ids that look like it, are not matched', () => {
  // `deepseek-v4-flash-vision-exp` IS a chat model that takes images, so the
  // pattern must not be a substring match on anything capability-shaped.
  const rows = [
    row('deepseek', 'deepseek-v4-flash-vision-exp'),
    row('openai', 'gpt-5.6-sol'),
    row('kilo', 'kilo-auto/free'),
    ANTHROPIC,
    row('xai', 'grok-4.6'),
    row('openai', 'openai/gpt-5.4'),
  ];
  for (const entry of curateModels(rows)) {
    assert.equal(entry.hidden, undefined, entry.id);
  }
});

test('a model that failed its last two real turns is hidden until the verdict expires', () => {
  const now = NOW;
  const failing = row('kilo', 'kilo-auto/free', {
    name: 'KiloCode',
    source: 'user-config',
  });
  const curated = curateModels([failing], {
    now,
    health: healthOf({
      [healthKeyOf(failing)]: {
        failing: true,
        failures: 2,
        reason: 'HTTP 400: MissingSessionID',
        since: now - 60_000,
        until: now + 6 * 60 * 60 * 1000,
      },
    }),
  });

  assert.equal(curated[0].hidden, true);
  assert.equal(curated[0].available, false);
  assert.equal(
    curated[0].hiddenReason,
    'Failed its last 2 turns (HTTP 400: MissingSessionID) - hidden until 2026-10-01 18:00 UTC',
  );
});

test('one failed turn is not a verdict, and two are', () => {
  // The threshold lives in the health table, so this is the two modules meeting:
  // one refusal on a model the operator just pinned is an accident, and the
  // model stays in the picker.
  const entry = row('kilo', 'kilo-auto/free', { name: 'KiloCode', source: 'user-config' });
  const health = createModelHealth({ now: () => NOW });

  health.recordFailure(healthKeyOf(entry), 'HTTP 400: MissingSessionID');
  assert.equal(curateModels([entry], { now: NOW, health })[0], entry);

  health.recordFailure(healthKeyOf(entry), 'HTTP 400: MissingSessionID');
  const [curated] = curateModels([entry], { now: NOW, health });
  assert.equal(curated.hidden, true);
  assert.match(curated.hiddenReason, /^Failed its last 2 turns \(HTTP 400: MissingSessionID\) - hidden until /);
});

test('the same rows come back, in the same order, with their fields intact', () => {
  const rows = [KILO, row('nous', 'poolside/laguna-xs-2.1:free', { available: false }), ANTHROPIC];
  const curated = curateModels(rows);

  assert.equal(curated.length, rows.length);
  assert.deepEqual(curated.map((entry) => entry.id), rows.map((entry) => entry.id));
  // A row no rule applies to is the same object, not a copy: nothing is added
  // to a row the Gate has no opinion about.
  assert.equal(curated[0], rows[0]);
  assert.equal(curated[2], rows[2]);
  assert.deepEqual(Object.keys(curated[1]), [...Object.keys(rows[1]), 'hidden', 'hiddenReason']);
});

test('the Gate\'s own provider rows are judged only by what a model is', () => {
  // The provider path carries no `available` and no provider metadata, so the
  // sign-in and merge rules cannot fire on it — a provider the operator signed
  // up for is never "not signed in on the host". Rule (d) WOULD apply to one of
  // these rows if a verdict existed for its key, and none does: the chat route
  // records outcomes for environment turns only, so `chatViaProviderService` /
  // `proxyChat` write nothing to the health table.
  const rows = [
    { id: 'gpt-5.6-sol', provider: 'openai', providerId: 'openai', label: 'gpt-5.6-sol', object: 'model' },
    { id: 'dall-e-3', provider: 'openai', providerId: 'openai', label: 'dall-e-3', object: 'model' },
  ];
  const curated = curateModels(rows);

  assert.equal(curated[0], rows[0]);
  assert.equal(curated[1].hidden, true);
  assert.equal(curated[1].hiddenReason, NOT_A_CHAT_MODEL);
  assert.equal(curated[1].available, undefined);
  // Stated rather than assumed: with no health table at all, a provider row
  // that DID refuse every turn here is still offered, because nothing on that
  // path recorded the refusals.
  const [refusing] = curateModels(
    [{ id: 'openai/gpt-5.6-sol', provider: 'openai', providerId: 'openai', label: 'openai' }],
    { now: NOW, health: { verdict: () => null } },
  );
  assert.equal(refusing.hidden, undefined);
});

test('a provider row IS hidden by rule (d) once a verdict exists for its key', () => {
  // The other half of the claim above, so the module is honest in both
  // directions: `curateModels` reads the verdict for a Gate row under its
  // `gate|<id>` key like any other, so the rule starts holding for the provider
  // path the moment that path records one.
  const row = { id: 'openai/gpt-5.6-sol', provider: 'openai', providerId: 'openai', label: 'openai' };
  const [curated] = curateModels([row], {
    now: NOW,
    health: healthOf({
      [healthKeyOf(row)]: {
        failing: true, failures: 2, reason: 'HTTP 429: rate limited',
        since: NOW - 60_000, until: NOW + 6 * 60 * 60 * 1000,
      },
    }),
  });

  assert.equal(curated.hidden, true);
  assert.equal(curated.available, false);
  assert.match(curated.hiddenReason, /^Failed its last 2 turns \(HTTP 429: rate limited\)/);
});

test('no rows, and rows with no provider at all, are answered honestly', () => {
  assert.deepEqual(curateModels([]), []);
  assert.deepEqual(curateModels(undefined), []);
  const [bare] = curateModels([{ id: 'kilo-auto/free', label: 'kilo-auto/free' }]);
  assert.equal(bare.hidden, undefined);
});

// What the module and the route SAY about the provider path is part of the
// contract: a comment claiming rule (d) is wired where it is not is how the
// next reader comes to trust a verdict that was never recorded. Read the two
// places that state it and pin the truth.
test('nothing claims the provider path records the verdicts rule (d) reads', () => {
  const curation = readFileSync(fileURLToPath(new URL('../core/model-curation.mjs', import.meta.url)), 'utf8');
  const server = readFileSync(fileURLToPath(new URL('../core/server.mjs', import.meta.url)), 'utf8');

  // The old claim, in either file, in the shape it was written.
  for (const [name, source] of [['model-curation.mjs', curation], ['server.mjs', server]]) {
    assert.doesNotMatch(
      source,
      /judged (?:only )?by what a model is and by\s*\n?\s*\*?\s*how it has answered/,
      `${name} still claims the provider path is judged by how a model answered`,
    );
    assert.doesNotMatch(source, /by how it has actually answered \(d\)/, `${name} still claims rule (d) runs there`);
  }
  // ...and the truth is stated where the rows are assembled.
  assert.match(curation, /rule d applies\s*\n?\s*\*?\s*ONLY if a verdict exists/);
  assert.match(server, /records none today/);
});
test("a Bot's failures are held against that Bot's catalogue only", async () => {
  // Each Bot is its own Hermes profile with its own provider keys. Two refused
  // turns on one Bot used to be filed under the Gate's own `gate` namespace,
  // which also hid the Gate provider row with the same id - a false hiding.
  const { healthScopeId, modelHealthKey } = await import('../core/model-health.mjs');
  const failing = { failing: true, reason: '429', until: NOW + 3_600_000 };
  const botKey = modelHealthKey(healthScopeId('hermes-local', 'anvil'), 'openai/gpt-5.6-sol');
  assert.equal(botKey, 'hermes-local@anvil|openai/gpt-5.6-sol');
  const health = healthOf({ [botKey]: failing });

  // The Bot's own picker (rows carry no backendId; the route passes the scope).
  const botRows = [row('openai', 'gpt-5.6-sol', { backendId: null })];
  const [botRow] = curateModels(botRows, { health, now: () => NOW, scopeId: 'hermes-local@anvil' });
  assert.equal(botRow.hidden, true);
  assert.equal(botRow.backendId, undefined, 'the scope is a key, not a field added to the answer');

  // Another Bot, the bare environment, and the Gate's own provider row all keep it.
  const [otherBot] = curateModels(botRows, { health, now: () => NOW, scopeId: 'hermes-local@forge' });
  assert.equal(otherBot.hidden, undefined);
  const [environmentRow] = curateModels([row('openai', 'gpt-5.6-sol')], { health, now: () => NOW });
  assert.equal(environmentRow.hidden, undefined);
  const [gateRow] = curateModels([{ id: 'openai/gpt-5.6-sol', providerId: 'openai' }], { health, now: () => NOW });
  assert.equal(gateRow.hidden, undefined);
});

test("rule b also runs inside a Bot's picker", () => {
  // A Bot's catalogue carries no backendId, so without its scope the shadowed
  // built-in twin stayed offered on the operator's everyday path.
  const botRows = [
    row('kilo', 'kilo-auto/free', { name: 'KiloCode', source: 'user-config', aliases: ['custom:kilocode', 'kilocode'], backendId: null }),
    row('kilocode', 'google/gemini-3-pro-preview', { name: 'Kilo Code', backendId: null }),
  ];
  const curated = curateModels(botRows, { now: () => NOW, scopeId: 'hermes-local@anvil' });
  assert.equal(curated[0].hidden, undefined);
  assert.equal(curated[1].hidden, true);
  assert.equal(curated[1].available, false);
});
