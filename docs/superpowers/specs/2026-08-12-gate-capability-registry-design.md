# Gate Capability Registry — Design

Date: 2026-08-12
Status: Approved design, not yet implemented
Related: `docs/superpowers/specs/2026-08-10-versutus-gate-design.md`, `docs/portal-architecture.md`, `CONTEXT.md`

## 1. Purpose

The 2026-08-10 Gate design solved this for one thing: LLM chat providers. Append
a provider, it shows up on the phone, no app change. Everything else a gateway
might offer — memory, real session persistence, voice, devices, cron, skills,
even new slash commands — still has no home. Hermes advertises some of these
in `/v1/capabilities` and 404s when asked; for the rest, `METHOD_GUIDANCE`
explains in prose why the app can't do it. Both are dead ends the app cannot
build its way out of, because Hermes is a third-party binary the app doesn't
control.

The Gate is first-party. This design generalizes its provider-only registry
(`gate/core/providers.mjs` + `config.mjs`) into one registry for every kind of
capability, so that closing a gap Hermes (or any gateway) has means registering
something into the Gate, not waiting on an upstream fix. `provider` becomes the
first of many kinds the same mechanism handles, not a special case.

Two requirements shape everything below:

- **The Gate is the primary gateway.** Closing this gap means connecting
  Versutus to the Gate instead of Hermes; the app's single-active-gateway
  architecture (`clientRef` in `gateway-provider.tsx`) is unchanged. There is
  no client-side routing between two simultaneously-connected backends.
- **Editable from the app, for every kind, including credentials.** Registering
  a new *kind* of capability is still a build-time, LLM-assisted scaffold (like
  today's `PROVIDER_PROMPT.md` flow). But creating, editing, and deleting
  *instances* of an existing kind must be possible entirely from Versutus, on
  the phone, with no file editing and no restart.

## 2. Goals

- A capability kind, once authored, can have instances created/edited/deleted
  entirely from the app — including fields that hold credentials.
- A new capability instance is live (validated, registered, advertised) without
  restarting the Gate.
- A capability kind can contribute its own slash commands to the app's `/`
  palette, not just satisfy commands the app already knows about.
- A capability's family/id is not limited to the ~19 baked into
  `CAPABILITY_GROUP_DEFS` — an unrecognized family is displayed, not dropped.
- `provider` (today's only kind) moves onto this mechanism with no behavior
  change: existing child-profile sync, chat, and flavor translation keep working.
- One failure-isolation discipline covers every layer: a bad kind, a bad
  instance, or a bad command contribution degrades to "that one thing is
  unhealthy," never a Gate crash and never silent disappearance.

## 3. Non-goals

- **No new `GatewayKind`.** The Gate keeps identifying as `kind: 'custom'`
  (or its existing manifest-driven identity). `ADAPTERS` and
  `createClientForKind` are untouched — this spec makes a `custom` gateway's
  advertised surface richer, it does not add a new gateway class.
- **No simultaneous multi-gateway / fleet view.** Per §1, the Gate is the
  single active gateway. Delegating specific RPC methods to a second,
  concurrently-connected backend while staying on Hermes is explicitly out —
  that is the "fleet" gap already tracked in
  `docs/repo-scope-multi-agent-remote-gateway.md` and is not solved here.
- **No OpenClaw changes.** OpenClaw stays a hand-written WS adapter, entirely
  outside this registry.
- **No real OS-keychain integration.** §7 ships an encrypted local file. A
  proper keychain (`keytar` / `@napi-rs/keyring`) is follow-on (§13).
- **No capability editor screen visual design.** §8 fixes the data contract
  (list kinds, generic-render a form from `configFields`, secrets via a
  separate call). Screen layout is an implementation/UX-pass concern.
- **No new real capability implementations.** This spec delivers the
  mechanism and migrates `provider` onto it as the end-to-end proof. Memory,
  real session persistence, voice, devices, cron, and skills are each their
  own follow-on effort built *using* this mechanism, one at a time — building
  all of them is not part of this spec, mirroring how the 2026-08-10 spec
  made the 12 `unsupported` capability groups "expressible per-gateway" without
  building them.
- **No server push for live capability changes.** §6 relies on the app
  re-fetching the manifest after a mutating call it made itself. A gateway
  pushing an unsolicited capability change to an already-connected app is not
  part of this spec.

## 4. Vocabulary & directory layout

Two terms, added to `CONTEXT.md`:

- **Capability kind** — a category of thing the Gate can do (`provider`,
  `memory`, `cron`, …). Defined once, in code.
- **Capability instance** — one configured, named instance of a kind (e.g. "my
  daily-standup cron job" is an instance of kind `cron`). Defined by config
  only, no code.

```
gate/core/capabilities/registry.mjs       # generalized loader (was providers.mjs)
gate/core/capabilities/<kind>/kind.mjs    # kind code (was provider.mjs + config.mjs)
gate/registry/<instance-id>.json          # instance config (was gate/providers/<id>/provider.mjs)
gate/secrets/store.enc.json               # encrypted secret values, gitignored (see §7)
gate/secrets/.key                         # local decryption key, gitignored
```

`gate/providers/`, `gate/core/providers.mjs`, and `gate/core/config.mjs` are
deleted outright, not deprecated. Per `docs/2026-08-11-session-handoff.md` no
provider is configured yet ("no providers configured, no `.env`, not
running"), so there is nothing to migrate at the data level — only the code
moves, to `gate/core/capabilities/provider/kind.mjs`.

## 5. Kind contract

Every `kind.mjs` exports:

```ts
export default {
  kind: 'cron',                 // matches instance.kind
  label: 'Scheduled jobs',
  family: 'cron',                // maps to a CAPABILITY_GROUP_DEFS id when one exists; else a new group is synthesized (§8)
  configFields: FieldDescriptor[],
  validate(config: unknown): { ok: boolean; errors: { field: string; message: string }[] },
  toManifestEntry(instance: CapabilityInstance): Record<string, unknown>,
  commands?: CapabilityCommandDef[],
  createHandlers(instance: CapabilityInstance): Record<string, (params: unknown) => unknown>,
};

type FieldDescriptor = {
  key: string;
  label: string;
  type: 'string' | 'string-list' | 'number' | 'boolean' | 'enum' | 'secret-ref';
  required?: boolean;
  options?: string[];   // enum only
  default?: unknown;
  help?: string;
};

type CapabilityInstance = {
  id: string;             // matches gate/registry/<id>.json, globally unique (flat namespace, §4)
  kind: string;
  label: string;
  config: Record<string, unknown>;
};

type CapabilityCommandDef = {
  slash: string;                          // e.g. '/standup'
  description: string;
  method: string;                         // fully-qualified: '<instance-id>.<localName>'
  danger: 'safe' | 'write' | 'destructive';
  params?: Record<string, unknown>;
};
```

`configFields` is declarative on purpose: it is both what `validate()` checks
structurally before any kind-specific rule runs, and what the app renders a
form from without knowing the kind in advance (§8). `validate()` covers only
what the declarative shape can't express (e.g. "if `flavor` is `custom`,
`baseUrl` is required") — this replaces today's `validateProviderConfig`,
same rule: name every error, never accept a literal secret in `config`
(secret-typed fields hold a reference name only — see §7).

`createHandlers()` is the new part: it returns the RPC methods this instance
answers, keyed by a *local* name the kind author chooses (e.g. `run`,
`history`). The registry prefixes every key with the instance id before
merging into the Gate's single dispatch table (§6) — instance `cron`
`standup-reminder`'s `run` becomes `standup-reminder.run`. Because
`gate/registry/<id>.json` is already a flat, globally-unique namespace (§4),
this makes cross-instance collision structurally impossible: a kind author
never has to coordinate method names with other instances of their own kind,
let alone other kinds. `commands[].method` (above) refers to this
fully-qualified name. The instance id `registry` is reserved and rejected by
`validate()` at the registry layer, since it would otherwise collide with the
built-in `registry.*` methods in §6. This generalizes what today only
Hermes-shaped REST routes do.

## 6. Instance registry — RPC CRUD, hot-apply, generic forms

The registry is live and mutable, not read once at boot. One always-present
set of Gate-core methods manages it, dispatched through the same endpoint as
every other capability method (§8) — there is one dispatch mechanism, not two:

- `registry.kinds.list()` → `{ id, label, family, configFields }[]` — lets the
  app offer "add a capability" without hardcoding kinds.
- `registry.instances.list()` / `.get(id)` → configured instances, `config`
  returned as-is. No redaction is needed: a `secret-ref` field's value in
  `config` is structurally always just a reference name (§7), never the
  underlying secret, the same way `apiKeyEnv` was never allowed to hold a
  literal key.
- `registry.instances.create(id, kind, label, config)` / `.update(id, label,
  config)` / `.delete(id)` → validated via that kind's `configFields` +
  `validate()`, written to `gate/registry/<id>.json`. `create` rejects an
  `id` that already exists; `update` rejects one that doesn't. `kind` is
  immutable once created — changing it means delete then create.

On any mutation: re-validate → re-run `createHandlers()` for that instance →
recompute that entry in the manifest's `capabilityInstances[]` → return the
full, refreshed `capabilityInstances[]` array in the RPC response (kinds
don't change from an instance mutation, so `capabilityKinds[]` isn't
re-sent). The app replaces its cached copy wholesale — no delta/patch format
to keep in sync — the same way it already applies the manifest fetched after
connect (§8). No push channel is introduced.

These methods require the same pairing/bearer auth as every other Gate call —
no new auth concept.

The Gate also watches `gate/registry/*.json` for changes made outside the RPC
path (the CLI, §9, or a human editing a file directly) and runs them through
the identical load → validate → register pipeline. There is one registry
loading path, not two — RPC and file-watch are just two ways to trigger it.

## 7. Secrets

`secret-ref` fields never appear as literal values in `gate/registry/*.json`,
matching the existing "no literal secrets in config" rule from the provider
design — only a reference name is stored there.

A dedicated method, `registry.secrets.set(refName, value)`, is the only way to
write a secret value. `registry.instances.get`/`.list` still return the
`refName` a `secret-ref` field points at — that's an opaque pointer, not
sensitive — but no read path ever returns the underlying `value`. Values are
stored in `gate/secrets/store.enc.json`, AES-256-GCM
encrypted with a key generated once (`crypto.randomBytes(32)`) into
`gate/secrets/.key` (gitignored).

This is a deliberate, named v1 tradeoff: the key lives beside the ciphertext
on the same disk, so this protects against "secret ends up in a commit, a
backup, or a synced folder by accident" — the same threat model `.env` already
covers — not against "this machine's disk is compromised." A real OS keychain
is follow-on work (§13), not a blocker for this spec: it replaces the storage
backend behind `registry.secrets.set` without changing the RPC contract or
anything upstream of it.

## 8. Manifest extension & app-side consumption

One subtlety before the schema: `kind: 'provider'` is not structurally special
in the registry. It is a kind like any other. It is only special in that its
instances *also* flow through the existing `child-sync.ts` reconciliation
(each provider instance still becomes a selectable child `GatewayProfile`,
unchanged from the 2026-08-10 design). No other kind triggers that path — a
`cron` or `memory` instance is a capability of the currently-connected Gate,
not a separate connectable endpoint.

`buildManifest()` gains two arrays alongside what it already produces:

```json
{
  "capabilityKinds": [
    { "id": "cron", "label": "Scheduled jobs", "family": "cron", "configFields": [ /* FieldDescriptor[] */ ] }
  ],
  "capabilityInstances": [
    {
      "id": "standup-reminder",
      "kind": "cron",
      "label": "Daily standup reminder",
      "family": "cron",
      "manifestEntry": { /* toManifestEntry() output */ },
      "commands": [ /* CapabilityCommandDef[], optional */ ]
    }
  ]
}
```

Both arrays are optional on `GatewayManifest` — an older or non-Gate manifest
simply yields empty arrays and today's fully-static behavior.

Four app files change:

1. **`manifest.ts`** — `GatewayManifest` type gains `capabilityKinds` and
   `capabilityInstances`.
2. **`dashboard.ts`** — `buildCapabilitySnapshot()` folds `capabilityInstances`
   in: an instance whose `family` matches an existing `CAPABILITY_GROUP_DEFS`
   id marks that group ready directly (no feature/endpoint alias guessing —
   the kind declares its family). A `family` matching nothing synthesizes a
   new group (`id: family, label: kind.label, status: 'ready'`) on the fly.
   This is what makes the vocabulary genuinely open rather than a fixed list
   with better aliasing.
3. **`slash-commands.ts`** — the palette becomes
   `[...GATEWAY_COMMANDS, ...commandsFromManifestInstances]`. Dynamic commands
   skip the availability-snapshot check (they exist only because their
   instance is live). A dynamic command whose `slash` collides with an
   existing one is rejected at registration time, isolated to that one
   instance (§10) — never a silent shadow. `GatewayCommand.group` (currently
   `GatewayFeatureFamily`, a closed union) widens to accept any string while
   keeping the existing literals for autocomplete
   (`GatewayFeatureFamily | (string & {})`), since a dynamic command's `group`
   is whatever `family` its owning kind declared.
4. **`manifest-client.ts`** — the one required *behavior* change, not just
   additive. `getSessions`, `getSessionMessages`, `rpcRequest`, and `stopRun`
   currently hard-throw "not advertised." `rpcRequest(method, params)` becomes
   a real passthrough to `POST /v1/capabilities/rpc { method, params }` on the
   Gate, which dispatches server-side to whichever instance's
   `createHandlers()` (or the built-in `registry.*` methods, §6) registered
   that name. This is consistent with how the app already treats RPC
   internally (`context.gatewayRequest(method, params)` throughout
   `slash-commands.ts`) — nothing new on the calling side, only on what the
   Gate can now answer.

Out of scope here: the actual "add/edit a capability" screen's visual layout.
The contract is fixed — list kinds, generic-render a form from
`configFields`, route `secret-ref` fields through `registry.secrets.set`
separately from the main form submit.

## 9. CLI scaffold + LLM prompt

For the rare, code-level event of inventing a new kind, this mirrors the
existing flow almost exactly:

- `node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>`
  scaffolds `gate/core/capabilities/<kind-id>/kind.mjs` from a template (the
  §5 shape), refuses to overwrite an existing kind.
- `node gate/cli.mjs add <instance-id> --kind <kind-id>` scaffolds
  `gate/registry/<instance-id>.json` — nearly identical to today's
  `add <id> --flavor <...>`.
- `gate/PROVIDER_PROMPT.md` generalizes to `gate/CAPABILITY_PROMPT.md`: fill in
  `configFields` / `validate` / `toManifestEntry` / `createHandlers`, never
  restructure the file — same discipline as today, extended to five exports
  instead of a single `config` block.

## 10. Error handling / failure isolation

Generalizes `loadProviders()`'s `skipped.push({ id, reason })` pattern to
every layer:

| Failure | Isolation | Visible via |
|---|---|---|
| Kind fails to import / missing required export | Kind skipped, Gate boots without it | `registry.kinds.list()` includes it with a `reason` |
| Instance references an unknown kind | Instance skipped | `registry.instances.list()` |
| Instance fails `validate()` | Instance skipped (or create/update RPC rejected before persisting) | RPC error response, `registry.instances.list()` |
| Command `slash` collides with an existing one | That one command contribution dropped, instance otherwise loads | `registry.instances.list()` reason on the instance |
| `createHandlers()` throws at registration | Instance marked unhealthy, not removed | `registry.instances.list()` status |

Nothing here takes down the Gate or hides its own failure — the same
discipline `providers.mjs` already proved, applied uniformly instead of only
to providers.

## 11. Testing

- **Gate-side loader tests** (new): good kind, bad kind (import throws),
  good instance, instance referencing an unknown kind, instance failing
  `validate()` — direct analog of today's provider-loader coverage, against
  `gate/core/capabilities/registry.mjs`.
- **Gate-side registry RPC tests** (new): create/update/delete round-trip
  through `registry.instances.*`, a rejected create on invalid config, a
  `registry.secrets.set` value never appearing in a subsequent
  `registry.instances.get`.
- **`capability-snapshot-test.ts`** gains a fixture: a manifest with
  `capabilityInstances` carrying an unrecognized `family` synthesizes a new
  group instead of the instance being invisible.
- **`slash-commands-test.ts`** gains a fixture: a manifest-contributed command
  reaches the palette and executes via the generic RPC path, plus a collision
  fixture asserting registration-time rejection.
- **`openclaw-mapping-test.ts`** is untouched.
- **App unit**: `manifest.ts` parsing of `capabilityKinds`/`capabilityInstances`
  (present, absent, malformed → empty arrays per §8).

## 12. Sequencing

1. `gate/core/capabilities/registry.mjs` — generalized kind + instance loader,
   failure isolation. `provider` migrates onto it
   (`gate/core/capabilities/provider/kind.mjs`), wrapping the existing
   openai/anthropic/custom flavor logic unchanged. **Regression gate**:
   existing provider-loading behavior is unchanged in substance, only in
   location.
2. `POST /v1/capabilities/rpc` generic dispatch endpoint, plus the built-in
   `registry.kinds.*` / `registry.instances.*` / `registry.secrets.set`
   methods and the encrypted secret store.
3. `gate/cli.mjs add-kind` / generalized `add`, `gate/CAPABILITY_PROMPT.md`.
4. `buildManifest()` gains `capabilityKinds[]` / `capabilityInstances[]`.
5. App: `manifest.ts`, `dashboard.ts` dynamic group synthesis,
   `slash-commands.ts` dynamic command merge + collision rejection,
   `manifest-client.ts` generic `rpcRequest`.
6. App: capability editor screen (list kinds, generic form, secrets flow).
7. **Acceptance gate**: connect Versutus to the Gate with `provider` as the
   only kind, confirm chat/child-sync/capability-snapshot behavior is
   byte-for-byte the same as before this spec. A second, genuinely new kind
   (e.g. `cron`) end-to-end is validation of the mechanism but is follow-on
   work (§13), not required to close this spec.

Steps 1–4 are independently verifiable without touching the app, same as the
2026-08-10 design's sequencing.

## 13. Follow-on work (not this spec)

- Real kinds: memory, session persistence (closing the Hermes
  `/api/sessions/{id}` 404 gap locally), voice, devices, skills — each
  authored one at a time using this mechanism.
- True OS-keychain integration behind `registry.secrets.set`, replacing the
  v1 encrypted-file store.
- Capability editor screen visual/UX design.
- A server-push mechanism for capability changes made outside the app's own
  session (e.g. a human editing `gate/registry/*.json` by hand while the app
  is connected).
