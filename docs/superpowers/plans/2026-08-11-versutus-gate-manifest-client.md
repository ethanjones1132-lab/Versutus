# ManifestClient, Provider Child Sync & Live Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app treat any conforming manifest-driven gateway as a first-class citizen. Today `createClientForKind('custom', ...)` falls through to `HermesGatewayClient` as a stopgap — a comment in `adapters.ts` says as much. This plan replaces that stopgap with `ManifestClient`, a `PortalClient` that resolves its routes from the gateway's own advertised `endpoints` instead of hardcoded Hermes paths. It also makes each provider a Gate advertises show up in the app as its own gateway entry with no phone-side setup, and extends the live smoke suite to run identical assertions against both Hermes and the Gate — proof the abstraction is real, not asserted.

**Architecture:** `ManifestClient` composes `HttpTransport` and `ConnectionMonitor` (built in Plan 1's foundation work) exactly the way `HermesGatewayClient` does, so the two-strike health policy and header sanitization live in one place and both clients share it. It differs from `HermesGatewayClient` only in *where it gets its paths*: every route comes from `identity.manifest.endpoints`, and any capability the manifest doesn't advertise fails with a clear, named error rather than guessing at a Hermes-shaped path that may not exist. Provider child sync is a small pure reconciliation function (given a parent profile, its manifest's `providers[]`, and the current gateway list, compute which child profiles to add, update, or remove) called from the app's existing single connect chokepoint (`attachClient` in `gateway-provider.tsx`) — no new integration surface, no polling.

**Tech Stack:** TypeScript + Jest, matching the rest of the app. No new dependencies — `ManifestClient` reuses `HttpTransport`/`ConnectionMonitor` from `src/lib/gateway/http-transport.ts` / `connection-monitor.ts`.

**This is Plan 2 of 2 for the Versutus Gate work** (Plan 1: foundation + Gate core; Plan 2a: chat proxy, Anthropic flavor, Ed25519 pairing — both complete). This plan is the acceptance gate for the whole multi-plan effort: Task 10's live comparison is the evidence that a phone-side abstraction built against one gateway (Hermes) also works, unmodified, against a completely different one (the Gate) — the actual point of the whole `versutus-gateway/v1` manifest contract.

---

## File Structure

**Modified:**
- `src/lib/portal/manifest.ts` — adds `GatewayManifestProvider` type, `providers?: GatewayManifestProvider[]` on `GatewayManifest`, a `manifestProviders()` accessor.
- `src/lib/portal/identify.ts` — carries `providers` through into `GatewayIdentity`.
- `src/lib/gateway/types.ts` — adds `parentId?: string` to `GatewayProfile` (child profiles point at the gateway that advertised them).
- `src/lib/portal/adapters.ts` — `createClientForKind('custom', ...)` now returns `ManifestClient` instead of falling through to `HermesGatewayClient`.
- `src/context/gateway-provider.tsx` — `attachClient` fetches the manifest post-connect and calls child sync.
- `scripts/smoke-live-gateway.mts` — generalized to identify the target gateway and use `createClientForKind` instead of constructing `HermesGatewayClient` directly, so the same assertions run against any kind.

**New:**
- `src/lib/gateway/child-sync.ts` — pure `reconcileChildProfiles()` plus a thin async `syncChildProfiles()` wrapper over `storage.ts`.
- `src/lib/gateway/manifest-client.ts` — `ManifestClient implements PortalClient`.
- `__tests__/manifest-providers-test.ts`
- `__tests__/child-sync-test.ts`
- `__tests__/manifest-client-test.ts`

---

## Task 1: Parse `providers[]` from the manifest

**Files:**
- Modify: `src/lib/portal/manifest.ts`
- Test: `__tests__/manifest-providers-test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/manifest-providers-test.ts`:

```ts
import { manifestProviders, type GatewayManifest } from '@/lib/portal/manifest';

const baseManifest: GatewayManifest = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Test Gate',
};

describe('manifestProviders', () => {
  test('returns an empty array when the manifest has no providers field', () => {
    expect(manifestProviders(baseManifest)).toEqual([]);
  });

  test('returns each well-formed provider entry', () => {
    const manifest: GatewayManifest = {
      ...baseManifest,
      providers: [
        { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true, streaming: true } },
      ],
    };
    expect(manifestProviders(manifest)).toEqual([
      { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true, streaming: true } },
    ]);
  });

  test('drops a malformed entry rather than throwing', () => {
    const manifest = {
      ...baseManifest,
      providers: [
        { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: {} },
        { id: 'broken' }, // missing basePath/models
        'not even an object',
      ],
    } as unknown as GatewayManifest;
    const result = manifestProviders(manifest);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('claude');
  });

  test('returns an empty array when providers is not an array', () => {
    const manifest = { ...baseManifest, providers: 'nope' } as unknown as GatewayManifest;
    expect(manifestProviders(manifest)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/manifest-providers-test.ts`
Expected: FAIL — `manifestProviders` is not exported, `GatewayManifestProvider` type doesn't exist

- [ ] **Step 3: Add the type and the parser**

In `src/lib/portal/manifest.ts`, add after `GatewayManifestAuth`:

```ts
export type GatewayManifestProvider = {
  id: string;
  label: string;
  basePath: string;
  models: string[];
  capabilities: { chat?: boolean; streaming?: boolean; [key: string]: boolean | undefined };
};

function isGatewayManifestProvider(value: unknown): value is GatewayManifestProvider {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.label === 'string' &&
    typeof raw.basePath === 'string' &&
    raw.basePath.length > 0 &&
    Array.isArray(raw.models) &&
    raw.models.every((m) => typeof m === 'string') &&
    typeof raw.capabilities === 'object' &&
    raw.capabilities !== null
  );
}
```

Add `providers?: GatewayManifestProvider[];` to the `GatewayManifest` type, right after `endpoints`:

```ts
  endpoints?: Record<string, string>;
  providers?: GatewayManifestProvider[];
};
```

Add the accessor at the bottom, near the other `manifest*` helpers:

```ts
/**
 * Every well-formed provider a gate advertises. A malformed entry is dropped,
 * not thrown — one bad entry in an otherwise valid manifest shouldn't take
 * down identification for every other provider.
 */
export function manifestProviders(manifest: GatewayManifest): GatewayManifestProvider[] {
  if (!Array.isArray(manifest.providers)) return [];
  return manifest.providers.filter(isGatewayManifestProvider);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/manifest-providers-test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/portal/manifest.ts __tests__/manifest-providers-test.ts
git commit -m "feat(portal): parse providers[] from the gateway manifest"
```

---

## Task 2: Carry providers through `GatewayIdentity`

**Files:**
- Modify: `src/lib/portal/identify.ts`

No new test file — this is a small, direct extension of `identityFromManifest`, and the existing manifest-parsing test coverage (Task 1) plus the pre-existing `identify.ts` behavior (unchanged for every other path) cover it. Verified by a one-line assertion added to Task 1's test file's sibling check below.

- [ ] **Step 1: Add `providers` to the `GatewayIdentity` type**

In `src/lib/portal/identify.ts`, add the import and field:

```ts
import {
  fetchGatewayManifest,
  manifestAuthSchemes,
  manifestCapabilityList,
  manifestKindLabel,
  manifestProviders,
  manifestRequiresToken,
  type GatewayManifest,
  type GatewayManifestProvider,
} from '@/lib/portal/manifest';
```

Add to the `GatewayIdentity` type, after `capabilities?: string[];`:

```ts
  /** Providers this gate advertises behind one manifest — see manifest.ts. */
  providers?: GatewayManifestProvider[];
```

- [ ] **Step 2: Populate it in `identityFromManifest`**

In `identityFromManifest`, add `providers: manifestProviders(manifest),` to the returned object, after `capabilities: manifestCapabilityList(manifest),`.

- [ ] **Step 3: Add one assertion covering this to the existing manifest-providers test**

Append to `__tests__/manifest-providers-test.ts`:

```ts
import { identifyGateway } from '@/lib/portal/identify';

describe('identifyGateway carries providers through', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a manifest with providers surfaces them on the identity', async () => {
    const manifest = {
      manifest: 'versutus-gateway/v1',
      kind: 'versutus-gate',
      auth: { schemes: ['bearer'] },
      providers: [
        { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true } },
      ],
    };
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(manifest)),
      } as unknown as Response),
    );

    const identity = await identifyGateway({ baseUrl: 'http://gate.test:8760' });
    expect(identity.providers).toHaveLength(1);
    expect(identity.providers?.[0].id).toBe('claude');
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/manifest-providers-test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/portal/identify.ts __tests__/manifest-providers-test.ts
git commit -m "feat(portal): carry manifest providers into GatewayIdentity"
```

---

## Task 3: Add `parentId` to `GatewayProfile`

**Files:**
- Modify: `src/lib/gateway/types.ts`

No test — a type-only addition. Verified by the typecheck step at the end of this task and exercised by Task 4's tests.

- [ ] **Step 1: Add the field**

In `src/lib/gateway/types.ts`, add to `GatewayProfile`, after `discoverySource`:

```ts
  discoverySource?: 'local' | 'wide-area' | 'manual' | 'tailscale' | 'relay' | 'deep-link';
  /**
   * Set on a profile materialized from a parent gateway's manifest
   * providers[] entry — see child-sync.ts. Absent on a profile the user
   * added directly.
   */
  parentId?: string;
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/gateway/types.ts
git commit -m "feat(gateway): add parentId to GatewayProfile for child sync"
```

---

## Task 4: Provider child-profile reconciliation

**Files:**
- Create: `src/lib/gateway/child-sync.ts`
- Test: `__tests__/child-sync-test.ts`

`reconcileChildProfiles` is a pure function: given a parent profile, the providers its manifest currently advertises, and every existing gateway (parent and children mixed together, as the app actually stores them), it computes which child profiles to upsert and which to remove. Child ids are deterministic (`${parentId}::${providerId}`) so re-running sync against an unchanged manifest is a no-op, and so "which gateways are this parent's children" can be answered without a separate index.

- [ ] **Step 1: Write the failing test**

Create `__tests__/child-sync-test.ts`:

```ts
import { reconcileChildProfiles } from '@/lib/gateway/child-sync';
import type { GatewayManifestProvider } from '@/lib/portal/manifest';
import type { GatewayProfile } from '@/lib/gateway/types';

const PARENT: GatewayProfile = {
  id: 'gw-parent',
  name: 'My Gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'parent-token',
  createdAt: 1000,
};

function provider(overrides: Partial<GatewayManifestProvider> = {}): GatewayManifestProvider {
  return {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
    ...overrides,
  };
}

describe('reconcileChildProfiles', () => {
  test('creates a child profile for a newly advertised provider', () => {
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT]);
    expect(toRemove).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({
      id: 'gw-parent::claude',
      name: 'Claude',
      url: 'http://gate.test:8760/p/claude',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
    });
  });

  test('is a no-op when the child already matches the provider', () => {
    const existingChild: GatewayProfile = {
      id: 'gw-parent::claude',
      name: 'Claude',
      url: 'http://gate.test:8760/p/claude',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT, existingChild]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  test('updates an existing child when the parent token rotates, preserving its id and createdAt', () => {
    const existingChild: GatewayProfile = {
      id: 'gw-parent::claude',
      name: 'Claude',
      url: 'http://gate.test:8760/p/claude',
      kind: 'custom',
      token: 'stale-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT, existingChild]);
    expect(toRemove).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({ id: 'gw-parent::claude', token: 'parent-token', createdAt: 2000 });
  });

  test('removes a child whose provider is no longer advertised', () => {
    const existingChild: GatewayProfile = {
      id: 'gw-parent::gone',
      name: 'Gone',
      url: 'http://gate.test:8760/p/gone',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [], [PARENT, existingChild]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual(['gw-parent::gone']);
  });

  test('never touches a gateway belonging to a different parent', () => {
    const otherParentChild: GatewayProfile = {
      id: 'gw-other::claude',
      name: 'Claude',
      url: 'http://other.test:8760/p/claude',
      kind: 'custom',
      token: 't',
      parentId: 'gw-other',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [], [PARENT, otherParentChild]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  test('handles multiple providers, adding one and removing another in the same pass', () => {
    const staleChild: GatewayProfile = {
      id: 'gw-parent::old',
      name: 'Old',
      url: 'http://gate.test:8760/p/old',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(
      PARENT,
      [provider(), provider({ id: 'grok', label: 'Grok', basePath: '/p/grok', models: ['grok-4'] })],
      [PARENT, staleChild],
    );
    expect(toRemove).toEqual(['gw-parent::old']);
    expect(toUpsert.map((p) => p.id).sort()).toEqual(['gw-parent::claude', 'gw-parent::grok']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/child-sync-test.ts`
Expected: FAIL — cannot find module `@/lib/gateway/child-sync`

- [ ] **Step 3: Write the implementation**

Create `src/lib/gateway/child-sync.ts`:

```ts
// ─── Provider child-profile sync ──────────────────────────────────
// A gate can advertise multiple providers behind one manifest (spec §7).
// Each becomes its own GatewayProfile so the rest of the app (which only
// knows how to talk to "a gateway") needs no special case for "a gateway
// with children." Child ids are deterministic so re-syncing an unchanged
// manifest is a no-op, and so "every child of this parent" is answerable
// by id prefix alone — no separate index to keep in sync.

import type { GatewayManifestProvider } from '@/lib/portal/manifest';
import type { GatewayProfile } from '@/lib/gateway/types';
import { loadGateways, saveGateways } from '@/lib/gateway/storage';

export function childProfileId(parentId: string, providerId: string): string {
  return `${parentId}::${providerId}`;
}

function childProfileFor(
  parent: GatewayProfile,
  provider: GatewayManifestProvider,
  existing: GatewayProfile | undefined,
): GatewayProfile {
  return {
    id: childProfileId(parent.id, provider.id),
    name: provider.label,
    url: `${parent.url.replace(/\/+$/, '')}${provider.basePath}`,
    kind: 'custom',
    token: parent.token,
    parentId: parent.id,
    createdAt: existing?.createdAt ?? Date.now(),
  };
}

function profilesEqual(a: GatewayProfile, b: GatewayProfile): boolean {
  return a.name === b.name && a.url === b.url && a.token === b.token && a.kind === b.kind;
}

/**
 * Pure reconciliation: given the parent, what it currently advertises, and
 * every gateway the app knows about, compute the child-profile diff. Never
 * touches a gateway belonging to a different parent.
 */
export function reconcileChildProfiles(
  parent: GatewayProfile,
  providers: GatewayManifestProvider[],
  allGateways: GatewayProfile[],
): { toUpsert: GatewayProfile[]; toRemove: string[] } {
  const prefix = `${parent.id}::`;
  const existingChildren = new Map(
    allGateways.filter((g) => g.parentId === parent.id && g.id.startsWith(prefix)).map((g) => [g.id, g]),
  );

  const toUpsert: GatewayProfile[] = [];
  const wanted = new Set<string>();

  for (const provider of providers) {
    const id = childProfileId(parent.id, provider.id);
    wanted.add(id);
    const existing = existingChildren.get(id);
    const next = childProfileFor(parent, provider, existing);
    if (!existing || !profilesEqual(existing, next)) toUpsert.push(next);
  }

  const toRemove = [...existingChildren.keys()].filter((id) => !wanted.has(id));

  return { toUpsert, toRemove };
}

/**
 * Applies reconcileChildProfiles against persisted storage and returns the
 * resulting full gateway list. Call after a successful connect or capability
 * refresh — see gateway-provider.tsx's attachClient.
 */
export async function syncChildProfiles(
  parent: GatewayProfile,
  providers: GatewayManifestProvider[],
): Promise<GatewayProfile[]> {
  const current = await loadGateways();
  const { toUpsert, toRemove } = reconcileChildProfiles(parent, providers, current);
  if (toUpsert.length === 0 && toRemove.length === 0) return current;

  const removeSet = new Set(toRemove);
  const upsertMap = new Map(toUpsert.map((p) => [p.id, p]));
  const next = current
    .filter((g) => !removeSet.has(g.id))
    .map((g) => upsertMap.get(g.id) ?? g);
  for (const [id, profile] of upsertMap) {
    if (!next.some((g) => g.id === id)) next.push(profile);
  }

  await saveGateways(next);
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/child-sync-test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/child-sync.ts __tests__/child-sync-test.ts
git commit -m "feat(gateway): reconcile child profiles from manifest providers[]"
```

---

## Task 5: Wire child sync into the connect flow

**Files:**
- Modify: `src/context/gateway-provider.tsx`

No new test file — `gateway-provider.tsx` has no existing unit test suite (it's a React context provider exercised through app usage), consistent with the rest of this file's testing approach. Verified by typecheck and the manual check in Step 3.

- [ ] **Step 1: Add the import**

In `src/context/gateway-provider.tsx`, add:

```tsx
import { fetchGatewayManifest } from '@/lib/portal/manifest';
import { manifestProviders } from '@/lib/portal/manifest';
import { syncChildProfiles } from '@/lib/gateway/child-sync';
```

(Combine with the existing `manifest.ts` import if one is already present in the file — check before adding a duplicate.)

- [ ] **Step 2: Call child sync after a successful connect**

In `attachClient`, after the `await client.connect();` line succeeds (i.e. after the existing `try { await client.connect(); } catch (error) { ... }` block, once no error was thrown), add:

```ts
      // Fetch is cheap and idempotent; only a manifest-serving gate returns
      // providers[] at all, so this is a no-op against Hermes/OpenClaw.
      void fetchGatewayManifest(gateway.url)
        .then((manifest) => {
          if (!manifest || !isCurrent()) return;
          return syncChildProfiles(gateway, manifestProviders(manifest));
        })
        .then((next) => {
          if (next && isCurrent()) setGateways(next);
        })
        .catch(() => undefined);
```

Place this right after the `try`/`catch` around `client.connect()` in `attachClient` — after the function returns normally (connect succeeded), before `attachClient`'s closing brace. Do not await it; sync runs in the background and updates the `gateways` list when it resolves, matching how `onCapabilities`/`onHello` already update state asynchronously in this same callback set.

- [ ] **Step 3: Verify manually**

This step needs a running Gate with at least one provider configured (from Plan 2a's manual verification) and the app pointed at it as a `custom`-kind gateway. If you don't have that running right now, skip this step and note it as pending in your final report — do not fabricate a result.

If you do: add the Gate as a gateway in the app, connect, and confirm a new gateway entry appears in the gateway list for each configured provider, named after the provider's `label`. Add or remove a provider on the Gate (`node gate/cli.mjs add ...` or delete a `gate/providers/<id>` directory) and restart the Gate; reconnect in the app and confirm the gateway list updates to match.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/context/gateway-provider.tsx
git commit -m "feat(gateway): sync provider child profiles on connect"
```

---

## Task 6: ManifestClient — connection, health, models, capabilities

**Files:**
- Create: `src/lib/gateway/manifest-client.ts`
- Test: `__tests__/manifest-client-test.ts`

This is the first of three tasks building `ManifestClient`. This one covers construction, `connect()`/`disconnect()`, and the three read endpoints every conforming manifest must advertise: health, models, and a capabilities snapshot synthesized from the manifest itself (a manifest-driven gate has no separate `/v1/capabilities` endpoint the way Hermes does — the manifest *is* the capability declaration).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/manifest-client-test.ts`:

```ts
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('ManifestClient', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });
  beforeEach(() => jest.useFakeTimers());

  test('connects by resolving health and models from manifest endpoints, not hardcoded paths', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) return Promise.resolve(jsonResponse({ data: [{ id: 'm1', object: 'model' }] }));
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.connect();

    expect(client.connectionStatus).toBe('connected');
    expect(calls.some((u) => u.endsWith('/health'))).toBe(true);
    client.disconnect();
  });

  test('throws a named error when the manifest has no health endpoint', async () => {
    const identityNoHealth: GatewayIdentity = {
      ...IDENTITY,
      manifest: { ...IDENTITY.manifest!, endpoints: { models: '/v1/models' } },
    };
    const client = new ManifestClient(PROFILE, identityNoHealth, {});
    await expect(client.connect()).rejects.toThrow(/health/i);
  });

  test('getModels resolves from the manifest-declared models endpoint', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'claude-opus-5', object: 'model' }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.connect();
    const models = await client.getModels();
    expect(models).toEqual([{ id: 'claude-opus-5', object: 'model' }]);
    client.disconnect();
  });

  test('getCapabilities synthesizes a snapshot from the manifest, not a live endpoint', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) return Promise.resolve(jsonResponse({ data: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.connect();
    const caps = await client.getCapabilities();
    expect(caps.features.chat).toBe(true);
    expect(caps.features.models).toBe(true);
    client.disconnect();
  });

  test('a rejected models call surfaces as an auth failure, matching HermesGatewayClient', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) {
        return Promise.resolve(jsonResponse({ error: { message: 'Invalid token' } }, 401));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.connect()).rejects.toThrow(/token/i);
    client.disconnect();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: FAIL — cannot find module `@/lib/gateway/manifest-client`

- [ ] **Step 3: Write the implementation**

Create `src/lib/gateway/manifest-client.ts`:

```ts
import { isAuthRejection } from '@/lib/gateway/errors';
import { HttpTransport } from '@/lib/gateway/http-transport';
import { ConnectionMonitor, HEALTH_INTERVAL_MS } from '@/lib/gateway/connection-monitor';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { PortalClientCallbacks } from '@/lib/portal/adapters';
import type {
  ConnectionStatus,
  GatewayCapabilities,
  GatewayProfile,
  HealthResponse,
  HermesSession,
  ModelInfo,
  SessionMessage,
} from '@/lib/gateway/types';

/**
 * A PortalClient for any gateway that serves the Open Gateway Manifest and
 * has no built-in adapter (spec: docs/superpowers/specs/2026-08-10-versutus-gate-design.md §7).
 * Every route comes from `identity.manifest.endpoints` — never a hardcoded
 * Hermes path — so a conforming gate works here with zero app-side code
 * specific to it. A capability the manifest doesn't advertise fails with a
 * named error rather than guessing at a path that may not exist.
 */
export class ManifestClient {
  private closed = false;
  private status: ConnectionStatus = 'disconnected';
  private detail = '';
  private currentSessionId: string | undefined;
  private transport: HttpTransport;
  private monitor: ConnectionMonitor;
  private endpoints: Record<string, string>;

  constructor(
    private profile: GatewayProfile,
    private identity: GatewayIdentity,
    private callbacks: PortalClientCallbacks = {},
  ) {
    this.endpoints = identity.manifest?.endpoints ?? {};
    this.transport = new HttpTransport({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
    this.monitor = new ConnectionMonitor({
      probe: async () => (await this.healthCheck()) !== null,
      recentlyServedUs: () =>
        this.transport.lastContactAt > 0 &&
        Date.now() - this.transport.lastContactAt < HEALTH_INTERVAL_MS,
      onStatus: (status, detail) => this.setStatus(status, detail),
      reconnect: () => this.connect().catch(() => undefined),
    });
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get statusDetail(): string {
    return this.detail;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  setSessionId(id: string | undefined) {
    this.currentSessionId = id;
  }

  updateProfile(profile: GatewayProfile) {
    this.profile = profile;
    this.transport.update({ baseUrl: profile.url, token: profile.token, sessionKey: profile.sessionKey });
  }

  /** The manifest-declared path for `name`, or throws a named error. */
  private requireEndpoint(name: string): string {
    const path = this.endpoints[name];
    if (!path) {
      throw new Error(`This gateway's manifest does not advertise a "${name}" endpoint.`);
    }
    return path;
  }

  async connect() {
    this.closed = false;
    this.setStatus('connecting');

    let health: HealthResponse | null;
    try {
      health = await this.healthCheck();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
      this.monitor.scheduleReconnect(message);
      throw error;
    }

    if (!health) {
      const reason = 'no response';
      this.callbacks.onError?.(`Could not reach ${this.transport.displayHost}: ${reason}`);
      this.monitor.scheduleReconnect(`No answer from ${this.transport.displayHost}`);
      return;
    }

    let capabilities: GatewayCapabilities | null = null;
    try {
      capabilities = await this.getCapabilities();
      // Prove the token by hitting an authenticated endpoint, mirroring
      // HermesGatewayClient's connect(): a manifest fetch alone is
      // unauthenticated, so it would never catch a rejected token.
      if (this.endpoints.models) await this.getModels();
    } catch (error) {
      if (isAuthRejection(error)) {
        this.monitor.suspend();
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus('disconnected', message);
        throw error;
      }
      // A capability snapshot or model list failing otherwise doesn't block connect.
    }

    this.setStatus('connected');
    this.callbacks.onHello?.({ type: 'hello-ok', protocol: 1, server: { version: this.identity.version } });
    if (capabilities) this.callbacks.onCapabilities?.(capabilities);
    this.callbacks.onHealthCheck?.(true, health);
    this.monitor.noteConnected();
    this.monitor.start();
  }

  disconnect() {
    this.closed = true;
    this.monitor.stop();
    this.monitor.resume();
    if (this.currentSessionId) this.profile.sessionId = this.currentSessionId;
    this.setStatus('disconnected');
  }

  suspendReconnect() {
    this.monitor.suspend();
  }

  resumeReconnect() {
    this.monitor.resume();
    if (!this.closed && this.status !== 'connected') {
      void this.connect().catch(() => undefined);
    }
  }

  async healthCheck(timeoutMs = 8000): Promise<HealthResponse | null> {
    try {
      const path = this.requireEndpoint('health');
      return await this.transport.request<HealthResponse>('GET', path, undefined, timeoutMs);
    } catch {
      return null;
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    const path = this.requireEndpoint('models');
    const result = await this.transport.request<{ data: ModelInfo[] }>('GET', path);
    return result.data;
  }

  /**
   * A manifest-driven gate has no separate live capabilities endpoint — the
   * manifest itself is the capability declaration. Synthesize the same
   * shape HermesGatewayClient reports so the rest of the app (capability
   * snapshot UI, dashboards) needs no gateway-kind branch.
   */
  async getCapabilities(): Promise<GatewayCapabilities> {
    const manifestCaps = this.identity.manifest?.capabilities ?? {};
    const endpointsRecord: Record<string, { method: string; path: string }> = {};
    for (const [name, path] of Object.entries(this.endpoints)) {
      endpointsRecord[name] = { method: name === 'chat' ? 'POST' : 'GET', path };
    }
    return {
      object: 'manifest-derived.capabilities',
      platform: this.identity.kindLabel,
      model: '',
      auth: { type: this.identity.auth.schemes[0] ?? 'bearer', required: this.identity.auth.requiresToken },
      runtime: { mode: 'gate', tool_execution: 'remote', split_runtime: false, description: this.identity.name ?? '' },
      features: { ...manifestCaps } as Record<string, boolean | string>,
      endpoints: endpointsRecord,
    };
  }

  private setStatus(status: ConnectionStatus, detail = '') {
    this.status = status;
    this.detail = detail;
    this.callbacks.onStatus?.(status, detail);
  }
}
```

This task deliberately leaves `streamChat`, `getSessions`, `getSessionMessages`, `rpcRequest`, and `stopRun` unimplemented — the class won't satisfy `PortalClient` yet and won't compile against that interface. That's expected; Tasks 7–8 add them. Don't add `implements PortalClient` to the class declaration until Task 8's step confirms it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/manifest-client.ts __tests__/manifest-client-test.ts
git commit -m "feat(gateway): add ManifestClient — connect, health, models, capabilities"
```

---

## Task 7: ManifestClient — chat streaming

**Files:**
- Modify: `src/lib/gateway/manifest-client.ts`
- Modify: `__tests__/manifest-client-test.ts`

The Gate normalizes every provider's response to the same OpenAI-shaped SSE delta (`{"choices":[{"delta":{"content":"..."}}]}`) regardless of upstream flavor — Plan 2a Task 9 built exactly that. `streamChat` here can therefore reuse the identical SSE-delta parsing `HermesGatewayClient.streamChat` already uses, which is itself evidence the abstraction holds: the same parsing code works against both gateways because the Gate was built to speak the dialect the app already understood.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/manifest-client-test.ts`:

```ts
describe('ManifestClient.streamChat', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('streams normalized SSE deltas from the manifest-declared chat endpoint', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const chunks: string[] = [];
    const full = await client.streamChat([{ role: 'user', content: 'hi' }], (t) => chunks.push(t));

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(full).toBe('Hello');
  });

  test('throws a named error when the manifest has no chat endpoint', async () => {
    const identityNoChat: GatewayIdentity = { ...IDENTITY, manifest: { ...IDENTITY.manifest!, endpoints: { health: '/health' } } };
    const client = new ManifestClient(PROFILE, identityNoChat, {});
    await expect(client.streamChat([{ role: 'user', content: 'hi' }], () => undefined)).rejects.toThrow(/chat/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: FAIL — `client.streamChat is not a function`

- [ ] **Step 3: Add `streamChat`**

In `src/lib/gateway/manifest-client.ts`, add after `getCapabilities`:

```ts
  async streamChat(
    messages: { role: string; content: string }[],
    onDelta: (text: string) => void,
    options?: { model?: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<string> {
    const path = this.requireEndpoint('chat');
    const body: Record<string, unknown> = { model: options?.model, messages, stream: true };

    const controller = new AbortController();
    const signal = options?.signal || controller.signal;

    const response = await fetch(`${this.transport.baseUrl}${path}`, {
      method: 'POST',
      headers: this.transport.headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    let fullText = '';
    await this.transport.streamSSE(
      response,
      (data) => {
        try {
          const chunk = JSON.parse(data);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onDelta(delta);
          }
        } catch {
          // ignore malformed chunks — matches HermesGatewayClient's streamChat
        }
      },
      signal,
    );

    return fullText;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/manifest-client.ts __tests__/manifest-client-test.ts
git commit -m "feat(gateway): add ManifestClient.streamChat via the manifest chat endpoint"
```

---

## Task 8: ManifestClient — graceful degradation for unadvertised capabilities

**Files:**
- Modify: `src/lib/gateway/manifest-client.ts`
- Modify: `__tests__/manifest-client-test.ts`

`PortalClient` requires `getSessions`, `getSessionMessages`, `rpcRequest`, and `stopRun` (they're not optional on the interface, unlike `createSession`/`startRun`/etc.). A manifest-driven gate isn't required to advertise session or run management — Plan 1's Gate doesn't. Each method here must fail with a clear, named error rather than guessing at a Hermes-shaped path, and this task is also where the class formally declares `implements PortalClient` so a compile error catches any gap immediately.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/manifest-client-test.ts`:

```ts
describe('ManifestClient — capabilities the manifest does not advertise', () => {
  test('getSessions names the missing capability rather than guessing a path', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.getSessions()).rejects.toThrow(/sessions/i);
  });

  test('getSessionMessages names the missing capability', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.getSessionMessages('s1')).rejects.toThrow(/sessions/i);
  });

  test('rpcRequest names the missing capability with the method that was requested', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.rpcRequest('sessions.list')).rejects.toThrow(/sessions\.list/);
  });

  test('stopRun names the missing capability', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.stopRun('r1')).rejects.toThrow(/run/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: FAIL — `client.getSessions is not a function` etc.

- [ ] **Step 3: Add the four methods and declare the interface**

In `src/lib/gateway/manifest-client.ts`:

Change the class declaration to import and implement `PortalClient`:

```ts
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';

// ...

export class ManifestClient implements PortalClient {
```

Add the four methods after `streamChat`:

```ts
  async getSessions(_limit?: number): Promise<HermesSession[]> {
    throw new Error(
      `${this.identity.kindLabel} does not advertise session management. This gate has no /api/sessions-style endpoint declared in its manifest.`,
    );
  }

  async getSessionMessages(_sessionId: string, _limit?: number): Promise<SessionMessage[]> {
    throw new Error(
      `${this.identity.kindLabel} does not advertise session management, so message history is unavailable.`,
    );
  }

  async rpcRequest<T = unknown>(method: string, _params: Record<string, unknown> = {}): Promise<T> {
    throw new Error(
      `${method} is not supported by ${this.identity.kindLabel} — it only advertises: ${Object.keys(this.endpoints).join(', ') || 'nothing'}.`,
    );
  }

  async stopRun(_runId: string): Promise<void> {
    throw new Error(`${this.identity.kindLabel} does not advertise run management, so a run cannot be stopped remotely.`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Typecheck to confirm the interface is fully satisfied**

Run: `npx tsc --noEmit`
Expected: no errors — this is the real proof `ManifestClient implements PortalClient` compiles clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/gateway/manifest-client.ts __tests__/manifest-client-test.ts
git commit -m "feat(gateway): complete PortalClient with named errors for unadvertised capabilities"
```

---

## Task 9: Wire ManifestClient into `createClientForKind`

**Files:**
- Modify: `src/lib/portal/adapters.ts`

`createClientForKind` currently takes only `(kind, profile, callbacks)` — no `GatewayIdentity`. `ManifestClient` needs the identity (specifically `identity.manifest.endpoints`) to build its routes, so this task threads an optional identity through the existing signature rather than changing every call site.

- [ ] **Step 1: Update the signature**

In `src/lib/portal/adapters.ts`, add the import and widen the signature:

```ts
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
```

Change `createClientForKind`:

```ts
/**
 * Create the client for an identified gateway kind.
 * - hermes / unknown → HermesGatewayClient (HTTP + SSE)
 * - openclaw → OpenClawAdapterClient (WS v4 with a Hermes-shaped surface)
 * - custom → ManifestClient when an identity with a manifest is supplied
 *   (resolves routes from endpoints); falls back to the Hermes-shaped HTTP
 *   adapter when no manifest is available, matching prior behaviour.
 */
export function createClientForKind(
  kind: GatewayKind,
  profile: GatewayProfile,
  callbacks: PortalClientCallbacks = {},
  identity?: GatewayIdentity,
): PortalClient {
  switch (kind) {
    case 'openclaw':
      return new OpenClawAdapterClient(profile, callbacks);
    case 'custom':
      if (identity?.manifest) return new ManifestClient(profile, identity, callbacks);
      return new HermesGatewayClient(profile, callbacks as GatewayClientCallbacks);
    case 'hermes':
    case 'unknown':
    default:
      return new HermesGatewayClient(profile, callbacks as GatewayClientCallbacks);
  }
}
```

- [ ] **Step 2: Thread the identity through from `attachClient`**

`attachClient` in `gateway-provider.tsx` currently calls `createClientForKind(gateway.kind ?? 'hermes', gateway, {...})` with no identity. A stored `GatewayProfile` doesn't currently carry the manifest — only `identifyGateway` (called once, at add-time) produces one, and it's discarded after add. For a `custom`-kind gateway, re-fetch the manifest before creating the client:

In `attachClient`, before the `const client = createClientForKind(...)` line, add:

```ts
      let identityForClient: GatewayIdentity | undefined;
      if (gateway.kind === 'custom') {
        const manifest = await fetchGatewayManifest(gateway.url).catch(() => null);
        if (manifest) {
          identityForClient = {
            kind: 'custom',
            kindLabel: manifestKindLabel(manifest),
            manifest,
            auth: {
              schemes: manifestAuthSchemes(manifest),
              requiresToken: manifestRequiresToken(manifest),
              grantPath: manifest.auth?.grantPath,
            },
            source: 'manifest',
            identifiedAt: Date.now(),
          };
        }
      }
```

Add the needed imports to `gateway-provider.tsx` (combine with the existing `manifest.ts`/`identify.ts` imports rather than duplicating):

```ts
import { fetchGatewayManifest, manifestAuthSchemes, manifestKindLabel, manifestRequiresToken } from '@/lib/portal/manifest';
import type { GatewayIdentity } from '@/lib/portal/identify';
```

Change the `createClientForKind` call to pass it through:

```ts
      const client = createClientForKind(gateway.kind ?? 'hermes', gateway, {
        onStatus: (nextStatus, detail) => {
          // ...unchanged...
```

becomes (only the call's last argument changes):

```ts
      const client = createClientForKind(
        gateway.kind ?? 'hermes',
        gateway,
        {
          onStatus: (nextStatus, detail) => {
            // ...unchanged, everything inside stays exactly as it is today...
          },
          // ...rest of the callbacks object, unchanged...
        },
        identityForClient,
      );
```

(This is a mechanical wrap of the existing callbacks object — do not change anything inside `onStatus`/`onHello`/`onCapabilities`/`onPairingRequired`/`onHealthCheck`/`onError`, only add the trailing `identityForClient` argument to the call.)

Note this manifest fetch is separate from Task 5's post-connect manifest fetch (which drives child sync) — they happen for different reasons (this one builds the client before connecting; Task 5's runs after connecting to sync child profiles) and at different points in `attachClient`. Both are cheap, idempotent GETs against `/.well-known/gateway.json`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run the full app suite**

Run: `npm test`
Expected: all suites pass (existing suites unaffected; the new `manifest-client-test.ts`, `child-sync-test.ts`, and expanded `manifest-providers-test.ts` all green)

- [ ] **Step 5: Commit**

```bash
git add src/lib/portal/adapters.ts src/context/gateway-provider.tsx
git commit -m "feat(portal): dispatch custom-kind gateways to ManifestClient"
```

---

## Task 10: Live parity — generalize `smoke:live` to run against any gateway

**Files:**
- Modify: `scripts/smoke-live-gateway.mts`

**Files:** none new — this task generalizes the existing script rather than adding a second one, so "the same assertions against two backends" is literally the same file with a different argument, not two scripts that can drift apart.

- [ ] **Step 1: Read the current script in full**

The script currently constructs `HermesGatewayClient` directly and reads `API_SERVER_KEY` from `%LOCALAPPDATA%\hermes\.env`. Read `scripts/smoke-live-gateway.mts` completely before editing — it has several check blocks (valid-key connect path, rejected-key fail-fast, DNS-free route, etc.) and this task must generalize the client construction without changing what each check asserts.

- [ ] **Step 2: Generalize client construction**

Replace the direct `new HermesGatewayClient(...)` construction with `identifyGateway` + `createClientForKind`, so the script works against any conforming gateway:

```ts
import { identifyGateway } from '../src/lib/portal/identify';
import { createClientForKind } from '../src/lib/portal/adapters';
```

Where the script currently does:

```ts
const client = new HermesGatewayClient(profileWith(key), { ... });
```

replace with:

```ts
const identity = await identifyGateway({ baseUrl: BASE_URL });
const client = createClientForKind(identity.kind, profileWith(key), { ... }, identity);
```

Keep every existing `check(...)` assertion as-is — they assert on `client.connectionStatus`, `client.getModels()`, error messages, etc., all of which are `PortalClient` interface members both `HermesGatewayClient` and `ManifestClient` implement identically. The only change is which concrete class answers.

- [ ] **Step 3: Generalize the API-key lookup**

The script's `readApiKey()` reads Hermes's `.env` specifically. Add a second lookup for a Gate token, and pick whichever applies based on the identified kind:

```ts
function readGateToken(): string | undefined {
  // The Gate prints its token on `cli.mjs start`; for smoke testing, read it
  // from gate/.tokens.json directly rather than requiring the operator to
  // copy it out of console output each run.
  try {
    const raw = readFileSync(join(process.cwd(), 'gate', '.tokens.json'), 'utf8');
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed.token;
  } catch {
    return undefined;
  }
}
```

Where the script currently calls `const key = readApiKey();`, change to try both, since the script doesn't know the gateway kind until after identification:

```ts
async function main() {
  const identity = await identifyGateway({ baseUrl: BASE_URL });
  const key = identity.kind === 'hermes' ? readApiKey() : readGateToken();
  console.log(`Gateway: ${BASE_URL} (identified as ${identity.kindLabel})`);
  console.log(`Token: ${key ? `loaded (${key.length} chars)` : 'NOT FOUND — authenticated checks skipped'}\n`);
  // ...rest of main() unchanged, using `identity` and `key` as already established above...
```

- [ ] **Step 4: Verify against the real Hermes gateway (regression)**

Run: `npm run smoke:live`
Expected: `All live checks passed.` — identical result to before this task, proving the generalization didn't change Hermes behavior.

- [ ] **Step 5: Verify against a real running Gate**

This needs a Gate running locally with at least one provider configured (from Plan 2a's manual verification). If one isn't running right now, skip this step and note it as pending manual operator action in your final report.

If it is:

```bash
npm run smoke:live -- http://127.0.0.1:8760
```

Expected: the script identifies the target as `Custom — versutus-gate`, connects via `ManifestClient`, and the checks that apply to any `PortalClient` (connect, `getModels`, capability presence) pass. Checks specific to Hermes's exact error-message wording (e.g. "Enter API_SERVER_KEY from...") may reasonably differ in wording for the Gate — note any such divergence in your report; it's expected, not a failure, as long as the *behavior* (auth rejection surfaces as an error, doesn't loop) matches.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-live-gateway.mts
git commit -m "feat(smoke): generalize smoke:live to run against any conforming gateway"
```

---

## Task 11: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Run every suite**

Run: `npm test`
Expected: all app suites pass, including the three new/expanded ones from this plan (`manifest-providers-test.ts`, `child-sync-test.ts`, `manifest-client-test.ts`)

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output from either

- [ ] **Step 3: Confirm the Gate's own suite is untouched**

Run: `cd gate && npm test`
Expected: PASS, unchanged from Plan 2a's final count — this plan touches nothing under `gate/`

- [ ] **Step 4: Confirm both smoke suites pass**

Run: `npm run smoke:portal && npm run smoke:live`
Expected: both `ALL PASS` / `All live checks passed.`

- [ ] **Step 5: Live parity check — the acceptance gate for the whole two-plan effort**

If a Gate is running locally with a provider configured, run:

```bash
npm run smoke:live -- http://127.0.0.1:8642   # Hermes
npm run smoke:live -- http://127.0.0.1:8760   # the Gate
```

Both should report their respective PASS results. Two structurally identical assertion runs succeeding against two independently-built backends — one hardcoded Hermes, one manifest-driven — is the evidence that `ManifestClient`'s abstraction is real rather than asserted. If a Gate isn't running, note this as the one remaining manual step and report everything else's status.

- [ ] **Step 6: Confirm no secrets are tracked**

Run: `git status --porcelain`
Expected: clean tree (or only the expected commits from this plan, if running inline rather than via subagent-driven-development where each task already commits)

- [ ] **Step 7: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: ManifestClient and provider child sync complete" || echo "nothing to commit"
```

---

## Done when

- `createClientForKind('custom', ...)` returns `ManifestClient` whenever an identity with a manifest is available, and `ManifestClient implements PortalClient` compiles clean with no method gaps.
- A gate advertising `providers[]` causes one child `GatewayProfile` per provider to appear in the app's gateway list with no phone-side setup, and a provider removed from the gate's manifest causes its child profile to disappear on the next connect.
- `ManifestClient.streamChat` correctly parses the same normalized SSE delta shape the Gate emits (Plan 2a Task 9), using the exact same per-chunk parsing pattern `HermesGatewayClient.streamChat` already uses.
- A capability the manifest doesn't advertise (`getSessions`, `rpcRequest`, `stopRun`, etc. against a gate with no such endpoint) fails with an error naming exactly what's missing, never a guessed Hermes-shaped path.
- `npm run smoke:live` runs the identical assertion script against both a real Hermes gateway and a real running Gate, using `identifyGateway` + `createClientForKind` rather than a hardcoded client class.

**This closes the Versutus Gate work started in Plan 1.** Follow-on work — deep links/QR onboarding, feature surfaces for the capability groups still reporting `unsupported` against Hermes, push notifications while backgrounded — is out of scope for all three plans and was already called out as such in the original design spec §12.
