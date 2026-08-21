# Hermes Bots create-and-collaborate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After slice 1 talk-to-existing, add in-session Bot model changes, New Agent from the phone, a routines pane, `@mention` handoff, and group rooms.

**Architecture:** Same as slice 1: Bot = Hermes profile, `backendId` + `bot=<id>`. Model picks for a Bot live in `botModels[botId]` (ADR 0014). New Agent is bounded `hermes profile create` plus SOUL/listen-key/pin writes (ADR 0015). Routines are existing jobs via `forBot`. Mentions post to the mentioned Bot's Bot Chat. Groups are Gate-owned roster rows that fan out onto `Group: <name>` sessions.

**Tech Stack:** Gate Node (`node --test` in `gate/`), Expo 57 / Jest. No new dependencies. No Python. No dashboard :9119.

**Spec:** `docs/superpowers/specs/2026-08-21-hermes-bots-create-and-collaborate-design.md`

## Global Constraints

- Order is mandatory (ADR 0007 + this spec): **Bot model in session → New Agent → routines → `@mention` → groups.** Do not start a later phase before the previous phase's tests pass.
- A Bot is a Hermes profile. Codex/Claude/OpenCode are not Bots (ADR 0004).
- `bot` is a selector on the Hermes backend, not a virtual backend (ADR 0009).
- Read **only** `API_SERVER_KEY` from `.env`. Never copy provider keys (ADR 0006). After `--clone-from`, **rotate** the new profile's listen key so it is not the default key.
- Multiplex off: fail honestly; no `config.yaml` multiplex write (ADR 0008). The only allowed `hermes config set` is New Agent's model pin on the **new** profile.
- `resolveBackendFor` for new routes, never position-based `resolveBackend`. Allowlist every new path.
- Advertise and dispatch together.
- Chat tab remains the roster (ADR 0010). `default` remains a Bot row (ADR 0013).
- App: https://docs.expo.dev/versions/v57.0.0/ before UI. Node does not prove the phone.
- Commit messages explain *why*. Work in `C:\Projects\Versutus`.
- After Gate tasks: `cd gate && node --test "__tests__/<file>.test.mjs"`. After app tasks: `npx jest <file> --runInBand`. `npx tsc --noEmit` on app tasks.
- `verify-config` `context-has-no-dead-state` fails if a context key is unused. Consume every new `useGateway` field.
- Every new RPC method needs `METHOD_TO_ROUTE` or `METHOD_GUIDANCE`.
- Qualified catalog ids are `providerId/modelId`. Store those in `botModels`. Do **not** write `gateway.providerId` on a Bot pick (that field is configurable-chat scoped).
- `getModels()` must `withScope` so a Bot picker sees `/p/<bot>/` catalogs (empty-key Bots otherwise show default's providers).
- Hermes `/v1/chat/completions` needs `provider` alongside `model` for a real override. `sendMessageStreaming` currently sends only `model.modelId` — that would make the in-session Bot picker a no-op.
- HTTP `createBackend({ baseUrl, credentials })` does not receive `record`. New Agent cannot spawn `hermes profile create` until `executablePath` is passed.
- `runCli` default timeout is 5s — too short for `profile create`. Inject 60s on create.
- Jobs today are GET list + run/pause/resume, unprefixed. Routines need POST create and `bot=` on every jobs path.
- Desktop Bot Mode groups live in a plugin. Gate-owned `bot-groups.json` will not appear in Hermes Desktop. That split is accepted, not a sync bug.

---

## File Structure

**New**

- `gate/core/cli-environments/hermes-bot-create.mjs` — name rules, create argv, listen-key ensure
- `gate/__tests__/hermes-bot-create.test.mjs`
- `src/lib/gateway/mentions.ts` — extract `@id` against the roster
- `__tests__/mentions-test.ts`
- `src/lib/gateway/routines.ts` — `[bot:<id>]` title helper
- `__tests__/routines-test.ts`
- `src/lib/gateway/groups.ts` — group session title, member caps, fan-out
- `__tests__/groups-test.ts`
- `gate/core/cli-environments/bot-groups.mjs` — Gate-home group store
- `src/components/chat/new-agent-sheet.tsx`
- `src/components/chat/routines-pane.tsx`
- `src/components/chat/group-room.tsx`

**Modified**

- `src/lib/gateway/types.ts` — `botModels?: Record<string, string>`
- `src/lib/gateway/model-selection.ts` — third `botId` argument
- `__tests__/model-selection-test.ts`
- `src/context/gateway-provider.tsx` — `selectModel` / `streamChat` use `effectiveModel(..., selectedBotId)`
- `src/components/chat/chat-screen.tsx` — model chip on Bot surface; New Agent; routines; mentions; groups
- `src/components/chat/chat-header.tsx` — model chip when `onModelPress` set
- `src/components/chat/chat-roster.tsx` — New Agent row; group rows
- `src/components/chat/chat-composer.tsx` — `@` suggestions
- `gate/core/cli-environments/backends/hermes.mjs` — `createBot`, `createJob` if missing, `forBot` already exists
- `gate/core/cli-environments/adapters/hermes.mjs` — pass `executablePath` + `record`
- `gate/core/cli-environments/backend-manager.mjs` — pass `record` into `createBackend`
- `gate/core/server.mjs` — `POST /v1/bots`, jobs + `bot=`, mention handoff, group routes
- `gate/core/manifest.mjs` — only if new endpoints
- `src/lib/gateway/manifest-client.ts` — `createBot`, `listJobs` with bot, groups

**Not modified**

- Hermes Python. Avatars. `runner.adapters`.

---

### Task 1: Bot-scoped `effectiveModel` / `withSelectedModel`

**Files:**
- Modify: `src/lib/gateway/types.ts` (`GatewayProfile`)
- Modify: `src/lib/gateway/model-selection.ts`
- Test: `__tests__/model-selection-test.ts`

**Interfaces:**
- Consumes: existing two-arg helpers
- Produces:
  - `GatewayProfile.botModels?: Record<string, string>`
  - `effectiveModel(gateway, selectedBackendId, selectedBotId?: string): string | undefined`
  - `withSelectedModel(gateway, modelId, selectedBackendId, selectedBotId?: string): T`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/model-selection-test.ts`:

```ts
describe('bot-scoped model', () => {
  it('prefers botModels when a bot is selected', () => {
    const profile = {
      ...BASE,
      model: 'gateway-default',
      backendModels: { 'hermes-local': 'hermes-default' },
      botModels: { researcher: 'anthropic/claude-opus' },
    };
    expect(effectiveModel(profile, 'hermes-local', 'researcher')).toBe('anthropic/claude-opus');
  });

  it('does not use botModels for configurable chat', () => {
    const profile = {
      ...BASE,
      backendModels: { 'hermes-local': 'hermes-default' },
      botModels: { researcher: 'anthropic/claude-opus' },
    };
    expect(effectiveModel(profile, 'hermes-local', undefined)).toBe('hermes-default');
  });

  it('withSelectedModel for a bot writes only botModels', () => {
    const next = withSelectedModel(BASE, 'x-ai/grok-4', 'hermes-local', 'researcher');
    expect(next.botModels).toEqual({ researcher: 'x-ai/grok-4' });
    expect(next.model).toBe('gateway-default');
    expect(next.backendModels).toBeUndefined();
  });

  it('withSelectedModel without a bot still writes backendModels and model', () => {
    const next = withSelectedModel(BASE, 'gpt-5.5', 'codex-local');
    expect(next.model).toBe('gpt-5.5');
    expect(next.backendModels).toEqual({ 'codex-local': 'gpt-5.5' });
    expect(next.botModels).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/model-selection-test.ts --runInBand`

Expected: FAIL — third argument ignored / `botModels` not written.

- [ ] **Step 3: Write minimal implementation**

In `types.ts` on `GatewayProfile`, after `backendModels`:

```ts
  /** Model remembered per Hermes Bot (profile id). Not a backend. */
  botModels?: Record<string, string>;
```

Replace `model-selection.ts` helpers:

```ts
type ModelBearing = Pick<GatewayProfile, 'model' | 'backendModels' | 'botModels'>;

export function effectiveModel(
  gateway: ModelBearing | null | undefined,
  selectedBackendId: string | undefined,
  selectedBotId?: string,
): string | undefined {
  if (!gateway) return undefined;
  if (selectedBotId) {
    const botRemembered = gateway.botModels?.[selectedBotId];
    if (botRemembered) return botRemembered;
  }
  if (selectedBackendId) {
    const remembered = gateway.backendModels?.[selectedBackendId];
    if (remembered) return remembered;
  }
  return gateway.model;
}

export function withSelectedModel<T extends ModelBearing>(
  gateway: T,
  modelId: string,
  selectedBackendId: string | undefined,
  selectedBotId?: string,
): T {
  if (selectedBotId) {
    return {
      ...gateway,
      botModels: { ...(gateway.botModels ?? {}), [selectedBotId]: modelId },
    };
  }
  if (!selectedBackendId) return { ...gateway, model: modelId };
  return {
    ...gateway,
    model: modelId,
    backendModels: { ...(gateway.backendModels ?? {}), [selectedBackendId]: modelId },
  };
}
```

Existing tests must keep passing: two-arg calls omit `selectedBotId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/model-selection-test.ts --runInBand`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/types.ts src/lib/gateway/model-selection.ts __tests__/model-selection-test.ts docs/adr/0014-bot-scoped-model-memory.md
git commit -m "feat(app): remember model per Bot without stealing configurable chat

backendModels is keyed by CLI environment. A Bot is a selector on Hermes
(ADR 0009). Writing gateway.model on a Bot pick would send Researcher's
model on the next configurable-chat turn."
```

---

### Task 2: Sends and `selectModel` honor `selectedBotId`

**Files:**
- Modify: `src/context/gateway-provider.tsx` (`selectModel` ~2204, `runAgentCommand` ~1324, `sendChatInput` streamChat ~1521, `selectBackend` restore ~1286)
- Test: extend `__tests__/model-selection-test.ts` is not enough — add a tiny pure wrapper if send paths cannot be unit-tested. Prefer extracting:

**Interfaces:**
- Consumes: `effectiveModel`, `withSelectedModel` from Task 1
- Produces: `selectModel` passes `selectedBotId`; streamChat `model:` is `effectiveModel(gateway, selectedBackendId, selectedBotId)`

- [ ] **Step 1: Write the failing test**

There is no provider unit test. Add `__tests__/model-send-test.ts` that only documents the send contract by re-exporting a helper from `model-selection.ts` (already Task 1). For this task, change `selectModel` / streamChat and add a comment-level test in `model-selection-test.ts` is wrong.

Instead add `resolveSendModel` in `model-selection.ts`:

```ts
export function resolveSendModel(
  gateway: ModelBearing | null | undefined,
  selectedBackendId: string | undefined,
  selectedBotId: string | undefined,
): { model?: string } {
  const model = effectiveModel(gateway, selectedBackendId, selectedBotId);
  return model ? { model } : {};
}
```

Test:

```ts
it('resolveSendModel uses the bot pick when selected', () => {
  const profile = { ...BASE, botModels: { researcher: 'x-ai/grok-4' }, model: 'other' };
  expect(resolveSendModel(profile, 'hermes-local', 'researcher')).toEqual({ model: 'x-ai/grok-4' });
  expect(resolveSendModel(profile, 'hermes-local', undefined)).toEqual({ model: 'other' });
});
```

Then production send sites use `resolveSendModel`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/model-selection-test.ts --runInBand`

Expected: FAIL — `resolveSendModel` missing.

- [ ] **Step 3: Implement helper and wire provider**

Add `resolveSendModel` as above.

`selectModel`:

```ts
const updated = {
  ...withSelectedModel(activeGateway, modelId, selectedBackendId, selectedBotId),
  providerId: providerId ?? activeGateway.providerId,
};
```

Add `selectedBotId` to that callback's dependency array.

Both `streamChat` option blocks:

```ts
...resolveSendModel(gateway, selectedBackendId, selectedBotId),
providerId: gateway.providerId,
```

`runAgentCommand` same. `selectBackend` restore stays `effectiveModel(activeGateway, backendId)` (no bot).

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/model-selection-test.ts --runInBand`

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/model-selection.ts src/context/gateway-provider.tsx __tests__/model-selection-test.ts
git commit -m "feat(app): Bot chat sends the Bot's remembered model

streamChat used gateway.model, so a Bot pick could not stay local to
that Bot. resolveSendModel is the single send-time read."
```

---

### Task 3: Model chip on the Bot surface

**Files:**
- Modify: `src/components/chat/chat-screen.tsx` (header `modelLabel` / `onModelPress` currently `surface.kind === 'configurable'` only)

**Interfaces:**
- Consumes: `openModelPicker`, `effectiveModel` via `activeGateway` + `selectedBotId`
- Produces: model chip when `surface.kind === 'bot' || surface.kind === 'configurable'`

- [ ] **Step 1: No new test file** — this is a one-line condition already covered by Task 1's memory. Implement.

In `chat-screen.tsx` compute:

```ts
const sendModel = effectiveModel(activeGateway, selectedBackendId, selectedBotId);
const modelLabel = sendModel ?? 'Default model';
```

Header:

```tsx
modelLabel={surface.kind === 'roster' ? undefined : modelLabel}
onModelPress={surface.kind === 'roster' ? undefined : () => openModelPicker('default')}
```

Do **not** show the backend picker on a Bot surface (keep current: configurable only).

Import `effectiveModel` from `@/lib/gateway/model-selection`. Use `selectedBotId` from `useGateway` (already destructured).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/chat-screen.tsx
git commit -m "feat(app): show the model picker inside a Bot session

Slice 1 hid the chip on Bot surfaces, so you could not change the
selected Bot model without dropping back to configurable chat."
```

---

### Task 4: Pure New Agent argv + name rules

**Files:**
- Create: `gate/core/cli-environments/hermes-bot-create.mjs`
- Test: `gate/__tests__/hermes-bot-create.test.mjs`

**Interfaces:**
- Produces:
  - `validateBotId(name: string): string | null` — returns the id or null if invalid
  - `createBotArgs(input: { name: string, inheritKeys: boolean, description?: string }): string[]`

Rules: id matches `/^[a-z0-9][a-z0-9_-]{0,62}$/i`, not `default`, not empty. Args are **only**:

`['profile', 'create', name, '--no-alias']` plus `'--clone-from', 'default'` when `inheritKeys`, plus `'--description', description` when provided. Never `--clone-all`. Never extra flags.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBotId, createBotArgs } from '../core/cli-environments/hermes-bot-create.mjs';

test('validateBotId accepts directory ids and rejects default', () => {
  assert.equal(validateBotId('researcher'), 'researcher');
  assert.equal(validateBotId('Default'), null);
  assert.equal(validateBotId('default'), null);
  assert.equal(validateBotId('has space'), null);
  assert.equal(validateBotId('../etc'), null);
});

test('createBotArgs is a fixed argv — inherit is clone-from default only', () => {
  assert.deepEqual(createBotArgs({ name: 'coder', inheritKeys: false }), [
    'profile', 'create', 'coder', '--no-alias',
  ]);
  assert.deepEqual(createBotArgs({ name: 'coder', inheritKeys: true, description: 'Writes patches' }), [
    'profile', 'create', 'coder', '--no-alias', '--clone-from', 'default', '--description', 'Writes patches',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/hermes-bot-create.test.mjs`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
export function validateBotId(name) {
  const id = typeof name === 'string' ? name.trim() : '';
  if (!id || id.toLowerCase() === 'default') return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(id)) return null;
  return id;
}

export function createBotArgs({ name, inheritKeys, description } = {}) {
  const id = validateBotId(name);
  if (!id) throw new Error('invalid bot name');
  const args = ['profile', 'create', id, '--no-alias'];
  if (inheritKeys) args.push('--clone-from', 'default');
  if (description) args.push('--description', String(description));
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test __tests__/hermes-bot-create.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/hermes-bot-create.mjs gate/__tests__/hermes-bot-create.test.mjs docs/adr/0015-new-agent-via-bounded-cli.md
git commit -m "feat(gate): bound New Agent to hermes profile create argv

Arbitrary CLI RPC is rejected (ADR 0002). --clone-all would copy
memory and crons; inherit is provider keys only via --clone-from default."
```

---

### Task 5: Distinct listen key after create

**Files:**
- Modify: `gate/core/cli-environments/hermes-bot-create.mjs`
- Modify: `gate/core/cli-environments/hermes-profiles.mjs` only if a write helper belongs there
- Test: `gate/__tests__/hermes-bot-create.test.mjs`

**Interfaces:**
- Produces: `ensureDistinctListenKey(envText: string, defaultKey: string | null): { envText: string, listenKey: string }`
  - If `API_SERVER_KEY` missing or equal to `defaultKey`, write a new 32-byte hex key.
  - Never insert `OPENAI_API_KEY` or other keys.
  - Preserve other existing lines.

- [ ] **Step 1: Write the failing test**

```js
import { randomBytes } from 'node:crypto';
import { ensureDistinctListenKey } from '../core/cli-environments/hermes-bot-create.mjs';

test('ensureDistinctListenKey adds a key on empty env without copying provider secrets', () => {
  const { envText, listenKey } = ensureDistinctListenKey('# comment\n', 'default-listen');
  assert.equal(listenKey.length, 64);
  assert.match(envText, /^API_SERVER_KEY=/m);
  assert.equal(envText.includes('OPENAI'), false);
});

test('ensureDistinctListenKey rotates a cloned default key', () => {
  const cloned = 'OPENAI_API_KEY=sk-keep\nAPI_SERVER_KEY=default-listen\n';
  const { envText, listenKey } = ensureDistinctListenKey(cloned, 'default-listen');
  assert.notEqual(listenKey, 'default-listen');
  assert.match(envText, /OPENAI_API_KEY=sk-keep/);
  assert.match(envText, new RegExp(`API_SERVER_KEY=${listenKey}`));
});

test('ensureDistinctListenKey keeps a unique existing key', () => {
  const { listenKey } = ensureDistinctListenKey('API_SERVER_KEY=already-unique\n', 'default-listen');
  assert.equal(listenKey, 'already-unique');
});
```

If 32-byte hex is 64 chars. Use `randomBytes(32).toString('hex')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/hermes-bot-create.test.mjs`

Expected: FAIL — export missing.

- [ ] **Step 3: Implement** using `node:crypto` `randomBytes`. Parse lines like `parseListenKey`. Replace or append `API_SERVER_KEY=`.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/hermes-bot-create.mjs gate/__tests__/hermes-bot-create.test.mjs
git commit -m "feat(gate): give each new Bot its own listen key

Named multiplex prefixes reject the default API_SERVER_KEY (July 2026).
Cloning default's .env would make /p/<name>/ 401. Rotate listen key;
leave provider keys untouched when inheriting."
```

---

### Task 6: `createBot` on the Hermes backend + `POST /v1/bots`

**Files:**
- Modify: `gate/core/cli-environments/backends/hermes.mjs`
- Modify: `gate/core/cli-environments/adapters/hermes.mjs` — pass `executablePath: record?.executable?.path`
- Modify: `gate/core/cli-environments/backend-manager.mjs` — `createBackend({ baseUrl, credentials, record })`
- Modify: `gate/core/server.mjs` — allowlist POST `/v1/bots`, handler
- Test: `gate/__tests__/hermes-backend.test.mjs` with injected `runCli` / `writeFile`
- Test: `gate/__tests__/backend-routes.test.mjs`

**Interfaces:**
- Consumes: `createBotArgs`, `validateBotId`, `ensureDistinctListenKey`, `runCli` from `adapters/shared.mjs` (inject `runCliImpl` on `createHermesBackend`)
- Produces: `backend.createBot({ name, soul, inheritKeys, description, modelId, providerId })` → public bot `{ id, displayName, routable: true }`

Sequence inside `createBot`:
1. `validateBotId`; throw `invalid_bot_name` if null; throw `bot_exists` if `getHermesBot` returns a record with a home that already has `config.yaml` or `.env` with more than a stub — simpler: if `getHermesBot` finds id and `home` directory exists with `config.yaml`.
2. `runCliImpl(executablePath, createBotArgs(...), { timeoutMs: 60000 })`. Non-zero code → throw with stderr.
3. Read new profile `.env`, `ensureDistinctListenKey` vs default profile's listen key, write `.env`.
4. If `soul` is a non-empty string, write `SOUL.md` (utf8). Do not write if omitted.
5. If `modelId`, `runCliImpl(executablePath, ['-p', id, 'config', 'set', 'model.default', modelId], { timeoutMs: 15000 })`. If `providerId`, also `['-p', id, 'config', 'set', 'model.provider', providerId]`.
6. Return `toPublicBot(await getHermesBot(profilesHome, id))`.

`createHermesBackend({ ..., executablePath, runCliImpl })`. Tests inject `runCliImpl` that records argv and writes a fake profile dir.

POST `/v1/bots` body: `{ name, soul?, inheritKeys?, description?, modelId?, providerId?, backendId? }`. `resolveBackendFor('createBot')`. 400 `invalid_bot_name`, 409 `bot_exists`.

- [ ] **Step 1: Write the failing backend test**

```js
test('createBot runs bounded profile create, rotates listen key, writes soul', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
  const argvLog = [];
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args) => {
      argvLog.push(args);
      if (args[0] === 'profile' && args[1] === 'create') {
        const id = args[2];
        await mkdir(join(home, 'profiles', id), { recursive: true });
        await writeFile(join(home, 'profiles', id, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const bot = await hermes.createBot({
    name: 'coder',
    inheritKeys: true,
    soul: 'You are a focused coding assistant.',
    modelId: 'anthropic/claude-sonnet-4',
  });
  assert.equal(bot.id, 'coder');
  assert.equal(bot.routable, true);
  assert.deepEqual(argvLog[0], ['profile', 'create', 'coder', '--no-alias', '--clone-from', 'default']);
  assert.ok(argvLog.some((a) => a.includes('model.default')));
  const env = await (await import('node:fs/promises')).readFile(join(home, 'profiles', 'coder', '.env'), 'utf8');
  assert.match(env, /OPENAI_API_KEY=sk-keep/);
  assert.doesNotMatch(env, /API_SERVER_KEY=default-listen/);
  const soul = await (await import('node:fs/promises')).readFile(join(home, 'profiles', 'coder', 'SOUL.md'), 'utf8');
  assert.match(soul, /focused coding assistant/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/hermes-backend.test.mjs`

Expected: FAIL — `createBot` missing.

- [ ] **Step 3: Implement `createBot` + POST route** (allowlist `pathname === '/v1/bots' && method === 'POST'`). Adapter: `createBackend({ baseUrl, credentials, record })` pass `executablePath: record?.executable?.path`. backend-manager HTTP branch already has `record` — add it to `createBackend` call.

Stub `createBot` on `stubFrontedRegistry` for route tests: push `createBot:${name}` and return `{ id: name, displayName: name, routable: true }`.

- [ ] **Step 4: Run tests**

Run: `cd gate && node --test __tests__/hermes-backend.test.mjs __tests__/backend-routes.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/backends/hermes.mjs gate/core/cli-environments/adapters/hermes.mjs gate/core/cli-environments/backend-manager.mjs gate/core/server.mjs gate/__tests__/hermes-backend.test.mjs gate/__tests__/backend-routes.test.mjs
git commit -m "feat(gate): POST /v1/bots creates a Hermes profile

The phone must not edit ~/.hermes by guesswork. Bounded profile create
plus a distinct listen key is the only write path (ADR 0015)."
```

---

### Task 7: New Agent sheet on the roster

**Files:**
- Create: `src/components/chat/new-agent-sheet.tsx`
- Modify: `src/lib/gateway/manifest-client.ts` — `createBot(body)`
- Modify: `src/components/chat/chat-roster.tsx` — `onNewAgent` row
- Modify: `src/components/chat/chat-screen.tsx` — sheet state, refresh roster
- Test: `__tests__/manifest-client-test.ts`

**Interfaces:**
- Produces: `ManifestClient.createBot({ name, soul?, inheritKeys?, description?, modelId?, providerId? })` POST `/v1/bots` with `backendId` + body. Roster shows a trailing `New Agent` row calling `onNewAgent`.

- [ ] **Step 1: Write the failing client test**

```ts
test('createBot POSTs /v1/bots with name and inheritKeys', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: 'coder', displayName: 'coder', routable: true }),
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  const client = clientWithEndpoints({ health: '/health', bots: '/v1/bots' });
  await client.createBot({ name: 'coder', inheritKeys: true, soul: 'Be brief.' });
  expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/bots');
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.name).toBe('coder');
  expect(body.inheritKeys).toBe(true);
  expect(body.soul).toBe('Be brief.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/manifest-client-test.ts --runInBand -t createBot`

Expected: FAIL — method missing.

- [ ] **Step 3: Implement client + UI**

`createBot` on ManifestClient POSTs to `endpoints.bots`. Add optional `createBot` on `PortalClient`.

Sheet fields (BaseSheet if the codebase has it, else a simple modal matching `BackendPickerSheet`): Name (required), Soul (multiline optional), Inherit keys switch (default true), Model (optional text or reuse ModelPickerSheet on confirm). Submit calls `createBot` then `onCreated(bot)`.

Roster: last row `New Agent` / `Create a Hermes profile` → `onNewAgent`. ChatScreen: after create, `listBots()` refresh; optionally `openBot(bot.id)`.

Read Expo SDK 57 before the sheet. Reuse existing `BaseSheet` / `ListRow` / `Button`. Do not add dependencies.

- [ ] **Step 4: Typecheck + jest**

Run: `npx tsc --noEmit`

Run: `npx jest __tests__/manifest-client-test.ts --runInBand`

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/manifest-client.ts src/lib/portal/adapters.ts src/components/chat/new-agent-sheet.tsx src/components/chat/chat-roster.tsx src/components/chat/chat-screen.tsx __tests__/manifest-client-test.ts
git commit -m "feat(app): New Agent sheet creates a Hermes Bot from the roster

Slice 1 could only talk to desktop Bots. Create must go through the
Gate so listen keys and SOUL land on the host, not in the app."
```

---

### Task 8: Jobs routes honor `bot=`

**Files:**
- Modify: `gate/core/server.mjs` — `/v1/jobs` GET and `/{id}/(run|pause|resume)` POST use `resolveConversationBackend`
- Modify: `gate/core/cli-environments/backends/hermes.mjs` — add `createJob(body)` POST `/api/jobs` if not present
- Test: `gate/__tests__/backend-routes.test.mjs`

**Interfaces:**
- Consumes: `forBot` from slice 1
- Produces: `GET /v1/jobs?bot=researcher` calls `forBot` then `listJobs`. POST create similarly.

- [ ] **Step 1: Write the failing test**

On `stubFrontedRegistry` forBot return object, add:

```js
async listJobs() { calls.push(`listJobs:${botId}`); return { data: [{ id: 'job-1' }] }; },
async createJob(body) { calls.push(`createJob:${botId}:${body?.name}`); return { id: 'job-2', name: body?.name }; },
```

Test GET `/v1/jobs?bot=researcher` includes `forBot:researcher` and `listJobs:researcher`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test __tests__/backend-routes.test.mjs`

Expected: FAIL — jobs ignore `bot`.

- [ ] **Step 3: Implement** — replace `resolveBackendFor('listJobs')` on GET `/v1/jobs` with `resolveConversationBackend(backendId, botId)` then `requireBackendMethod(..., 'listJobs')`. Same for job actions. Add POST `/v1/jobs` allowlist + handler calling `createJob`. Hermes `createJob` is `call('/api/jobs', { method: 'POST', body: JSON.stringify(body) })`.

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gate/core/server.mjs gate/core/cli-environments/backends/hermes.mjs gate/__tests__/backend-routes.test.mjs
git commit -m "feat(gate): scope jobs to a Bot via forBot

Unprefixed /v1/jobs is the default profile's cron. Routines for
Researcher must hit /p/researcher/api/jobs or they land on default."
```

---

### Task 9: Routine title helper + pane

**Files:**
- Create: `src/lib/gateway/routines.ts`
- Test: `__tests__/routines-test.ts`
- Create: `src/components/chat/routines-pane.tsx`
- Modify: `src/components/chat/chat-screen.tsx` — show pane when `surface.kind === 'bot'`
- Modify: `src/lib/gateway/manifest-client.ts` — `listJobs` / `createJob` / pause / run with `bot=`

**Interfaces:**
- Produces:
  - `ROUTINE_PREFIX = (botId: string) => \`[bot:${botId}]\``
  - `routineName(botId: string, title: string): string` → `[bot:researcher] inbox`
  - `parseRoutineName(name: string): { botId?: string, title: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { parseRoutineName, routineName } from '@/lib/gateway/routines';

test('routineName namespaces a job to a bot', () => {
  expect(routineName('researcher', 'inbox')).toBe('[bot:researcher] inbox');
  expect(parseRoutineName('[bot:researcher] inbox')).toEqual({ botId: 'researcher', title: 'inbox' });
  expect(parseRoutineName('plain')).toEqual({ title: 'plain' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/routines-test.ts --runInBand`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement helper + client methods + pane**

Client: GET `withScope('/v1/jobs')` (already has `withBot`). POST create with `{ bot, name: routineName(botId, title), prompt, schedule }`.

Pane: list jobs for current `selectedBotId`, fields prompt + schedule (text, Advanced as spec), pause/run buttons. Dock below header when in a Bot, above the transcript. Keep it collapsible (`Routines` label). Reuse `ListRow`.

- [ ] **Step 4: tsc + jest**

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/routines.ts __tests__/routines-test.ts src/components/chat/routines-pane.tsx src/lib/gateway/manifest-client.ts src/components/chat/chat-screen.tsx
git commit -m "feat(app): routines pane is that Bot's cron, not the default profile

Desktop namespaces jobs [bot:<name>]. Listing unprefixed jobs on a Bot
surface would show someone else's schedule."
```

---

### Task 10: Mention extraction

**Files:**
- Create: `src/lib/gateway/mentions.ts`
- Test: `__tests__/mentions-test.ts`

**Interfaces:**
- Produces: `extractMentions(text: string, rosterIds: string[]): string[]` — unique, order of appearance, case-insensitive match to roster ids. Emails and unknown `@foo` omitted from the result (they stay in the text).

- [ ] **Step 1: Write the failing test**

```ts
import { extractMentions } from '@/lib/gateway/mentions';

test('extractMentions returns roster ids only', () => {
  const ids = ['researcher', 'coder', 'default'];
  expect(extractMentions('hey @researcher look at this @nobody @coder', ids)).toEqual([
    'researcher',
    'coder',
  ]);
  expect(extractMentions('email me @user@example.com', ids)).toEqual([]);
  expect(extractMentions('@Researcher', ids)).toEqual(['researcher']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/mentions-test.ts --runInBand`

- [ ] **Step 3: Implement** with regex `/@([a-z0-9][a-z0-9_-]{0,62})/gi`, skip if next char is `@` (email). Lowercase compare to a Set of roster ids.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/mentions.ts __tests__/mentions-test.ts
git commit -m "feat(app): @mentions resolve against the Bot roster only

An email address must not become a handoff. Desktop validates mention
names against the live roster; unknown @ stays ordinary text."
```

---

### Task 11: Composer suggestions + mention handoff

**Files:**
- Modify: `src/components/chat/chat-composer.tsx` — when draft matches `/@(\w*)$/` and `surface` is a Bot, show roster ids
- Modify: `gate/core/cli-environments/backends/hermes.mjs` — `handoffMention({ fromId, toId, text })`
- Modify: `gate/core/server.mjs` — `POST /v1/bots/handoff`
- Modify: `src/lib/gateway/manifest-client.ts` — `handoffMention`
- Modify: `src/context/gateway-provider.tsx` — after a successful send, if mentions.length, call handoff (do not block the visible send)

**Interfaces:**
- Produces: `handoffMention` loads mentioned Bot Chat via `forBot(toId)` + `ensureBotChat` equivalent, `sendMessage` with prefix:

`Message from 🤖 ${fromId} (@${fromId}):\n\n${text}`

Derive from Desktop's CLI prefix. Do not shell-out `hermes -p`.

- [ ] **Step 1: Write the failing backend test** that `handoffMention` calls `forBot('researcher')` then sendMessage containing `Message from 🤖 coder (@coder):`.

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement Gate route + client + composer suggestions from `listBots` ids already on ChatScreen (pass `mentionIds` into composer). After `sendChatInput` resolves, `extractMentions` and POST handoff for each id ≠ current bot. Errors append to `lastError` but do not roll back the user's send.

Composer: do not invent a new palette if slash suggestions already exist — a small list above the input is enough. Read Expo 57.

- [ ] **Step 4: tests pass**

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-environments/backends/hermes.mjs gate/core/server.mjs src/lib/gateway/manifest-client.ts src/components/chat/chat-composer.tsx src/context/gateway-provider.tsx src/components/chat/chat-screen.tsx gate/__tests__/hermes-backend.test.mjs
git commit -m "feat: @mention delivers into the named Bot's Bot Chat

API Bot Chat may not inject bot_mode_protocol. Posting the Desktop
prefix into the mentioned Bot Chat is the handoff that does not
depend on a hidden prompt section."
```

---

### Task 12: Group session identity + fan-out

**Files:**
- Create: `src/lib/gateway/groups.ts`
- Test: `__tests__/groups-test.ts`

**Interfaces:**
- Produces:
  - `GROUP_SESSION_TITLE = (name: string) => \`Group: ${name}\``
  - `validateGroup({ name, memberIds }): { ok: boolean, error?: string }` — 2–6 unique existing bot ids, name non-empty
  - `planGroupRounds({ memberIds, mentionedIds, maxRounds = 3, maxMessages = 10 }): { botId: string }[]` — Desktop: mentioned members respond, else everyone; serial; stop after a silent round is **runtime**, this helper only lists the candidate order per round (members filtered by mention, else all). Return `maxRounds` copies of that list, flattened, sliced to `maxMessages`.

- [ ] **Step 1: Write the failing test**

```ts
import { GROUP_SESSION_TITLE, planGroupRounds, validateGroup } from '@/lib/gateway/groups';

test('validateGroup enforces 2–6 members', () => {
  expect(validateGroup({ name: 'crew', memberIds: ['a'] }).ok).toBe(false);
  expect(validateGroup({ name: 'crew', memberIds: ['a', 'b'] }).ok).toBe(true);
  expect(validateGroup({ name: 'crew', memberIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok).toBe(false);
});

test('planGroupRounds mentions subset and caps at 10', () => {
  const planned = planGroupRounds({
    memberIds: ['coder', 'researcher', 'writer'],
    mentionedIds: ['researcher'],
  });
  expect(planned.every((step) => step.botId === 'researcher')).toBe(true);
  expect(planned.length).toBeLessThanOrEqual(10);
  expect(GROUP_SESSION_TITLE('crew')).toBe('Group: crew');
});
```

- [ ] **Step 2: FAIL** then implement, PASS, commit.

```bash
git commit -m "feat(app): group rooms are 2–6 Bots with Group: name sessions

Desktop caps 3 rounds and 10 messages. Encode the caps in a helper so
the Gate cannot invent a different spin limit."
```

---

### Task 13: Gate group store + fan-out route

**Files:**
- Create: `gate/core/cli-environments/bot-groups.mjs` — `{ list, create, get }` JSON under Gate home `bot-groups.json`
- Modify: `gate/core/server.mjs` — `GET/POST /v1/bot-groups`, `POST /v1/bot-groups/:id/messages`
- Test: `gate/__tests__/bot-groups.test.mjs` + backend-routes allowlist

**Interfaces:**
- Store: `{ id, name, memberIds }[]`. `create` validates via the same 2–6 rule (duplicate the validate function in the Gate module or keep a copy — do not import from `src/`).
- POST message: for each step in `planGroupRounds`, `forBot(member).` find-or-create session titled `Group: <name>`, `sendMessage`. Collect `{ botId, text }[]`. Stop early if a turn returns empty (silent pass). Cap already in planner.

- [ ] **Step 1–5:** TDD store file, then routes with `isKnownAuthenticatedRoute`, `resolveBackendFor` not required (Gate-owned store) but sending uses Hermes `forBot`. Manifest `endpoints.botGroups`.

Commit message: groups live in Gate home because Hermes Bot Mode groups are a desktop plugin, not the API server.

---

### Task 14: Groups on the roster + room surface

**Files:**
- Modify: `src/lib/gateway/bots.ts` — `RosterRow` union add `{ kind: 'group', group: { id, name, memberIds } }`
- Modify: `src/components/chat/chat-roster.tsx`
- Create: `src/components/chat/group-room.tsx`
- Modify: `src/components/chat/chat-screen.tsx` — `ChatSurface` add `{ kind: 'group', groupId: string }`
- Modify: `buildRoster` to take optional groups array: configurable, bots, then groups, then New Agent
- Test: `__tests__/bots-roster-test.ts` for row order

- [ ] **Step 1: Failing test** — `buildRoster(bots, groups)` places groups after bots.

- [ ] **Step 2–5:** Implement. Group room: member chips, transcript of attributed replies, composer that POSTs `/v1/bot-groups/:id/messages`. Creating a group: sheet with multi-select of roster Bots (2–6) + name.

Commit: roster lists groups as rooms, not as Bots.

---

### Task 15: Verify

- [ ] `npm run verify`
- [ ] Restart Gate (`node gate/cli.mjs start`)
- [ ] Live: model chip on Researcher does not change configurable chat's model; New Agent appears on roster; routine on Researcher does not show on default; `@coder` from Researcher delivers; a 2-Bot group fans out
- [ ] Device pass on Chat tab (SSE `body` class)

---

## Self-review (spec coverage)

| Spec item | Task |
|---|---|
| In-session Bot model, no clobber | 1–3 |
| New Agent name/soul/inherit/pin | 4–7 |
| Distinct listen key | 5 |
| Bounded CLI only | 4, 6 |
| Routines pane, `[bot:id]` | 8–9 |
| `@mention` roster-validated + handoff | 10–11 |
| Groups 2–6, `Group: name`, caps | 12–14 |
| Avatars / Codex-as-Bot / multiplex write | excluded |

No TBD. `createBot`, `botModels`, `routineName`, `extractMentions`, `GROUP_SESSION_TITLE` names are stable.
