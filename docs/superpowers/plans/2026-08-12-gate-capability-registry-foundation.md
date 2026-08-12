# Gate Capability Registry — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gate's provider-only loader (`gate/core/providers.mjs` + `config.mjs`) with the generalized kind/instance registry loader from the design spec, migrating `provider` onto it with no functional behavior change.

**Architecture:** `gate/core/capabilities/registry.mjs` loads kind modules from `gate/core/capabilities/<kind>/kind.mjs` and instance configs from `gate/registry/<id>.json`, cross-validates them, and resolves both into the wire shapes `gate/core/manifest.mjs` needs. `provider` becomes the first (and for this plan, only) kind, at `gate/core/capabilities/provider/kind.mjs`, wrapping the exact validation and manifest-entry logic `config.mjs`/`providers.mjs` had. `server.mjs` swaps its loader call and keeps every existing HTTP route (`/v1/chat/completions`, `/p/{id}/...`, `/v1/models`) working unchanged.

**Tech Stack:** Node.js (`.mjs`, no build step), `node --test` + `node:assert/strict`.

**Related:** `docs/superpowers/specs/2026-08-12-gate-capability-registry-design.md` (§4, §5, §8 provider/child-sync note, §12 steps 1). This plan covers sequencing step 1 only — the generic RPC endpoint, secrets store, CLI/prompt generalization, and app-side changes are separate follow-on plans (steps 2–3 and 5–6 of the spec).

**Scope note:** `gate/providers/nvidia/provider.mjs` already exists and is committed (the design spec's claim that "nothing is configured yet" was accurate as of 2026-08-11 but is no longer true — an NVIDIA NIM provider was added since). Task 8 migrates it for real; this is not the no-op the spec assumed.

---

## File Structure

Create:
- `gate/core/capabilities/registry.mjs` — `loadKinds`, `loadInstances`, `describeKinds`, `resolveManifestInstances`, `loadCapabilities`
- `gate/core/capabilities/provider/kind.mjs` — the `provider` kind (validate, configFields, toManifestEntry, createHandlers)
- `gate/registry/nvidia.json` — migrated instance config
- `gate/__tests__/capabilities-registry.test.mjs`
- `gate/__tests__/provider-kind.test.mjs`

Modify:
- `gate/core/manifest.mjs` — `buildManifest()` takes `capabilityKinds`/`capabilityInstances` (already wire-shaped), derives legacy `providers[]` from instances of kind `provider`
- `gate/core/server.mjs` — `createGate()` calls `loadCapabilities()` instead of `loadProviders()`
- `gate/cli.mjs` — `handleAdd` scaffolds `gate/registry/<id>.json` instead of `gate/providers/<id>/provider.mjs`
- `gate/PROVIDER_PROMPT.md` — path/shape corrections only (full rename/generalization is a later plan)
- `gate/__tests__/manifest.test.mjs` — fixtures use the new `buildManifest()` signature
- `gate/__tests__/server.test.mjs` — `testSetup()` writes a registry JSON file instead of a provider directory
- `gate/__tests__/chat-route.test.mjs` — `gateWithStubProvider()` writes a registry JSON file instead of a provider directory

Delete:
- `gate/core/providers.mjs`, `gate/core/config.mjs`
- `gate/providers/nvidia/provider.mjs`, `gate/providers/.gitkeep` (and the now-empty `gate/providers/` directory)
- `gate/__tests__/providers.test.mjs`, `gate/__tests__/config.test.mjs`

---

### Task 1: `loadKinds` — discover and validate kind modules

**Files:**
- Create: `gate/core/capabilities/registry.mjs`
- Test: `gate/__tests__/capabilities-registry.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKinds } from '../core/capabilities/registry.mjs';

async function kindsDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-kinds-'));
  for (const [id, source] of Object.entries(entries)) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'kind.mjs'), source, 'utf8');
  }
  return root;
}

const goodKind = (id) => `
export default {
  kind: '${id}',
  label: '${id}',
  family: '${id}',
  configFields: [],
  validate(config) { return { ok: true, errors: [] }; },
  toManifestEntry(instance) { return { id: instance.id }; },
  createHandlers(instance) { return {}; },
};
`;

test('loads a valid kind', async () => {
  const root = await kindsDir({ cron: goodKind('cron') });
  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 1);
  assert.equal(kinds.get('cron').label, 'cron');
  assert.deepEqual(skipped, []);
});

test('skips a kind that throws on import, without losing the others', async () => {
  const root = await kindsDir({
    cron: goodKind('cron'),
    exploding: `throw new Error('boom');`,
  });

  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 1);
  assert.ok(kinds.has('cron'));
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'exploding');
  assert.match(skipped[0].reason, /boom/);
});

test('skips a kind missing a required export', async () => {
  const root = await kindsDir({
    broken: `export default { kind: 'broken', label: 'Broken' };`,
  });

  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /missing/);
});

test('returns empty rather than throwing when there are no kinds', async () => {
  const root = await kindsDir({});
  const { kinds, skipped } = await loadKinds(root);

  assert.equal(kinds.size, 0);
  assert.deepEqual(skipped, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: FAIL — `Cannot find module '../core/capabilities/registry.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REQUIRED_KIND_EXPORTS = [
  'kind', 'label', 'family', 'configFields', 'validate', 'toManifestEntry', 'createHandlers',
];

/**
 * Load all capability kind modules from a directory (one subdirectory per
 * kind, each containing kind.mjs). Skips invalid kinds and logs reasons
 * without crashing — the same discipline loadProviders() used.
 *
 * @param {string} root
 * @returns {Promise<{ kinds: Map<string, object>, skipped: Array<{id, reason}> }>}
 */
export async function loadKinds(root) {
  const kinds = new Map();
  const skipped = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { kinds, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirId = entry.name;
    const modulePath = join(root, dirId, 'kind.mjs');
    const moduleUrl = pathToFileURL(modulePath).href;

    let module;
    try {
      module = await import(moduleUrl);
    } catch (err) {
      skipped.push({ id: dirId, reason: err.message });
      continue;
    }

    const definition = module.default;
    if (!definition || typeof definition !== 'object') {
      skipped.push({ id: dirId, reason: 'kind.mjs must have a default export' });
      continue;
    }

    const missing = REQUIRED_KIND_EXPORTS.filter((key) => definition[key] === undefined);
    if (missing.length > 0) {
      skipped.push({ id: dirId, reason: `kind.mjs default export is missing: ${missing.join(', ')}` });
      continue;
    }

    kinds.set(definition.kind || dirId, definition);
  }

  return { kinds, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/registry.mjs gate/__tests__/capabilities-registry.test.mjs
git commit -m "feat(gate): add loadKinds capability kind loader"
```

---

### Task 2: `loadInstances` — discover, cross-validate, and reject reserved ids

**Files:**
- Modify: `gate/core/capabilities/registry.mjs`
- Test: `gate/__tests__/capabilities-registry.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/capabilities-registry.test.mjs`:

```js
import { loadInstances } from '../core/capabilities/registry.mjs';

function fakeKinds(overrides = {}) {
  const kinds = new Map();
  kinds.set('cron', {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [],
    validate: overrides.validate ?? (() => ({ ok: true, errors: [] })),
    toManifestEntry: (instance) => ({ id: instance.id }),
    createHandlers: () => ({}),
  });
  return kinds;
}

async function registryDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-registry-'));
  for (const [filename, contents] of Object.entries(entries)) {
    await writeFile(join(root, filename), typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  }
  return root;
}

test('loads a valid instance referencing a known kind', async () => {
  const root = await registryDir({
    'standup.json': { kind: 'cron', label: 'Standup reminder', config: { schedule: '0 9 * * 1-5' } },
  });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0], {
    id: 'standup',
    kind: 'cron',
    label: 'Standup reminder',
    config: { schedule: '0 9 * * 1-5' },
  });
  assert.deepEqual(skipped, []);
});

test('skips an instance referencing an unknown kind', async () => {
  const root = await registryDir({
    'ghost.json': { kind: 'nonexistent', label: 'Ghost', config: {} },
  });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /unknown kind/);
});

test('skips an instance that fails its kind\'s validate()', async () => {
  const root = await registryDir({
    'bad.json': { kind: 'cron', label: 'Bad', config: {} },
  });
  const kinds = fakeKinds({ validate: () => ({ ok: false, errors: [{ field: 'schedule', message: 'is required' }] }) });
  const { instances, skipped } = await loadInstances(root, kinds);

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /schedule: is required/);
});

test('skips malformed JSON without crashing', async () => {
  const root = await registryDir({ 'broken.json': '{ not valid json' });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /invalid JSON/);
});

test('rejects the reserved instance id "registry"', async () => {
  const root = await registryDir({
    'registry.json': { kind: 'cron', label: 'Should not load', config: {} },
  });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.equal(instances.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'registry');
  assert.match(skipped[0].reason, /reserved/);
});

test('ignores non-.json files in the registry directory', async () => {
  const root = await registryDir({ 'readme.md': '# not an instance' });
  const { instances, skipped } = await loadInstances(root, fakeKinds());

  assert.deepEqual(instances, []);
  assert.deepEqual(skipped, []);
});

test('returns instances sorted by id', async () => {
  const root = await registryDir({
    'zzz.json': { kind: 'cron', label: 'Z', config: {} },
    'aaa.json': { kind: 'cron', label: 'A', config: {} },
  });
  const { instances } = await loadInstances(root, fakeKinds());

  assert.deepEqual(instances.map((i) => i.id), ['aaa', 'zzz']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: FAIL — `loadInstances is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `gate/core/capabilities/registry.mjs`:

```js
const RESERVED_INSTANCE_IDS = new Set(['registry']);

/**
 * Load all capability instance configs from a directory (one <id>.json file
 * per instance), cross-validated against already-loaded kinds. Skips
 * invalid instances and logs reasons without crashing.
 *
 * @param {string} root
 * @param {Map<string, object>} kinds - result of loadKinds()
 * @returns {Promise<{ instances: Array, skipped: Array<{id, reason}> }>}
 */
export async function loadInstances(root, kinds) {
  const instances = [];
  const skipped = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { instances, skipped };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);

    if (RESERVED_INSTANCE_IDS.has(id)) {
      skipped.push({ id, reason: `instance id "${id}" is reserved for built-in registry methods` });
      continue;
    }

    let raw;
    try {
      raw = await readFile(join(root, entry.name), 'utf8');
    } catch (err) {
      skipped.push({ id, reason: err.message });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      skipped.push({ id, reason: `invalid JSON: ${err.message}` });
      continue;
    }

    const { kind, label, config } = parsed ?? {};
    const kindModule = kinds.get(kind);
    if (!kindModule) {
      skipped.push({ id, reason: `unknown kind "${kind}"` });
      continue;
    }

    const validation = kindModule.validate(config ?? {});
    if (!validation.ok) {
      skipped.push({ id, reason: validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ') });
      continue;
    }

    instances.push({ id, kind, label: label ?? id, config: config ?? {} });
  }

  instances.sort((a, b) => a.id.localeCompare(b.id));
  return { instances, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: PASS (11 tests total)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/registry.mjs gate/__tests__/capabilities-registry.test.mjs
git commit -m "feat(gate): add loadInstances with kind cross-validation and reserved-id check"
```

---

### Task 3: `describeKinds` and `resolveManifestInstances` — wire-shape helpers

**Files:**
- Modify: `gate/core/capabilities/registry.mjs`
- Test: `gate/__tests__/capabilities-registry.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/capabilities-registry.test.mjs`:

```js
import { describeKinds, resolveManifestInstances } from '../core/capabilities/registry.mjs';

test('describeKinds exposes only the wire-safe kind fields', () => {
  const kinds = fakeKinds();
  const described = describeKinds(kinds);

  assert.deepEqual(described, [
    { id: 'cron', label: 'Cron', family: 'cron', configFields: [] },
  ]);
});

test('resolveManifestInstances attaches family and calls toManifestEntry', () => {
  const kinds = fakeKinds();
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' } }];

  const resolved = resolveManifestInstances(kinds, instances);

  assert.deepEqual(resolved, [
    { id: 'standup', kind: 'cron', label: 'Standup', family: 'cron', manifestEntry: { id: 'standup' } },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: FAIL — `describeKinds is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `gate/core/capabilities/registry.mjs`:

```js
/** Wire-safe kind catalog: drops the function properties, keeps the schema. */
export function describeKinds(kinds) {
  return [...kinds.values()].map((k) => ({
    id: k.kind,
    label: k.label,
    family: k.family,
    configFields: k.configFields,
  }));
}

/** Wire-safe instance list: each instance's manifest contribution, resolved via its kind. */
export function resolveManifestInstances(kinds, instances) {
  return instances.map((instance) => {
    const kindModule = kinds.get(instance.kind);
    return {
      id: instance.id,
      kind: instance.kind,
      label: instance.label,
      family: kindModule.family,
      manifestEntry: kindModule.toManifestEntry(instance),
    };
  });
}

/** Load kinds and instances together from a Gate root directory. */
export async function loadCapabilities(root) {
  const { kinds, skipped: skippedKinds } = await loadKinds(join(root, 'core', 'capabilities'));
  const { instances, skipped: skippedInstances } = await loadInstances(join(root, 'registry'), kinds);
  return { kinds, instances, skippedKinds, skippedInstances };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/registry.mjs gate/__tests__/capabilities-registry.test.mjs
git commit -m "feat(gate): add describeKinds, resolveManifestInstances, loadCapabilities"
```

---

### Task 4: `provider` kind — `validate()` and `configFields`

**Files:**
- Create: `gate/core/capabilities/provider/kind.mjs`
- Test: `gate/__tests__/provider-kind.test.mjs`

This ports `gate/core/config.mjs`'s `validateProviderConfig` body exactly (same rules, same fields), reshaped to return `{ ok, errors: [{field, message}] }` instead of a single string, per the design spec §5 kind contract.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import providerKind from '../core/capabilities/provider/kind.mjs';

const valid = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  streaming: true,
};

test('exposes the required kind contract fields', () => {
  assert.equal(providerKind.kind, 'provider');
  assert.equal(typeof providerKind.label, 'string');
  assert.equal(typeof providerKind.family, 'string');
  assert.ok(Array.isArray(providerKind.configFields));
});

test('accepts a well-formed config', () => {
  const result = providerKind.validate(valid);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('rejects an unknown flavor, naming the field', () => {
  const result = providerKind.validate({ ...valid, flavor: 'banana' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'flavor');
});

test('rejects a literal apiKey so secrets cannot reach the registry file', () => {
  const result = providerKind.validate({ ...valid, apiKeyEnv: undefined, apiKey: 'sk-live-abc123' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'apiKey'));
  assert.ok(result.errors.some((e) => e.field === 'apiKeyEnv'));
});

test('rejects an empty model list, naming the field', () => {
  const result = providerKind.validate({ ...valid, models: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'models');
});

test('rejects a non-https base URL for a public provider', () => {
  const result = providerKind.validate({ ...valid, baseUrl: 'http://api.x.ai/v1' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'baseUrl');
});

test('accepts http on loopback for local testing', () => {
  const result = providerKind.validate({ ...valid, baseUrl: 'http://127.0.0.1:9999/v1' });
  assert.equal(result.ok, true);
});

test('collects every violated rule, not just the first', () => {
  const result = providerKind.validate({ flavor: 'banana', models: [] });
  assert.equal(result.ok, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('flavor'));
  assert.ok(fields.includes('models'));
  assert.ok(fields.includes('apiKeyEnv'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/provider-kind.test.mjs`
Expected: FAIL — `Cannot find module '../core/capabilities/provider/kind.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
const FLAVORS = ['openai', 'anthropic', 'custom'];

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function validate(config) {
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: [{ field: 'config', message: 'must be an object' }] };
  }

  const errors = [];

  if (!FLAVORS.includes(config.flavor)) {
    errors.push({ field: 'flavor', message: `must be one of [${FLAVORS.join(', ')}], got ${config.flavor}` });
  }

  if (!config.apiKeyEnv || typeof config.apiKeyEnv !== 'string') {
    errors.push({ field: 'apiKeyEnv', message: 'must be a non-empty string naming the environment variable' });
  }

  if (config.apiKey !== undefined) {
    errors.push({ field: 'apiKey', message: 'literal apiKey is not allowed; use apiKeyEnv instead' });
  }

  if (!Array.isArray(config.models) || config.models.length === 0) {
    errors.push({ field: 'models', message: 'must be a non-empty array' });
  }

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push({ field: 'baseUrl', message: 'must be a non-empty string' });
  } else {
    let hostname;
    try {
      hostname = new URL(config.baseUrl).hostname;
    } catch {
      errors.push({ field: 'baseUrl', message: 'must be a valid URL' });
      hostname = undefined;
    }
    if (hostname !== undefined && !config.baseUrl.startsWith('https://') && !isLoopback(hostname)) {
      errors.push({ field: 'baseUrl', message: 'must use https, not http' });
    }
  }

  return { ok: errors.length === 0, errors };
}

export default {
  kind: 'provider',
  label: 'Model provider',
  family: 'provider',
  configFields: [
    { key: 'flavor', label: 'Flavor', type: 'enum', required: true, options: FLAVORS },
    { key: 'baseUrl', label: 'Base URL', type: 'string', required: true },
    { key: 'apiKeyEnv', label: 'API key environment variable', type: 'string', required: true },
    { key: 'models', label: 'Models', type: 'string-list', required: true },
    { key: 'streaming', label: 'Supports streaming', type: 'boolean', default: true },
  ],
  validate,
};
```

Note: `toManifestEntry` and `createHandlers` are added in Task 5 — `loadKinds`'s required-export check means this file will fail to load until then, which is fine since nothing references it yet.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/provider-kind.test.mjs`
Expected: FAIL — the contract test (`exposes the required kind contract fields`) still fails because `toManifestEntry`/`createHandlers` are undefined. This is expected; Task 5 completes the file. Confirm the other 7 validate() tests pass.

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/provider/kind.mjs gate/__tests__/provider-kind.test.mjs
git commit -m "feat(gate): add provider kind validate(), ported from validateProviderConfig"
```

---

### Task 5: `provider` kind — `toManifestEntry()` and `createHandlers()`

**Files:**
- Modify: `gate/core/capabilities/provider/kind.mjs`
- Test: `gate/__tests__/provider-kind.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/provider-kind.test.mjs`:

```js
test('toManifestEntry produces the same shape the old manifest.providers[] entry had', () => {
  const instance = {
    id: 'claude',
    kind: 'provider',
    label: 'Claude',
    config: { flavor: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', models: ['claude-opus-5'], streaming: true },
  };

  assert.deepEqual(providerKind.toManifestEntry(instance), {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
  });
});

test('toManifestEntry never includes apiKeyEnv or baseUrl', () => {
  const instance = {
    id: 'claude',
    kind: 'provider',
    label: 'Claude',
    config: { flavor: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', models: ['claude-opus-5'], streaming: true },
  };

  const serialized = JSON.stringify(providerKind.toManifestEntry(instance));
  assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('toManifestEntry defaults streaming to true when omitted', () => {
  const instance = { id: 'x', label: 'X', config: { models: ['m'] } };
  assert.equal(providerKind.toManifestEntry(instance).capabilities.streaming, true);
});

test('toManifestEntry respects streaming: false', () => {
  const instance = { id: 'x', label: 'X', config: { models: ['m'], streaming: false } };
  assert.equal(providerKind.toManifestEntry(instance).capabilities.streaming, false);
});

test('createHandlers returns no RPC methods — chat is served over the dedicated HTTP routes', () => {
  assert.deepEqual(providerKind.createHandlers({ id: 'claude' }), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/provider-kind.test.mjs`
Expected: FAIL — `providerKind.toManifestEntry is not a function`

- [ ] **Step 3: Write minimal implementation**

In `gate/core/capabilities/provider/kind.mjs`, add above the `export default`:

```js
function toManifestEntry(instance) {
  return {
    id: instance.id,
    label: instance.label,
    basePath: `/p/${instance.id}`,
    models: instance.config.models,
    capabilities: { chat: true, streaming: instance.config.streaming !== false },
  };
}

function createHandlers() {
  return {};
}
```

And add both to the default export object:

```js
export default {
  kind: 'provider',
  label: 'Model provider',
  family: 'provider',
  configFields: [
    { key: 'flavor', label: 'Flavor', type: 'enum', required: true, options: FLAVORS },
    { key: 'baseUrl', label: 'Base URL', type: 'string', required: true },
    { key: 'apiKeyEnv', label: 'API key environment variable', type: 'string', required: true },
    { key: 'models', label: 'Models', type: 'string-list', required: true },
    { key: 'streaming', label: 'Supports streaming', type: 'boolean', default: true },
  ],
  validate,
  toManifestEntry,
  createHandlers,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/provider-kind.test.mjs`
Expected: PASS (13 tests total, including the Task 4 contract test that was failing)

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/provider/kind.mjs gate/__tests__/provider-kind.test.mjs
git commit -m "feat(gate): complete provider kind with toManifestEntry and createHandlers"
```

---

### Task 6: Rewrite `buildManifest()` to consume kinds/instances

**Files:**
- Modify: `gate/core/manifest.mjs`
- Modify: `gate/__tests__/manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Replace the contents of `gate/__tests__/manifest.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

const capabilityKinds = [
  { id: 'provider', label: 'Model provider', family: 'provider', configFields: [{ key: 'flavor', label: 'Flavor', type: 'enum', required: true, options: ['openai', 'anthropic', 'custom'] }] },
];

const capabilityInstances = [
  {
    id: 'claude',
    kind: 'provider',
    label: 'Claude',
    family: 'provider',
    manifestEntry: { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true, streaming: true } },
  },
];

test('declares the manifest spec version and kind', () => {
  const manifest = buildManifest({ name: "Ethan's Gate", capabilityKinds, capabilityInstances });
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
  assert.equal(manifest.kind, 'versutus-gate');
  assert.equal(manifest.name, "Ethan's Gate");
});

test('advertises design-spec transport, endpoints, and capabilities', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.deepEqual(manifest.transport, { primary: 'http' });
  assert.deepEqual(manifest.endpoints, {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
  });
  assert.deepEqual(manifest.capabilities, { chat: true, models: true });
});

test('derives providers[] from capabilityInstances of kind provider, in the legacy shape', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.equal(manifest.providers.length, 1);
  assert.deepEqual(manifest.providers[0], {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
  });
});

test('excludes non-provider instances from the legacy providers[] array', () => {
  const mixed = [
    ...capabilityInstances,
    { id: 'standup', kind: 'cron', label: 'Standup', family: 'cron', manifestEntry: { id: 'standup', schedule: '0 9 * * 1-5' } },
  ];
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances: mixed });
  assert.equal(manifest.providers.length, 1);
  assert.equal(manifest.providers[0].id, 'claude');
});

test('advertises capabilityKinds and capabilityInstances verbatim', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.deepEqual(manifest.capabilityKinds, capabilityKinds);
  assert.deepEqual(manifest.capabilityInstances, capabilityInstances);
});

test('never leaks the API key env var name or base URL to the client', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('advertises the signed access path so the app can pair', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.equal(manifest.auth.grantPath, '/.well-known/gateway/access');
  assert.ok(manifest.auth.schemes.includes('bearer'));
});

test('serves a valid manifest with nothing configured', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] });
  assert.deepEqual(manifest.providers, []);
  assert.deepEqual(manifest.capabilityKinds, []);
  assert.deepEqual(manifest.capabilityInstances, []);
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/manifest.test.mjs`
Expected: FAIL — `providers[0]` assertions fail (old `buildManifest` doesn't accept `capabilityInstances` and ignores it, so `manifest.providers` is `[]`); `capabilityKinds`/`capabilityInstances` assertions fail with `undefined`.

- [ ] **Step 3: Write minimal implementation**

Replace `gate/core/manifest.mjs`:

```js
/**
 * Manifest builder for Versutus Gateway.
 * Assembles the gateway's advertised transport, capability kinds, and
 * capability instances. `providers[]` is derived from instances of kind
 * `provider` for backward compatibility with child-profile sync — see
 * docs/superpowers/specs/2026-08-12-gate-capability-registry-design.md §8.
 */

export const MANIFEST_SPEC = 'versutus-gateway/v1';
export const GATE_KIND = 'versutus-gate';

/**
 * @param {Object} options
 * @param {string} options.name
 * @param {string} [options.version]
 * @param {Array<Object>} [options.capabilityKinds] - wire-shaped, from describeKinds()
 * @param {Array<Object>} [options.capabilityInstances] - wire-shaped, from resolveManifestInstances()
 */
export function buildManifest({ name, version, capabilityKinds = [], capabilityInstances = [] }) {
  const providers = capabilityInstances
    .filter((instance) => instance.kind === 'provider')
    .map((instance) => instance.manifestEntry);

  const manifest = {
    manifest: MANIFEST_SPEC,
    kind: GATE_KIND,
    name,
    transport: { primary: 'http' },
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    },
    capabilities: { chat: true, models: true },
    providers,
    capabilityKinds,
    capabilityInstances,
    auth: {
      grantPath: '/.well-known/gateway/access',
      schemes: ['bearer'],
    },
  };

  if (version) {
    manifest.version = version;
  }

  return manifest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/manifest.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add gate/core/manifest.mjs gate/__tests__/manifest.test.mjs
git commit -m "feat(gate): buildManifest consumes capabilityKinds/capabilityInstances, derives legacy providers[]"
```

---

### Task 7: Wire `server.mjs` to the new loader

**Files:**
- Modify: `gate/core/server.mjs`
- Modify: `gate/__tests__/server.test.mjs`
- Modify: `gate/__tests__/chat-route.test.mjs`

`proxyChat` and every HTTP route in `server.mjs` reference a local `providers` array shaped `{id, label, config, module}[]` (e.g. `provider.config.models`, `provider.config.flavor`, `provider.config.apiKeyEnv`). Rather than rewrite every route, `createGate()` builds that exact same shape from the new instances list, so the routing code below the loader swap is untouched.

- [ ] **Step 1: Write the failing test**

In `gate/__tests__/server.test.mjs`, replace `testSetup()`:

```js
async function testSetup() {
  const root = await mkdtemp(join(tmpdir(), 'gate-server-test-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(
    join(process.cwd(), 'gate', 'core', 'capabilities', 'provider', 'kind.mjs'),
    join(root, 'core', 'capabilities', 'provider', 'kind.mjs'),
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'test-provider.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'Test Provider',
      config: {
        flavor: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'TEST_KEY',
        models: ['test-model-1', 'test-model-2'],
        streaming: true,
      },
    }),
    'utf8',
  );
  return root;
}
```

Add `copyFile` to the existing `node:fs/promises` import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/server.test.mjs`
Expected: FAIL — `authenticated models endpoint returns all provider models` and similar fail because `createGate()` still calls `loadProviders(join(root, 'providers'))`, which finds nothing under the new `registry/` layout.

- [ ] **Step 3: Write minimal implementation**

In `gate/core/server.mjs`, replace the imports and the provider-loading section of `createGate()`:

```js
import { loadCapabilities, describeKinds, resolveManifestInstances } from './capabilities/registry.mjs';
```
(remove `import { loadProviders } from './providers.mjs';`)

Replace:
```js
  const providersDir = join(root, 'providers');
  const tokenPath = join(root, '.tokens.json');

  // Load providers from the specified directory
  const { providers } = await loadProviders(providersDir);
```
with:
```js
  const tokenPath = join(root, '.tokens.json');

  // Load capability kinds + instances, then adapt provider instances into
  // the { id, label, config, module } shape the chat/models routes below
  // already expect — those routes are otherwise unchanged.
  const { kinds, instances } = await loadCapabilities(root);
  const providers = instances
    .filter((instance) => instance.kind === 'provider')
    .map((instance) => ({ id: instance.id, label: instance.label, config: instance.config }));
```

Replace the manifest-building section:
```js
  // Build manifest
  const manifest = buildManifest({
    name,
    version,
    providers,
  });
```
with:
```js
  // Build manifest
  const manifest = buildManifest({
    name,
    version,
    capabilityKinds: describeKinds(kinds),
    capabilityInstances: resolveManifestInstances(kinds, instances),
  });
```

One more required change: `proxyChat` currently checks `provider.config.capabilities?.streaming !== true` to gate streaming (the pre-existing nested shape). The new `provider` kind config is flat (`config.streaming`, set by Task 4/5's `configFields` and read the same way by `toManifestEntry`) — left as `capabilities?.streaming`, this check would always see `undefined` and reject every streaming request. In `server.mjs`, change:

```js
  if (wantsStream && provider.config.capabilities?.streaming !== true) {
```
to:
```js
  if (wantsStream && provider.config.streaming !== true) {
```

Every other route handler references `provider.config.*` fields that didn't change shape (`models`, `flavor`, `apiKeyEnv`, `baseUrl`) — no further changes needed in `server.mjs` for this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/server.test.mjs`
Expected: PASS (10 tests)

- [ ] **Step 5: Fix `chat-route.test.mjs` the same way**

Replace `gateWithStubProvider()` in `gate/__tests__/chat-route.test.mjs`:

```js
async function gateWithStubProvider(upstreamBaseUrl, capabilities = { streaming: true }) {
  const root = await mkdtemp(join(tmpdir(), 'gate-chat-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(
    join(process.cwd(), 'gate', 'core', 'capabilities', 'provider', 'kind.mjs'),
    join(root, 'core', 'capabilities', 'provider', 'kind.mjs'),
  );
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(
    join(root, 'registry', 'stub.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'Stub',
      config: {
        flavor: 'openai',
        baseUrl: upstreamBaseUrl,
        apiKeyEnv: 'STUB_KEY',
        models: ['stub-1'],
        streaming: capabilities.streaming,
      },
    }),
    'utf8',
  );
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({ root, port: 0 });
  return gate;
}
```

Add `copyFile` to the `node:fs/promises` import, and update the one call site that passes `{ chat: true, streaming: false }`:

```js
const gate = await gateWithStubProvider(upstream.baseUrl, { streaming: false });
```
(drop the now-meaningless `chat: true` key — `provider` kind's `toManifestEntry` always sets `chat: true`).

Run: `node --test gate/__tests__/chat-route.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the full gate suite to confirm nothing else broke**

Run: `npm run test:gate`
Expected: All test files pass except `providers.test.mjs` and `config.test.mjs`, which still import the modules Task 8 deletes — confirm those are the *only* failures before proceeding.

- [ ] **Step 7: Commit**

```bash
git add gate/core/server.mjs gate/__tests__/server.test.mjs gate/__tests__/chat-route.test.mjs
git commit -m "feat(gate): wire server.mjs to the capability registry loader"
```

---

### Task 8: Migrate `nvidia`, delete the old loader, update the CLI and prompt doc

**Files:**
- Create: `gate/registry/nvidia.json`
- Delete: `gate/providers/nvidia/provider.mjs`, `gate/providers/.gitkeep`, `gate/core/providers.mjs`, `gate/core/config.mjs`, `gate/__tests__/providers.test.mjs`, `gate/__tests__/config.test.mjs`
- Modify: `gate/cli.mjs`
- Modify: `gate/PROVIDER_PROMPT.md`

- [ ] **Step 1: Migrate the nvidia provider**

Create `gate/registry/nvidia.json`:

```json
{
  "kind": "provider",
  "label": "NVIDIA NIM",
  "config": {
    "flavor": "openai",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "apiKeyEnv": "NVIDIA_API_KEY",
    "models": ["deepseek-ai/deepseek-v4-flash-0731", "meta/llama-3.1-8b-instruct"],
    "streaming": true
  }
}
```

- [ ] **Step 2: Delete the old provider directory and loader**

```bash
git rm -r gate/providers gate/core/providers.mjs gate/core/config.mjs gate/__tests__/providers.test.mjs gate/__tests__/config.test.mjs
git add gate/registry/nvidia.json
```

- [ ] **Step 3: Update `gate/cli.mjs` to scaffold registry JSON instead of a provider directory**

Replace `getProviderTemplate`:

```js
function getInstanceTemplate(id, flavor) {
  const label = id.charAt(0).toUpperCase() + id.slice(1);
  return JSON.stringify({
    kind: 'provider',
    label,
    config: {
      flavor,
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      models: ['model-id-here'],
      streaming: true,
    },
  }, null, 2) + '\n';
}
```

Replace the body of `handleAdd` from the directory-creation point onward:

```js
  const registryDir = join(__dirname, 'registry');
  const instanceFile = join(registryDir, `${id}.json`);

  // Check if instance already exists
  try {
    await access(instanceFile);
    console.error(`Error: instance "${id}" already exists at ${instanceFile}`);
    process.exit(1);
  } catch {
    // Instance does not exist, which is what we want
  }

  // Create registry instance file
  try {
    await mkdir(registryDir, { recursive: true });
    const template = getInstanceTemplate(id, flavor);
    await writeFile(instanceFile, template, 'utf-8');
    console.log(`Created instance "${id}" at ${instanceFile}`);
  } catch (err) {
    console.error(`Error creating instance: ${err.message}`);
    process.exit(1);
  }
```

Update the help text line:
```js
    console.log('  add <id> --flavor <openai|anthropic|custom>');
    console.log('    Scaffold a new provider instance in gate/registry/<id>.json');
```

- [ ] **Step 4: Verify the CLI scaffold manually**

```bash
node gate/cli.mjs add test-scaffold --flavor openai
cat gate/registry/test-scaffold.json
```
Expected: prints a JSON file matching the template shape, `kind: "provider"`.

Clean up the manual test artifact:
```bash
rm gate/registry/test-scaffold.json
```

- [ ] **Step 5: Correct `gate/PROVIDER_PROMPT.md`**

Update the "Overview" and "Creating a New Provider" sections to reflect the new layout — replace:

```
Each provider is a directory under `gate/providers/<id>/` containing a `provider.mjs` file. The Gate loads these providers at startup and exposes their models through the gateway manifest.
```
with:
```
Each provider is a JSON file at `gate/registry/<id>.json`. The Gate loads every instance in `gate/registry/` at startup and exposes provider models through the gateway manifest.
```

Replace:
```
This creates `gate/providers/<id>/provider.mjs` with a template.
```
with:
```
This creates `gate/registry/<id>.json` with a template.
```

Update the "Full Example" section's file paths (`gate/providers/openai-prod/provider.mjs` → `gate/registry/openai-prod.json`, etc.) and JS code fences to the JSON shape from Step 3's template. Update the "Troubleshooting" section's path reference (`gate/providers/<id>/provider.mjs` → `gate/registry/<id>.json`).

This is a documentation-only change with no test coverage; a full rename to `CAPABILITY_PROMPT.md` and multi-kind generalization happens in a later plan.

- [ ] **Step 6: Run the full gate suite**

Run: `npm run test:gate`
Expected: PASS, all files, zero failures.

- [ ] **Step 7: Commit**

```bash
git add gate/cli.mjs gate/PROVIDER_PROMPT.md
git commit -m "chore(gate): migrate nvidia to the registry, retire the old provider loader"
```

---

### Task 9: End-to-end manual verification

**Files:** none (manual smoke test)

- [ ] **Step 1: Start the Gate**

```bash
NVIDIA_API_KEY=test-placeholder node gate/cli.mjs start
```
Expected output includes a `Token:` line and `Manifest: http://127.0.0.1:8760/.well-known/gateway.json`.

- [ ] **Step 2: Fetch the manifest in a second terminal and confirm the new shape**

```bash
curl -s http://127.0.0.1:8760/.well-known/gateway.json
```
Expected: JSON containing `"providers":[{"id":"nvidia","label":"NVIDIA NIM",...}]`, plus `"capabilityKinds":[{"id":"provider",...}]` and `"capabilityInstances":[{"id":"nvidia","kind":"provider",...}]`. Confirm `NVIDIA_API_KEY` and `integrate.api.nvidia.com` do not appear anywhere in the output.

- [ ] **Step 3: Confirm authenticated models still works**

```bash
curl -s -H "Authorization: Bearer <token from step 1>" http://127.0.0.1:8760/v1/models
```
Expected: `data[]` includes `deepseek-ai/deepseek-v4-flash-0731` and `meta/llama-3.1-8b-instruct`.

- [ ] **Step 4: Stop the Gate**

`Ctrl+C` in the terminal from Step 1.

No commit — this task only confirms Tasks 1–8 add up to working software.

---

## Plan Self-Review Notes

- **Spec coverage**: This plan implements design spec §4 (vocabulary/layout), §5 (kind contract, minus `commands`, which no kind in this plan uses yet), and the `provider`/child-sync carve-out from §8. It deliberately does **not** implement §6 (RPC CRUD/hot-apply), §7 (secrets), the rest of §8 (app-side consumption), or §9 (full CLI `add-kind` generalization) — those are follow-on plans, matching spec §12's own step numbering (this plan is step 1).
- **Type consistency**: `validate()` returns `{ok, errors: [{field, message}]}` everywhere (registry.mjs, provider/kind.mjs, and every test) — no lingering single-string `error` field from the old `validateProviderConfig` shape.
- **`FieldDescriptor` gap found while writing this plan**: the design spec's `type` union (`'string' | 'number' | 'boolean' | 'enum' | 'secret-ref'`) has no array type, but `provider.models` is a `string[]`. Fixed by adding `'string-list'` to the spec's `FieldDescriptor.type` union directly (§5) rather than silently diverging from the committed design doc.
- **`proxyChat`/streaming bug found while writing this plan**: flattening `capabilities.streaming` to a top-level `streaming` config field (Tasks 4–5) is inconsistent with `server.mjs`'s pre-existing `provider.config.capabilities?.streaming !== true` check, which would silently reject streaming for every provider once the loader swap landed. Task 7 now includes the corresponding `proxyChat` edit (`provider.config.streaming !== true`) as a required step, not an optional cleanup.
