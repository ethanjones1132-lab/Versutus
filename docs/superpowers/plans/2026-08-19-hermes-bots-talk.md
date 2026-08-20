# Hermes Bots talk-to-existing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Chat tab opens a roster (configurable chat, then every Hermes Bot including `default`); tapping a Bot opens that profile's Bot Chat through multiplex, with parallel sessions on the same Bot.

**Architecture:** Hermes profiles on disk are the system of record. The Gate inventories them (listen keys only), fronts `GET /v1/bots`, and when `bot=<id>` is set on existing session/chat routes it rebinds the Hermes backend to `/p/<id>/` with that Bot's listen key. The app does not treat a Bot as a backend.

**Tech Stack:** Gate Node (`node --test` in `gate/`), existing Hermes HTTP backend, Expo 57 / Jest for app pure layers. No new dependencies. No Python.

**Spec:** `docs/superpowers/specs/2026-08-19-hermes-bots-talk-design.md`

## Global Constraints

- After runtime succeeds, next work is New Agent → routines → `@mention` → group chats (ADR 0007). Do not start those here.
- A Bot is a Hermes profile. Codex/Claude/OpenCode are not Bots (ADR 0004).
- `bot` is a selector on the Hermes backend, not a virtual backend and not nested REST (ADR 0009).
- Read **only** `API_SERVER_KEY` from profile `.env`. Never copy provider keys, OAuth, messaging tokens, or SOUL (ADR 0006).
- `.env` remains the listen-key source of record. Do not write per-Bot keys into DPAPI. Re-read on inventory / `forBot`.
- Multiplex off: explicit error, **no** `config.yaml` write, **no** second Hermes process (ADR 0008).
- Never collapse `bot=default` to omitted `bot`. Never fall back `bot=researcher` to the unprefixed listener.
- `GET /v1/bots` must be in `isKnownAuthenticatedRoute` **and** use `resolveBackendFor('listBots')`, not `resolveBackend` (that 501'd skills onto claude-local once).
- Advertise and dispatch together. No Home tile over a dead command.
- Chat tab opens the roster; it does not resume last session (ADR 0010).
- Inventory the profile directories Hermes uses (`~/.hermes` + `~/.hermes/profiles/<id>`). Do not scrape `hermes profile list` table output (ADR 0002 rejected scraping CLI prose).
- App work: read https://docs.expo.dev/versions/v57.0.0/ first. Node tests do not prove the phone (gap audit §0).
- Commit messages explain *why* and name the failure they prevent. Work in `C:\Projects\Versutus`.
- After each Gate task: `cd gate && node --test "__tests__/<file>.test.mjs"`. After each app task: `npx jest <file> --runInBand`. `npx tsc --noEmit` on app tasks.

---

## File Structure

**New**

- `gate/core/cli-environments/hermes-profiles.mjs` — parse listen keys, list bots from a Hermes home
- `gate/__tests__/hermes-profiles.test.mjs`
- `src/lib/gateway/bots.ts` — roster rows, Bot Chat identity, public types
- `__tests__/bots-roster-test.ts`
- `src/components/chat/chat-roster.tsx` — Chat tab landing list

**Modified**

- `gate/core/cli-environments/backends/hermes.mjs` — `listBots()`, `forBot(id)`
- `gate/core/cli-environments/adapters/hermes.mjs` — `'bots'` capability; pass `profilesHome`
- `gate/core/server.mjs` — allowlist `/v1/bots`; handler; `bot` on session/chat routes
- `gate/core/manifest.mjs` — `endpoints.bots` when `backendCan('bots')`
- `gate/core/capabilities/gateway-methods.mjs` — `bots.list`
- `gate/__tests__/hermes-backend.test.mjs`
- `gate/__tests__/backend-routes.test.mjs`
- `gate/__tests__/manifest-capabilities-advertised.test.mjs`
- `src/lib/gateway/manifest-client.ts` — `bot` selector next to `backendId`
- `__tests__/manifest-client-test.ts`
- `src/lib/gateway/dashboard.ts` — Bots command + group def with `endpoints: ['bots']`
- `src/components/chat/chat-screen.tsx` — roster vs configurable vs Bot surface
- `src/components/chat/chat-header.tsx` — back-to-roster control when inside a Bot

**Not modified**

- Hermes Python. No `/api/bots`. No `runner.adapters`.
- `docs/handoff-phase7-bots-2026-08-19.md` (wrong object; leave as warning)

---

### Task 1: Inventory Hermes profiles from disk

**Files:**
- Create: `gate/core/cli-environments/hermes-profiles.mjs`
- Test: `gate/__tests__/hermes-profiles.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseListenKey(envText: string): string | null`
  - `parseDisplayName(yamlText: string): string | null`
  - `listHermesBots(hermesHome: string, io?: { readFile, readdir }): Promise<HermesBotRecord[]>`
  - `getHermesBot(hermesHome: string, id: string, io?): Promise<HermesBotRecord | null>`
  - `toPublicBot(record: HermesBotRecord): { id: string, displayName: string, routable: boolean }`
  - `type HermesBotRecord = { id: string, displayName: string, listenKey: string | null, home: string }`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/hermes-profiles.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/hermes-profiles.test.mjs`

Expected: FAIL — `Cannot find module` or export missing.

- [ ] **Step 3: Write minimal implementation**

Create `gate/core/cli-environments/hermes-profiles.mjs`:

```js
import { readdir as defaultReaddir, readFile as defaultReadFile } from 'node:fs/promises';
import { join } from 'node:path';

export function parseListenKey(envText) {
  if (typeof envText !== 'string') return null;
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== 'API_SERVER_KEY') continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

export function parseDisplayName(yamlText) {
  const match = typeof yamlText === 'string'
    ? /^\s*display_name:\s*(.+)\s*$/m.exec(yamlText)
    : null;
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || null;
}

export function toPublicBot(record) {
  return {
    id: record.id,
    displayName: record.displayName,
    routable: Boolean(record.listenKey),
  };
}

async function readText(path, readFile) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function botAt(id, home, readFile) {
  const envText = await readText(join(home, '.env'), readFile);
  const yamlText = await readText(join(home, 'profile.yaml'), readFile);
  return {
    id,
    displayName: parseDisplayName(yamlText) || id,
    listenKey: parseListenKey(envText),
    home,
  };
}

export async function listHermesBots(hermesHome, io = {}) {
  const readFile = io.readFile ?? defaultReadFile;
  const readdir = io.readdir ?? defaultReaddir;
  const bots = [await botAt('default', hermesHome, readFile)];
  let names = [];
  try {
    names = await readdir(join(hermesHome, 'profiles'), { withFileTypes: true });
  } catch {
    return bots;
  }
  for (const entry of names) {
    const name = entry.name ?? entry;
    const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : true;
    if (!isDir || name.startsWith('.')) continue;
    bots.push(await botAt(name, join(hermesHome, 'profiles', name), readFile));
  }
  return bots;
}

export async function getHermesBot(hermesHome, id, io = {}) {
  if (!id) return null;
  if (id === 'default') {
    const readFile = io.readFile ?? defaultReadFile;
    return botAt('default', hermesHome, readFile);
  }
  const bots = await listHermesBots(hermesHome, io);
  return bots.find((bot) => bot.id === id) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test __tests__/hermes-profiles.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/hermes-profiles.mjs gate/__tests__/hermes-profiles.test.mjs
git commit -m "feat(gate): inventory Hermes profiles without ingesting provider keys

A Bot is a Hermes profile on disk. Reading OPENAI_API_KEY or bot tokens
from .env would violate ADR 0006 / 0002. Parse API_SERVER_KEY only, and
always include default — skipping it hid the agent Desktop lists."
```

---

### Task 2: Prefix a Hermes backend for one Bot

**Files:**
- Modify: `gate/core/cli-environments/backends/hermes.mjs`
- Test: `gate/__tests__/hermes-backend.test.mjs`

**Interfaces:**
- Consumes: `createHermesBackend({ baseUrl, apiKey, fetchImpl, profilesHome })`
- Produces: `backend.forBot(botId): Promise<backend>` — same methods, `baseUrl` is `{root}/p/{botId}`, Authorization is that Bot's listen key. Throws `{ code: 'unknown_bot' }` or `{ code: 'bot_not_routable' }`.

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/hermes-backend.test.mjs`:

```js
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('forBot prefixes /p/<id>/ and uses that profile listen key, not the default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-listen\nOPENAI_API_KEY=sk-nope\n');

  const { calls, hermes } = backend();
  hermes.profilesHome = home;
  const scoped = await hermes.forBot('researcher');
  await scoped.listSessions();

  assert.equal(calls[0].url, 'http://h:8642/p/researcher/api/sessions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer res-listen');
});

test('forBot(default) still prefixes — omitted bot is the other door', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  const { calls, fetchImpl } = recordingFetch();
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl,
    profilesHome: home,
  });
  const scoped = await hermes.forBot('default');
  await scoped.listSessions();
  assert.equal(calls[0].url, 'http://h:8642/p/default/api/sessions');
});

test('forBot rejects unknown and unroutable bots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'silent'), { recursive: true });
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });
  await assert.rejects(() => hermes.forBot('nope'), (err) => err.code === 'unknown_bot');
  await assert.rejects(() => hermes.forBot('silent'), (err) => err.code === 'bot_not_routable');
});
```

Fix the first test: `backend()` does not set `profilesHome`. Use the explicit `createHermesBackend` form in all three tests (as in the second). Replace the first test's `{ calls, hermes } = backend(); hermes.profilesHome = home` with an explicit constructor.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/hermes-backend.test.mjs`

Expected: FAIL — `forBot` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `createHermesBackend`, accept `profilesHome`. After the returned object methods, add:

```js
async forBot(botId) {
  const { getHermesBot } = await import('../hermes-profiles.mjs');
  const record = await getHermesBot(profilesHome, botId);
  if (!record) {
    const error = new Error(`unknown bot "${botId}"`);
    error.code = 'unknown_bot';
    error.status = 404;
    throw error;
  }
  if (!record.listenKey) {
    const error = new Error(`bot "${botId}" has no API_SERVER_KEY`);
    error.code = 'bot_not_routable';
    error.status = 409;
    throw error;
  }
  return createHermesBackend({
    baseUrl: `${root}/p/${encodeURIComponent(botId)}`,
    apiKey: record.listenKey,
    fetchImpl,
    profilesHome,
  });
},
```

Pass `profilesHome` into `createHermesBackend({ baseUrl, apiKey, fetchImpl = fetch, profilesHome } = {})`. Default `profilesHome` is only used when provided; `forBot` without it throws `bot_not_routable`/`unknown_bot` via `getHermesBot(undefined)` — instead require `profilesHome` when `forBot` is called:

```js
if (!profilesHome) {
  const error = new Error('Hermes home is not configured');
  error.code = 'unknown_bot';
  throw error;
}
```

Adapter (`adapters/hermes.mjs` `createBackend`): pass `profilesHome: join(homedir(), '.hermes')` from `node:os` / `node:path`. Do not pass it from credentials.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test __tests__/hermes-backend.test.mjs`

Expected: PASS (existing tests still pass; new ones pass).

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/backends/hermes.mjs gate/core/cli-environments/adapters/hermes.mjs gate/__tests__/hermes-backend.test.mjs
git commit -m "feat(gate): scope Hermes HTTP to /p/<bot>/ with that listen key

Omitted bot is configurable chat on the unprefixed listener. bot=default
must still prefix or the two doors collapse (ADR 0013). Using the default
API_SERVER_KEY on a named prefix is the July 2026 auth break."
```

---

### Task 3: `listBots()` on the Hermes backend

**Files:**
- Modify: `gate/core/cli-environments/backends/hermes.mjs`
- Test: `gate/__tests__/hermes-backend.test.mjs`

**Interfaces:**
- Consumes: `listHermesBots`, `toPublicBot`
- Produces: `backend.listBots(): Promise<{ object: 'list', data: PublicBot[] }>` — no listen keys in `data`

- [ ] **Step 1: Write the failing test**

```js
test('listBots returns every profile including default and never leaks listen keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-nope\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });
  const body = await hermes.listBots();
  assert.equal(body.object, 'list');
  const ids = body.data.map((row) => row.id);
  assert.ok(ids.includes('default'));
  assert.ok(ids.includes('researcher'));
  assert.equal(body.data.find((row) => row.id === 'researcher').routable, true);
  assert.equal(JSON.stringify(body).includes('res-listen'), false);
  assert.equal(JSON.stringify(body).includes('sk-nope'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/hermes-backend.test.mjs`

Expected: FAIL — `listBots` is not a function.

- [ ] **Step 3: Write minimal implementation**

```js
async listBots() {
  const { listHermesBots, toPublicBot } = await import('../hermes-profiles.mjs');
  if (!profilesHome) return { object: 'list', data: [] };
  const records = await listHermesBots(profilesHome);
  return { object: 'list', data: records.map(toPublicBot) };
},
```

Prefer static imports at top of `hermes.mjs` instead of dynamic import (same module as Task 2). Use static `import { listHermesBots, getHermesBot, toPublicBot } from '../hermes-profiles.mjs';` and delete the dynamic imports from Task 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test __tests__/hermes-backend.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/backends/hermes.mjs gate/__tests__/hermes-backend.test.mjs
git commit -m "feat(gate): list Hermes bots without a Python /api/bots

The Phase 7 handoff enumerated runner.adapters (channels). Bots are
profiles. Listing ~/.hermes keeps the app's source of truth in this repo
and never round-trips listen keys to the phone."
```

---

### Task 4: Front `GET /v1/bots` (allowlist + resolveBackendFor + manifest)

**Files:**
- Modify: `gate/core/cli-environments/adapters/hermes.mjs` (add `'bots'` to `capabilities`)
- Modify: `gate/core/manifest.mjs` (`endpoints.bots` when `backendCan('bots')`)
- Modify: `gate/core/server.mjs` (allowlist + handler)
- Modify: `gate/__tests__/backend-routes.test.mjs`
- Modify: `gate/__tests__/manifest-capabilities-advertised.test.mjs`

**Interfaces:**
- Consumes: `backend.listBots()`
- Produces: `GET /v1/bots` → `{ object: 'list', data: PublicBot[] }`; `manifest.endpoints.bots === '/v1/bots'`

- [ ] **Step 1: Write the failing tests**

In `stubFrontedRegistry` (backend-routes.test.mjs), add `'bots'` to capabilities and:

```js
async listBots() { calls.push('listBots'); return { object: 'list', data: [{ id: 'researcher', displayName: 'researcher', routable: true }] }; },
```

New tests:

```js
test('GET /v1/bots is allowlisted and resolved by method, not attachment order', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, 'researcher');
    assert.ok(calls.includes('listBots'));
  } finally {
    await gate.close();
  }
});

test('GET /v1/bots 501s when no backend implements listBots', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, 'backend_unsupported');
  } finally {
    await gate.close();
  }
});
```

Add to `CAPABILITY_BACKING` in `manifest-capabilities-advertised.test.mjs` **only when** you also advertise a boolean capability. This slice advertises an **endpoint**, not `capabilities.bots: true`, unless you add the boolean. Add:

```js
...(backendCan('bots') ? { bots: '/v1/bots' } : {}),
```

in `manifest.mjs` `endpoints` only. Do **not** set `capabilities.bots: true` unless `CAPABILITY_BACKING` gains `bots: 'bots'`. Prefer endpoint-only (skills pattern uses both endpoint and, for cron, a boolean). Follow skills: endpoint `bots` only is enough for the Chat tab. Add `CAPABILITY_BACKING` entry only if you add `capabilities.bots`. **Do not add the boolean** in this task — the Chat tab will fetch `/v1/bots` when the endpoint exists. Manifest-client must expose `endpoints.bots`.

Extend the advertised-when-backend-present test:

```js
assert.equal(manifest.endpoints.bots, '/v1/bots');
```

in the stubFrontedRegistry manifest test (add `'bots'` to that stub's capabilities, already done).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs`

Expected: FAIL — 404 on `/v1/bots` (allowlist) or 501.

- [ ] **Step 3: Write minimal implementation**

1. `adapters/hermes.mjs` capabilities array: add `'bots'` next to `'cron'`. Comment: declared so `backendCan('bots')` advertises the inventory endpoint.
2. `manifest.mjs` endpoints: `...(backendCan('bots') ? { bots: '/v1/bots' } : {}),`
3. `server.mjs` `isKnownAuthenticatedRoute`: `(pathname === '/v1/bots' && method === 'GET') ||`
4. Handler beside skills:

```js
if (pathname === '/v1/bots' && method === 'GET') {
  const backend = await resolveBackendFor('listBots');
  if (!backend) return;
  res.writeHead(200);
  res.end(JSON.stringify(await backend.listBots()));
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs __tests__/manifest-capabilities-advertised.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/adapters/hermes.mjs gate/core/manifest.mjs gate/core/server.mjs gate/__tests__/backend-routes.test.mjs gate/__tests__/manifest-capabilities-advertised.test.mjs
git commit -m "feat(gate): front GET /v1/bots via resolveBackendFor

A handler without an allowlist entry 404s 180 lines earlier. Resolving by
attachment order 501s on claude-local while hermes-local can serve it —
that already shipped once (b88c336). Method resolve is the check."
```

---

### Task 5: `bots.list` RPC (advertise and dispatch together)

**Files:**
- Modify: `gate/core/capabilities/gateway-methods.mjs`
- Modify: `src/lib/gateway/dashboard.ts`
- Test: `gate/__tests__/capabilities-rpc-route.test.mjs` or extend backend-routes if RPC tests live there
- Test: existing dashboard/command tests if they snapshot method names

**Interfaces:**
- Consumes: `listBots()`
- Produces: RPC method `bots.list`; dashboard command `id: 'bots'` with `method: 'bots.list'`

- [ ] **Step 1: Write the failing test**

If there is a gateway-methods unit test, add `bots.list`. Otherwise in a Gate RPC test against `stubFrontedRegistry`:

```js
test('bots.list dispatches to listBots', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { ...auth(gate), 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'bots.list' }),
    });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('listBots'));
  } finally {
    await gate.close();
  }
});
```

Add dashboard command (so the method is not an orphan). In `dashboard.ts` command list, after channels or in a `Bots` group:

```ts
{
  id: 'bots',
  label: 'Bots',
  group: 'Bots',
  transport: 'rpc',
  method: 'bots.list',
  params: {},
  requiredScope: 'operator.read',
  danger: 'safe',
  slash: '/bots',
  description: 'List Hermes bots',
},
```

Group def:

```ts
{ id: 'bots', label: 'Bots', endpoints: ['bots'], commandGroups: ['Bots'] },
```

Do not add a group without the command, and do not add the command without `method`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs`

Expected: FAIL — `unknown_method` for `bots.list`.

- [ ] **Step 3: Write minimal implementation**

In `createGatewayMethods`:

```js
'bots.list': (params) => via(getBackend, params, 'listBots', (b) => b.listBots()),
```

Add the dashboard command and group def from Step 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs`

Run: `npx jest __tests__/capability-snapshot-test.ts --runInBand`

Expected: PASS (update snapshot tests if a new group appears as undeclared/not-offered). If `capability-snapshot-test.ts` asserts exact group counts, update it: `bots` should match `endpoints.bots` and be ready when that key is present.

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/gateway-methods.mjs src/lib/gateway/dashboard.ts gate/__tests__/backend-routes.test.mjs __tests__/capability-snapshot-test.ts
git commit -m "feat(gate): dispatch bots.list over the same listBots passthrough

Advertised-without-dispatch is the tools:true trap. One method table
feeds both the slash command and the Chat roster's fetch."
```

---

### Task 6: Session and chat routes honor `bot=`

**Files:**
- Modify: `gate/core/server.mjs`
- Test: `gate/__tests__/backend-routes.test.mjs`

**Interfaces:**
- Consumes: `backend.forBot(botId)`
- Produces: `resolveConversationBackend()` used by GET/POST `/v1/sessions`, session messages, `/v1/chat/completions` when `bot` is present (query or body)

Error map:

- `unknown_bot` → 404 `{ code: 'unknown_bot' }`
- `bot_not_routable` → 409 `{ code: 'bot_not_routable' }`
- prefixed call HTTP 404 on `/health` probe (see below) → 501 `{ code: 'multiplex_disabled', message: 'Enable multiplex on the host: set gateway.multiplex_profiles true' }`

- [ ] **Step 1: Write the failing tests**

Extend the hermes-like stub with `forBot`:

```js
async forBot(botId) {
  calls.push(`forBot:${botId}`);
  if (botId === 'nope') {
    const error = new Error('unknown');
    error.code = 'unknown_bot';
    throw error;
  }
  if (botId === 'silent') {
    const error = new Error('no key');
    error.code = 'bot_not_routable';
    throw error;
  }
  return {
    async listSessions() { calls.push(`listSessions:${botId}`); return [{ ...SESSION, title: 'Bot Chat' }]; },
    async createSession(input) { calls.push(`createSession:${botId}:${input?.title}`); return { ...SESSION, title: input?.title ?? 'Bot Chat' }; },
    async listMessages() { return []; },
    async sendMessage() { return { text: 'ok', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }; },
  };
},
```

Tests:

```js
test('GET /v1/sessions?bot=researcher uses forBot, not the unprefixed backend', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(
      `http://127.0.0.1:${gate.port}/v1/sessions?backendId=stub-local&bot=researcher`,
      { headers: auth(gate) },
    );
    assert.equal(response.status, 200);
    assert.ok(calls.includes('forBot:researcher'));
    assert.ok(calls.includes('listSessions:researcher'));
  } finally {
    await gate.close();
  }
});

test('bot=default still calls forBot(default)', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=default`, { headers: auth(gate) });
    assert.ok(calls.includes('forBot:default'));
  } finally {
    await gate.close();
  }
});

test('unknown bot is 404, unroutable is 409', async () => {
  const { gate } = await makeGate({ calls: [], registry: stubFrontedRegistry([]) });
  try {
    const unknown = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=nope`, { headers: auth(gate) });
    assert.equal(unknown.status, 404);
    const silent = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=silent`, { headers: auth(gate) });
    assert.equal(silent.status, 409);
  } finally {
    await gate.close();
  }
});
```

Add a POST `/v1/sessions` test with `{ backendId, bot, title: 'scratch' }` that `createSession`s on the scoped backend.

Note: `makeGate` stub environment id may not be `stub-local`. Read `makeGate` in this file and use the actual environment id in `backendId=` (existing tests use `stub-local` — match them).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs`

Expected: FAIL — `bot` ignored, `forBot` never called.

- [ ] **Step 3: Write minimal implementation**

In `server.mjs` next to `resolveBackendFor`:

```js
function readBotId(url, body) {
  return url.searchParams.get('bot') || body?.bot || undefined;
}

async function resolveConversationBackend(backendId, botId) {
  const backend = await resolveBackend(backendId);
  if (!backend) return null;
  if (!botId) return backend;
  if (typeof backend.forBot !== 'function') {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'This backend does not implement bots', code: 'backend_unsupported' },
    }));
    return null;
  }
  try {
    return await backend.forBot(botId);
  } catch (error) {
    const code = error.code ?? 'backend_unsupported';
    const status = code === 'unknown_bot' ? 404 : code === 'bot_not_routable' ? 409 : 501;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, code } }));
    return null;
  }
}
```

Replace session GET/POST, session messages, session delete, and the `body.backendId` branch of `/v1/chat/completions` to use `resolveConversationBackend(..., readBotId(url, body))` instead of `resolveBackend`.

Do **not** apply `bot=` to `/v1/skills`, jobs, or models in this slice unless a test requires it — conversation routes only.

Multiplex probe: if `forBot` listSessions throws status 404 on the first prefixed call, map to `multiplex_disabled` in `hermes.mjs` `call()` when `root` contains `/p/`. Add a hermes-backend test: prefixed 404 → error.code `multiplex_disabled`. Keep it in this task if cheap; otherwise a follow-up assertion in Task 2's `call()`:

When `root` includes `/p/` and `response.status === 404` and path is the first request, still prefer mapping only `/health` probe. Simplest honest version: in `forBot`, after building the scoped backend, `GET /health` (which becomes `/p/id/health`). If 404, throw `multiplex_disabled`. Add that probe to `forBot` and one backend test with fetch returning `{ ok: false, status: 404 }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs __tests__/hermes-backend.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/server.mjs gate/core/cli-environments/backends/hermes.mjs gate/__tests__/backend-routes.test.mjs gate/__tests__/hermes-backend.test.mjs
git commit -m "feat(gate): route bot-scoped sessions through forBot

Falling back to the unprefixed listener would mix Researcher tokens
into the default home. unknown_bot must 404, not silently chat as
default. multiplex off must not write config.yaml."
```

---

### Task 7: Manifest client `bot` selector

**Files:**
- Modify: `src/lib/gateway/manifest-client.ts`
- Test: `__tests__/manifest-client-test.ts`

**Interfaces:**
- Consumes: existing `withBackend`
- Produces:
  - `get botId(): string | undefined`
  - `setBotId(id: string | undefined): void`
  - `listBots(): Promise<{ id: string, displayName: string, routable: boolean }[]>`
  - session/chat methods append `bot=` when `botId` is set (query and POST body)

Read https://docs.expo.dev/versions/v57.0.0/ before this task (app client).

- [ ] **Step 1: Write the failing test**

In `__tests__/manifest-client-test.ts` inside `ManifestClient sessions and runs when advertised`:

```ts
test('getSessions appends bot= when a bot is selected', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ object: 'list', data: [] }),
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  const client = clientWithEndpoints({ health: '/health', sessions: '/v1/sessions' });
  client.setBotId('researcher');
  await client.getSessions(10);
  expect(String(fetchMock.mock.calls[0][0])).toContain('bot=researcher');
});

test('createSession posts bot in the body', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: 's2' }),
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  const client = clientWithEndpoints({ health: '/health', sessions: '/v1/sessions' });
  client.setBotId('default');
  await client.createSession('notes');
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.bot).toBe('default');
});

test('listBots GETs endpoints.bots and does not resume a session', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      object: 'list',
      data: [{ id: 'default', displayName: 'Harumesu', routable: true }],
    }),
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  const client = clientWithEndpoints({ health: '/health', bots: '/v1/bots' });
  const bots = await client.listBots();
  expect(bots[0].id).toBe('default');
  expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/bots');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/manifest-client-test.ts --runInBand`

Expected: FAIL — `setBotId` / `listBots` missing.

- [ ] **Step 3: Write minimal implementation**

Mirror `backendId`:

```ts
private selectedBotId: string | undefined;

get botId(): string | undefined {
  return this.selectedBotId;
}

setBotId(id: string | undefined) {
  this.selectedBotId = id || undefined;
}

private withBot(path: string): string {
  const botId = this.botId;
  if (!botId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}bot=${encodeURIComponent(botId)}`;
}
```

Use `this.withBot(this.withBackend(...))` on GET session/message paths. Add `bot: this.botId` to `createSession` and chat POST bodies when set.

```ts
async listBots(): Promise<Array<{ id: string; displayName: string; routable: boolean }>> {
  const path = this.endpoints.bots;
  if (!path) return [];
  const result = await this.rootTransport.request<{ data?: Array<{ id: string; displayName: string; routable: boolean }> }>(
    'GET',
    this.withBackend(path),
  );
  return result.data ?? [];
}
```

Empty list when the endpoint is absent — configurable chat still works.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/manifest-client-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/manifest-client.ts __tests__/manifest-client-test.ts
git commit -m "feat(app): thread bot= next to backendId on session routes

backendId is the runtime. bot is the Hermes profile. Mixing them into
one field would make Codex look like a Bot and drop multiplex routing."
```

---

### Task 8: Roster model and Bot Chat identity

**Files:**
- Create: `src/lib/gateway/bots.ts`
- Test: `__tests__/bots-roster-test.ts`

**Interfaces:**
- Consumes: public bot list from the Gate
- Produces:
  - `BOT_CHAT_TITLE = 'Bot Chat'`
  - `buildRoster(bots: PublicBot[]): RosterRow[]` — `{ kind: 'configurable' }` first, then one `{ kind: 'bot', bot }` per item including `default`
  - `findBotChat<T extends { title?: string | null }>(sessions: T[]): T | undefined`
  - `isBotChat(session: { title?: string | null }): boolean`

Hermes Desktop pins a session titled `Bot Chat`. Derive that string; do not invent a Versutus-only title.

- [ ] **Step 1: Write the failing test**

```ts
import { BOT_CHAT_TITLE, buildRoster, findBotChat, isBotChat } from '@/lib/gateway/bots';

test('roster is configurable chat first, then every bot including default', () => {
  const rows = buildRoster([
    { id: 'default', displayName: 'Harumesu', routable: true },
    { id: 'researcher', displayName: 'researcher', routable: true },
  ]);
  expect(rows[0]).toEqual({ kind: 'configurable' });
  expect(rows[1]).toEqual({
    kind: 'bot',
    bot: { id: 'default', displayName: 'Harumesu', routable: true },
  });
  expect(rows[2].kind).toBe('bot');
});

test('findBotChat picks the canonical title, not the last session', () => {
  const sessions = [
    { id: 's1', title: 'yesterday' },
    { id: 's2', title: BOT_CHAT_TITLE },
    { id: 's3', title: 'notes' },
  ];
  expect(findBotChat(sessions)?.id).toBe('s2');
  expect(isBotChat({ title: BOT_CHAT_TITLE })).toBe(true);
  expect(isBotChat({ title: 'notes' })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
export const BOT_CHAT_TITLE = 'Bot Chat';

export type PublicBot = { id: string; displayName: string; routable: boolean };

export type RosterRow =
  | { kind: 'configurable' }
  | { kind: 'bot'; bot: PublicBot };

export function buildRoster(bots: PublicBot[]): RosterRow[] {
  return [{ kind: 'configurable' }, ...bots.map((bot) => ({ kind: 'bot' as const, bot }))];
}

export function isBotChat(session: { title?: string | null }): boolean {
  return session.title === BOT_CHAT_TITLE;
}

export function findBotChat<T extends { title?: string | null }>(sessions: T[]): T | undefined {
  return sessions.find((session) => isBotChat(session));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/bots.ts __tests__/bots-roster-test.ts
git commit -m "feat(app): roster puts configurable chat above every Bot including default

Auto-opening last night's thread is what ADR 0010 forbids. Skipping
default hid the Bot Mode door (ADR 0013). Bot Chat is a title we
derive from Desktop, not a new session type."
```

---

### Task 9: Chat tab opens the roster

**Files:**
- Create: `src/components/chat/chat-roster.tsx`
- Modify: `src/components/chat/chat-screen.tsx`
- Modify: `src/components/chat/chat-header.tsx` (optional back affordance)

**Interfaces:**
- Consumes: `buildRoster`, `client.listBots()`, `ChatRosterProps`
- Produces: Chat tab surface `'roster' | 'configurable' | { botId: string }`. Mount surface is `'roster'`. Choosing configurable renders today's composer. Choosing a Bot is Task 10.

Read Expo SDK 57 docs for any new UI primitives; prefer existing `ListRow`, `EmptyState`, `Screen`.

- [ ] **Step 1: Write a pure-failing assertion already covered** — Task 8 guarantees order. For this task, keep ChatScreen's initial surface as roster by extracting:

```ts
export type ChatSurface = { kind: 'roster' } | { kind: 'configurable' } | { kind: 'bot'; botId: string };
```

in `src/lib/gateway/bots.ts` (add to Task 8 file) and a tiny test:

```ts
test('the tab starts on the roster, not a session', () => {
  const initial: ChatSurface = { kind: 'roster' };
  expect(initial.kind).toBe('roster');
});
```

That is documentation-as-test. The implementation is the screen.

- [ ] **Step 2: Implement `ChatRoster`**

`src/components/chat/chat-roster.tsx`:

- Props: `rows: RosterRow[]`, `loading: boolean`, `error?: string`, `onSelectConfigurable: () => void`, `onSelectBot: (bot: PublicBot) => void`
- First `ListRow` title `Chat`, caption `Model, sessions, and backend` → `onSelectConfigurable`
- Each bot: title `bot.displayName`, caption `bot.routable ? 'Bot' : 'No listen key'`, disabled if `!bot.routable`, `onSelectBot`
- `EmptyState` if `rows.length === 1` (only configurable) and not loading — Bots empty is OK; still show Chat row
- Do not call `reloadHistory` here

Wire `ChatScreen`:

```ts
const [surface, setSurface] = useState<ChatSurface>({ kind: 'roster' });
const [rosterRows, setRosterRows] = useState<RosterRow[]>([{ kind: 'configurable' }]);
```

On mount / when `surface.kind === 'roster'`, `client.listBots()` → `buildRoster`. Do **not** load the transcript until surface is configurable or bot.

When `surface.kind === 'roster'`, render `ChatRoster` instead of the message list/composer. Keep pairing/error chrome.

Configurable: `setSurface({ kind: 'configurable' }); client.setBotId(undefined);` then existing chat.

Header: when surface is not roster, a control that `setSurface({ kind: 'roster' })` and `client.setBotId(undefined)` — back to roster, do not destroy sessions.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

Fix `GatewayCommand['group']` if `'Bots'` is not in the union — add `'Bots'` to the group union in `dashboard.ts`.

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/bots.ts src/components/chat/chat-roster.tsx src/components/chat/chat-screen.tsx src/components/chat/chat-header.tsx
git commit -m "feat(app): Chat tab lands on the roster instead of last session

Opening the tab into last night's thread is the behavior this slice
exists to kill (ADR 0010). Configurable chat stays one tap; Bots sit
under it."
```

---

### Task 10: Tap a Bot opens Bot Chat

**Files:**
- Modify: `src/components/chat/chat-screen.tsx`
- Modify: `src/lib/gateway/bots.ts` if a helper helps
- Test: `__tests__/bots-roster-test.ts` for ensure helper

**Interfaces:**
- Consumes: `setBotId`, `getSessions`, `createSession`, `findBotChat`, `BOT_CHAT_TITLE`
- Produces: `ensureBotChat(sessions, create): Promise<session>` — return existing Bot Chat or `create(BOT_CHAT_TITLE)`

- [ ] **Step 1: Write the failing test**

```ts
import { BOT_CHAT_TITLE, ensureBotChat, findBotChat } from '@/lib/gateway/bots';

test('ensureBotChat reuses the canonical session and does not create a second', async () => {
  const created: string[] = [];
  const existing = [{ id: 's2', title: BOT_CHAT_TITLE }];
  const session = await ensureBotChat(existing, async (title) => {
    created.push(title);
    return { id: 'new', title };
  });
  expect(session.id).toBe('s2');
  expect(created).toEqual([]);
});

test('ensureBotChat creates Bot Chat when missing', async () => {
  const session = await ensureBotChat([{ id: 's1', title: 'notes' }], async (title) => ({ id: 'new', title }));
  expect(session.title).toBe(BOT_CHAT_TITLE);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Expected: FAIL — `ensureBotChat` missing.

- [ ] **Step 3: Implement helper and wire tap**

```ts
export async function ensureBotChat<T extends { title?: string | null }>(
  sessions: T[],
  create: (title: string) => Promise<T>,
): Promise<T> {
  return findBotChat(sessions) ?? create(BOT_CHAT_TITLE);
}
```

On `onSelectBot(bot)`:

1. If `!bot.routable`, do nothing (row disabled).
2. `client.setBotId(bot.id)`
3. `const sessions = await client.getSessions(200)` (or existing loader)
4. `const chat = await ensureBotChat(sessions, (title) => client.createSession(title))`
5. Switch the provider's current session to `chat.id` the same way the session selector does today (find `selectSession` / `setCurrentSessionId` on `useGateway` — use that, do not invent a second store).
6. `setSurface({ kind: 'bot', botId: bot.id })`

If create fails, stay on roster and set `lastError`.

Session chip inside a Bot opens the existing `SessionSelectorSheet` filtered to current `getSessions()` (already bot-scoped once `botId` is set).

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/bots-roster-test.ts --runInBand`

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/bots.ts src/components/chat/chat-screen.tsx __tests__/bots-roster-test.ts
git commit -m "feat(app): tapping a Bot opens Bot Chat, not last session

Last-session-on-that-profile is ADR 0012 option C, which we rejected.
Missing Bot Chat is created and pinned by title, matching Desktop."
```

---

### Task 11: New session on a Bot stays on that Bot

**Files:**
- Modify: `src/components/chat/chat-screen.tsx` (session create path)
- Test: `__tests__/manifest-client-test.ts` already covers `createSession` body. Add:

**Interfaces:**
- Consumes: `botId` still set while inside `{ kind: 'bot' }`
- Produces: New session from the session sheet calls `createSession` **without** using `BOT_CHAT_TITLE` (user title or `undefined`). `setBotId` is not cleared. `/new` inside Bot Chat is **not** wired to replace Bot Chat in this slice.

- [ ] **Step 1: Write the failing test**

```ts
test('createSession from a Bot does not clear botId', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: 's9', title: 'scratch' }),
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  const client = clientWithEndpoints({ health: '/health', sessions: '/v1/sessions' });
  client.setBotId('researcher');
  await client.createSession('scratch');
  expect(client.botId).toBe('researcher');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).bot).toBe('researcher');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).title).toBe('scratch');
});
```

- [ ] **Step 2: Run test to verify it fails** — should already PASS if Task 7 did not clear `botId`. If createSession clears it, FAIL.

- [ ] **Step 3: Wire the session sheet**

The existing "new session" control in Chat overflow / session selector must run while `surface.kind === 'bot'` without `setBotId(undefined)`. Do not pass `BOT_CHAT_TITLE` as the new title.

If `/new` slash currently forks the current session, **do not** change it to compact in this slice; also do not let it rename Bot Chat. If the slash goes through `createSession`, that is a dedicated session (allowed). If it resets in place, leave it — compact is next-work.

Header session chip: when `isBotChat(currentSession)`, label is `Bot Chat` (the constant).

- [ ] **Step 4: Run tests + tsc**

Run: `npx jest __tests__/manifest-client-test.ts __tests__/bots-roster-test.ts --runInBand`

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/manifest-client.ts src/components/chat/chat-screen.tsx __tests__/manifest-client-test.ts
git commit -m "feat(app): parallel sessions on a Bot keep bot=

A new thread on Researcher must not drop multiplex and land in default
home. Bot Chat stays the canonical row; scratch sessions are extra."
```

---

### Task 12: Verify the slice

**Files:** none required unless tests failed

- [ ] **Step 1: Full Gate + Jest**

Run: `cd gate && node --test "__tests__/*.test.mjs"`

Run: `npx jest --runInBand __tests__/bots-roster-test.ts __tests__/manifest-client-test.ts __tests__/capability-snapshot-test.ts`

Run: `npx tsc --noEmit`

- [ ] **Step 2: `npm run verify`**

Expected: green (or only pre-existing failures unrelated to this slice — do not expand scope).

- [ ] **Step 3: Live against Hermes (operator)**

Restart Gate: `node gate/cli.mjs start` (no hot reload). Confirm:

- Chat tab = roster, not last transcript
- Configurable chat still models/sessions/backend
- Desktop named profiles appear; `default` appears as a Bot
- Tap Researcher → session titled `Bot Chat`
- New session on Researcher is a second thread; returning to roster does not auto-open it
- Configurable chat and `default` Bot both work and stay different
- Listen keys never appear in `GET /v1/bots` JSON

Device: one real pass on the Chat tab before claiming done (SSE `body` class).

- [ ] **Step 4: Commit only if Step 2 produced fixes**

If verify forced a small fix, commit that fix with a message naming the failure. Do not commit secrets or `.tokens.json`.

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| Inventory including `default`, listen key only | 1, 3 |
| `GET /v1/bots` allowlisted, `resolveBackendFor` | 4 |
| `bots.list` with advertisement | 5 |
| `bot=` on session/chat, `bot=default` prefixed | 2, 6 |
| unknown 404, unroutable 409, multiplex fail-closed | 6 |
| Roster, no auto-resume | 8, 9 |
| Duplicate default Bot + configurable chat | 8, 9 |
| Tap → Bot Chat | 10 |
| Parallel sessions keep `bot=` | 11 |
| No Python `/api/bots`, no virtual backends, no config.yaml write | constraints + 3, 6 |
| Device/live | 12 |
| Next work not in this plan | Global constraints |

No TBD. `forBot` / `listBots` / `setBotId` / `ensureBotChat` names are stable across tasks.
