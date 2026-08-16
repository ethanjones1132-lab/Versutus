# Backend & Capability Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Gate tell the phone the truth about its providers and backends, and show that truth in chat and on the setup screen.

**Architecture:** The Gate's manifest gains real provider records (from `ProviderService`, not the legacy registry) and per-backend health. The app narrows capability claims to the selected backend, surfaces the backend as the chat title, and remembers a model per backend. The provider and environment cards are rebuilt on primitives the codebase already has.

**Tech Stack:** Node 24 (`node --test`) for the Gate; Expo SDK 57 / React Native 0.86 / React 19 with jest-expo for the app. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-15-backend-capability-surfacing-design.md`

---

## File Structure

**Gate (new):**
- `gate/__tests__/manifest-providers.test.mjs` — manifest provider merge rules
- `gate/__tests__/manifest-provider-merge.test.mjs` — server-level wiring + fallback
- `gate/__tests__/backend-describe-health.test.mjs` — backend health fields
- `gate/__tests__/secret-ref-guard.test.mjs` — credential-shaped refName rejection

**Gate (modified):**
- `gate/core/manifest.mjs` — accept `providerSnapshots`, merge, dedupe
- `gate/core/server.mjs:280-297` — pass `providerService.list()` into `buildManifest`; pass `environmentState` into `createBackendManager`
- `gate/core/cli-environments/backend-manager.mjs:63-77` — `describe()` carries `state`/`cliVersion`
- `gate/core/capabilities/secrets.mjs` — export `looksLikeCredential`
- `gate/core/capabilities/registry-methods.mjs:97-110` — reject credential-shaped refName

**App (new):**
- `src/lib/gateway/backend-capabilities.ts` — `capabilitiesForBackend`
- `src/lib/gateway/model-selection.ts` — `effectiveModel`, `withSelectedModel`
- `src/lib/gateway/entity-actions.ts` — `providerPrimaryAction`, `environmentPrimaryAction`
- `src/components/chat/backend-picker-sheet.tsx`
- `src/components/gateway/provider-actions-sheet.tsx`
- `src/components/gateway/provider-key-sheet.tsx`
- `__tests__/backend-capabilities-test.ts`, `__tests__/model-selection-test.ts`, `__tests__/entity-actions-test.ts`

**App (modified):**
- `src/lib/portal/manifest.ts:119-126` — `GatewayBackend` health fields; provider entry type
- `src/lib/gateway/types.ts:13-43` — `GatewayProfile.backendModels`
- `src/lib/gateway/dashboard.ts:881-888` — snapshot options param
- `src/context/gateway-provider.tsx` — effective model, backend-aware `selectModel`/`selectBackend`
- `src/components/chat/chat-header.tsx`, `src/components/chat/chat-screen.tsx`
- `src/components/gateway/provider-card.tsx`, `environment-card.tsx`, `providers-section.tsx`, `environments-section.tsx`
- `src/app/gateway/capabilities.tsx:210-215` — secret field label + validation

---

## Task 1: Provider entries in the manifest

**Files:**
- Modify: `gate/core/manifest.mjs`
- Test: `gate/__tests__/manifest-providers.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/manifest-providers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

/** A ProviderService snapshot, shaped as toSnapshot() returns it. */
function snapshot(id, overrides = {}) {
  return {
    id,
    label: id.toUpperCase(),
    providerType: 'openai-compatible',
    mode: 'api_key',
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-08-15T00:00:00Z' },
    catalog: {
      state: 'fresh',
      source: 'live',
      generation: 1,
      models: [{ providerId: id, id: `${id}/model-a`, available: true }],
    },
    ...overrides,
  };
}

/** A legacy registry instance, as resolveManifestInstances() produces it. */
function legacyInstance(id) {
  return {
    kind: 'provider',
    manifestEntry: {
      id,
      label: `legacy ${id}`,
      basePath: `/p/${id}`,
      models: ['legacy-model'],
      capabilities: { chat: true, streaming: true },
    },
  };
}

test('a v2 provider reaches the manifest with its live state', () => {
  const manifest = buildManifest({ name: 'Gate', providerSnapshots: [snapshot('nvidia')] });
  const entry = manifest.providers.find((provider) => provider.id === 'nvidia');
  assert.ok(entry, 'the v2 provider must appear in the manifest');
  assert.equal(entry.readiness.state, 'ready');
  assert.equal(entry.auth.state, 'ready');
  assert.equal(entry.catalog.state, 'fresh');
  assert.equal(entry.catalog.source, 'live');
  assert.equal(entry.catalog.count, 1);
  assert.deepEqual(entry.models, ['nvidia/model-a']);
  assert.equal(entry.basePath, '/p/nvidia');
});

test('a v2 record wins over a legacy record with the same id', () => {
  const manifest = buildManifest({
    name: 'Gate',
    providerSnapshots: [snapshot('nvidia')],
    capabilityInstances: [legacyInstance('nvidia')],
  });
  const matches = manifest.providers.filter((provider) => provider.id === 'nvidia');
  assert.equal(matches.length, 1, 'a duplicate id must not appear twice');
  assert.equal(matches[0].label, 'NVIDIA', 'the v2 record must win');
});

test('a legacy provider with no v2 counterpart is retained', () => {
  const manifest = buildManifest({
    name: 'Gate',
    providerSnapshots: [snapshot('opencode-zen')],
    capabilityInstances: [legacyInstance('someone-else')],
  });
  assert.deepEqual(
    manifest.providers.map((provider) => provider.id),
    ['opencode-zen', 'someone-else'],
    'v2 first, then legacy, each sorted by id',
  );
});

test('provider entries carry state, never credentials', () => {
  const manifest = buildManifest({
    name: 'Gate',
    providerSnapshots: [
      snapshot('nvidia', { config: { credentialRef: 'provider/nvidia/api-key', baseUrl: 'https://x' } }),
    ],
  });
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{8,}/, 'no key material in the manifest');
  assert.doesNotMatch(serialized, /credentialRef/, 'no credential ref in the manifest');
  assert.doesNotMatch(serialized, /baseUrl/, 'no upstream base URL in the manifest');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test "__tests__/manifest-providers.test.mjs"`
Expected: FAIL — `manifest.providers.find(...)` returns undefined, because `buildManifest` ignores `providerSnapshots`.

- [ ] **Step 3: Write minimal implementation**

In `gate/core/manifest.mjs`, add the entry builder above `buildManifest`:

```js
/**
 * A provider as a client needs to see it: enough state to decide whether it is
 * usable, and nothing that could be a credential. The manifest is served to any
 * paired device, so `credentialRef`, `baseUrl` and key material stay out.
 */
function providerEntryFromSnapshot(snapshot) {
  return {
    id: snapshot.id,
    label: snapshot.label,
    basePath: `/p/${snapshot.id}`,
    models: (snapshot.catalog?.models ?? []).map((model) => model.id),
    capabilities: { chat: true, streaming: true },
    readiness: {
      state: snapshot.readiness?.state ?? 'unavailable',
      ...(snapshot.readiness?.code ? { code: snapshot.readiness.code } : {}),
    },
    auth: { state: snapshot.auth?.state ?? 'missing' },
    catalog: {
      state: snapshot.catalog?.state ?? 'unavailable',
      source: snapshot.catalog?.source ?? 'legacy_bootstrap',
      count: (snapshot.catalog?.models ?? []).length,
    },
  };
}

const byId = (a, b) => a.id.localeCompare(b.id);
```

Change the signature and the `providers` derivation:

```js
export function buildManifest({
  name,
  version,
  backends = [],
  providerSnapshots = [],
  capabilityKinds = [],
  capabilityInstances = [],
}) {
  // v2 providers are owned by ProviderService and persist under Gate home;
  // legacy ones are registry files. Both are advertised, but a v2 record wins
  // on a collision — it is the one with live readiness and a real catalog.
  const v2Providers = providerSnapshots.map(providerEntryFromSnapshot).sort(byId);
  const v2Ids = new Set(v2Providers.map((entry) => entry.id));
  const legacyProviders = capabilityInstances
    .filter((instance) => instance.kind === 'provider')
    .map((instance) => instance.manifestEntry)
    .filter((entry) => entry && !v2Ids.has(entry.id))
    .sort(byId);
  const providers = [...v2Providers, ...legacyProviders];
```

Leave the rest of the function unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test "__tests__/manifest-providers.test.mjs"`
Expected: PASS — 4 tests.

- [ ] **Step 5: Run the whole Gate suite for regressions**

Run: `npm run test:gate`
Expected: PASS — previously 363 tests, now 367.

- [ ] **Step 6: Commit**

```bash
git add gate/core/manifest.mjs gate/__tests__/manifest-providers.test.mjs
git commit -m "feat(gate): advertise v2 providers in the manifest"
```

---

## Task 2: Wire ProviderService into the manifest

**Files:**
- Modify: `gate/core/server.mjs:280-297`
- Test: `gate/__tests__/manifest-provider-merge.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/manifest-provider-merge.test.mjs`:

```js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gateWithProvider() {
  const root = await mkdtemp(join(tmpdir(), 'gate-manifest-'));
  const gateHome = join(root, 'home');
  roots.push(root);
  // A v2 provider record, as ProviderService persists it under Gate home.
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'nvidia.json'),
    JSON.stringify({
      schemaVersion: 2,
      kind: 'provider',
      id: 'nvidia',
      label: 'NVIDIA NIM',
      providerType: 'nvidia-nim',
      enabled: true,
      registration: { mode: 'api_key', protocol: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', credentialRef: 'provider/nvidia/api-key' },
    }),
    'utf8',
  );
  const gate = await createGate({ root, port: 0, gateHome });
  return gate;
}

test('a provider owned by ProviderService appears in the manifest', async () => {
  const gate = await gateWithProvider();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    const entry = manifest.providers.find((provider) => provider.id === 'nvidia');
    assert.ok(entry, 'the configured provider must be advertised');
    assert.equal(entry.label, 'NVIDIA NIM');
    assert.ok(entry.readiness?.state, 'readiness must be carried');
    assert.ok(entry.catalog?.state, 'catalog state must be carried');
  } finally {
    await gate.close();
  }
});

test('the manifest still builds when the provider service fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-manifest-fail-'));
  roots.push(root);
  const gate = await createGate({ root, port: 0, gateHome: join(root, 'home') });
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.ok(Array.isArray(manifest.providers), 'providers must always be an array');
    assert.equal(manifest.capabilities.providers, true);
  } finally {
    await gate.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test "__tests__/manifest-provider-merge.test.mjs"`
Expected: FAIL on the first test — `entry` is undefined, because `computeState` never asks `ProviderService` for anything.

- [ ] **Step 3: Write minimal implementation**

In `gate/core/server.mjs`, inside `computeState()` (currently lines 280-297), add the snapshot fetch beside the existing `backends` fetch and pass it through:

```js
    const backends = await backendManager.describe().catch(() => []);
    // v2 providers live under Gate home and are owned by ProviderService, so
    // loadCapabilities(root) — which only reads the legacy registry — cannot
    // see them. A failure here must not take the manifest down.
    const providerSnapshots = await providerService.list().catch(() => []);
    const manifest = buildManifest({
      name,
      version,
      backends,
      providerSnapshots,
      capabilityKinds: describeKinds(kinds),
      capabilityInstances: resolveManifestInstances(kinds, instances),
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test "__tests__/manifest-provider-merge.test.mjs"`
Expected: PASS — 2 tests.

- [ ] **Step 5: Confirm the provider list refreshes after a mutation**

`providers.*` RPC methods must call `reload()` so a newly registered provider reaches the manifest without a restart. Check `gate/core/providers/rpc.mjs` for an `onChanged`/`reload` hook; if create/delete does not trigger one, wire it the way `createEnvironmentRpc` does at `gate/core/server.mjs:248-254`.

Run: `npm run test:gate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gate/core/server.mjs gate/__tests__/manifest-provider-merge.test.mjs
git commit -m "fix(gate): build the manifest from the providers it actually owns"
```

---

## Task 3: Backend health in the manifest

**Files:**
- Modify: `gate/core/cli-environments/backend-manager.mjs:63-77`, `gate/core/server.mjs:260-272`
- Test: `gate/__tests__/backend-describe-health.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/backend-describe-health.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';

const RECORD = {
  id: 'opencode-local',
  label: 'OpenCode',
  adapterId: 'opencode',
  enabled: true,
  executable: { path: 'C:\\tools\\opencode.exe' },
  workspacePolicy: { defaultRoot: 'C:\\Projects' },
};

function manager(environmentState) {
  return createBackendManager({
    store: { list: async () => [RECORD] },
    registry: {
      get: () => ({
        capabilities: ['sessions', 'tools', 'models'],
        server: { transport: 'http' },
        createBackend: () => ({}),
      }),
    },
    environmentState,
  });
}

test('describe carries the health the picker needs', async () => {
  const state = new Map([['opencode-local', { state: 'ready', probe: { cliVersion: '1.18.18' } }]]);
  const [backend] = await manager(state).describe();
  assert.equal(backend.state, 'ready');
  assert.equal(backend.cliVersion, '1.18.18');
  assert.deepEqual(backend.capabilities, ['sessions', 'tools', 'models']);
});

test('an unprobed environment falls back to its enabled flag', async () => {
  const [backend] = await manager(new Map()).describe();
  assert.equal(backend.state, 'stopped');
  assert.equal(backend.cliVersion, undefined);
});

test('describe never leaks the executable path', async () => {
  const [backend] = await manager(new Map()).describe();
  assert.equal(backend.executable, undefined);
  assert.doesNotMatch(JSON.stringify(backend), /opencode\.exe/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test "__tests__/backend-describe-health.test.mjs"`
Expected: FAIL — `backend.state` is undefined; `createBackendManager` accepts no `environmentState`.

- [ ] **Step 3: Write minimal implementation**

In `gate/core/cli-environments/backend-manager.mjs`, add `environmentState` to the destructured options:

```js
export function createBackendManager({
  store,
  registry,
  vault,
  buildEnvironment,
  onDiagnostic,
  // Live per-environment status, shared with CliEnvironmentService. Adapter
  // capabilities are a static declaration; this is what says whether the CLI
  // behind them answered.
  environmentState,
  createServer,
} = {}) {
```

Replace the body of `describe()`:

```js
  /** Wire-safe description for the manifest and the app's backend picker. */
  async function describe() {
    return (await list()).map((record) => {
      const adapter = registry.get(record.adapterId);
      const status = environmentState?.get?.(record.id) ?? {};
      return {
        id: record.id,
        label: record.label,
        kind: 'environment',
        adapterId: record.adapterId,
        capabilities: adapter.capabilities ?? [],
        workspaceRoot: record.workspacePolicy?.defaultRoot,
        state: status.state ?? (record.enabled ? 'stopped' : 'disabled'),
        ...(status.probe?.cliVersion ? { cliVersion: status.probe.cliVersion } : {}),
      };
    });
  }
```

In `gate/core/server.mjs`, pass the service's map into the manager (`environmentService` is already constructed above it at line 244):

```js
  const backendManager = createBackendManager({
    store: environmentStore,
    registry: environmentRegistry,
    vault,
    environmentState: environmentService.environmentState,
    buildEnvironment: async ({ record, credentials }) =>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gate && node --test "__tests__/backend-describe-health.test.mjs"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the whole Gate suite**

Run: `npm run test:gate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gate/core/cli-environments/backend-manager.mjs gate/core/server.mjs gate/__tests__/backend-describe-health.test.mjs
git commit -m "feat(gate): carry backend health in the manifest"
```

---

## Task 4: Backend capability narrowing (app helper)

**Files:**
- Modify: `src/lib/portal/manifest.ts:119-126`
- Create: `src/lib/gateway/backend-capabilities.ts`
- Test: `__tests__/backend-capabilities-test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/backend-capabilities-test.ts`:

```ts
import { capabilitiesForBackend } from '@/lib/gateway/backend-capabilities';
import type { GatewayBackend } from '@/lib/portal/manifest';

const OPENCODE: GatewayBackend = {
  id: 'opencode-local',
  label: 'OpenCode',
  kind: 'environment',
  capabilities: ['sessions', 'tools', 'models'],
};
const HERMES: GatewayBackend = {
  id: 'hermes-local',
  label: 'Hermes',
  kind: 'environment',
  capabilities: ['chat', 'tools'],
};

describe('capabilitiesForBackend', () => {
  it('narrows to the selected backend', () => {
    expect(capabilitiesForBackend([OPENCODE, HERMES], 'hermes-local')).toEqual({
      sessions: false,
      tools: true,
    });
  });

  it('falls back to the union when nothing is selected', () => {
    expect(capabilitiesForBackend([OPENCODE, HERMES], undefined)).toEqual({
      sessions: true,
      tools: true,
    });
  });

  it('falls back to the union when the selection is unknown', () => {
    expect(capabilitiesForBackend([OPENCODE], 'deleted-backend')).toEqual({
      sessions: true,
      tools: true,
    });
  });

  it('reports nothing for a gateway with no backends', () => {
    expect(capabilitiesForBackend([], undefined)).toEqual({ sessions: false, tools: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/backend-capabilities-test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/backend-capabilities`.

- [ ] **Step 3: Write minimal implementation**

Extend `GatewayBackend` in `src/lib/portal/manifest.ts` (currently lines 119-126):

```ts
export type GatewayBackend = {
  id: string;
  label: string;
  kind: 'environment';
  adapterId?: string;
  capabilities?: string[];
  workspaceRoot?: string;
  /** Lifecycle state from the Gate's last probe — not a live guarantee. */
  state?: string;
  cliVersion?: string;
};
```

Create `src/lib/gateway/backend-capabilities.ts`:

```ts
import type { GatewayBackend } from '@/lib/portal/manifest';

export type BackendCapabilities = {
  sessions: boolean;
  tools: boolean;
};

/**
 * The manifest advertises the union across every backend — true for the Gate,
 * misleading once one backend is in use. A conversation runs inside exactly one
 * backend, so its capabilities are the ones that matter.
 *
 * An unknown selection falls back to the union rather than reporting nothing:
 * a backend removed on the Gate must not make the app claim less than it can do.
 */
export function capabilitiesForBackend(
  backends: GatewayBackend[],
  selectedBackendId: string | undefined,
): BackendCapabilities {
  const selected = selectedBackendId
    ? backends.find((backend) => backend.id === selectedBackendId)
    : undefined;
  const source = selected ? [selected] : backends;
  const can = (capability: string) =>
    source.some((backend) => (backend.capabilities ?? []).includes(capability));
  return { sessions: can('sessions'), tools: can('tools') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/backend-capabilities-test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/backend-capabilities.ts src/lib/portal/manifest.ts __tests__/backend-capabilities-test.ts
git commit -m "feat(app): narrow capability claims to the selected backend"
```

---

## Task 5: Capability tiles tell the backend truth

**Files:**
- Modify: `src/lib/gateway/dashboard.ts:881-940`
- Test: `__tests__/capability-snapshot-test.ts` (existing — add cases)

- [ ] **Step 1: Write the failing test**

Append to `__tests__/capability-snapshot-test.ts`. The existing suite passes `hello` as `null` and hands capabilities in the fifth argument — match that:

```ts
describe('capability tiles reflect the selected backend', () => {
  const backends = [
    { id: 'opencode-local', label: 'OpenCode', kind: 'environment' as const, capabilities: ['sessions', 'tools'] },
    { id: 'hermes-local', label: 'Hermes', kind: 'environment' as const, capabilities: ['chat'] },
  ];

  test('marks tools unsupported when the selected backend cannot do it', () => {
    const snapshot = buildCapabilitySnapshot(
      'connected',
      null,
      undefined,
      Date.now(),
      { chat: true, tools: true, sessions: true } as unknown as GatewayCapabilities,
      [],
      { backends, selectedBackendId: 'hermes-local' },
    );
    const tools = snapshot.groups.find((group) => group.id === 'tools');
    expect(tools?.status).toBe('unsupported');
    expect(tools?.note).toContain('Hermes');
  });

  test('attributes a supported capability to the backend providing it', () => {
    const snapshot = buildCapabilitySnapshot(
      'connected',
      null,
      undefined,
      Date.now(),
      { chat: true, tools: true, sessions: true } as unknown as GatewayCapabilities,
      [],
      { backends, selectedBackendId: 'opencode-local' },
    );
    const tools = snapshot.groups.find((group) => group.id === 'tools');
    expect(tools?.status).toBe('ready');
    expect(tools?.note).toBe('via OpenCode');
  });

  test('counts provider readiness rather than endpoint existence', () => {
    const snapshot = buildCapabilitySnapshot(
      'connected',
      null,
      undefined,
      Date.now(),
      { providers: true } as unknown as GatewayCapabilities,
      [],
      {
        providers: [
          { id: 'a', readiness: { state: 'ready' } },
          { id: 'b', readiness: { state: 'unavailable' } },
          { id: 'c', readiness: { state: 'unavailable' } },
        ],
      },
    );
    const providers = snapshot.groups.find((group) => group.id === 'providers');
    expect(providers?.status).toBe('partial');
    expect(providers?.note).toBe('1 of 3 ready');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/capability-snapshot-test.ts`
Expected: FAIL — `buildCapabilitySnapshot` takes 6 parameters and ignores a 7th.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/gateway/dashboard.ts`, add the options parameter (keeping all six existing positional parameters so every current call site is unaffected):

```ts
export type CapabilitySnapshotOptions = {
  backends?: import('@/lib/portal/manifest').GatewayBackend[];
  selectedBackendId?: string;
  providers?: { id: string; readiness?: { state?: string } }[];
};

export function buildCapabilitySnapshot(
  status: ConnectionStatus,
  hello: GatewayHelloOk | null,
  commands: GatewayCommand[] = GATEWAY_COMMANDS,
  lastProbeAt: number = Date.now(),
  capabilities: import('@/lib/gateway/types').GatewayCapabilities | null = null,
  capabilityInstances: GatewayCapabilityInstance[] = [],
  options: CapabilitySnapshotOptions = {},
): import('@/lib/gateway/types').GatewayCapabilitySnapshot {
```

Inside, after `isGroupReady` is defined, add the two overrides:

```ts
  // A conversation runs inside one backend. Reporting the Gate-wide union once
  // a backend is selected makes the app offer surfaces that backend cannot serve.
  const backends = options.backends ?? [];
  const selectedBackend = options.selectedBackendId
    ? backends.find((backend) => backend.id === options.selectedBackendId)
    : undefined;
  const backendScoped = capabilitiesForBackend(backends, options.selectedBackendId);
  const backendOverride: Record<string, boolean> = { sessions: backendScoped.sessions, tools: backendScoped.tools };

  const providerRecords = options.providers ?? [];
  const readyProviders = providerRecords.filter(
    (provider) => provider.readiness?.state === 'ready',
  ).length;
```

Then, in the `groups` map, replace the final `return` (the `ready ? 'ready' : 'unsupported'` block) with:

```ts
      const ready = isGroupReady(definition);

      // Sessions and tools exist only because a backend provides them.
      if (backends.length > 0 && definition.id in backendOverride) {
        const supported = backendOverride[definition.id];
        return {
          id: definition.id,
          label: definition.label,
          status: supported ? 'ready' : 'unsupported',
          availableCount: supported ? totalCount : 0,
          totalCount,
          note: supported
            ? selectedBackend
              ? `via ${selectedBackend.label}`
              : undefined
            : selectedBackend
              ? `${selectedBackend.label} does not offer this`
              : 'No backend offers this',
        };
      }

      // A Gate with three keyless providers and one that works look identical
      // when readiness comes from the endpoint existing.
      if (definition.id === 'providers' && providerRecords.length > 0) {
        return {
          id: definition.id,
          label: definition.label,
          status: readyProviders === providerRecords.length ? 'ready' : readyProviders > 0 ? 'partial' : 'unhealthy',
          availableCount: readyProviders,
          totalCount: providerRecords.length,
          note: `${readyProviders} of ${providerRecords.length} ready`,
        };
      }

      return {
        id: definition.id,
        label: definition.label,
        status: ready ? 'ready' : 'unsupported',
        availableCount: ready ? totalCount : 0,
        totalCount,
        note: ready ? undefined : 'Not offered by this gateway',
      };
```

Add the import at the top of the file:

```ts
import { capabilitiesForBackend } from '@/lib/gateway/backend-capabilities';
```

`'partial'` is **not** currently in the status union — `gateway-home-dashboard.tsx:262` only matches it through an `as string` cast. Widen `GatewayCapabilityGroup.status` in `src/lib/gateway/types.ts:292` to include it:

```ts
  status: 'available' | 'unavailable' | 'unknown' | 'ready' | 'missing-scope' | 'unsupported' | 'warming' | 'stale' | 'partial' | 'unhealthy' | 'experimental';
```

Then drop the now-redundant cast at `gateway-home-dashboard.tsx:262`:

```tsx
      {capabilitySnapshot.groups.find(g => g.id === 'channels' && ['unhealthy', 'partial'].includes(g.status)) && (
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/capability-snapshot-test.ts`
Expected: PASS.

- [ ] **Step 5: Pass the new data in from the provider**

In `src/context/gateway-provider.tsx`, find the `buildCapabilitySnapshot(...)` call and add the seventh argument:

```ts
      buildCapabilitySnapshot(status, hello, GATEWAY_COMMANDS, lastProbeAt, capabilities, capabilityInstances, {
        backends: activeManifest?.backends ?? [],
        selectedBackendId,
        providers: activeManifest?.providers,
      }),
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && npx jest --coverage=false`
Expected: clean; 30+ suites pass.

```bash
git add src/lib/gateway/dashboard.ts src/context/gateway-provider.tsx __tests__/capability-snapshot-test.ts
git commit -m "feat(app): report capabilities from the backend and providers in use"
```

---

## Task 6: Per-backend model memory (helper)

**Files:**
- Modify: `src/lib/gateway/types.ts:13-43`
- Create: `src/lib/gateway/model-selection.ts`
- Test: `__tests__/model-selection-test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/model-selection-test.ts`:

```ts
import { effectiveModel, withSelectedModel } from '@/lib/gateway/model-selection';
import type { GatewayProfile } from '@/lib/gateway/types';

const BASE: GatewayProfile = {
  id: 'g1',
  name: 'Gate',
  url: 'http://127.0.0.1:8760',
  createdAt: 0,
  model: 'gateway-default',
};

describe('effectiveModel', () => {
  it('prefers the model remembered for the active backend', () => {
    const profile = { ...BASE, backendModels: { 'codex-local': 'gpt-5.5' } };
    expect(effectiveModel(profile, 'codex-local')).toBe('gpt-5.5');
  });

  it('falls back to the profile model when the backend has no memory', () => {
    const profile = { ...BASE, backendModels: { 'codex-local': 'gpt-5.5' } };
    expect(effectiveModel(profile, 'opencode-local')).toBe('gateway-default');
  });

  it('falls back when no backend is selected', () => {
    expect(effectiveModel(BASE, undefined)).toBe('gateway-default');
  });

  it('is safe on a profile saved before backendModels existed', () => {
    expect(effectiveModel(BASE, 'codex-local')).toBe('gateway-default');
  });
});

describe('withSelectedModel', () => {
  it('remembers the model against the active backend', () => {
    const next = withSelectedModel(BASE, 'gpt-5.5', 'codex-local');
    expect(next.backendModels).toEqual({ 'codex-local': 'gpt-5.5' });
  });

  it('also sets the profile model so every send path stays correct', () => {
    const next = withSelectedModel(BASE, 'gpt-5.5', 'codex-local');
    expect(next.model).toBe('gpt-5.5');
  });

  it('does not disturb another backend’s memory', () => {
    const profile = { ...BASE, backendModels: { 'opencode-local': 'claude-sonnet' } };
    const next = withSelectedModel(profile, 'gpt-5.5', 'codex-local');
    expect(next.backendModels).toEqual({
      'opencode-local': 'claude-sonnet',
      'codex-local': 'gpt-5.5',
    });
  });

  it('writes only the profile model when no backend is selected', () => {
    const next = withSelectedModel(BASE, 'grok-4', undefined);
    expect(next.model).toBe('grok-4');
    expect(next.backendModels).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/model-selection-test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/model-selection`.

- [ ] **Step 3: Write minimal implementation**

Add to `GatewayProfile` in `src/lib/gateway/types.ts`, after the `model` field:

```ts
  /**
   * Model remembered per chat backend. A Codex model id is meaningless to
   * OpenCode, so one profile-wide override cannot serve both.
   */
  backendModels?: Record<string, string>;
```

Create `src/lib/gateway/model-selection.ts`:

```ts
import type { GatewayProfile } from '@/lib/gateway/types';

type ModelBearing = Pick<GatewayProfile, 'model' | 'backendModels'>;

/** The model a send should use: the active backend's memory, else the profile's. */
export function effectiveModel(
  gateway: ModelBearing | null | undefined,
  selectedBackendId: string | undefined,
): string | undefined {
  if (!gateway) return undefined;
  if (selectedBackendId) {
    const remembered = gateway.backendModels?.[selectedBackendId];
    if (remembered) return remembered;
  }
  return gateway.model;
}

/**
 * Records a model choice. `model` is written too, not just the per-backend
 * entry: every existing send path reads `gateway.model`, and leaving it stale
 * would send the previous backend's model id to the new one.
 */
export function withSelectedModel<T extends ModelBearing>(
  gateway: T,
  modelId: string,
  selectedBackendId: string | undefined,
): T {
  if (!selectedBackendId) return { ...gateway, model: modelId };
  return {
    ...gateway,
    model: modelId,
    backendModels: { ...(gateway.backendModels ?? {}), [selectedBackendId]: modelId },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/model-selection-test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/model-selection.ts src/lib/gateway/types.ts __tests__/model-selection-test.ts
git commit -m "feat(app): remember a model per chat backend"
```

---

## Task 7: Apply per-backend model in the provider

**Files:**
- Modify: `src/context/gateway-provider.tsx:1041-1052` (`selectBackend`), `:1960-1975` (`selectModel`)

- [ ] **Step 1: Restore the remembered model on backend switch**

Import the helpers at the top of `src/context/gateway-provider.tsx`:

```ts
import { effectiveModel, withSelectedModel } from '@/lib/gateway/model-selection';
```

Replace the body of `selectBackend`:

```ts
  const selectBackend = useCallback(
    (backendId: string | undefined) => {
      const client = clientRef.current as { setBackendId?: (id: string | undefined) => void } | null;
      client?.setBackendId?.(backendId);
      setSelectedBackendId(backendId);
      sessionIdRef.current = undefined;
      setCurrentSessionId(undefined);
      setMessages([]);
      // Restore the model last used in this backend, so a send after the switch
      // does not carry the previous backend's model id.
      if (activeGateway) {
        const restored = effectiveModel(activeGateway, backendId);
        if (restored && restored !== activeGateway.model) {
          void updateGateway({ ...activeGateway, model: restored });
        }
        void reloadHistoryFor(activeGateway);
      }
    },
    [activeGateway, reloadHistoryFor, updateGateway],
  );
```

Confirm the persistence function is named `updateGateway`; if it differs, use the existing one that writes a profile back to storage (the same one `selectModel` calls at line ~1970).

- [ ] **Step 2: Record the choice against the backend**

In `selectModel` (around line 1960), replace the line building `updated`:

```ts
      const updated = {
        ...withSelectedModel(activeGateway, modelId, selectedBackendId),
        providerId: providerId ?? activeGateway.providerId,
      };
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx jest --coverage=false && npm run lint`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src/context/gateway-provider.tsx
git commit -m "feat(app): restore the remembered model when switching backend"
```

---

## Task 8: Backend picker sheet

**Files:**
- Create: `src/components/chat/backend-picker-sheet.tsx`

- [ ] **Step 1: Write the component**

`ListRow` accepts `title`, `subtitle`, `icon`, `statusColor`, `trailing`, `onPress`, `chevron`, `style` — no `selected` prop and no children. Selection is expressed through `style`, capabilities through `subtitle`, health through `trailing`.

```tsx
import { useCallback } from 'react';
import { FlatList, StyleSheet } from 'react-native';

import * as Haptics from 'expo-haptics';

import { Badge, BaseSheet, EmptyState, ListRow, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayBackend } from '@/lib/portal/manifest';

export type BackendPickerSheetProps = {
  visible: boolean;
  backends: GatewayBackend[];
  selectedBackendId?: string;
  onSelect: (backendId: string) => void;
  onClose: () => void;
};

/** Switching backend switches sessions, models and tools — so it says so. */
export function BackendPickerSheet({
  visible,
  backends,
  selectedBackendId,
  onSelect,
  onClose,
}: BackendPickerSheetProps) {
  const tokens = useTokens();

  const renderItem = useCallback(
    ({ item }: { item: GatewayBackend }) => {
      const healthy = item.state === 'ready' || item.state === 'running';
      const capabilities = item.capabilities ?? [];
      const detail = [
        item.adapterId,
        item.cliVersion,
        capabilities.length > 0 ? capabilities.join(' · ') : undefined,
      ]
        .filter(Boolean)
        .join(' — ');
      return (
        <ListRow
          title={item.label}
          subtitle={detail}
          chevron={false}
          statusColor={healthy ? tokens.statusSuccess : tokens.textTertiary}
          trailing={<Badge label={healthy ? 'Ready' : (item.state ?? 'unknown')} tone={healthy ? 'success' : 'neutral'} />}
          style={
            item.id === selectedBackendId
              ? { borderColor: tokens.accentWarm, borderWidth: 1, borderRadius: Radius.lg }
              : undefined
          }
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSelect(item.id);
            onClose();
          }}
        />
      );
    },
    [onClose, onSelect, selectedBackendId, tokens],
  );

  if (!visible) return null;

  return (
    <BaseSheet visible={visible} eyebrow="CHAT" title="Chat backend" onClose={onClose} closeLabel="Dismiss">
      <Text variant="caption" color="tertiary" style={styles.blurb}>
        Sessions, models and tools all belong to the backend. Switching starts a fresh session.
      </Text>
      {backends.length === 0 ? (
        <EmptyState
          icon={{ ios: 'terminal', android: 'terminal', web: 'terminal' }}
          title="No chat backends"
          description="Attach a CLI environment on the Gate — OpenCode, Codex or Claude Code — to converse through it."
        />
      ) : (
        <FlatList
          data={backends}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          removeClippedSubviews
        />
      )}
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  blurb: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.two },
});
```

Confirm `tokens.statusSuccess` and `tokens.accentWarm` are the right token names by checking `src/hooks/use-tokens.ts`; the palette keys used elsewhere in chat are `accentWarm`, `textTertiary`, `glassBorder`.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/backend-picker-sheet.tsx src/components/ui/ListRow.tsx
git commit -m "feat(app): add the chat backend picker"
```

---

## Task 9: Backend as the chat header title

**Files:**
- Modify: `src/components/chat/chat-header.tsx:9-50`, `src/components/chat/chat-screen.tsx:129-210`

- [ ] **Step 1: Extend the header**

Add to `ChatHeaderProps`:

```ts
  /** Present only when the gateway advertises chat backends. */
  backendLabel?: string;
  onBackendPress?: () => void;
```

Destructure them, then replace the `titles` block:

```tsx
        <PressableScale
          onPress={onBackendPress}
          disabled={!onBackendPress || !backendLabel}
          accessibilityRole={backendLabel && onBackendPress ? 'button' : undefined}
          accessibilityLabel={backendLabel ? `Chat backend: ${backendLabel}. Change backend.` : undefined}
          style={styles.titles}>
          <Text variant="headline" numberOfLines={1} style={styles.name}>
            {backendLabel ?? gatewayName}
          </Text>
          <Text variant="micro" color="secondary" numberOfLines={1}>
            {streaming
              ? 'Streaming response…'
              : backendLabel
                ? `via ${gatewayName}${statusDetail ? ` · ${statusDetail}` : ''}`
                : statusDetail || 'Ready for chat and slash commands'}
          </Text>
        </PressableScale>
```

`PressableScale` is already imported in this file.

- [ ] **Step 2: Wire the chat screen**

In `src/components/chat/chat-screen.tsx`, pull the backend state from the provider (add to the existing `useGateway()` destructure):

```ts
    backends,
    selectedBackendId,
    selectBackend,
```

Add local sheet state beside the other sheet state:

```ts
  const [backendPickerVisible, setBackendPickerVisible] = useState(false);
```

Derive the label near `modelLabel` (line ~130):

```ts
  const activeBackend = backends.find((backend) => backend.id === selectedBackendId) ?? backends[0];
  const backendLabel = activeBackend?.label;
```

Pass to `ChatHeader`:

```tsx
        backendLabel={backendLabel}
        onBackendPress={backends.length > 0 ? () => setBackendPickerVisible(true) : undefined}
```

Render the sheet beside `ChatOverflowSheet`:

```tsx
      <BackendPickerSheet
        visible={backendPickerVisible}
        backends={backends}
        selectedBackendId={activeBackend?.id}
        onSelect={selectBackend}
        onClose={() => setBackendPickerVisible(false)}
      />
```

Import it: `import { BackendPickerSheet } from '@/components/chat/backend-picker-sheet';`

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npx jest --coverage=false`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/chat-header.tsx src/components/chat/chat-screen.tsx
git commit -m "feat(app): name the chat backend in the header"
```

---

## Task 10: Card action helpers

**Files:**
- Create: `src/lib/gateway/entity-actions.ts`
- Test: `__tests__/entity-actions-test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/entity-actions-test.ts`:

```ts
import { environmentPrimaryAction, providerPrimaryAction } from '@/lib/gateway/entity-actions';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

function provider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: 'p',
    label: 'P',
    providerType: 'openai-compatible',
    mode: 'api_key',
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '' },
    catalog: { state: 'fresh', source: 'live', generation: 1, models: [] },
    ...overrides,
  } as ProviderSnapshot;
}

describe('providerPrimaryAction', () => {
  it('asks for a key when an api-key provider has none', () => {
    const action = providerPrimaryAction(provider({ auth: { state: 'missing', credentialCustodian: 'gate' } }));
    expect(action).toEqual({ id: 'set-key', label: 'Set key' });
  });

  it('asks for authorization when an oauth provider has no credential', () => {
    const action = providerPrimaryAction(
      provider({ mode: 'oauth', auth: { state: 'missing', credentialCustodian: 'gate' } }),
    );
    expect(action).toEqual({ id: 'authorize', label: 'Authorize' });
  });

  it('asks to sign in again after a revoked credential', () => {
    const action = providerPrimaryAction(
      provider({ auth: { state: 'needs_reauth', credentialCustodian: 'gate' } }),
    );
    expect(action).toEqual({ id: 'authorize', label: 'Sign in again' });
  });

  it('offers a catalog refresh when ready', () => {
    expect(providerPrimaryAction(provider())).toEqual({ id: 'refresh', label: 'Refresh catalog' });
  });

  it('offers a check when degraded', () => {
    const action = providerPrimaryAction(provider({ readiness: { state: 'degraded', checkedAt: '' } }));
    expect(action).toEqual({ id: 'check', label: 'Check' });
  });

  it('offers enable when disabled', () => {
    const action = providerPrimaryAction(provider({ readiness: { state: 'disabled', checkedAt: '' } }));
    expect(action).toEqual({ id: 'enable', label: 'Enable' });
  });
});

describe('environmentPrimaryAction', () => {
  const environment = (state: string) => ({ state } as EnvironmentSnapshot);

  it('offers stop while running', () => {
    expect(environmentPrimaryAction(environment('running'))).toEqual({ id: 'stop', label: 'Stop' });
  });

  it('offers stop while ready', () => {
    expect(environmentPrimaryAction(environment('ready'))).toEqual({ id: 'stop', label: 'Stop' });
  });

  it('offers start when stopped', () => {
    expect(environmentPrimaryAction(environment('stopped'))).toEqual({ id: 'start', label: 'Start' });
  });

  it('offers a check when disabled', () => {
    expect(environmentPrimaryAction(environment('disabled'))).toEqual({ id: 'check', label: 'Check' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/entity-actions-test.ts`
Expected: FAIL — cannot resolve `@/lib/gateway/entity-actions`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/gateway/entity-actions.ts`:

```ts
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

export type CardAction = { id: string; label: string };

/**
 * The one action a card should lead with. Seven equal buttons made every
 * provider look the same regardless of what it actually needed next.
 */
export function providerPrimaryAction(snapshot: ProviderSnapshot): CardAction {
  if (snapshot.auth.state === 'missing') {
    return snapshot.mode === 'oauth'
      ? { id: 'authorize', label: 'Authorize' }
      : { id: 'set-key', label: 'Set key' };
  }
  if (snapshot.auth.state === 'needs_reauth' || snapshot.auth.state === 'denied') {
    return { id: 'authorize', label: 'Sign in again' };
  }
  if (snapshot.readiness.state === 'disabled') return { id: 'enable', label: 'Enable' };
  if (snapshot.readiness.state === 'ready') return { id: 'refresh', label: 'Refresh catalog' };
  return { id: 'check', label: 'Check' };
}

export function environmentPrimaryAction(environment: EnvironmentSnapshot): CardAction {
  if (environment.state === 'running' || environment.state === 'ready') {
    return { id: 'stop', label: 'Stop' };
  }
  if (environment.state === 'disabled') return { id: 'check', label: 'Check' };
  return { id: 'start', label: 'Start' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/entity-actions-test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/entity-actions.ts __tests__/entity-actions-test.ts
git commit -m "feat(app): choose one primary action per provider and environment"
```

---

## Task 11: Rebuild the provider card

**Files:**
- Modify: `src/components/gateway/provider-card.tsx` (full rewrite)
- Create: `src/components/gateway/provider-actions-sheet.tsx`

- [ ] **Step 1: Write the actions sheet**

Create `src/components/gateway/provider-actions-sheet.tsx`:

```tsx
import { Alert } from 'react-native';

import * as Haptics from 'expo-haptics';

import { BaseSheet, Divider, ListRow } from '@/components/ui';

export type ProviderActionsSheetProps = {
  visible: boolean;
  label: string;
  onClose: () => void;
  onSetKey: () => void;
  onAuthorize: () => void;
  onCheck: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onDisable: () => void;
  onDelete: () => void;
};

export function ProviderActionsSheet({
  visible,
  label,
  onClose,
  onSetKey,
  onAuthorize,
  onCheck,
  onRefresh,
  onDisconnect,
  onDisable,
  onDelete,
}: ProviderActionsSheetProps) {
  if (!visible) return null;

  const run = (action: () => void) => () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    action();
    onClose();
  };

  function confirmDelete() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert('Remove provider?', `${label} and its stored credential will be removed from the Gate.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          onDelete();
          onClose();
        },
      },
    ]);
  }

  return (
    <BaseSheet visible={visible} eyebrow="PROVIDER" title={label} onClose={onClose} closeLabel="Dismiss">
      <ListRow title="Set key" icon={{ ios: 'key', android: 'key', web: 'key' }} chevron={false} onPress={run(onSetKey)} />
      <ListRow title="Authorize" icon={{ ios: 'person.badge.key', android: 'lock_open', web: 'lock_open' }} chevron={false} onPress={run(onAuthorize)} />
      <ListRow title="Check readiness" icon={{ ios: 'stethoscope', android: 'health_and_safety', web: 'health_and_safety' }} chevron={false} onPress={run(onCheck)} />
      <ListRow title="Refresh catalog" icon={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} chevron={false} onPress={run(onRefresh)} />
      <Divider />
      <ListRow title="Disconnect" icon={{ ios: 'link.badge.plus', android: 'link_off', web: 'link_off' }} chevron={false} onPress={run(onDisconnect)} />
      <ListRow title="Disable" icon={{ ios: 'pause.circle', android: 'pause_circle', web: 'pause_circle' }} chevron={false} onPress={run(onDisable)} />
      <ListRow title="Remove provider" icon={{ ios: 'trash', android: 'delete', web: 'delete' }} chevron={false} onPress={confirmDelete} />
    </BaseSheet>
  );
}
```

- [ ] **Step 2: Rewrite the card**

Replace `src/components/gateway/provider-card.tsx` entirely:

```tsx
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { ProviderActionsSheet } from '@/components/gateway/provider-actions-sheet';
import { Badge, Button, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { providerPrimaryAction } from '@/lib/gateway/entity-actions';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';
import { providerUiState } from '@/lib/gateway/provider-state';

export type ProviderCardProps = {
  snapshot: ProviderSnapshot;
  onCheck: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onDisable: () => void;
  onDelete: () => void;
  onSetKey: () => void;
  onAuthorize: () => void;
  onEnable: () => void;
};

export function ProviderCard(props: ProviderCardProps) {
  const { snapshot } = props;
  const [actionsVisible, setActionsVisible] = useState(false);
  const label = providerUiState(snapshot);
  const primary = providerPrimaryAction(snapshot);
  const ready = label === 'Ready';

  const handlers: Record<string, () => void> = {
    'set-key': props.onSetKey,
    authorize: props.onAuthorize,
    check: props.onCheck,
    refresh: props.onRefresh,
    enable: props.onEnable,
  };

  const modelCount = snapshot.catalog.models.length;
  const catalogNote =
    snapshot.catalog.state === 'unavailable'
      ? 'no catalog yet'
      : `${modelCount} model${modelCount === 1 ? '' : 's'} · ${snapshot.catalog.source === 'live' ? 'live' : 'last known good'}`;

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text variant="title" numberOfLines={1}>{snapshot.label}</Text>
          <Text variant="caption" color="tertiary" numberOfLines={1}>
            {snapshot.providerType} · {catalogNote}
          </Text>
        </View>
        <Badge label={label} tone={ready ? 'success' : label === 'Not configured' ? 'accent' : 'neutral'} />
      </View>

      {snapshot.readiness.message ? (
        <Text variant="caption" color="tertiary" numberOfLines={3}>
          {snapshot.readiness.message}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          label={primary.label}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            handlers[primary.id]?.();
          }}
          style={styles.primary}
        />
        <PressableScale
          onPress={() => setActionsVisible(true)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${snapshot.label}`}
          style={styles.overflow}>
          <Icon name={{ ios: 'ellipsis', android: 'more_vert', web: 'more_vert' }} size={18} color="textSecondary" />
        </PressableScale>
      </View>

      <ProviderActionsSheet
        visible={actionsVisible}
        label={snapshot.label}
        onClose={() => setActionsVisible(false)}
        onSetKey={props.onSetKey}
        onAuthorize={props.onAuthorize}
        onCheck={props.onCheck}
        onRefresh={props.onRefresh}
        onDisconnect={props.onDisconnect}
        onDisable={props.onDisable}
        onDelete={props.onDelete}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  titles: { flex: 1, minWidth: 0, gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  primary: { flex: 1 },
  overflow: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
```

- [ ] **Step 3: Add the missing `onEnable` handler at the call site**

In `src/components/gateway/providers-section.tsx`, add to the `<ProviderCard>` props:

```tsx
          onEnable={() => void client.update(snapshot.id, { enabled: true }).then(load)}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/gateway/provider-card.tsx src/components/gateway/provider-actions-sheet.tsx src/components/gateway/providers-section.tsx
git commit -m "feat(app): lead the provider card with one action"
```

---

## Task 12: Rebuild the environment card

**Files:**
- Modify: `src/components/gateway/environment-card.tsx` (full rewrite)

- [ ] **Step 1: Rewrite the card**

Mirror Task 11's structure. Replace `src/components/gateway/environment-card.tsx`:

```tsx
import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { Badge, Button, Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { environmentPrimaryAction } from '@/lib/gateway/entity-actions';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

export type EnvironmentCardProps = {
  environment: EnvironmentSnapshot;
  onCheck: () => void;
  onStart: () => void;
  onStop: () => void;
  onRun: () => void;
};

export function EnvironmentCard({ environment, onCheck, onStart, onStop, onRun }: EnvironmentCardProps) {
  const primary = environmentPrimaryAction(environment);
  const handlers: Record<string, () => void> = { start: onStart, stop: onStop, check: onCheck };
  const healthy = environment.state === 'ready' || environment.state === 'running';
  const protocol = environment.probe?.protocol ?? environment.protocolPreference.join(', ');

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text variant="title" numberOfLines={1}>{environment.label}</Text>
          <Text variant="caption" color="tertiary" numberOfLines={1}>
            {environment.adapterId}
            {environment.probe?.cliVersion ? ` ${environment.probe.cliVersion}` : ''} · {protocol}
          </Text>
        </View>
        <Badge label={environment.state} tone={healthy ? 'success' : 'neutral'} />
      </View>

      <Text variant="caption" color="tertiary" numberOfLines={2}>
        {environment.workspacePolicy.defaultSandbox} · {environment.workspacePolicy.defaultRoot}
      </Text>
      <Text variant="caption" color="tertiary">
        {environment.providerRefs.length > 0
          ? `Bound providers: ${environment.providerRefs.join(', ')}`
          : 'Uses its own credentials — no Gate provider bound.'}
      </Text>

      <View style={styles.actions}>
        <Button
          label={primary.label}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            handlers[primary.id]?.();
          }}
          style={styles.primary}
        />
        <Button label="Run" variant="secondary" onPress={onRun} style={styles.primary} />
      </View>
      <Text variant="micro" color="tertiary">Interactive operations require desktop presence.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  titles: { flex: 1, minWidth: 0, gap: 2 },
  actions: { flexDirection: 'row', gap: Spacing.two },
  primary: { flex: 1 },
});
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

```bash
git add src/components/gateway/environment-card.tsx
git commit -m "feat(app): lead the environment card with one action"
```

---

## Task 13: Errors, skeletons, and the key sheet

**Files:**
- Create: `src/components/gateway/provider-key-sheet.tsx`
- Modify: `src/components/gateway/providers-section.tsx`, `src/components/gateway/environments-section.tsx`
- Delete: `src/components/gateway/provider-editor.tsx`

- [ ] **Step 1: Move key entry into a sheet**

Create `src/components/gateway/provider-key-sheet.tsx`:

```tsx
import { useState } from 'react';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export type ProviderKeySheetProps = {
  visible: boolean;
  label: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

/**
 * Anchored to the provider it belongs to. The previous inline editor rendered
 * below the whole list, so setting a key on the first of three providers put
 * the input off-screen.
 */
export function ProviderKeySheet({ visible, label, busy, onSubmit, onClose }: ProviderKeySheetProps) {
  const [value, setValue] = useState('');
  if (!visible) return null;

  return (
    <BaseSheet visible={visible} eyebrow="PROVIDER" title={`Key for ${label}`} onClose={onClose} closeLabel="Cancel">
      <Text variant="caption" color="tertiary">
        Stored in the Gate vault and never shown again. The Gate checks it before this sheet closes.
      </Text>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder="Paste API key"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={{ marginVertical: Spacing.two }}
      />
      <Button
        label={busy ? 'Checking…' : 'Save key'}
        disabled={!value || busy}
        onPress={() => {
          onSubmit(value);
          setValue('');
        }}
      />
    </BaseSheet>
  );
}
```

Delete `src/components/gateway/provider-editor.tsx` and replace its usage in `providers-section.tsx`:

```tsx
      <ProviderKeySheet
        visible={editingId !== null}
        label={providers.find((provider) => provider.id === editingId)?.label ?? editingId ?? ''}
        busy={busy}
        onSubmit={(value) => { if (editingId) void saveKey(editingId, value); }}
        onClose={() => setEditingId(null)}
      />
```

- [ ] **Step 2: Replace bare error captions with `ErrorCard`**

In both `providers-section.tsx` and `environments-section.tsx`, replace:

```tsx
      {error ? <Text variant="caption">{error}</Text> : null}
```

with (providers wording shown; use "CLI environments" and `environments.list` for the environments section):

```tsx
      {error ? (
        <ErrorCard
          cause={error}
          affected="Providers on this Gate"
          next={status === 'connected' ? 'Retry, or check the Gate log for the failing call.' : 'Connect to the Gate first.'}
        />
      ) : null}
```

`ErrorCard` takes exactly `cause`, `affected?`, `next?`, `onRetry?`, `retryLabel?`, `style?` — the props above are correct as written. Add `onRetry={() => void load()}` to give the card a working retry.

- [ ] **Step 3: Add first-load skeletons**

In both sections, add a loading flag:

```tsx
  const [loaded, setLoaded] = useState(false);
```

Set `setLoaded(true)` in a `finally` at the end of `load()`. Then render before the list:

```tsx
      {!loaded && status === 'connected' ? (
        <>
          <Skeleton height={96} style={{ marginBottom: Spacing.three }} />
          <Skeleton height={96} />
        </>
      ) : null}
```

Gate the `EmptyState` on `loaded` too, so it does not flash before the first response:

```tsx
      {loaded && providers.length === 0 && !registering && status === 'connected' ? (
```

`Skeleton` takes `width?`, `height?`, `radius?`, `style?` — the usage above is correct as written.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npx jest --coverage=false`
Expected: all clean.

```bash
git add src/components/gateway/ && git rm src/components/gateway/provider-editor.tsx
git commit -m "feat(app): structure setup errors, loading, and key entry"
```

---

## Task 14: Reject a credential as a secret ref

**Files:**
- Modify: `gate/core/capabilities/secrets.mjs`, `gate/core/capabilities/registry-methods.mjs:97-110`
- Test: `gate/__tests__/secret-ref-guard.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/secret-ref-guard.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeCredential } from '../core/capabilities/secrets.mjs';

test('known key prefixes are rejected', () => {
  for (const value of [
    'sk-Q0f4ioEsl3tE7Hm4ahCvlLIfuPoKxp6OAgXxaoy3mbDP22JR',
    'sk_live_abc123',
    'gsk_abcdef',
    'xai-abcdef',
    'ghp_abcdef',
  ]) {
    assert.equal(looksLikeCredential(value), true, `${value} must be rejected`);
  }
});

test('a long unbroken token is rejected', () => {
  assert.equal(looksLikeCredential('a'.repeat(40)), true);
});

test('ordinary ref names are accepted', () => {
  for (const value of ['my-api-key', 'nvidia/api-key', 'memory.token', 'openai_key', 'k']) {
    assert.equal(looksLikeCredential(value), false, `${value} must be accepted`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gate && node --test "__tests__/secret-ref-guard.test.mjs"`
Expected: FAIL — `looksLikeCredential` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `gate/core/capabilities/secrets.mjs`:

```js
const CREDENTIAL_PREFIXES = ['sk-', 'sk_', 'gsk_', 'xai-', 'ghp_', 'github_pat_'];

/**
 * The vault names each file after its ref, so a ref that is itself a key writes
 * the secret into a filename — which happened on 2026-08-14, in a directory
 * that was not gitignored. This rejects rather than sanitizes: a silently
 * renamed ref would strand the secret under a name no adapter reads.
 */
export function looksLikeCredential(refName) {
  const value = String(refName ?? '').trim();
  if (CREDENTIAL_PREFIXES.some((prefix) => value.toLowerCase().startsWith(prefix))) return true;
  return value.length >= 32 && !/[/\-_.:]/.test(value);
}
```

In `gate/core/capabilities/registry-methods.mjs`, add the check inside `registry.secrets.set` after the existing `provider/` guard (line ~107):

```js
      if (looksLikeCredential(refName)) {
        throw new Error(
          'refName looks like a credential. It names the secret, it is not the secret — put the key in "value".',
        );
      }
```

Add it to the import on line 5:

```js
import { setSecret, looksLikeCredential } from './secrets.mjs';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gate && node --test "__tests__/secret-ref-guard.test.mjs"` then `npm run test:gate`
Expected: PASS both.

- [ ] **Step 5: Label the field in the app**

In `src/app/gateway/capabilities.tsx`, change the secret-value label (line ~213) and add validation in `saveDraft` before the `registry.secrets.set` call (line ~128):

```tsx
      if (refName && draft.secretValue.trim()) {
        if (/^(sk-|sk_|gsk_|xai-|ghp_)/i.test(refName)) {
          setError('The secret-ref field names the secret — it is not the key itself. Put the key in the value field.');
          return;
        }
        await gatewayRequest('registry.secrets.set', { refName, value: draft.secretValue.trim() });
      }
```

Update the label text to: `Secret value — the key itself. The ref field above only names it.`

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all clean.

```bash
git add gate/core/capabilities/secrets.mjs gate/core/capabilities/registry-methods.mjs gate/__tests__/secret-ref-guard.test.mjs src/app/gateway/capabilities.tsx
git commit -m "fix(gate,app): reject a credential used as a secret ref"
```

---

## Final verification

- [ ] Run the full gate: `npx tsc --noEmit && npm run lint && npm test && npm run smoke:portal`
- [ ] Start the Gate and confirm the manifest carries real providers:
  ```bash
  curl -s http://127.0.0.1:8760/.well-known/gateway.json | jq '.providers, .backends'
  ```
  Expected: three providers with `readiness`/`catalog`, three backends with `state`.
- [ ] On the phone: open Chat, confirm the header names the backend, switch backend, confirm the session resets and the model chip changes.
