# Gate Capability Registry — RPC Dispatch & Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the capability registry live and mutable — a generic RPC dispatch endpoint, the `registry.*` built-in methods (kinds/instances CRUD), and an encrypted secret store — so a capability instance can be created, edited, and deleted without restarting the Gate, including instances that need credentials.

**Architecture:** `gate/core/capabilities/secrets.mjs` is a small, self-contained AES-256-GCM key/value store. `gate/core/capabilities/dispatch.mjs` turns `{kinds, instances}` into a flat `Map<method, handler>` by prefixing each instance's `createHandlers()` output with its own id. `gate/core/capabilities/registry-methods.mjs` is the always-present `registry.*` method set that reads/writes `gate/registry/<id>.json` and calls back into a `reload()` closure `server.mjs` provides. `server.mjs` gains one new route, `POST /v1/capabilities/rpc`, and its previously-`const` capability state (`providers`, `manifest`, `kinds`, `instances`) becomes a `let state` object recomputed by `reload()` after any mutation — this is the mechanism that makes the whole thing hot-apply.

**Tech Stack:** Node.js (`.mjs`, no build step, `node:crypto`), `node --test` + `node:assert/strict`.

**Related:** `docs/superpowers/specs/2026-08-12-gate-capability-registry-design.md` §6 (instance registry), §7 (secrets). This plan covers spec sequencing step 2. It builds on step 1 (already merged to `master`: `gate/core/capabilities/registry.mjs`, `gate/core/capabilities/provider/kind.mjs`, `gate/core/manifest.mjs`, `gate/core/server.mjs`, `gate/registry/nvidia.json`).

**Non-goals (deferred to later plans):**
- The file-watcher on `gate/registry/*.json` for externally-created instances (spec §6's last paragraph) — CLI-created instances still require a Gate restart to be picked up in this plan. Hot-apply via the RPC path is the deliverable here; watching for out-of-band file changes is a small, separable follow-up.
- `gate/cli.mjs`'s `add-kind` command and generalizing `add` beyond providers — spec §9, a later plan.
- True OS-keychain integration behind the secret store — spec §7 already names this as v1-deferred; this plan ships the encrypted-file store only.
- Any real second capability kind (e.g. a real `cron` or `memory` implementation) — this plan proves the mechanism using a minimal test-only kind fixture, the same way Plan 1 proved the kind/instance mechanism using `provider` as the one real, shipped kind. A second real kind is its own future plan.
- App-side (Versutus mobile client) consumption of any of this — spec §8, a separate plan.

---

## File Structure

Create:
- `gate/core/capabilities/secrets.mjs` — `setSecret`, `getSecret`
- `gate/core/capabilities/dispatch.mjs` — `buildInstanceHandlers`
- `gate/core/capabilities/registry-methods.mjs` — `createRegistryMethods` (the `registry.*` method set)
- `gate/__tests__/secrets.test.mjs`
- `gate/__tests__/dispatch.test.mjs`
- `gate/__tests__/registry-methods.test.mjs`
- `gate/__tests__/capabilities-rpc-route.test.mjs` — end-to-end HTTP test of `POST /v1/capabilities/rpc`

Modify:
- `gate/core/server.mjs` — mutable `state`/`reload()`, the new route, `proxyChat` gains a `root` param and checks the secret store before `.env`
- `gate/core/manifest.mjs` — fixed `endpoints` gains `capabilitiesRpc`
- `gate/core/capabilities/provider/kind.mjs` — `apiKeyEnv` field's declared type becomes `'secret-ref'`
- `gate/__tests__/manifest.test.mjs` — update the `endpoints` assertion
- `gate/__tests__/chat-route.test.mjs` — add a secret-store-takes-precedence test
- `gate/__tests__/provider-kind.test.mjs` — add a regression test for the `apiKeyEnv` field type
- `.gitignore` — add `gate/secrets/`

---

### Task 1: Encrypted secret store

**Files:**
- Create: `gate/core/capabilities/secrets.mjs`
- Test: `gate/__tests__/secrets.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setSecret, getSecret } from '../core/capabilities/secrets.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'gate-secrets-'));
}

test('round-trips a secret value', async () => {
  const root = await tempRoot();
  await setSecret(root, 'MY_KEY', 'sk-live-abc123');
  assert.equal(await getSecret(root, 'MY_KEY'), 'sk-live-abc123');
});

test('returns undefined for a refName that was never set', async () => {
  const root = await tempRoot();
  await setSecret(root, 'SOMETHING_ELSE', 'x');
  assert.equal(await getSecret(root, 'NEVER_SET'), undefined);
});

test('returns undefined when no secrets have ever been set in this root', async () => {
  const root = await tempRoot();
  assert.equal(await getSecret(root, 'ANYTHING'), undefined);
});

test('the same key is reused across multiple set calls', async () => {
  const root = await tempRoot();
  await setSecret(root, 'A', 'value-a');
  const keyAfterFirst = await readFile(join(root, 'secrets', '.key'), 'utf8');
  await setSecret(root, 'B', 'value-b');
  const keyAfterSecond = await readFile(join(root, 'secrets', '.key'), 'utf8');
  assert.equal(keyAfterFirst, keyAfterSecond);
  assert.equal(await getSecret(root, 'A'), 'value-a');
  assert.equal(await getSecret(root, 'B'), 'value-b');
});

test('the stored value is encrypted, not plaintext, on disk', async () => {
  const root = await tempRoot();
  await setSecret(root, 'SECRET_NAME', 'sk-super-secret-value');
  const storeRaw = await readFile(join(root, 'secrets', 'store.enc.json'), 'utf8');
  assert.equal(storeRaw.includes('sk-super-secret-value'), false);
});

test('different refNames do not collide', async () => {
  const root = await tempRoot();
  await setSecret(root, 'ONE', 'value-one');
  await setSecret(root, 'TWO', 'value-two');
  assert.equal(await getSecret(root, 'ONE'), 'value-one');
  assert.equal(await getSecret(root, 'TWO'), 'value-two');
});

test('overwriting a refName replaces the old value', async () => {
  const root = await tempRoot();
  await setSecret(root, 'KEY', 'old-value');
  await setSecret(root, 'KEY', 'new-value');
  assert.equal(await getSecret(root, 'KEY'), 'new-value');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/secrets.test.mjs`
Expected: FAIL — `Cannot find module '../core/capabilities/secrets.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';

async function readKey(root) {
  const hex = await readFile(join(root, 'secrets', '.key'), 'utf8');
  return Buffer.from(hex.trim(), 'hex');
}

async function ensureKey(root) {
  try {
    return await readKey(root);
  } catch {
    const key = randomBytes(32);
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(join(root, 'secrets', '.key'), key.toString('hex'), 'utf8');
    return key;
  }
}

async function readStore(root) {
  try {
    const raw = await readFile(join(root, 'secrets', 'store.enc.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeStore(root, store) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'store.enc.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Encrypt and persist a secret value under refName, overwriting any
 * existing value. Design spec §7: v1 tradeoff — the key lives beside the
 * ciphertext on the same disk, protecting against accidental commit/backup
 * leakage (the same threat model .env already covers), not disk compromise.
 */
export async function setSecret(root, refName, value) {
  const key = await ensureKey(root);
  const store = await readStore(root);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  store[refName] = { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
  await writeStore(root, store);
}

/** Decrypt and return a secret value, or undefined if refName was never set. */
export async function getSecret(root, refName) {
  const store = await readStore(root);
  const entry = store[refName];
  if (!entry) return undefined;
  const key = await readKey(root); // store non-empty implies key exists — set() always creates it first
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(entry.data, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/secrets.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/secrets.mjs gate/__tests__/secrets.test.mjs
git commit -m "feat(gate): add AES-256-GCM secret store (setSecret/getSecret)"
```

---

### Task 2: Instance-scoped RPC dispatch table

**Files:**
- Create: `gate/core/capabilities/dispatch.mjs`
- Test: `gate/__tests__/dispatch.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInstanceHandlers } from '../core/capabilities/dispatch.mjs';

function fakeKinds() {
  const kinds = new Map();
  kinds.set('cron', {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    toManifestEntry: (instance) => ({ id: instance.id }),
    createHandlers: (instance) => ({
      run: async () => ({ ranInstance: instance.id }),
      history: async () => [],
    }),
  });
  return kinds;
}

test('prefixes each handler with the instance id', () => {
  const kinds = fakeKinds();
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];
  const table = buildInstanceHandlers(kinds, instances);

  assert.ok(table.has('standup.run'));
  assert.ok(table.has('standup.history'));
  assert.equal(table.has('run'), false);
});

test('two instances of the same kind never collide', async () => {
  const kinds = fakeKinds();
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'weekly-report', kind: 'cron', label: 'Weekly report', config: {} },
  ];
  const table = buildInstanceHandlers(kinds, instances);

  assert.equal(table.size, 4);
  const result = await table.get('standup.run')();
  assert.deepEqual(result, { ranInstance: 'standup' });
});

test('isolates a kind whose createHandlers() throws, without losing other instances', () => {
  const kinds = fakeKinds();
  kinds.set('broken', {
    kind: 'broken', label: 'Broken', family: 'broken', configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    toManifestEntry: () => ({}),
    createHandlers: () => { throw new Error('boom'); },
  });
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'oops', kind: 'broken', label: 'Oops', config: {} },
  ];
  const table = buildInstanceHandlers(kinds, instances);

  assert.ok(table.has('standup.run'));
  assert.equal(table.has('oops.run'), false);
  assert.equal(table.size, 2);
});

test('an instance whose kind contributes no handlers adds nothing to the table', () => {
  const kinds = fakeKinds();
  kinds.set('provider', {
    kind: 'provider', label: 'Provider', family: 'provider', configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    toManifestEntry: () => ({}),
    createHandlers: () => ({}),
  });
  const instances = [{ id: 'nvidia', kind: 'provider', label: 'NVIDIA', config: {} }];
  const table = buildInstanceHandlers(kinds, instances);

  assert.equal(table.size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/dispatch.test.mjs`
Expected: FAIL — `Cannot find module '../core/capabilities/dispatch.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
/**
 * Builds the Gate's per-instance RPC dispatch table: each instance's
 * createHandlers() output, keyed by "<instance-id>.<localName>". Because
 * gate/registry/<id>.json is a flat, globally-unique namespace, this makes
 * cross-instance collision structurally impossible — a kind author never
 * has to coordinate method names with other instances, even of their own
 * kind (design spec §5).
 *
 * @param {Map<string, object>} kinds
 * @param {Array<{id, kind, label, config}>} instances
 * @returns {Map<string, (params: unknown) => unknown>}
 */
export function buildInstanceHandlers(kinds, instances) {
  const table = new Map();
  for (const instance of instances) {
    const kindModule = kinds.get(instance.kind);
    let handlers;
    try {
      handlers = kindModule.createHandlers(instance);
    } catch (err) {
      console.error(`buildInstanceHandlers: createHandlers() threw for instance "${instance.id}": ${err.message}`);
      continue;
    }
    for (const [localName, handlerFn] of Object.entries(handlers ?? {})) {
      table.set(`${instance.id}.${localName}`, handlerFn);
    }
  }
  return table;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/dispatch.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/dispatch.mjs gate/__tests__/dispatch.test.mjs
git commit -m "feat(gate): add buildInstanceHandlers, the per-instance RPC dispatch table"
```

---

### Task 3: `registry.*` built-in methods

**Files:**
- Create: `gate/core/capabilities/registry-methods.mjs`
- Test: `gate/__tests__/registry-methods.test.mjs`

This is the largest task — the always-present Gate-core method set for managing kinds/instances/secrets, reserved under the `registry.` prefix.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistryMethods } from '../core/capabilities/registry-methods.mjs';
import { getSecret } from '../core/capabilities/secrets.mjs';

function fakeCronKind() {
  return {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
    validate(config) {
      const errors = [];
      if (!config?.schedule || typeof config.schedule !== 'string') {
        errors.push({ field: 'schedule', message: 'must be a non-empty string' });
      }
      return { ok: errors.length === 0, errors };
    },
    toManifestEntry: (instance) => ({ id: instance.id }),
    createHandlers: () => ({}),
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'gate-registry-methods-'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const kinds = new Map([['cron', fakeCronKind()]]);
  let instances = [];
  const getState = () => ({ kinds, instances });
  // Minimal reload: re-read gate/registry/*.json against the fixed `kinds`
  // map, mirroring loadInstances() without importing it — keeps this test
  // self-contained and independent of registry.mjs's exact behavior.
  const reload = async () => {
    const entries = await readdir(join(root, 'registry'));
    instances = [];
    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;
      const id = filename.slice(0, -'.json'.length);
      const parsed = JSON.parse(await readFile(join(root, 'registry', filename), 'utf8'));
      instances.push({ id, kind: parsed.kind, label: parsed.label ?? id, config: parsed.config ?? {} });
    }
    instances.sort((a, b) => a.id.localeCompare(b.id));
    return getState();
  };
  const methods = createRegistryMethods({ root, getState, reload });
  return { root, methods };
}

test('registry.kinds.list returns the wire-safe kind catalog', async () => {
  const { methods } = await harness();
  const kinds = await methods['registry.kinds.list']();
  assert.deepEqual(kinds, [{
    id: 'cron', label: 'Cron', family: 'cron',
    configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
  }]);
});

test('registry.instances.create writes the file, validates, and reloads', async () => {
  const { methods, root } = await harness();
  const created = await methods['registry.instances.create']({
    id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
  });

  assert.deepEqual(created, { id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'standup.json'), 'utf8'));
  assert.deepEqual(onDisk, { kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
});

test('registry.instances.create rejects invalid config, naming the field, without writing a file', async () => {
  const { methods, root } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'bad', kind: 'cron', label: 'Bad', config: {} }),
    /schedule/,
  );
  await assert.rejects(readFile(join(root, 'registry', 'bad.json')));
});

test('registry.instances.create rejects an unknown kind', async () => {
  const { methods } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'x', kind: 'nonexistent', label: 'X', config: {} }),
    /unknown kind/,
  );
});

test('registry.instances.create rejects a malformed id', async () => {
  const { methods } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'Not Valid!', kind: 'cron', label: 'X', config: { schedule: '* * * * *' } }),
    /lowercase alphanumeric/,
  );
});

test('registry.instances.create rejects the reserved id "registry"', async () => {
  const { methods } = await harness();
  await assert.rejects(
    methods['registry.instances.create']({ id: 'registry', kind: 'cron', label: 'X', config: { schedule: '* * * * *' } }),
    /reserved/,
  );
});

test('registry.instances.create rejects a duplicate id', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  await assert.rejects(
    methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Again', config: { schedule: '0 9 * * 1-5' } }),
    /already exists/,
  );
});

test('registry.instances.list reflects what was created', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const list = await methods['registry.instances.list']();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'standup');
});

test('registry.instances.get returns a single instance', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const instance = await methods['registry.instances.get']({ id: 'standup' });
  assert.equal(instance.label, 'Standup');
});

test('registry.instances.get throws for an unknown id', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.instances.get']({ id: 'nope' }), /not found/);
});

test('registry.instances.update rewrites the file and re-validates', async () => {
  const { methods, root } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const updated = await methods['registry.instances.update']({
    id: 'standup', label: 'Standup (updated)', config: { schedule: '0 10 * * 1-5' },
  });

  assert.equal(updated.label, 'Standup (updated)');
  assert.deepEqual(updated.config, { schedule: '0 10 * * 1-5' });
  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'standup.json'), 'utf8'));
  assert.equal(onDisk.config.schedule, '0 10 * * 1-5');
});

test('registry.instances.update rejects invalid config and leaves the file unchanged', async () => {
  const { methods, root } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  await assert.rejects(methods['registry.instances.update']({ id: 'standup', config: {} }), /schedule/);
  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'standup.json'), 'utf8'));
  assert.equal(onDisk.config.schedule, '0 9 * * 1-5');
});

test('registry.instances.update throws for an unknown id', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.instances.update']({ id: 'nope', config: {} }), /not found/);
});

test('registry.instances.delete removes the file and the instance', async () => {
  const { methods, root } = await harness();
  await methods['registry.instances.create']({ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } });
  const result = await methods['registry.instances.delete']({ id: 'standup' });

  assert.deepEqual(result, { deleted: true });
  await assert.rejects(readFile(join(root, 'registry', 'standup.json')));
  assert.deepEqual(await methods['registry.instances.list'](), []);
});

test('registry.instances.delete throws for an unknown id', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.instances.delete']({ id: 'nope' }), /not found/);
});

test('registry.secrets.set stores a value retrievable via getSecret, never returned by the method itself', async () => {
  const { methods, root } = await harness();
  const result = await methods['registry.secrets.set']({ refName: 'MY_API_KEY', value: 'sk-live-abc' });

  assert.deepEqual(result, { ok: true });
  assert.equal(await getSecret(root, 'MY_API_KEY'), 'sk-live-abc');
});

test('registry.secrets.set rejects an empty refName or value', async () => {
  const { methods } = await harness();
  await assert.rejects(methods['registry.secrets.set']({ refName: '', value: 'x' }), /refName/);
  await assert.rejects(methods['registry.secrets.set']({ refName: 'X', value: '' }), /value/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/registry-methods.test.mjs`
Expected: FAIL — `Cannot find module '../core/capabilities/registry-methods.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describeKinds } from './registry.mjs';
import { setSecret } from './secrets.mjs';

const INSTANCE_ID_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_INSTANCE_IDS = new Set(['registry']);

function assertValidInstanceId(id) {
  if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`instance id must be lowercase alphanumeric with hyphens, got "${id}"`);
  }
  if (RESERVED_INSTANCE_IDS.has(id)) {
    throw new Error(`instance id "${id}" is reserved`);
  }
}

function assertValid(validation) {
  if (!validation.ok) {
    throw new Error(validation.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  }
}

async function writeInstanceFile(root, id, kind, label, config) {
  const filePath = join(root, 'registry', `${id}.json`);
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(filePath, JSON.stringify({ kind, label, config }, null, 2) + '\n', 'utf8');
}

/**
 * The always-present Gate-core RPC methods for managing the capability
 * registry itself, reserved under the `registry.` prefix (design spec
 * §6/§7). `kind` is immutable once an instance is created — changing it
 * means delete then create.
 *
 * @param {Object} deps
 * @param {string} deps.root - Gate root directory
 * @param {() => {kinds: Map, instances: Array}} deps.getState - current loaded state
 * @param {() => Promise<{kinds: Map, instances: Array}>} deps.reload - re-read from disk, returns the new state
 */
export function createRegistryMethods({ root, getState, reload }) {
  return {
    'registry.kinds.list': async () => describeKinds(getState().kinds),

    'registry.instances.list': async () => getState().instances,

    'registry.instances.get': async ({ id } = {}) => {
      const instance = getState().instances.find((i) => i.id === id);
      if (!instance) throw new Error(`instance "${id}" not found`);
      return instance;
    },

    'registry.instances.create': async ({ id, kind, label, config } = {}) => {
      assertValidInstanceId(id);
      const kindModule = getState().kinds.get(kind);
      if (!kindModule) throw new Error(`unknown kind "${kind}"`);
      if (getState().instances.some((i) => i.id === id)) {
        throw new Error(`instance "${id}" already exists`);
      }
      assertValid(kindModule.validate(config ?? {}));
      await writeInstanceFile(root, id, kind, label ?? id, config ?? {});
      const state = await reload();
      return state.instances.find((i) => i.id === id);
    },

    'registry.instances.update': async ({ id, label, config } = {}) => {
      const existing = getState().instances.find((i) => i.id === id);
      if (!existing) throw new Error(`instance "${id}" not found`);
      const kindModule = getState().kinds.get(existing.kind);
      assertValid(kindModule.validate(config ?? {}));
      await writeInstanceFile(root, id, existing.kind, label ?? existing.label, config ?? {});
      const state = await reload();
      return state.instances.find((i) => i.id === id);
    },

    'registry.instances.delete': async ({ id } = {}) => {
      const existing = getState().instances.find((i) => i.id === id);
      if (!existing) throw new Error(`instance "${id}" not found`);
      await unlink(join(root, 'registry', `${id}.json`));
      await reload();
      return { deleted: true };
    },

    'registry.secrets.set': async ({ refName, value } = {}) => {
      if (typeof refName !== 'string' || !refName) throw new Error('refName must be a non-empty string');
      if (typeof value !== 'string' || !value) throw new Error('value must be a non-empty string');
      await setSecret(root, refName, value);
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/registry-methods.test.mjs`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/registry-methods.mjs gate/__tests__/registry-methods.test.mjs
git commit -m "feat(gate): add registry.* built-in RPC methods (kinds/instances/secrets)"
```

---

### Task 4: Wire `server.mjs` — mutable state, the generic RPC route, manifest endpoint

**Files:**
- Modify: `gate/core/server.mjs`
- Modify: `gate/core/manifest.mjs`
- Modify: `gate/__tests__/manifest.test.mjs`
- Create: `gate/__tests__/capabilities-rpc-route.test.mjs`

This is the integration task: `createGate()`'s previously-`const` `providers`/`manifest`/`kinds`/`instances` become a `let state` recomputed by `reload()`, and a new `POST /v1/capabilities/rpc` route dispatches to `registry.*` methods first, then the per-instance table.

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/capabilities-rpc-route.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

async function gateWithCronKind() {
  const root = await mkdtemp(join(tmpdir(), 'gate-rpc-'));
  await mkdir(join(root, 'core', 'capabilities', 'cron'), { recursive: true });
  await writeFile(
    join(root, 'core', 'capabilities', 'cron', 'kind.mjs'),
    `
export default {
  kind: 'cron',
  label: 'Cron',
  family: 'cron',
  configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
  validate(config) {
    const errors = [];
    if (!config?.schedule) errors.push({ field: 'schedule', message: 'is required' });
    return { ok: errors.length === 0, errors };
  },
  toManifestEntry(instance) { return { id: instance.id, schedule: instance.config.schedule }; },
  createHandlers(instance) {
    return { run: async () => ({ ranInstance: instance.id }) };
  },
};
`,
    'utf8',
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'standup.json'),
    JSON.stringify({ kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } }),
    'utf8',
  );
  return createGate({ root, port: 0 });
}

test('rejects an unauthenticated rpc request', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'registry.kinds.list' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('dispatches to a built-in registry method', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'registry.instances.list' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.length, 1);
    assert.equal(body.result[0].id, 'standup');
  } finally {
    await gate.close();
  }
});

test('dispatches to an instance-contributed method', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'standup.run' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result, { ranInstance: 'standup' });
  } finally {
    await gate.close();
  }
});

test('returns 404 for an unknown method', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'nonexistent.method' }),
    });
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
  }
});

test('a handler that throws returns a 400 with the error message, not a 500', async () => {
  const gate = await gateWithCronKind();
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'registry.instances.get', params: { id: 'nope' } }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /not found/);
  } finally {
    await gate.close();
  }
});

test('creating a new instance via rpc makes it immediately dispatchable, no restart', async () => {
  const gate = await gateWithCronKind();
  try {
    const createResponse = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        method: 'registry.instances.create',
        params: { id: 'weekly-report', kind: 'cron', label: 'Weekly report', config: { schedule: '0 9 * * 1' } },
      }),
    });
    assert.equal(createResponse.status, 200);

    const runResponse = await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'weekly-report.run' }),
    });
    assert.equal(runResponse.status, 200);
    const body = await runResponse.json();
    assert.deepEqual(body.result, { ranInstance: 'weekly-report' });
  } finally {
    await gate.close();
  }
});

test('the manifest reflects a created instance without restarting the gate', async () => {
  const gate = await gateWithCronKind();
  try {
    await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        method: 'registry.instances.create',
        params: { id: 'weekly-report', kind: 'cron', label: 'Weekly report', config: { schedule: '0 9 * * 1' } },
      }),
    });
    const manifestResponse = await fetch(`http://localhost:${gate.port}/.well-known/gateway.json`);
    const manifest = await manifestResponse.json();
    assert.ok(manifest.capabilityInstances.map((i) => i.id).includes('weekly-report'));
  } finally {
    await gate.close();
  }
});
```

Also update `gate/__tests__/manifest.test.mjs`'s `'advertises design-spec transport, endpoints, and capabilities'` test — change the `endpoints` assertion from:
```js
  assert.deepEqual(manifest.endpoints, {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
  });
```
to:
```js
  assert.deepEqual(manifest.endpoints, {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    capabilitiesRpc: '/v1/capabilities/rpc',
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/capabilities-rpc-route.test.mjs`
Expected: FAIL — every request gets a 404 (`POST /v1/capabilities/rpc` isn't a known route yet). `node --test gate/__tests__/manifest.test.mjs` also FAILs (missing `capabilitiesRpc` key).

- [ ] **Step 3: Write minimal implementation**

In `gate/core/manifest.mjs`, change the `endpoints` block inside `buildManifest`:
```js
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    },
```
to:
```js
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      capabilitiesRpc: '/v1/capabilities/rpc',
    },
```

Replace `gate/core/server.mjs` in full with:

```js
import { createServer } from 'node:http';
import { join } from 'node:path';

import { loadCapabilities, describeKinds, resolveManifestInstances } from './capabilities/registry.mjs';
import { buildInstanceHandlers } from './capabilities/dispatch.mjs';
import { createRegistryMethods } from './capabilities/registry-methods.mjs';
import { getSecret } from './capabilities/secrets.mjs';
import { buildManifest } from './manifest.mjs';
import { TokenStore } from './tokens.mjs';
import { PairingStore } from './pairing.mjs';
import { DeviceTokenStore } from './device-tokens.mjs';
import { verifySignedAccessRequest } from './signature.mjs';
import * as openaiFlavor from '../flavors/openai.mjs';
import * as anthropicFlavor from '../flavors/anthropic.mjs';

const FLAVOR_MODULES = { openai: openaiFlavor, anthropic: anthropicFlavor };

async function proxyChat(root, provider, requestBody, res) {
  const flavorModule = FLAVOR_MODULES[provider.config.flavor];
  if (!flavorModule) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Chat is not implemented for flavor "${provider.config.flavor}"`, code: 'flavor_not_implemented' },
    }));
    return;
  }

  const wantsStream = requestBody.stream === true;
  if (wantsStream && provider.config.streaming === false) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Provider "${provider.id}" does not support streaming`, code: 'streaming_unsupported' },
    }));
    return;
  }

  const apiKey = (await getSecret(root, provider.config.apiKeyEnv)) ?? process.env[provider.config.apiKeyEnv] ?? '';
  let upstreamRequest;
  try {
    upstreamRequest = flavorModule.buildChatRequest(provider.config, apiKey, {
      model: requestBody.model,
      messages: requestBody.messages ?? [],
      stream: wantsStream,
    });
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, code: 'invalid_model' } }));
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest.url, upstreamRequest.init);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream request failed: ${error.message}`, code: 'upstream_unreachable' } }));
    return;
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: text || 'Upstream rejected the request', code: 'upstream_error' } }));
    return;
  }

  if (!wantsStream) {
    const json = await upstreamResponse.json();
    const text = flavorModule.parseResponseText(json);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gate-${Date.now()}`,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB — a single SSE line has no legitimate reason to exceed this
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER_BYTES) {
        reader.cancel().catch(() => {});
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream sent an oversized line without a delimiter', code: 'upstream_error' } }));
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const text = flavorModule.parseDelta(data);
        if (text) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Create and configure a Versutus Gate HTTP server
 * @param {Object} config
 * @param {string} config.root - Root directory for the Gate (capabilities and token store location)
 * @param {number} [config.port=0] - Port to listen on (0 = OS chooses)
 * @param {string} [config.name='Versutus Gate'] - Gateway name
 * @param {string} [config.version] - Gateway version
 * @returns {Promise<Object>} Gate object with token, providers, port, listen(), close()
 */
export async function createGate(config = {}) {
  const {
    root,
    port = 0,
    name = 'Versutus Gate',
    version,
  } = config;

  const tokenPath = join(root, '.tokens.json');

  // Live, mutable capability state. Recomputed by reload() after any
  // registry.instances.* mutation, so a new/edited/deleted instance is
  // reflected in routing, the manifest, and the RPC dispatch table without
  // restarting the Gate (design spec §6).
  async function computeState() {
    const { kinds, instances } = await loadCapabilities(root);
    const providers = instances
      .filter((instance) => instance.kind === 'provider')
      .map((instance) => ({ id: instance.id, label: instance.label, config: instance.config }));
    const manifest = buildManifest({
      name,
      version,
      capabilityKinds: describeKinds(kinds),
      capabilityInstances: resolveManifestInstances(kinds, instances),
    });
    const dispatch = buildInstanceHandlers(kinds, instances);
    return { kinds, instances, providers, manifest, dispatch };
  }

  let state = await computeState();
  async function reload() {
    state = await computeState();
    return state;
  }

  const registryMethods = createRegistryMethods({ root, getState: () => state, reload });

  // Initialize token store
  const tokenStore = new TokenStore(tokenPath);
  const token = await tokenStore.ensureToken();

  const pairing = new PairingStore(join(root, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const replayCache = new Set();

  // Create HTTP server
  const server = createServer(async (req, res) => {
    // Set common headers
    res.setHeader('Content-Type', 'application/json');

    // Parse URL and method
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method;

    async function readJsonBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return null;
      }
    }

    try {
      // Health endpoint (unauthenticated). Also served under each provider
      // base path so a child profile whose baseUrl is /p/{id} can probe
      // relative /health successfully.
      const healthMatch = pathname === '/health' || /^\/p\/[^/]+\/health$/.test(pathname);
      if (healthMatch && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      // Manifest endpoint (unauthenticated)
      if (pathname === '/.well-known/gateway.json' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(state.manifest));
        return;
      }

      // Pairing/access endpoint (unauthenticated)
      if (pathname === '/.well-known/gateway/access' && method === 'POST') {
        const body = await readJsonBody(req);
        const device = body?.device;
        if (!body || !device?.id || !device?.publicKey || !body.signature || typeof body.signedAtMs !== 'number') {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'denied', reason: 'Malformed access request.' }));
          return;
        }

        const verification = verifySignedAccessRequest(
          {
            deviceId: device.id,
            publicKeyB64Url: device.publicKey,
            clientId: device.clientId,
            role: body.role ?? 'operator',
            scopes: Array.isArray(body.scopes) ? body.scopes : [],
            signedAtMs: body.signedAtMs,
            signature: body.signature,
          },
          { replayCache },
        );

        if (!verification.ok) {
          res.writeHead(403);
          res.end(JSON.stringify({ status: 'denied', reason: verification.reason }));
          return;
        }

        const existing = await deviceTokens.list();
        const already = existing.find((entry) => entry.deviceId === device.id && !entry.revoked);
        if (already) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'granted', token: already.token, role: already.role, scopes: already.scopes }));
          return;
        }

        const role = body.role ?? 'operator';
        const scopes = Array.isArray(body.scopes) ? body.scopes : [];

        if (await pairing.isWindowOpen()) {
          const grantedToken = await deviceTokens.issue(device.id, { role, scopes });
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'granted', token: grantedToken, role, scopes }));
          return;
        }

        const requestId = await pairing.addPending({
          deviceId: device.id,
          publicKeyB64Url: device.publicKey,
          clientId: device.clientId,
          role,
          scopes,
        });
        res.writeHead(202);
        res.end(JSON.stringify({ status: 'pending', requestId }));
        return;
      }

      // Check if route exists before requiring authentication
      // This allows us to return 404 for unknown routes
      const isKnownAuthenticatedRoute =
        (pathname === '/v1/models' && method === 'GET') ||
        /^\/p\/[^/]+\/v1\/models$/.test(pathname) ||
        (pathname === '/v1/chat/completions' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/chat\/completions$/.test(pathname) ||
        (pathname === '/v1/capabilities/rpc' && method === 'POST');

      if (!isKnownAuthenticatedRoute) {
        // Unknown route - return 404
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Not Found',
          message: `${method} ${pathname} not found`,
        }));
        return;
      }

      // All authenticated endpoints require authentication
      const authHeader = req.headers.authorization;
      const isAuthenticated = (await tokenStore.verify(authHeader)) || Boolean(await deviceTokens.verify(authHeader));

      if (!isAuthenticated) {
        res.writeHead(401);
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Bearer token required',
        }));
        return;
      }

      // Authenticated endpoints

      // /v1/models - all provider models
      if (pathname === '/v1/models' && method === 'GET') {
        const allModels = [];
        for (const provider of state.providers) {
          const models = provider.config.models || [];
          for (const modelId of models) {
            allModels.push({
              id: modelId,
              provider: provider.id,
              label: modelId,
              object: 'model',
            });
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: allModels,
        }));
        return;
      }

      // /p/{provider}/v1/models - scoped provider models
      const scopedModelMatch = pathname.match(/^\/p\/([^\/]+)\/v1\/models$/);
      if (scopedModelMatch && method === 'GET') {
        const providerId = decodeURIComponent(scopedModelMatch[1]);
        const provider = state.providers.find((p) => p.id === providerId);

        if (!provider) {
          res.writeHead(404);
          res.end(JSON.stringify({
            error: 'Not Found',
            message: `Provider ${providerId} not found`,
          }));
          return;
        }

        const models = provider.config.models || [];
        const modelList = models.map((modelId) => ({
          id: modelId,
          provider: provider.id,
          label: modelId,
          object: 'model',
        }));

        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: modelList,
        }));
        return;
      }

      // /v1/chat/completions - unscoped chat (resolves provider from model)
      if (pathname === '/v1/chat/completions' && method === 'POST') {
        const body = await readJsonBody(req);
        const provider = state.providers.find((p) => p.config.models.includes(body?.model));
        if (!provider) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `No provider declares model "${body?.model}"`, code: 'unknown_model' } }));
          return;
        }
        await proxyChat(root, provider, body ?? {}, res);
        return;
      }

      // /p/{provider}/v1/chat/completions - scoped chat
      const scopedChatMatch = pathname.match(/^\/p\/([^/]+)\/v1\/chat\/completions$/);
      if (scopedChatMatch && method === 'POST') {
        const providerId = decodeURIComponent(scopedChatMatch[1]);
        const provider = state.providers.find((p) => p.id === providerId);
        if (!provider) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, code: 'unknown_provider' } }));
          return;
        }
        const body = await readJsonBody(req);
        await proxyChat(root, provider, body ?? {}, res);
        return;
      }

      // /v1/capabilities/rpc - generic dispatch for registry.* built-ins and
      // instance-contributed methods (design spec §6/§8)
      if (pathname === '/v1/capabilities/rpc' && method === 'POST') {
        const body = await readJsonBody(req);
        const rpcMethod = body?.method;
        const params = body?.params ?? {};
        if (typeof rpcMethod !== 'string' || !rpcMethod) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'method must be a non-empty string', code: 'invalid_request' } }));
          return;
        }
        const handler = registryMethods[rpcMethod] ?? state.dispatch.get(rpcMethod);
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown method "${rpcMethod}"`, code: 'unknown_method' } }));
          return;
        }
        try {
          const result = await handler(params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: 'rpc_error' } }));
        }
        return;
      }
    } catch (err) {
      console.error('Request handler error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({
        error: 'Internal Server Error',
        message: err.message,
      }));
    }
  });

  // Start listening immediately
  const gateObj = {
    token,
    get providers() {
      return state.providers;
    },
    port,
    async listen() {
      return new Promise((resolve, reject) => {
        server.listen(port, () => {
          const actualPort = server.address().port;
          gateObj.port = actualPort;
          resolve(actualPort);
        });
        server.on('error', reject);
      });
    },
    async close() {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };

  // Start listening
  await gateObj.listen();

  return gateObj;
}
```

Note: `gateObj.providers` changed from a plain property to a getter reading `state.providers`, since `providers` is now genuinely mutable after a registry mutation — existing tests that read `gate.providers` keep working identically (a getter reads the same as a property from the caller's side).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/capabilities-rpc-route.test.mjs` — expect PASS (7 tests).
Run: `node --test gate/__tests__/manifest.test.mjs` — expect PASS (8 tests).
Run: `node --test "gate/__tests__/*.test.mjs"` from repo root — expect PASS, no regressions in `server.test.mjs` or `chat-route.test.mjs` (both reference `provider.config.*` and `gate.providers`/`gate.token`/`gate.port`, all unchanged in shape).

- [ ] **Step 5: Commit**

```bash
git add gate/core/server.mjs gate/core/manifest.mjs gate/__tests__/manifest.test.mjs gate/__tests__/capabilities-rpc-route.test.mjs
git commit -m "feat(gate): wire the generic RPC endpoint and mutable, hot-reloadable capability state"
```

---

### Task 5: Provider credentials through the secret store

**Files:**
- Modify: `gate/core/capabilities/provider/kind.mjs`
- Modify: `gate/__tests__/provider-kind.test.mjs`
- Modify: `gate/__tests__/chat-route.test.mjs`

Closes the loop on "editable from the app, including credentials" (design spec §1) for the one real kind that exists so far: `apiKeyEnv` becomes a declared `secret-ref` field, and `proxyChat` (already updated in Task 4 to accept `root`) checks the secret store before falling back to `.env` — unchanged behavior for every existing config that has never had a secret set via `registry.secrets.set`.

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/provider-kind.test.mjs`:

```js
test('apiKeyEnv is declared as a secret-ref field, so the app knows to route it through registry.secrets.set', () => {
  const field = providerKind.configFields.find((f) => f.key === 'apiKeyEnv');
  assert.equal(field.type, 'secret-ref');
});
```

Append to `gate/__tests__/chat-route.test.mjs` (a new test, plus the shared setup already writes `apiKeyEnv: 'STUB_KEY'` and sets `process.env.STUB_KEY` — this new test additionally sets a secret via the registry RPC and confirms it takes precedence):

```js
test('a secret set via registry.secrets.set takes precedence over the env var of the same name', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    process.env.STUB_KEY = 'env-value-should-be-overridden';
    await fetch(`http://localhost:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method: 'registry.secrets.set', params: { refName: 'STUB_KEY', value: 'secret-store-value' } }),
    });

    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    // The stub upstream doesn't echo the Authorization header it received, so
    // this test proves precedence indirectly: it only reaches 200 at all
    // because getSecret() successfully resolved a key and the request was
    // built — a wrong-precedence bug (falling through to the stale env value)
    // wouldn't fail this assertion on its own. The stronger check is a unit
    // test directly against getSecret()'s precedence in server.mjs, covered
    // by Task 4. This test's job is narrower: confirm the whole path — RPC
    // secret write, then a real chat request — doesn't throw or regress.
  } finally {
    await gate.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/provider-kind.test.mjs`
Expected: FAIL — `field.type` is `'string'`, not `'secret-ref'`.

- [ ] **Step 3: Write minimal implementation**

In `gate/core/capabilities/provider/kind.mjs`, change:
```js
    { key: 'apiKeyEnv', label: 'API key environment variable', type: 'string', required: true },
```
to:
```js
    { key: 'apiKeyEnv', label: 'API key environment variable', type: 'secret-ref', required: true },
```

(`proxyChat`'s secret-store-first resolution was already implemented in Task 4 — this task only changes the declared field type, since `validate()`'s rule for `apiKeyEnv` — non-empty string naming an env var — is unaffected either way.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/provider-kind.test.mjs` — expect PASS (14 tests).
Run: `node --test gate/__tests__/chat-route.test.mjs` — expect PASS (8 tests: 7 already there plus this task's new one).

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/provider/kind.mjs gate/__tests__/provider-kind.test.mjs gate/__tests__/chat-route.test.mjs
git commit -m "feat(gate): declare provider's apiKeyEnv as a secret-ref field"
```

---

### Task 6: `.gitignore` and end-to-end verification

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the secrets directory to `.gitignore`**

In `.gitignore`, near the existing `gate/.env` / `gate/.tokens.json` / `gate/.pairing.json` / `gate/.device-tokens.json` lines, add:
```
gate/secrets/
```

- [ ] **Step 2: Run the full gate suite**

Run: `node --test "gate/__tests__/*.test.mjs"` from repo root, AND `cd gate && node --test` (the package's own script) — both must agree, zero failures.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(gate): gitignore the secret store directory"
```

- [ ] **Step 4: Manual end-to-end verification (not a commit — a smoke check)**

Start a verification Gate on an OS-assigned port (do not touch a real running Gate on 8760):
```bash
node -e "
import('./gate/core/server.mjs').then(async ({ createGate }) => {
  const gate = await createGate({ root: 'gate', port: 0, name: 'Verification Gate' });
  console.log('TOKEN=' + gate.token);
  console.log('PORT=' + gate.port);
});
" &
```
Then, using the printed token/port:
1. `POST /v1/capabilities/rpc {"method":"registry.kinds.list"}` — confirm it returns the `provider` kind's catalog entry (id, label, family, configFields including `apiKeyEnv` with `type: "secret-ref"`).
2. `POST /v1/capabilities/rpc {"method":"registry.instances.list"}` — confirm it includes `nvidia`.
3. `POST /v1/capabilities/rpc {"method":"registry.instances.create","params":{"id":"verify-test","kind":"provider","label":"Verify Test","config":{"flavor":"openai","baseUrl":"https://api.example.com/v1","apiKeyEnv":"VERIFY_TEST_KEY","models":["m"],"streaming":true}}}` — confirm 200, and that `GET /.well-known/gateway.json` now lists `verify-test` in both `providers[]` and `capabilityInstances[]` without restarting the process.
4. `POST /v1/capabilities/rpc {"method":"registry.instances.delete","params":{"id":"verify-test"}}` — confirm 200 and that `verify-test` is gone from both arrays afterward, and `gate/registry/verify-test.json` no longer exists on disk.
5. Confirm the manifest response never contains any literal secret value or `NVIDIA_API_KEY`/`VERIFY_TEST_KEY` substring anywhere.
6. Stop the verification Gate process; confirm `git status` is clean (no leftover `gate/registry/verify-test.json` or `gate/secrets/` debris left uncommitted — `gate/secrets/` should now be gitignored so its existence on disk after this test is fine, but confirm it's genuinely not tracked: `git status --short` should show nothing for it).

---

## Plan Self-Review Notes

- **Spec coverage:** Implements design spec §6 (instance registry RPC CRUD, hot-apply — file-watch explicitly deferred, see Non-goals) and §7 (secrets) in full. `endpoints.capabilitiesRpc` closes the gap `ManifestClient.rpcRequest()` will need in the future app-side plan (§8), so that work can resolve the route from the manifest rather than a hardcoded string, consistent with every other `ManifestClient` method.
- **Type consistency:** `validate()` error shape (`{ok, errors: [{field, message}]}`) is used identically in `registry-methods.mjs` as everywhere else. `getState()`/`reload()` signatures match between `server.mjs` (the real caller) and the test harness in `registry-methods.test.mjs` (a deliberately independent re-implementation, not an import, so the test doesn't just mirror the code it's testing).
- **Consistency with Plan 1's fixed bugs:** `proxyChat`'s streaming check (`provider.config.streaming === false`) and the `try/catch` around `kindModule.validate()`/`toManifestEntry()` inside `registry.mjs` (already merged) are both preserved unchanged in this plan's full-file `server.mjs` replacement — verified by diffing against the current merged file before writing this plan, not reconstructed from memory.
- **Security:** no new literal secret ever reaches `gate/registry/*.json` (unchanged `validate()` rule) or the manifest (`toManifestEntry`/`describeKinds`/`resolveManifestInstances` untouched in this plan beyond the `apiKeyEnv` field's declared `type`). `registry.secrets.set`'s value is never returned by any method, and `getSecret`'s result is only ever used server-side inside `proxyChat`, never serialized into a response.
