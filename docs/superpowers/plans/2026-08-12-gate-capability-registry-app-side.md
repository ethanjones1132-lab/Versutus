# Gate Capability Registry — App-Side Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Versutus app consume what the Gate now advertises — capability instances light up (or synthesize) capability groups in the Home/Tools snapshot, instance-contributed commands appear in the `/` palette and execute, and `ManifestClient.rpcRequest` becomes a real passthrough to the Gate's generic RPC endpoint instead of a hard throw.

**Architecture:** The manifest is already fetched on connect (`gateway-provider.tsx`) but currently discarded after child-profile sync. This plan keeps it in state and feeds it to two consumers: `buildCapabilitySnapshot` (which folds `capabilityInstances[]` into its group list — matching an existing `CAPABILITY_GROUP_DEFS` id marks that group ready, an unrecognized `family` synthesizes a new group) and the slash-command palette (which appends instance-contributed commands, with built-ins always winning a slash collision). `ManifestClient.rpcRequest` resolves `endpoints.capabilitiesRpc` from the manifest and unwraps the Gate's `{result}` / `{error}` envelope.

**Tech Stack:** TypeScript, React Native / Expo SDK 57, Jest (`jest-expo`), tests in `__tests__/*-test.ts` importing via the `@/` alias.

**Related:** `docs/superpowers/specs/2026-08-12-gate-capability-registry-design.md` §8. This is the last plan in the series — the three Gate-side plans (foundation, RPC+secrets, CLI generalization) are already merged to `master`.

---

## ⚠️ Before Starting: Uncommitted-Work Conflict

`git status` currently shows **uncommitted changes from the Hermes-audit work** in five files, two of which this plan modifies:

```
 M src/context/gateway-provider.tsx     ← this plan modifies (Task 5)
 M src/lib/gateway/slash-commands.ts    ← this plan modifies (Task 3)
 M src/lib/gateway/rpc-routes.ts
 M src/lib/portal/openclaw-adapter.ts
 M src/lib/portal/openclaw-mapping.ts
?? __tests__/openclaw-mapping-test.ts
?? __tests__/slash-commands-test.ts     ← this plan extends (Task 3)
```

**✅ RESOLVED — no action needed.** The Hermes-audit work was committed to `master` as
`37ff32b` (`fix(gateway): honor the capability snapshot in the slash-command executor`)
after verifying it clean: `tsc --noEmit` zero errors, 87/87 Jest tests passing. `git status`
is clean for both files, so a worktree branched from `HEAD` now includes that work and this
plan's Task 3 anchors match the committed `slash-commands.ts` (which has
`blockUnsupportedCommand` and the `methods` snapshot pass-through).

Kept here as the record of why the plan is ordered the way it is. If you find those files
dirty again before starting, the original guidance applies: commit or stash first, because
a worktree branches from `HEAD` and merging back would hit "local changes would be
overwritten."

---

**Non-goals (deferred):**
- **No capability editor screen.** Rendering a form from `configFields` and wiring it to `registry.instances.create/update/delete` + `registry.secrets.set` is its own plan (design spec §13 lists it as follow-on). This plan delivers the *read* path — the app sees and can invoke what the Gate advertises. Creating/editing instances from the phone stays CLI-only for now.
- **No `GatewayFeatureFamily` union widening.** The spec's §8 point 3 suggested widening `GatewayCommand['group']` to accept any string. That turns out to be unnecessary: instance-contributed commands never become `GatewayCommand` objects — they stay their own type and map straight into `SlashCommandSuggestion`, whose `family` is already `string`, and synthesized groups use `GatewayCapabilityGroup.id`, which is already `string`. Leaving the closed union alone keeps autocomplete honest for the static registry. This is a deliberate simplification of the spec, not an omission.
- **No `getSessions`/`getSessionMessages`/`stopRun` change in `ManifestClient`.** Only `rpcRequest` becomes real. The other three keep their named "not advertised" throws until a Gate kind actually implements sessions or runs.
- **No new Gate-side capability kinds.** The `note` kind used during verification is scratch, deleted afterward.

---

## File Structure

Create:
- `__tests__/manifest-capabilities-test.ts` — accessor parsing/filtering
- `__tests__/dynamic-commands-test.ts` — palette merge + collision precedence

Modify:
- `src/lib/portal/manifest.ts` — `capabilityKinds`/`capabilityInstances` types + accessors
- `src/lib/gateway/dashboard.ts` — `buildCapabilitySnapshot` folds in capability instances
- `src/lib/gateway/slash-commands.ts` — dynamic commands in palette and execution
- `src/lib/gateway/manifest-client.ts` — real `rpcRequest` passthrough
- `src/context/gateway-provider.tsx` — keep the manifest, feed both consumers
- `__tests__/capability-snapshot-test.ts` — fixtures for instance-driven groups
- `gate/core/capabilities/registry.mjs` — emit + instance-qualify each kind's `commands[]` (Task 5)
- `gate/__tests__/capabilities-registry.test.mjs` — matching tests
- `gate/core/capabilities/provider/kind.mjs` — `family: 'provider'` → `'models'` (Task 6)
- `gate/__tests__/provider-kind.test.mjs` — matching assertion

---

### Task 1: Manifest types and accessors

**Files:**
- Modify: `src/lib/portal/manifest.ts`
- Test: `__tests__/manifest-capabilities-test.ts`

Mirrors the existing `manifestProviders` discipline exactly: a malformed entry is dropped, never thrown, so one bad entry can't break identification for everything else.

- [ ] **Step 1: Write the failing test**

```ts
import {
  manifestCapabilityKinds,
  manifestCapabilityInstances,
  manifestDynamicCommands,
  type GatewayManifest,
} from '@/lib/portal/manifest';

function manifestWith(extra: Partial<GatewayManifest>): GatewayManifest {
  return { manifest: 'versutus-gateway/v1', kind: 'versutus-gate', ...extra } as GatewayManifest;
}

const CRON_KIND = {
  id: 'cron',
  label: 'Scheduled jobs',
  family: 'cron',
  configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
};

const STANDUP_INSTANCE = {
  id: 'standup',
  kind: 'cron',
  label: 'Standup reminder',
  family: 'cron',
  manifestEntry: { id: 'standup', schedule: '0 9 * * 1-5' },
  commands: [
    { slash: '/standup', description: 'Run the standup job now', method: 'standup.run', danger: 'write' },
  ],
};

describe('manifestCapabilityKinds', () => {
  test('returns well-formed kinds', () => {
    const kinds = manifestCapabilityKinds(manifestWith({ capabilityKinds: [CRON_KIND] } as any));
    expect(kinds).toHaveLength(1);
    expect(kinds[0].id).toBe('cron');
  });

  test('returns empty when the field is absent — a non-Gate manifest stays valid', () => {
    expect(manifestCapabilityKinds(manifestWith({}))).toEqual([]);
  });

  test('drops a malformed kind without dropping its well-formed siblings', () => {
    const kinds = manifestCapabilityKinds(
      manifestWith({ capabilityKinds: [{ id: '' }, CRON_KIND, { label: 'no id' }] } as any),
    );
    expect(kinds.map((kind) => kind.id)).toEqual(['cron']);
  });

  test('drops a kind whose configFields is not an array', () => {
    const kinds = manifestCapabilityKinds(
      manifestWith({ capabilityKinds: [{ ...CRON_KIND, configFields: 'nope' }] } as any),
    );
    expect(kinds).toEqual([]);
  });
});

describe('manifestCapabilityInstances', () => {
  test('returns well-formed instances', () => {
    const instances = manifestCapabilityInstances(
      manifestWith({ capabilityInstances: [STANDUP_INSTANCE] } as any),
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ id: 'standup', kind: 'cron', family: 'cron' });
  });

  test('returns empty when the field is absent', () => {
    expect(manifestCapabilityInstances(manifestWith({}))).toEqual([]);
  });

  test('drops an instance missing id, kind, or family', () => {
    const instances = manifestCapabilityInstances(
      manifestWith({
        capabilityInstances: [
          STANDUP_INSTANCE,
          { id: 'x', kind: 'cron', label: 'no family' },
          { kind: 'cron', label: 'no id', family: 'cron' },
        ],
      } as any),
    );
    expect(instances.map((instance) => instance.id)).toEqual(['standup']);
  });
});

describe('manifestDynamicCommands', () => {
  test('flattens commands across instances', () => {
    const commands = manifestDynamicCommands(
      manifestWith({
        capabilityInstances: [
          STANDUP_INSTANCE,
          {
            id: 'weekly',
            kind: 'cron',
            label: 'Weekly',
            family: 'cron',
            commands: [
              { slash: '/weekly', description: 'Run weekly', method: 'weekly.run', danger: 'safe' },
            ],
          },
        ],
      } as any),
    );
    expect(commands.map((command) => command.slash)).toEqual(['/standup', '/weekly']);
  });

  test('returns empty for instances that contribute no commands', () => {
    const commands = manifestDynamicCommands(
      manifestWith({
        capabilityInstances: [{ id: 'nvidia', kind: 'provider', label: 'NVIDIA', family: 'models' }],
      } as any),
    );
    expect(commands).toEqual([]);
  });

  test('drops a malformed command — a bad slash, method, or danger never reaches the palette', () => {
    const commands = manifestDynamicCommands(
      manifestWith({
        capabilityInstances: [
          {
            id: 'standup',
            kind: 'cron',
            label: 'Standup',
            family: 'cron',
            commands: [
              { slash: 'no-leading-slash', description: 'x', method: 'a.b', danger: 'safe' },
              { slash: '/nomethod', description: 'x', danger: 'safe' },
              { slash: '/baddanger', description: 'x', method: 'a.b', danger: 'catastrophic' },
              { slash: '/good', description: 'x', method: 'a.b', danger: 'safe' },
            ],
          },
        ],
      } as any),
    );
    expect(commands.map((command) => command.slash)).toEqual(['/good']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/manifest-capabilities-test.ts`
Expected: FAIL — `manifestCapabilityKinds is not a function` (the module has no such export yet).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/portal/manifest.ts`, add these types after the existing `GatewayManifestProvider` block:

```ts
export type GatewayCapabilityField = {
  key: string;
  label: string;
  type: 'string' | 'string-list' | 'number' | 'boolean' | 'enum' | 'secret-ref';
  required?: boolean;
  options?: string[];
  default?: unknown;
  help?: string;
};

export type GatewayCapabilityKind = {
  id: string;
  label: string;
  family: string;
  configFields: GatewayCapabilityField[];
};

export type GatewayCapabilityCommand = {
  slash: string;
  description: string;
  method: string;
  danger: 'safe' | 'write' | 'destructive';
  params?: Record<string, unknown>;
};

export type GatewayCapabilityInstance = {
  id: string;
  kind: string;
  label: string;
  family: string;
  manifestEntry?: Record<string, unknown>;
  commands?: GatewayCapabilityCommand[];
};

function isGatewayCapabilityKind(value: unknown): value is GatewayCapabilityKind {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.label === 'string' &&
    typeof raw.family === 'string' &&
    raw.family.length > 0 &&
    Array.isArray(raw.configFields)
  );
}

function isGatewayCapabilityInstance(value: unknown): value is GatewayCapabilityInstance {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.kind === 'string' &&
    raw.kind.length > 0 &&
    typeof raw.label === 'string' &&
    typeof raw.family === 'string' &&
    raw.family.length > 0
  );
}

function isGatewayCapabilityCommand(value: unknown): value is GatewayCapabilityCommand {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.slash === 'string' &&
    raw.slash.startsWith('/') &&
    typeof raw.method === 'string' &&
    raw.method.length > 0 &&
    typeof raw.description === 'string' &&
    (raw.danger === 'safe' || raw.danger === 'write' || raw.danger === 'destructive')
  );
}
```

Add the two optional fields to the `GatewayManifest` type (alongside the existing `providers?:` line):

```ts
  capabilityKinds?: GatewayCapabilityKind[];
  capabilityInstances?: GatewayCapabilityInstance[];
```

Add the accessors next to `manifestProviders`:

```ts
/**
 * Every well-formed capability kind a gate advertises. A malformed entry is
 * dropped, not thrown — same discipline as manifestProviders().
 */
export function manifestCapabilityKinds(manifest: GatewayManifest): GatewayCapabilityKind[] {
  if (!Array.isArray(manifest.capabilityKinds)) return [];
  return manifest.capabilityKinds.filter(isGatewayCapabilityKind);
}

/** Every well-formed configured capability instance a gate advertises. */
export function manifestCapabilityInstances(manifest: GatewayManifest): GatewayCapabilityInstance[] {
  if (!Array.isArray(manifest.capabilityInstances)) return [];
  return manifest.capabilityInstances.filter(isGatewayCapabilityInstance);
}

/**
 * Every well-formed command a gate's instances contribute, flattened across
 * instances. A malformed command is dropped so it can never reach the palette
 * as an entry that could only fail.
 */
export function manifestDynamicCommands(manifest: GatewayManifest): GatewayCapabilityCommand[] {
  return manifestCapabilityInstances(manifest).flatMap((instance) =>
    Array.isArray(instance.commands) ? instance.commands.filter(isGatewayCapabilityCommand) : [],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/manifest-capabilities-test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/portal/manifest.ts __tests__/manifest-capabilities-test.ts
git commit -m "feat(app): parse capabilityKinds/capabilityInstances from the gateway manifest"
```

---

### Task 2: Capability snapshot folds in capability instances

**Files:**
- Modify: `src/lib/gateway/dashboard.ts`
- Modify: `__tests__/capability-snapshot-test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/capability-snapshot-test.ts` (it already imports `buildCapabilitySnapshot` at the top):

```ts
describe('capability instances drive the snapshot', () => {
  const cronInstance = { id: 'standup', kind: 'cron', label: 'Standup', family: 'cron' };
  const providerInstance = { id: 'nvidia', kind: 'provider', label: 'NVIDIA', family: 'models' };

  function snapshotWith(instances: any[]) {
    return buildCapabilitySnapshot('connected', null, undefined, Date.now(), HERMES_CAPABILITIES, instances);
  }

  test('an instance whose family matches a built-in group marks it ready', () => {
    // Hermes advertises jobs_admin: false, so cron is unsupported without instances.
    const without = buildCapabilitySnapshot('connected', null, undefined, Date.now(), HERMES_CAPABILITIES);
    expect(without.groups.find((group) => group.id === 'cron')!.status).toBe('unsupported');

    const withInstance = snapshotWith([cronInstance]);
    expect(withInstance.groups.find((group) => group.id === 'cron')!.status).toBe('ready');
  });

  test('a family matching nothing built-in synthesizes its own group', () => {
    const snapshot = snapshotWith([{ id: 'x', kind: 'weather', label: 'Weather', family: 'weather' }]);
    const group = snapshot.groups.find((entry) => entry.id === 'weather');
    expect(group).toBeDefined();
    expect(group!.status).toBe('ready');
    expect(group!.label).toBe('Weather');
    expect(group!.totalCount).toBe(1);
  });

  test('several instances of one synthesized family are counted together', () => {
    const snapshot = snapshotWith([
      { id: 'a', kind: 'weather', label: 'A', family: 'weather' },
      { id: 'b', kind: 'weather', label: 'B', family: 'weather' },
    ]);
    expect(snapshot.groups.find((entry) => entry.id === 'weather')!.totalCount).toBe(2);
  });

  test('no instances leaves the built-in group list unchanged', () => {
    const withNone = buildCapabilitySnapshot('connected', null, undefined, Date.now(), HERMES_CAPABILITIES);
    const withEmpty = snapshotWith([]);
    expect(withEmpty.groups.map((group) => group.id)).toEqual(withNone.groups.map((group) => group.id));
  });

  test('an instance whose family is already ready does not duplicate the group', () => {
    const snapshot = snapshotWith([providerInstance]);
    const models = snapshot.groups.filter((group) => group.id === 'models');
    expect(models).toHaveLength(1);
    expect(models[0].status).toBe('ready');
  });

  test('instance-driven readiness unlocks that group\'s commands too', () => {
    // Hermes has jobs_admin: false, so Memory-group commands are gated off.
    // A memory-family instance should flip them available.
    const withInstance = snapshotWith([{ id: 'm', kind: 'memory', label: 'M', family: 'memory' }]);
    expect(withInstance.groups.find((group) => group.id === 'memory')!.status).toBe('ready');
  });

  test('a disconnected gateway reports synthesized groups as unavailable, not ready', () => {
    const snapshot = buildCapabilitySnapshot('disconnected', null, undefined, Date.now(), null, [
      { id: 'x', kind: 'weather', label: 'Weather', family: 'weather' },
    ] as any);
    expect(snapshot.groups.find((entry) => entry.id === 'weather')!.status).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/capability-snapshot-test.ts`
Expected: FAIL — the `cron` group stays `unsupported` and no `weather` group exists (the 6th argument is currently ignored).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/gateway/dashboard.ts`, add the import at the top:

```ts
import type { GatewayCapabilityInstance } from '@/lib/portal/manifest';
```

Change `buildCapabilitySnapshot`'s signature to take a sixth parameter:

```ts
export function buildCapabilitySnapshot(
  status: ConnectionStatus,
  hello: GatewayHelloOk | null,
  commands: GatewayCommand[] = GATEWAY_COMMANDS,
  lastProbeAt: number = Date.now(),
  capabilities: import('@/lib/gateway/types').GatewayCapabilities | null = null,
  capabilityInstances: GatewayCapabilityInstance[] = [],
): import('@/lib/gateway/types').GatewayCapabilitySnapshot {
```

Immediately after the existing `const isStale = ...` line, add:

```ts
  // A configured capability instance is direct evidence the gateway offers
  // that family — stronger than inferring it from a feature flag or endpoint
  // key, and the only signal available for a family the app has never heard
  // of (design spec §8).
  const instanceFamilies = new Set(capabilityInstances.map((instance) => instance.family));
  const isGroupReady = (definition: CapabilityGroupDef) =>
    Boolean(capabilities && groupIsAdvertised(definition, capabilities)) ||
    instanceFamilies.has(definition.id);
```

Inside the `groups` map, replace:
```ts
      const ready = groupIsAdvertised(definition, capabilities);
```
with:
```ts
      const ready = isGroupReady(definition);
```

Replace the `advertised` set computation:
```ts
  const advertised = new Set(
    CAPABILITY_GROUP_DEFS.filter(
      (definition) => capabilities && groupIsAdvertised(definition, capabilities),
    ).flatMap((definition) => definition.commandGroups ?? []),
  );
```
with:
```ts
  const advertised = new Set(
    CAPABILITY_GROUP_DEFS.filter(isGroupReady).flatMap(
      (definition) => definition.commandGroups ?? [],
    ),
  );
```

After the `groups` map and before the `overallStatus` block, add the synthesis step:

```ts
  // A family no built-in group covers gets its own group, so a capability
  // kind invented after this app shipped is still visible rather than
  // silently absent.
  const knownGroupIds = new Set(CAPABILITY_GROUP_DEFS.map((definition) => definition.id));
  const synthesizedGroups = [...instanceFamilies]
    .filter((family) => !knownGroupIds.has(family))
    .sort()
    .map<import('@/lib/gateway/types').GatewayCapabilityGroup>((family) => {
      const count = capabilityInstances.filter((instance) => instance.family === family).length;
      return {
        id: family,
        label: family.charAt(0).toUpperCase() + family.slice(1),
        status: connected ? 'ready' : 'unavailable',
        availableCount: connected ? count : 0,
        totalCount: count,
        note: connected ? undefined : 'Gateway offline',
      };
    });
```

Finally, change the returned `groups` to include them:

```ts
    groups: [...groups, ...synthesizedGroups],
```

Note on the synthesized label: it's the capitalized family rather than the kind's `label`, because several kinds can share one family and the group is the family, not the kind. `weather` → `Weather`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/capability-snapshot-test.ts`
Expected: PASS — the whole file, including every pre-existing Hermes-contract test (the 6th parameter defaults to `[]`, so nothing that omits it changes behavior).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/dashboard.ts __tests__/capability-snapshot-test.ts
git commit -m "feat(app): capability instances mark groups ready and synthesize unknown families"
```

---

### Task 3: Instance-contributed slash commands

**Files:**
- Modify: `src/lib/gateway/slash-commands.ts`
- Test: `__tests__/dynamic-commands-test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { getSlashCommandSuggestions, executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';

const STANDUP: GatewayCapabilityCommand = {
  slash: '/standup',
  description: 'Run the standup job now',
  method: 'standup.run',
  danger: 'write',
};

describe('dynamic commands in the palette', () => {
  test('an instance-contributed command is suggested', () => {
    const suggestions = getSlashCommandSuggestions('/stand', null, [], {}, [STANDUP]);
    const match = suggestions.find((item) => item.value === '/standup');
    expect(match).toBeDefined();
    expect(match!.description).toBe('Run the standup job now');
    expect(match!.unavailable).toBe(false);
  });

  test('dynamic commands are absent when the gateway contributes none', () => {
    const suggestions = getSlashCommandSuggestions('/stand', null, [], {}, []);
    expect(suggestions.find((item) => item.value === '/standup')).toBeUndefined();
  });

  test('a dynamic command cannot shadow a built-in slash', () => {
    const impostor: GatewayCapabilityCommand = {
      slash: '/help',
      description: 'Malicious override',
      method: 'evil.run',
      danger: 'safe',
    };
    const suggestions = getSlashCommandSuggestions('/help', null, [], {}, [impostor]);
    const help = suggestions.filter((item) => item.value === '/help');
    expect(help).toHaveLength(1);
    expect(help[0].description).not.toBe('Malicious override');
  });
});

describe('dynamic command execution', () => {
  function context(overrides: Record<string, unknown> = {}) {
    return {
      hello: null,
      gatewayRequest: jest.fn().mockResolvedValue({ ranInstance: 'standup' }),
      runAgentCommand: jest.fn(),
      dynamicCommands: [STANDUP],
      ...overrides,
    } as any;
  }

  test('dispatches through gatewayRequest with the declared method', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/standup', ctx);
    expect(ctx.gatewayRequest).toHaveBeenCalledWith('standup.run', {});
    expect(result.title).toBe('/standup');
  });

  test('passes declared params, and free text as `input`', async () => {
    const ctx = context({
      dynamicCommands: [{ ...STANDUP, params: { dryRun: true } }],
    });
    await executeGatewaySlashCommand('/standup now please', ctx);
    expect(ctx.gatewayRequest).toHaveBeenCalledWith('standup.run', { dryRun: true, input: 'now please' });
  });

  test('a built-in still wins when a dynamic command claims its slash', async () => {
    const ctx = context({
      dynamicCommands: [{ slash: '/help', description: 'x', method: 'evil.run', danger: 'safe' }],
    });
    const result = await executeGatewaySlashCommand('/help', ctx);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
    expect(result.title).toBe('/help');
  });

  test('an unknown command is still unknown when dynamic commands exist', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/definitely-not-real', ctx);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toMatch(/Unknown command/);
  });

  test('a failing dynamic command surfaces the gateway error, not a crash', async () => {
    const ctx = context({
      gatewayRequest: jest.fn().mockRejectedValue(new Error('instance is unhealthy')),
    });
    await expect(executeGatewaySlashCommand('/standup', ctx)).rejects.toThrow('instance is unhealthy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/dynamic-commands-test.ts`
Expected: FAIL — `/standup` is not suggested (the 5th argument is ignored) and executing it returns "Unknown command".

- [ ] **Step 3: Write minimal implementation**

In `src/lib/gateway/slash-commands.ts`, add the import:

```ts
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';
```

Add to the `SlashCommandContext` type, after the existing `methods?:` field:

```ts
  /**
   * Commands contributed by the connected gateway's capability instances
   * (design spec §8). Tried only after every built-in has had its chance,
   * so a gateway can never shadow a first-party command.
   */
  dynamicCommands?: GatewayCapabilityCommand[];
```

Add a fifth parameter to `getSlashCommandSuggestions`:

```ts
  methods: Record<string, GatewayMethodAvailability> = {},
  dynamicCommands: GatewayCapabilityCommand[] = [],
): SlashCommandSuggestion[] {
```

Inside that function, after `registrySuggestions` is built, add:

```ts
  // Instance-contributed commands. A slash already claimed by a built-in is
  // dropped rather than shadowing it — the same precedence the executor uses.
  const builtInSlashes = new Set<string>([
    ...GATEWAY_COMMANDS.map((command) => command.slash).filter(
      (slash): slash is string => Boolean(slash),
    ),
    ...LOCAL_SUGGESTIONS.map((suggestion) => suggestion.value),
  ]);
  const dynamicSuggestions: SlashCommandSuggestion[] = dynamicCommands
    .filter((command) => !builtInSlashes.has(command.slash))
    .map((command) => ({
      value: command.slash,
      label: command.slash,
      description: command.description,
      danger: command.danger,
      family: 'Capability',
      unavailable: false,
    }));
```

Change the merge line from:
```ts
  let suggestions = [...recentSuggestions, ...localWithMeta, ...registrySuggestions];
```
to:
```ts
  let suggestions = [...recentSuggestions, ...localWithMeta, ...registrySuggestions, ...dynamicSuggestions];
```

In `executeGatewaySlashCommand`, replace the fallback block:

```ts
  const command = findCommandBySlash(commandName);
  if (!command) {
    return textResult(`Unknown command: ${commandName}\n\n${formatHelp(context.hello)}`, commandName);
  }
```
with:
```ts
  const command = findCommandBySlash(commandName);
  if (!command) {
    // Reached only after every built-in dispatch above has declined, so a
    // gateway-advertised slash can never take precedence over a first-party one.
    const dynamic = context.dynamicCommands?.find((entry) => entry.slash === commandName);
    if (dynamic) return runDynamicCommand(dynamic, argText, context);
    return textResult(`Unknown command: ${commandName}\n\n${formatHelp(context.hello)}`, commandName);
  }
```

Add the executor next to the other `run*` helpers:

```ts
async function runDynamicCommand(
  command: GatewayCapabilityCommand,
  argText: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const params: Record<string, unknown> = { ...(command.params ?? {}) };
  const trimmed = argText.trim();
  if (trimmed) params.input = trimmed;

  const result = await context.gatewayRequest(command.method, params);
  return textResult(
    summarizeCommandResult(result),
    command.slash,
    typeof result === 'string' ? result : JSON.stringify(result, null, 2),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/dynamic-commands-test.ts __tests__/slash-commands-test.ts`
Expected: PASS — both files, including every pre-existing slash-command test (both new parameters default to empty, so callers that omit them are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/slash-commands.ts __tests__/dynamic-commands-test.ts
git commit -m "feat(app): merge and execute instance-contributed slash commands"
```

---

### Task 4: Real `rpcRequest` in `ManifestClient`

**Files:**
- Modify: `src/lib/gateway/manifest-client.ts`
- Modify: `__tests__/manifest-client-test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/manifest-client-test.ts`, matching whatever construction helper that file already uses for a `ManifestClient` (read it first — it already builds clients from a `GatewayProfile` + `GatewayIdentity` pair):

```ts
describe('rpcRequest against a gate advertising capabilitiesRpc', () => {
  test('posts {method, params} and unwraps the result envelope', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ result: { ranInstance: 'standup' } }),
      json: async () => ({ result: { ranInstance: 'standup' } }),
    });
    global.fetch = fetchMock as any;

    const client = clientWithEndpoints({ health: '/health', capabilitiesRpc: '/v1/capabilities/rpc' });
    const result = await client.rpcRequest('standup.run', { dryRun: true });

    expect(result).toEqual({ ranInstance: 'standup' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/capabilities/rpc');
    expect(JSON.parse(init.body)).toEqual({ method: 'standup.run', params: { dryRun: true } });
  });

  test('throws the gateway error message when the envelope carries one', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { message: 'instance "nope" not found', code: 'rpc_error' } }),
      json: async () => ({ error: { message: 'instance "nope" not found', code: 'rpc_error' } }),
    }) as any;

    const client = clientWithEndpoints({ health: '/health', capabilitiesRpc: '/v1/capabilities/rpc' });
    await expect(client.rpcRequest('registry.instances.get', { id: 'nope' })).rejects.toThrow(/not found/);
  });

  test('still throws a named error when the manifest advertises no rpc endpoint', async () => {
    const client = clientWithEndpoints({ health: '/health' });
    await expect(client.rpcRequest('anything')).rejects.toThrow(/not supported/);
  });
});
```

Define `clientWithEndpoints` in that file if it doesn't already exist, reusing the file's existing construction pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: FAIL — `rpcRequest` currently throws "is not supported by …" unconditionally, so the first two tests fail (the third already passes).

- [ ] **Step 3: Write minimal implementation**

Replace `ManifestClient.rpcRequest` in `src/lib/gateway/manifest-client.ts`:

```ts
  /**
   * Generic capability RPC. A gate that advertises `capabilitiesRpc` can
   * answer both its built-in `registry.*` methods and anything its capability
   * instances contribute (design spec §6/§8). A gate that doesn't advertise it
   * keeps the old named error rather than guessing at a path.
   */
  async rpcRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const path = this.endpoints.capabilitiesRpc;
    if (!path) {
      throw new Error(
        `${method} is not supported by ${this.identity.kindLabel} — it only advertises: ${Object.keys(this.endpoints).join(', ') || 'nothing'}.`,
      );
    }

    const body = await this.transport.request<{
      result?: T;
      error?: { message?: string; code?: string };
    }>('POST', path, { method, params });

    if (body?.error) {
      throw new Error(body.error.message ?? `${method} failed on ${this.identity.kindLabel}.`);
    }
    return body?.result as T;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/manifest-client-test.ts`
Expected: PASS — the whole file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/manifest-client.ts __tests__/manifest-client-test.ts
git commit -m "feat(app): ManifestClient.rpcRequest dispatches through capabilitiesRpc"
```

---

### ~~Task 5: Gate emits instance `commands[]` into the manifest~~ — ✅ ALREADY DONE

> **Skip this task.** It shipped ahead of the rest of the plan, on `master` in commits
> `38ccd9d` (emit + instance-qualify) and `5fd399d` (validation, deep-copy, docs).
> Kept below for the reasoning; verify with
> `grep -n "qualifyCommands" gate/core/capabilities/registry.mjs` before assuming otherwise.
>
> What shipped is broader than what's written below, because a code-review pass found two
> further ways to advertise an undispatchable command:
> - A command missing `method` produced `"<id>.undefined"`; one whose `method` already
>   contained a dot produced `"<id>.<id>.<name>"`. Both now skip with a logged reason,
>   via a `qualifyCommands(instance, kindModule)` helper.
> - `{...command}` is a shallow spread, so a command's nested `params` stayed aliased
>   across every instance of the kind and back into the kind module. Deep-copied now.
> - `gate/CAPABILITY_PROMPT.md` never documented `commands` at all — it said the contract
>   had "exactly these fields" and "do not add new top-level exports", so a kind author
>   following it would never have known the field was legal. Now documented, including
>   the local-vs-qualified `method` rule.
>
> Gate suite is 161/161 under both invocation styles. **Task 3's app-side work is now
> genuinely reachable end to end** — verified against a running Gate: the manifest
> advertises `my-note.read`, calling it returns 200, and calling the bare `read` returns
> 404, confirming the qualification is load-bearing rather than cosmetic.

### Task 5 (shipped — reference only): Gate emits instance `commands[]` into the manifest

**Files:**
- Modify: `gate/core/capabilities/registry.mjs`
- Modify: `gate/__tests__/capabilities-registry.test.mjs`

A prerequisite gap found while writing this plan, confirmed by inspection: the design spec (§5) puts an optional `commands?: CapabilityCommandDef[]` on the kind contract, and Task 3 builds the entire app-side consumption of it — but `resolveManifestInstances` never emits it. `grep -n "commands" gate/core/capabilities/registry.mjs` returns nothing. A kind that declares `commands` today has them silently dropped before they ever reach the wire, so Task 3's feature is unreachable end to end until this lands.

**The method name must be qualified here, not passed through.** A kind is authored once, before any instance of it exists, so its `commands[].method` can only name a *local* handler (`run`, `read`) — the same local name `createHandlers` returns as an object key. But `buildInstanceHandlers` (`gate/core/capabilities/dispatch.mjs`) registers those handlers as `<instance-id>.<localName>`, and the app calls `command.method` verbatim against `/v1/capabilities/rpc`. So this task must rewrite each command's `method` to the instance-qualified form as it emits it. Passing the local name through unchanged would produce a palette entry that 404s on every invocation.

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/capabilities-registry.test.mjs` (it already has the `fakeKinds()` helper and imports `resolveManifestInstances`):

```js
test('resolveManifestInstances qualifies a kind\'s declared command methods with the instance id', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/standup', description: 'Run it', method: 'run', danger: 'write' },
  ];
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];

  const [resolved] = resolveManifestInstances(kinds, instances);

  // 'run' is the local handler name the kind declares; the dispatch table
  // registers it as 'standup.run', so that is what the app must be told.
  assert.deepEqual(resolved.commands, [
    { slash: '/standup', description: 'Run it', method: 'standup.run', danger: 'write' },
  ]);
});

test('two instances of one kind get distinctly qualified command methods', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/run', description: 'Run it', method: 'run', danger: 'write' },
  ];
  const instances = [
    { id: 'standup', kind: 'cron', label: 'Standup', config: {} },
    { id: 'weekly', kind: 'cron', label: 'Weekly', config: {} },
  ];

  const resolved = resolveManifestInstances(kinds, instances);

  assert.equal(resolved[0].commands[0].method, 'standup.run');
  assert.equal(resolved[1].commands[0].method, 'weekly.run');
});

test('resolveManifestInstances preserves a command\'s other declared fields', () => {
  const kinds = fakeKinds();
  kinds.get('cron').commands = [
    { slash: '/standup', description: 'Run it', method: 'run', danger: 'write', params: { dryRun: true } },
  ];
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];

  const [resolved] = resolveManifestInstances(kinds, instances);

  assert.deepEqual(resolved.commands[0].params, { dryRun: true });
  assert.equal(resolved.commands[0].danger, 'write');
});

test('resolveManifestInstances omits commands for a kind that declares none', () => {
  const kinds = fakeKinds();
  const instances = [{ id: 'standup', kind: 'cron', label: 'Standup', config: {} }];

  const [resolved] = resolveManifestInstances(kinds, instances);

  assert.equal(resolved.commands, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs`
Expected: FAIL — `resolved.commands` is `undefined` in the first three tests.

- [ ] **Step 3: Write minimal implementation**

In `gate/core/capabilities/registry.mjs`, inside `resolveManifestInstances`'s returned object, add `commands` after `manifestEntry`:

```js
    // A kind declares commands with LOCAL method names, since it is authored
    // before any instance of it exists. buildInstanceHandlers registers those
    // handlers as `<instance-id>.<localName>`, so qualify them here — the app
    // calls whatever `method` we advertise, verbatim.
    const commands = Array.isArray(kindModule.commands)
      ? kindModule.commands.map((command) => ({
          ...command,
          method: `${instance.id}.${command.method}`,
        }))
      : undefined;

    return {
      id: instance.id,
      kind: instance.kind,
      label: instance.label,
      family: kindModule.family,
      manifestEntry,
      ...(commands ? { commands } : {}),
    };
```

The conditional spread keeps `commands` absent (rather than `undefined`) for kinds that declare none, so the manifest JSON stays clean and the existing `capabilityInstances` fixtures in `gate/__tests__/manifest.test.mjs` still `deepEqual` exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test gate/__tests__/capabilities-registry.test.mjs` — expect PASS.
Run: `node --test "gate/__tests__/*.test.mjs"` AND `cd gate && node --test` — expect PASS on both, no regressions.

- [ ] **Step 5: Commit**

```bash
git add gate/core/capabilities/registry.mjs gate/__tests__/capabilities-registry.test.mjs
git commit -m "feat(gate): emit a kind's declared commands into capabilityInstances"
```

---

### Task 6: Plumb the manifest through the provider, and point `provider` at the Models family

**Files:**
- Modify: `src/context/gateway-provider.tsx`
- Modify: `gate/core/capabilities/provider/kind.mjs`
- Modify: `gate/__tests__/provider-kind.test.mjs`

Two changes that only make sense together. `gateway-provider.tsx` already fetches the manifest on connect but discards it after child-profile sync — Tasks 2 and 3 are dead code until it's kept. And the `provider` kind currently declares `family: 'provider'`, which under Task 2 would synthesize a redundant "Provider" group right next to the "Models" group a Gate already lights up via `endpoints.models`. Declaring `family: 'models'` is exactly the "several kinds can share one family" case `CAPABILITY_PROMPT.md` documents.

- [ ] **Step 1: Write the failing Gate-side test**

In `gate/__tests__/provider-kind.test.mjs`, change the contract test's family assertion. Find:

```js
test('exposes the required kind contract fields', () => {
  assert.equal(providerKind.kind, 'provider');
```
and add immediately after the existing `family` type assertion in that test:

```js
test('declares the models family so provider instances reinforce the built-in Models group', () => {
  assert.equal(providerKind.family, 'models');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test gate/__tests__/provider-kind.test.mjs`
Expected: FAIL — `family` is `'provider'`, not `'models'`.

- [ ] **Step 3: Write the Gate-side change**

In `gate/core/capabilities/provider/kind.mjs`, change:
```js
  family: 'provider',
```
to:
```js
  family: 'models',
```

Run: `node --test "gate/__tests__/*.test.mjs"` — expect PASS, full suite.

- [ ] **Step 4: Plumb the manifest through `gateway-provider.tsx`**

Add to the existing `@/lib/portal/manifest` import (which already brings in `fetchGatewayManifest` and `manifestProviders`):

```ts
  manifestCapabilityInstances,
  manifestDynamicCommands,
  type GatewayManifest,
```

Add state next to the existing `liveCapabilities` state declaration:

```ts
  const [activeManifest, setActiveManifest] = useState<GatewayManifest | null>(null);
```

In `attachClient`'s manifest fetch, keep the manifest instead of only syncing children. Change:

```ts
      void fetchGatewayManifest(gateway.url)
        .then((manifest) => {
          if (!manifest || !isCurrent()) return;
          return syncChildProfiles(gateway, manifestProviders(manifest));
        })
```
to:
```ts
      void fetchGatewayManifest(gateway.url)
        .then((manifest) => {
          if (!manifest || !isCurrent()) return;
          // Kept, not discarded: capabilityInstances[] drives the capability
          // snapshot and the slash palette (design spec §8).
          setActiveManifest(manifest);
          return syncChildProfiles(gateway, manifestProviders(manifest));
        })
```

Derive the two consumers next to the `capabilitySnapshot` memo:

```ts
  const capabilityInstances = useMemo(
    () => (activeManifest ? manifestCapabilityInstances(activeManifest) : []),
    [activeManifest],
  );
  const dynamicCommands = useMemo(
    () => (activeManifest ? manifestDynamicCommands(activeManifest) : []),
    [activeManifest],
  );
```

Pass instances into the snapshot — change the `capabilitySnapshot` memo to:

```ts
  const capabilitySnapshot = useMemo<GatewayCapabilitySnapshot>(
    () =>
      buildCapabilitySnapshot(
        status,
        activeHello,
        GATEWAY_COMMANDS,
        capabilityCheckedAt,
        liveCapabilities,
        capabilityInstances,
      ),
    [status, activeHello, liveCapabilities, capabilityCheckedAt, capabilityInstances],
  );
```

At the `executeGatewaySlashCommand` call site (the object literal that currently passes `methods: capabilitySnapshot.methods`), add:

```ts
          dynamicCommands,
```
and add `dynamicCommands` to that callback's dependency array alongside the existing `capabilitySnapshot.methods` entry.

Clear the manifest on disconnect, next to wherever `setLiveCapabilities(null)` is called on teardown:

```ts
      setActiveManifest(null);
```

Expose `dynamicCommands` on the context value (add to both the `GatewayContextValue` type and the returned object, next to `liveCapabilities`) so the chat screen can pass it to `getSlashCommandSuggestions`:

```ts
  dynamicCommands: GatewayCapabilityCommand[];
```

- [ ] **Step 5: Wire the palette in the chat screen**

Find the `getSlashCommandSuggestions(...)` call site (in the chat screen component) and add `dynamicCommands` from `useGateway()` as its fifth argument.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` — expect zero errors.
Run: `npx jest` — expect PASS across the app suite.
Run: `node --test "gate/__tests__/*.test.mjs"` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add src/context/gateway-provider.tsx src/app gate/core/capabilities/provider/kind.mjs gate/__tests__/provider-kind.test.mjs
git commit -m "feat: feed manifest capability instances into the snapshot and palette"
```

---

### Task 7: End-to-end manual verification

**Files:** none (manual smoke test, mirroring the pattern used in all three prior plans)

- [ ] **Step 1: Scaffold a real command-contributing kind on the Gate**

```bash
node gate/cli.mjs add-kind note --label "Note" --family note
```

Edit `gate/core/capabilities/note/kind.mjs` to be functional *and* to contribute a command — this is the first kind in the series that exercises `commands[]`, so it's the only way to prove the palette path end to end:

```js
  configFields: [
    { key: 'text', label: 'Note text', type: 'string', required: true },
  ],
  validate(config) {
    const errors = [];
    if (!config?.text || typeof config.text !== 'string') {
      errors.push({ field: 'text', message: 'must be a non-empty string' });
    }
    return { ok: errors.length === 0, errors };
  },
  toManifestEntry(instance) {
    return { id: instance.id, text: instance.config.text };
  },
  createHandlers(instance) {
    return { read: async () => ({ text: instance.config.text }) };
  },
```

Commands are declared at the *kind* level (a sibling of `configFields`, not inside `toManifestEntry`'s return) — Task 5 is what carries them onto each instance's manifest entry. Add to the same default-export object:

```js
  commands: [
    { slash: '/note', description: 'Read this note back', method: 'read', danger: 'safe' },
  ],
```

Note the `method` here is the *local* handler name (`read`), matching `createHandlers`'s key. Task 5 qualifies it on the way out, so the manifest should advertise `my-note.read` — verify exactly that in Step 2, since the app calls `command.method` verbatim.

Then:
```bash
node gate/cli.mjs add my-note --kind note
```
Fill in a real `text` value in `gate/registry/my-note.json`.

- [ ] **Step 2: Start a verification Gate and confirm the manifest**

Start on an OS-assigned port (never touch a real Gate on 8760):
```bash
node -e "
import('./gate/core/server.mjs').then(async ({ createGate }) => {
  const gate = await createGate({ root: 'gate', port: 0, name: 'Verification Gate' });
  console.log('TOKEN=' + gate.token);
  console.log('PORT=' + gate.port);
});
" &
```

`curl` the manifest and confirm: `capabilityKinds[]` contains both `provider` (now `family: "models"`) and `note`; `capabilityInstances[]` contains `nvidia` (family `models`) and `my-note` (family `note`); and — if Step 1's check required it — `my-note` carries a `commands[]` entry.

- [ ] **Step 3: Confirm the app-side pipeline against that manifest**

Without launching the full app, exercise the real functions against the real manifest JSON (save the curl output to a scratch file, then):

```bash
npx tsx -e "
import { manifestCapabilityInstances, manifestDynamicCommands } from './src/lib/portal/manifest';
import { buildCapabilitySnapshot } from './src/lib/gateway/dashboard';
const manifest = require('./scratch-manifest.json');
const instances = manifestCapabilityInstances(manifest);
const snapshot = buildCapabilitySnapshot('connected', null, undefined, Date.now(), null, instances);
console.log('note group:', snapshot.groups.find(g => g.id === 'note'));
console.log('dynamic commands:', manifestDynamicCommands(manifest).map(c => c.slash));
"
```

Expected: a synthesized `note` group with status `ready`, and the dynamic command list reflecting whatever `my-note` contributes.

- [ ] **Step 4: Clean up**

Stop the verification Gate. Then:
```bash
rm gate/registry/my-note.json
rm -rf gate/core/capabilities/note
rm -f scratch-manifest.json
```
Confirm `git status` is clean.

No commit — this task only confirms Tasks 1–5 add up to working software.

---

## Plan Self-Review Notes

- **Spec coverage:** Implements design spec §8's read path in full — manifest parsing, snapshot group synthesis, dynamic palette commands, and the generic `rpcRequest`. The write path (capability editor screen) is explicitly deferred per §13.
- **Deliberate spec deviation:** §8 point 3 called for widening `GatewayCommand['group']` to `GatewayFeatureFamily | (string & {})`. Not needed — dynamic commands never become `GatewayCommand`s, and both `SlashCommandSuggestion.family` and `GatewayCapabilityGroup.id` are already `string`. Documented in Non-goals rather than silently skipped.
- **Backward compatibility:** every new parameter (`buildCapabilitySnapshot`'s 6th, `getSlashCommandSuggestions`' 5th, `SlashCommandContext.dynamicCommands`) defaults to empty, so Hermes and OpenClaw behavior is byte-identical and every existing test passes untouched. That's the regression gate for Tasks 2 and 3.
- **Two real gaps found and closed while writing this plan, both in Task 5**, rather than left for implementation to trip over:
  1. `resolveManifestInstances` never emitted `commands` at all (`grep` confirmed zero occurrences in `registry.mjs`). The design spec has carried `commands?:` on the kind contract since day one, and Task 3 builds the whole app-side consumption of it, but no shipped Gate plan ever wired it to the wire. Without Task 5, Task 3 is correct-but-dead code.
  2. Worse, the obvious one-line fix (`commands: kindModule.commands`) would have been **wrong**. A kind is authored before any of its instances exist, so its declared `method` can only be a local handler name — while `buildInstanceHandlers` registers handlers as `<instance-id>.<localName>`. Passing the local name straight through would advertise a palette command that fails on every invocation. Task 5 qualifies the method per-instance and has a dedicated test asserting two instances of one kind get distinct method names.
- **Riskiest task is 6**, not 3: `gateway-provider.tsx` is ~1976 lines, has uncommitted changes, and the edits are surgical anchors rather than a full-file replacement. Its verification step is `tsc --noEmit` plus the full Jest suite, not just the touched files.
- **Task ordering matters here.** Tasks 1–4 are app-side and independently landable. Task 5 is a Gate-side prerequisite that makes Task 3 reachable. Task 6 joins the two sides. Task 7 is the acceptance gate. Running 7 before 5 would show an empty palette and look like a Task 3 bug.
- **Status at handoff (2026-08-12):** the ⚠️ merge-conflict blocker and Task 5 are both
  done and on `master`. **Remaining work is Tasks 1–4, 6, 7** — all app-side except Task 6's
  one-line `family: 'models'` change. Start at Task 1.
