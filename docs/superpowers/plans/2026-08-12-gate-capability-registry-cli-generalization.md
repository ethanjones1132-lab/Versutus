# Gate Capability Registry — CLI Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize `gate/cli.mjs`'s `add` command from provider-only (`--flavor`) to any kind (`--kind`), add a new `add-kind` command for scaffolding brand-new capability kinds, and rewrite `PROVIDER_PROMPT.md` into `CAPABILITY_PROMPT.md` describing both.

**Architecture:** A new `gate/core/cli-helpers.mjs` holds the pure, testable logic (id validation, per-field-type template placeholders, kind-module scaffold text) — `cli.mjs` itself stays a thin script wrapper, since it calls `main()` unconditionally at load time and can't be safely imported by a test file. `add` dynamically imports the target kind's module to read its `configFields` and generates an instance template with one entry per declared field, instead of a hardcoded provider-shaped template. `add-kind` scaffolds a `kind.mjs` stub with the five required exports as empty holes to fill in, mirroring exactly how `add` today scaffolds a provider config's holes.

**Tech Stack:** Node.js (`.mjs`, no build step), `node --test` + `node:assert/strict`.

**Related:** `docs/superpowers/specs/2026-08-12-gate-capability-registry-design.md` §9. This plan covers spec sequencing step 3, the last purely Gate-side piece — app-side (Versutus client) consumption (§8) remains a separate follow-on plan.

**Non-goals:**
- No changes to `gate/core/server.mjs`, `gate/core/manifest.mjs`, or any `gate/core/capabilities/*` runtime module — this plan only touches the CLI and its docs.
- No preservation of the old provider-specific scaffold defaults (`baseUrl: 'https://api.example.com/v1'`, a derived `apiKeyEnv` name, a placeholder model id). The new generic template uses each field's declared `default` or a type-appropriate empty placeholder — this is a deliberate, expected consequence of the CLI no longer knowing anything provider-specific, not a regression to special-case around.
- No automated tests for `cli.mjs`'s argv-parsing/`process.exit` behavior itself, matching this project's existing convention (there has never been a `cli.test.mjs`) — the new pure logic in `cli-helpers.mjs` gets full test coverage instead, and the CLI's end-to-end behavior gets one manual verification pass (Task 4).
- No `registry.kinds.*` RPC-driven scaffolding (e.g., an app-triggered "create a new kind" flow) — `add-kind` is explicitly the rare, local, code-writing path; anything RPC-reachable stays config-only, per the design spec's own kind/instance split.

---

## File Structure

Create:
- `gate/core/cli-helpers.mjs` — `validateId`, `templateValueForField`, `buildInstanceConfigTemplate`, `getKindTemplate`
- `gate/__tests__/cli-helpers.test.mjs`
- `gate/CAPABILITY_PROMPT.md` — replaces `gate/PROVIDER_PROMPT.md`

Modify:
- `gate/cli.mjs` — `add` generalized to `--kind`, new `add-kind` command, help text updated
- `README.md` — provider-scaffolding line updated (`--flavor` → `--kind provider`)

Delete:
- `gate/PROVIDER_PROMPT.md` (replaced by `gate/CAPABILITY_PROMPT.md`)

---

### Task 1: `cli-helpers.mjs` — pure scaffold logic

**Files:**
- Create: `gate/core/cli-helpers.mjs`
- Test: `gate/__tests__/cli-helpers.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateId,
  templateValueForField,
  buildInstanceConfigTemplate,
  getKindTemplate,
} from '../core/cli-helpers.mjs';

test('validateId accepts lowercase alphanumeric with hyphens', () => {
  assert.equal(validateId('my-kind-1'), true);
});

test('validateId rejects uppercase, spaces, and empty', () => {
  assert.equal(validateId('My-Kind'), false);
  assert.equal(validateId('bad id'), false);
  assert.equal(validateId(''), false);
  assert.equal(validateId(undefined), false);
});

test('templateValueForField uses the declared default when present', () => {
  assert.equal(templateValueForField({ type: 'boolean', default: true }), true);
  assert.equal(templateValueForField({ type: 'string', default: 'x' }), 'x');
});

test('templateValueForField returns a type-appropriate placeholder when no default', () => {
  assert.equal(templateValueForField({ type: 'string' }), '');
  assert.deepEqual(templateValueForField({ type: 'string-list' }), []);
  assert.equal(templateValueForField({ type: 'number' }), 0);
  assert.equal(templateValueForField({ type: 'boolean' }), false);
  assert.equal(templateValueForField({ type: 'secret-ref' }), 'ENV_VAR_NAME_HERE');
});

test('templateValueForField uses the first enum option when no default', () => {
  assert.equal(templateValueForField({ type: 'enum', options: ['a', 'b'] }), 'a');
});

test('templateValueForField falls back to empty string for an enum with no options', () => {
  assert.equal(templateValueForField({ type: 'enum' }), '');
});

test('buildInstanceConfigTemplate builds one entry per configField, keyed correctly', () => {
  const configFields = [
    { key: 'flavor', type: 'enum', options: ['openai', 'anthropic'] },
    { key: 'apiKeyEnv', type: 'secret-ref' },
    { key: 'models', type: 'string-list' },
    { key: 'streaming', type: 'boolean', default: true },
  ];
  assert.deepEqual(buildInstanceConfigTemplate(configFields), {
    flavor: 'openai',
    apiKeyEnv: 'ENV_VAR_NAME_HERE',
    models: [],
    streaming: true,
  });
});

test('buildInstanceConfigTemplate returns an empty object for no fields', () => {
  assert.deepEqual(buildInstanceConfigTemplate([]), {});
  assert.deepEqual(buildInstanceConfigTemplate(undefined), {});
});

test('getKindTemplate produces importable ESM naming the given kind/label/family', () => {
  const source = getKindTemplate('cron', 'Scheduled jobs', 'cron');
  assert.match(source, /kind: 'cron'/);
  assert.match(source, /label: 'Scheduled jobs'/);
  assert.match(source, /family: 'cron'/);
  assert.match(source, /export default \{/);
});

test('getKindTemplate output is actually valid, importable JS', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const dir = await mkdtemp(join(tmpdir(), 'cli-helpers-kind-'));
  const filePath = join(dir, 'kind.mjs');
  await writeFile(filePath, getKindTemplate('cron', 'Scheduled jobs', 'cron'), 'utf8');

  const module = await import(pathToFileURL(filePath).href);
  assert.equal(module.default.kind, 'cron');
  assert.equal(module.default.label, 'Scheduled jobs');
  assert.equal(module.default.family, 'cron');
  assert.deepEqual(module.default.configFields, []);
  assert.deepEqual(module.default.validate({}), { ok: true, errors: [] });
  assert.deepEqual(module.default.createHandlers({ id: 'x' }), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/cli-helpers.test.mjs`
Expected: FAIL — `Cannot find module '../core/cli-helpers.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
/** Validate a kind id or instance id (lowercase alphanumeric + hyphens). Both use
 *  the same rule — instance ids are filenames, kind ids are directory names,
 *  and gate/registry/ is a flat namespace either way. */
export function validateId(id) {
  return Boolean(id) && /^[a-z0-9-]+$/.test(id);
}

/** A type-appropriate placeholder value for a field with no declared default —
 *  what a newly-scaffolded instance's config gets before it's filled in. */
export function templateValueForField(field) {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'string-list':
      return [];
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return field.options?.[0] ?? '';
    case 'secret-ref':
      return 'ENV_VAR_NAME_HERE';
    case 'string':
    default:
      return '';
  }
}

/** Build a new instance's config object from a kind's declared configFields. */
export function buildInstanceConfigTemplate(configFields) {
  const config = {};
  for (const field of configFields ?? []) {
    config[field.key] = templateValueForField(field);
  }
  return config;
}

/** Source text for a newly-scaffolded kind.mjs — the five required exports
 *  as empty holes, matching how `add` scaffolds a provider config's holes. */
export function getKindTemplate(kindId, label, family) {
  return `export default {
  kind: '${kindId}',
  label: '${label}',
  family: '${family}',
  configFields: [
    // Describe this kind's config fields here, e.g.:
    // { key: 'example', label: 'Example', type: 'string', required: true },
  ],
  validate(config) {
    const errors = [];
    // Push { field, message } for each violated rule.
    return { ok: errors.length === 0, errors };
  },
  toManifestEntry(instance) {
    return {
      id: instance.id,
      // What does this kind advertise in the manifest?
    };
  },
  createHandlers(instance) {
    return {
      // RPC methods this instance answers, e.g.:
      // run: async () => ({ /* ... */ }),
    };
  },
};
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/cli-helpers.test.mjs`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add gate/core/cli-helpers.mjs gate/__tests__/cli-helpers.test.mjs
git commit -m "feat(gate): add cli-helpers.mjs — pure scaffold logic for add/add-kind"
```

---

### Task 2: Generalize `gate/cli.mjs` — `add --kind` and `add-kind`

**Files:**
- Modify: `gate/cli.mjs`

- [ ] **Step 1: Replace `gate/cli.mjs` in full**

```js
#!/usr/bin/env node

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGate } from './core/server.mjs';
import { PairingStore } from './core/pairing.mjs';
import { DeviceTokenStore } from './core/device-tokens.mjs';
import { validateId, buildInstanceConfigTemplate, getKindTemplate } from './core/cli-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load a kind module by id, or null if it doesn't exist / fails to import.
 * Logs the real error so a broken kind (syntax error, throwing top-level
 * code) is distinguishable from a genuinely missing one.
 */
async function loadKindModule(kindId) {
  const modulePath = join(__dirname, 'core', 'capabilities', kindId, 'kind.mjs');
  try {
    const module = await import(pathToFileURL(modulePath).href);
    return module.default ?? null;
  } catch (err) {
    console.error(`(kind "${kindId}" failed to load: ${err.message})`);
    return null;
  }
}

/**
 * Handle 'add' command: scaffold a new capability instance of an existing kind
 */
async function handleAdd(args) {
  const id = args[0];
  const kindIndex = args.indexOf('--kind');

  if (!id) {
    console.error('Error: instance id is required');
    console.error('Usage: node gate/cli.mjs add <id> --kind <kind-id>');
    process.exit(1);
  }

  if (kindIndex === -1) {
    console.error('Error: --kind flag is required');
    console.error('Usage: node gate/cli.mjs add <id> --kind <kind-id>');
    process.exit(1);
  }

  const kindId = args[kindIndex + 1];

  if (!validateId(id)) {
    console.error(`Error: instance id must be lowercase alphanumeric with hyphens, got "${id}"`);
    process.exit(1);
  }

  if (!validateId(kindId)) {
    console.error(`Error: kind id must be lowercase alphanumeric with hyphens, got "${kindId}"`);
    process.exit(1);
  }

  const kindModule = await loadKindModule(kindId);
  if (!kindModule) {
    console.error(`Error: kind "${kindId}" not found at gate/core/capabilities/${kindId}/kind.mjs`);
    console.error(`Run "node gate/cli.mjs add-kind ${kindId} --label \\"<label>\\" --family <family>" first, or check the kind id.`);
    process.exit(1);
  }

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

  const label = id.charAt(0).toUpperCase() + id.slice(1);
  const config = buildInstanceConfigTemplate(kindModule.configFields);
  const template = JSON.stringify({ kind: kindId, label, config }, null, 2) + '\n';

  // Create registry instance file
  try {
    await mkdir(registryDir, { recursive: true });
    await writeFile(instanceFile, template, 'utf-8');
    console.log(`Created instance "${id}" at ${instanceFile}`);
  } catch (err) {
    console.error(`Error creating instance: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Handle 'add-kind' command: scaffold a new capability kind module
 */
async function handleAddKind(args) {
  const kindId = args[0];
  const labelIndex = args.indexOf('--label');
  const familyIndex = args.indexOf('--family');

  if (!kindId) {
    console.error('Error: kind id is required');
    console.error('Usage: node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>');
    process.exit(1);
  }

  if (labelIndex === -1 || familyIndex === -1) {
    console.error('Error: --label and --family flags are required');
    console.error('Usage: node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>');
    process.exit(1);
  }

  const label = args[labelIndex + 1];
  const family = args[familyIndex + 1];

  if (!validateId(kindId)) {
    console.error(`Error: kind id must be lowercase alphanumeric with hyphens, got "${kindId}"`);
    process.exit(1);
  }

  if (!label) {
    console.error('Error: --label must be a non-empty string');
    process.exit(1);
  }

  if (!family) {
    console.error('Error: --family must be a non-empty string');
    process.exit(1);
  }

  const kindDir = join(__dirname, 'core', 'capabilities', kindId);
  const kindFile = join(kindDir, 'kind.mjs');

  // Check if kind already exists
  try {
    await access(kindFile);
    console.error(`Error: kind "${kindId}" already exists at ${kindFile}`);
    process.exit(1);
  } catch {
    // Kind does not exist, which is what we want
  }

  try {
    await mkdir(kindDir, { recursive: true });
    const template = getKindTemplate(kindId, label, family);
    await writeFile(kindFile, template, 'utf-8');
    console.log(`Created kind "${kindId}" at ${kindFile}`);
  } catch (err) {
    console.error(`Error creating kind: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Handle 'start' command: start the Gate server
 */
async function handleStart() {
  const gateName = process.env.GATE_NAME || 'Versutus Gate';

  try {
    console.log(`Starting ${gateName}...`);
    const gate = await createGate({
      root: __dirname,
      port: 8760,
      name: gateName,
    });

    console.log(`Token: ${gate.token}`);
    console.log(`Listening on port ${gate.port}`);
    console.log(`Manifest: http://127.0.0.1:${gate.port}/.well-known/gateway.json`);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await gate.close();
      process.exit(0);
    });
  } catch (err) {
    console.error(`Error starting gate: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Handle 'pair' command: manage device pairing and tokens
 */
async function handlePair(args) {
  const [sub, ...rest] = args;
  const pairing = new PairingStore(join(__dirname, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(__dirname, '.device-tokens.json'));

  if (sub === 'open') {
    const minutesIndex = rest.indexOf('--minutes');
    const minutes = minutesIndex >= 0 ? Number(rest[minutesIndex + 1]) : 5;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.error('Error: --minutes must be a positive number');
      process.exit(1);
    }
    await pairing.openWindow(minutes * 60_000);
    console.log(`Pairing window open for ${minutes} minute(s). The next device to connect is granted automatically.`);
    return;
  }

  if (sub === 'approve') {
    const requestId = rest[0];
    if (!requestId) {
      console.error('Error: Usage: node gate/cli.mjs pair approve <requestId>');
      process.exit(1);
    }
    const entry = await pairing.takePending(requestId);
    if (!entry) {
      console.error(`Error: No pending request "${requestId}". Run "pair list" to see open requests.`);
      process.exit(1);
    }
    const token = await deviceTokens.issue(entry.deviceId, { role: entry.role, scopes: entry.scopes });
    console.log(`Approved device ${entry.deviceId}. Token: ${token}`);
    return;
  }

  if (sub === 'revoke') {
    const deviceId = rest[0];
    if (!deviceId) {
      console.error('Error: Usage: node gate/cli.mjs pair revoke <deviceId>');
      process.exit(1);
    }
    const found = await deviceTokens.revoke(deviceId);
    console.log(found ? `Revoked device ${deviceId}.` : `No device "${deviceId}" on file.`);
    return;
  }

  if (sub === 'list') {
    const pending = await pairing.listPending();
    const devices = await deviceTokens.list();
    console.log('Pending requests:');
    for (const entry of pending) console.log(`  ${entry.requestId}  device=${entry.deviceId}  role=${entry.role}`);
    if (pending.length === 0) console.log('  (none)');
    console.log('Paired devices:');
    for (const entry of devices) console.log(`  ${entry.deviceId}  role=${entry.role}  ${entry.revoked ? '(revoked)' : ''}`);
    if (devices.length === 0) console.log('  (none)');
    return;
  }

  console.error('Usage: node gate/cli.mjs pair <open|approve|revoke|list>');
  process.exit(1);
}

/**
 * Main CLI entry point
 */
async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    console.log('Versutus Gate CLI');
    console.log('');
    console.log('Usage: node gate/cli.mjs <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  add <id> --kind <kind-id>');
    console.log('    Scaffold a new capability instance in gate/registry/<id>.json,');
    console.log('    pre-filled from the kind\'s declared config fields');
    console.log('');
    console.log('  add-kind <kind-id> --label "<label>" --family <family>');
    console.log('    Scaffold a new capability kind module at');
    console.log('    gate/core/capabilities/<kind-id>/kind.mjs');
    console.log('');
    console.log('  start');
    console.log('    Start the Gate HTTP server on port 8760');
    console.log('');
    console.log('  pair <open|approve|revoke|list>');
    console.log('    Manage device pairing and access tokens');
    console.log('    open [--minutes N]  Open the pairing window (default 5 minutes)');
    console.log('    approve <requestId> Approve a pending access request');
    console.log('    revoke <deviceId>   Revoke a device\'s access token');
    console.log('    list                List pending requests and paired devices');
    console.log('');
    console.log('Environment variables:');
    console.log('  GATE_NAME  - Name of the Gate (defaults to "Versutus Gate")');
    console.log('');
    process.exit(0);
  }

  if (command === 'add') {
    await handleAdd(args);
  } else if (command === 'add-kind') {
    await handleAddKind(args);
  } else if (command === 'start') {
    await handleStart();
  } else if (command === 'pair') {
    await handlePair(args);
  } else {
    console.error(`Error: unknown command "${command}"`);
    console.error('Run "node gate/cli.mjs help" for usage');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
```

Note what changed from before: `validateProviderId`/`validateFlavor`/`getInstanceTemplate` are gone (superseded by `cli-helpers.mjs`'s `validateId`/`buildInstanceConfigTemplate`), `handleAdd` now takes `--kind` instead of `--flavor` and dynamically loads the target kind to build its template, and `handleAddKind` is new.

- [ ] **Step 2: Manual verification**

```bash
node gate/cli.mjs add test-scaffold --kind provider
cat gate/registry/test-scaffold.json
```
Expected: a JSON file with `kind: "provider"`, `label: "Test-scaffold"`, and a `config` object with keys `flavor`, `baseUrl`, `apiKeyEnv`, `models`, `streaming` — `flavor` pre-filled `"openai"` (the first enum option), `streaming` pre-filled `true` (its declared default), the rest empty placeholders.

```bash
node gate/cli.mjs add test-scaffold-2 --kind nonexistent-kind
```
Expected: `Error: kind "nonexistent-kind" not found at gate/core/capabilities/nonexistent-kind/kind.mjs`, exit code 1, no file created.

```bash
node gate/cli.mjs add-kind test-kind --label "Test Kind" --family test
cat gate/core/capabilities/test-kind/kind.mjs
```
Expected: a `kind.mjs` file with `kind: 'test-kind'`, `label: 'Test Kind'`, `family: 'test'`, and the five-export stub shape.

```bash
node gate/cli.mjs add-kind test-kind --label "Duplicate" --family test
```
Expected: `Error: kind "test-kind" already exists at ...`, exit code 1, original file unmodified.

Clean up every artifact created by this manual pass:
```bash
rm gate/registry/test-scaffold.json
rm -rf gate/core/capabilities/test-kind
```

- [ ] **Step 3: Run the full gate suite**

Run: `node --test "gate/__tests__/*.test.mjs"` from repo root, AND `cd gate && node --test` (the package's own script) — both must agree, zero failures (this task doesn't add or change any `.test.mjs` file, so the count should be unchanged from before this task).

- [ ] **Step 4: Commit**

```bash
git add gate/cli.mjs
git commit -m "feat(gate): generalize cli add to --kind, add add-kind command"
```

---

### Task 3: `CAPABILITY_PROMPT.md` and the README

**Files:**
- Create: `gate/CAPABILITY_PROMPT.md`
- Delete: `gate/PROVIDER_PROMPT.md`
- Modify: `README.md`

- [ ] **Step 1: Create `gate/CAPABILITY_PROMPT.md`**

```markdown
# Capability Configuration Guide

This guide explains how to register new capabilities for the Versutus Gate — both
adding an instance of an existing capability kind (common, config-only) and
authoring a brand-new kind (rare, a small amount of code).

## Two Tiers: Kinds and Instances

- **Kind** — a category of thing the Gate can do (`provider`, and any others
  that get added later). Defined once, in code, at
  `gate/core/capabilities/<kind>/kind.mjs`.
- **Instance** — one configured, named instance of a kind (e.g. "my nvidia
  chat provider"). Defined by config only, at `gate/registry/<id>.json`. No
  code.

Registering a new *instance* of an already-existing kind is the common case
and needs no code at all. Authoring a new *kind* is rarer and is the only
place a model writes real logic.

## Adding an Instance (common case)

```bash
node gate/cli.mjs add <id> --kind <kind-id>
```

- `<id>`: instance identifier (lowercase alphanumeric + hyphens, e.g.
  `my-openai`, `standup-reminder`). This becomes the filename —
  `gate/registry/<id>.json` — never a field inside the file itself.
- `<kind-id>`: an already-registered kind, e.g. `provider`.

This creates `gate/registry/<id>.json`, pre-filled with one entry per field
the kind declares in its `configFields`, using each field's declared
`default` where one exists and a type-appropriate placeholder otherwise
(empty string, empty list, `0`, `false`, the first `enum` option, or
`ENV_VAR_NAME_HERE` for a `secret-ref`). Fill in real values inside the
`config` block; do not add or remove keys, and do not add an `id` field.

### Instance file shape

```json
{
  "kind": "<kind-id>",
  "label": "<human-readable name>",
  "config": {
    "...": "one entry per the kind's configFields"
  }
}
```

## Adding a New Kind (rare — the only place a model writes code)

```bash
node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>
```

- `<kind-id>`: lowercase alphanumeric + hyphens, e.g. `cron`, `memory`.
- `<label>`: human-readable name shown in UI/logs.
- `<family>`: the capability group this kind belongs to for the app's
  capability snapshot (often the same as `<kind-id>`, but doesn't have to
  be — several kinds can share one family).

This creates `gate/core/capabilities/<kind-id>/kind.mjs`, scaffolded with
the five required exports (below) as empty stubs. Fill in the stubs; do not
restructure the file, add new top-level exports, or rename the existing
ones.

### The kind contract

Every `kind.mjs` exports a default object with exactly these fields:

```ts
export default {
  kind: string,                 // matches the directory name
  label: string,
  family: string,
  configFields: FieldDescriptor[],
  validate(config) -> { ok: boolean, errors: { field: string, message: string }[] },
  toManifestEntry(instance) -> object,   // what this instance advertises in the manifest
  createHandlers(instance) -> Record<string, (params) => unknown>,  // RPC methods, or {} if none
};
```

`configFields` describes each config field declaratively:

```ts
type FieldDescriptor = {
  key: string;
  label: string;
  type: 'string' | 'string-list' | 'number' | 'boolean' | 'enum' | 'secret-ref';
  required?: boolean;
  options?: string[];   // enum only
  default?: unknown;
  help?: string;
};
```

Use `type: 'secret-ref'` for any field that holds a credential's *reference
name*, never the credential itself — the actual value is set separately,
through the Gate's secret store (`registry.secrets.set`), and is never
written into `gate/registry/<id>.json`.

`validate(config)` should name every violated rule with a `field` and
`message`, not just the first one — that's what lets the app render a
helpful, specific error next to the offending form field.

`createHandlers(instance)` returns RPC methods local to this one instance,
e.g. `{ run: async () => {...} }` — the Gate automatically prefixes each key
with the instance's id (`<instance-id>.run`) before it becomes callable, so
you never need to worry about colliding with another instance's method
names, even of the same kind. Return `{}` if this kind has no RPC surface
of its own (e.g. `provider`, whose "surface" is the Gate's dedicated chat
HTTP routes, not generic RPC).

## Worked Example: `provider`

`provider` is the one kind the Gate ships today — an LLM chat backend. Its
`configFields` are `flavor` (enum: `openai`/`anthropic`/`custom`), `baseUrl`
(string), `apiKeyEnv` (secret-ref), `models` (string-list), and `streaming`
(boolean, default `true`).

```bash
node gate/cli.mjs add my-openai --kind provider
```

produces `gate/registry/my-openai.json`:

```json
{
  "kind": "provider",
  "label": "My-openai",
  "config": {
    "flavor": "openai",
    "baseUrl": "",
    "apiKeyEnv": "ENV_VAR_NAME_HERE",
    "models": [],
    "streaming": true
  }
}
```

Fill in the real values:

```json
{
  "kind": "provider",
  "label": "OpenAI Production",
  "config": {
    "flavor": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "models": ["gpt-4-turbo-preview", "gpt-4", "gpt-3.5-turbo"],
    "streaming": true
  }
}
```

Set the environment variable (or use `registry.secrets.set` from the app
instead — either works, the secret store is checked first):

```bash
export OPENAI_API_KEY=sk-...
node gate/cli.mjs start
```

## Validation

Every instance is validated against its kind's `validate()` on load. A
config that fails validation is skipped with a logged reason — it never
takes down the Gate or any other instance.

For `provider` specifically:
- `flavor` must be one of `openai`, `anthropic`, `custom`
- `apiKeyEnv` must be a non-empty string (never a literal key)
- `models` must be a non-empty array
- `baseUrl` must start with `https://` (loopback addresses are exempt, for
  local testing)

## Accessing the Gateway

```bash
curl http://127.0.0.1:8760/.well-known/gateway.json
```

The manifest lists every registered kind's schema (`capabilityKinds`) and
every configured instance (`capabilityInstances`), plus, for backward
compatibility, a `providers[]` array derived from instances of kind
`provider`:

```json
{
  "providers": [
    { "id": "my-openai", "label": "OpenAI Production", "models": ["..."], "capabilities": { "chat": true, "streaming": true } }
  ],
  "capabilityKinds": [
    { "id": "provider", "label": "Model provider", "family": "provider", "configFields": ["..."] }
  ],
  "capabilityInstances": [
    { "id": "my-openai", "kind": "provider", "label": "OpenAI Production", "family": "provider", "manifestEntry": {} }
  ]
}
```

Call any registered method, built-in or instance-contributed:

```bash
curl -X POST http://127.0.0.1:8760/v1/capabilities/rpc \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"method":"registry.instances.list"}'
```

Get all models across all provider instances:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8760/v1/models
```

## Troubleshooting

### An instance isn't loading
- Check that the file exists: `gate/registry/<id>.json`
- Check the Gate startup logs for a validation error
- Call `registry.instances.list` over RPC — a skipped instance's reason
  is visible there

### `add` fails with "kind not found"
- The kind hasn't been scaffolded yet — run `add-kind` first, or check the
  kind id for typos

### A provider's API key isn't found
- Check the environment variable name matches `apiKeyEnv` in the config,
  or that a secret was set for that same name via `registry.secrets.set`
- The secret store is checked first, `.env` second — either can supply it
```

- [ ] **Step 2: Delete the old file**

```bash
git rm gate/PROVIDER_PROMPT.md
git add gate/CAPABILITY_PROMPT.md
```

- [ ] **Step 3: Update `README.md`**

Find the line (in the "Versutus Gate (in-repo)" section):
```
Providers live at `gate/registry/<id>.json` (example: `nvidia`), scaffolded via `node cli.mjs add <id> --flavor <openai|anthropic|custom>` and validated against `gate/core/capabilities/provider/kind.mjs`. Tokens print on start and may be cached in `gate/.tokens.json` (gitignored patterns apply).
```
Replace with:
```
Providers live at `gate/registry/<id>.json` (example: `nvidia`), scaffolded via `node cli.mjs add <id> --kind provider` (fill in the generated template per `gate/CAPABILITY_PROMPT.md`) and validated against `gate/core/capabilities/provider/kind.mjs`. Tokens print on start and may be cached in `gate/.tokens.json` (gitignored patterns apply).
```

- [ ] **Step 4: Run the full gate suite**

Run: `node --test "gate/__tests__/*.test.mjs"` from repo root — expect PASS, unchanged count (this task is docs-only, no test file touched).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(gate): rename PROVIDER_PROMPT.md to CAPABILITY_PROMPT.md, generalize for any kind"
```

---

### Task 4: End-to-end manual verification

**Files:** none (manual smoke test, mirrors the pattern used in the two prior plans of this series)

- [ ] **Step 1: Scaffold a real second kind and instance, start a verification Gate, confirm it all loads**

Use `add-kind` to scaffold a minimal but *functional* (not stub) kind — e.g. a `note` kind that just stores a text field and has no RPC surface:

```bash
node gate/cli.mjs add-kind note --label "Note" --family note
```

Edit `gate/core/capabilities/note/kind.mjs` to fill in a real, working `configFields`/`validate`/`toManifestEntry` (a single `text` string field is enough) — this proves `add-kind`'s scaffold is genuinely usable, not just syntactically valid.

```bash
node gate/cli.mjs add my-note --kind note
```
Confirm `gate/registry/my-note.json` was created with a `text` field, then edit it to a real value.

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

Using the printed token/port, `POST /v1/capabilities/rpc {"method":"registry.kinds.list"}` and confirm both `provider` and `note` appear. `POST /v1/capabilities/rpc {"method":"registry.instances.list"}` and confirm `my-note` appears with the real `text` value you set.

- [ ] **Step 2: Clean up every artifact from this manual pass**

Stop the verification Gate process. Then:
```bash
rm gate/registry/my-note.json
rm -rf gate/core/capabilities/note
```

Confirm `git status` is clean — nothing from this manual verification pass should be left uncommitted or untracked.

No commit — this task only confirms Tasks 1-3 add up to working software, mirroring the acceptance-gate pattern from the two prior plans in this series.

---

## Plan Self-Review Notes

- **Spec coverage:** Implements design spec §9 in full — both CLI commands and the renamed/generalized prompt doc.
- **Placeholder scan:** `getKindTemplate`'s generated `.mjs` file intentionally contains `// TODO`-style comments (`// Describe this kind's config fields here, e.g.: ...`) — this is correct and expected, matching the existing convention from the provider template's `─── CONFIG: edit only inside this block ───` markers. It is a template meant to be filled in, not shipped code; it's not a placeholder left in *this plan's own* deliverables.
- **Type consistency:** `cli-helpers.mjs`'s `templateValueForField`/`buildInstanceConfigTemplate` signatures match exactly how `cli.mjs` calls them (`buildInstanceConfigTemplate(kindModule.configFields)`), and the `FieldDescriptor.type` union matches the spec's `'string' | 'string-list' | 'number' | 'boolean' | 'enum' | 'secret-ref'` exactly (including the `'string-list'` amendment made during the foundation plan).
- **No `cli.mjs` test file added**, consistent with this project's existing convention (there has never been one) — `main()` runs unconditionally at module load, making direct import-based testing unsafe without restructuring the script's execution trigger, which this plan deliberately avoids doing since it's out of scope for "generalize the CLI." All new *logic* (the parts that actually needed generalizing) lives in the fully-tested `cli-helpers.mjs` instead.
- **Path-traversal bug found and fixed during implementation**: the code block above originally called `loadKindModule(kindId)` without validating `kindId` first, while `add-kind` (correctly) validated its own id before ever constructing a path from it. Since `loadKindModule` builds a filesystem path from `kindId` and dynamically `import()`s it, an unvalidated `kindId` like `../../../anything` let a crafted `--kind` value execute arbitrary local `.mjs` code before the "not found" fallback ran — demonstrated directly, not theoretical. Fixed by adding the same `validateId(kindId)` check `add-kind` already had, in the same position (before any path is built), and by making `loadKindModule`'s catch log the real import error instead of a blanket `catch { return null }` that made a broken kind indistinguishable from a missing one. The code block above reflects the corrected, shipped version.
