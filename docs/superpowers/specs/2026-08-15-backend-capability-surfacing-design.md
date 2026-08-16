# Backend & capability surfacing — design

Date: 2026-08-15
Branch: `feat/provider-cli-environments`

The Gate can hold a conversation through three native agent CLIs, and owns three configured
providers. The app shows almost none of it. This closes the gap between what the Gate knows and
what the phone is told.

---

## Problem

Three defects, found by tracing the manifest from `buildManifest` to the capability tiles.

**P1 — v2 providers never reach the manifest.** `computeState()` derives `providers[]` from
`loadCapabilities(root)`, which reads the legacy `gate/registry/` directory. The v2 providers live
under Gate home and are owned by `ProviderService`, which is not passed to `buildManifest`. On this
desktop the manifest therefore advertises one stale legacy `nvidia` record while `nvidia`,
`opencode-go` and `opencode-zen` — with real readiness, catalogs and DPAPI credentials — are
invisible to every manifest-driven surface. They are reachable only through the `providers.list`
RPC that the Setup screen calls directly.

**P2 — capability claims are an OR across backends.** `backendCan()` uses `.some(...)`, so one
backend offering `tools` makes the Gate advertise `tools: true` for the whole Gate. Select a
backend that cannot, and the app's Tools tile still reads ready.

**P3 — declared capabilities are not live capabilities.** Backend capabilities come from the
adapter's static declaration. Claude Code advertises `sessions, tools, models` even while its OAuth
token is revoked. `backendManager.describe()` drops the record's `state` and probe result, so the
app cannot distinguish a working backend from a broken one without a second RPC.

Alongside these, the backend is invisible in chat, and the provider/environment cards are raw
enough to look unfinished next to the rest of the app.

## Non-goals

- No changes to the Gate's backend transports (OpenCode HTTP+SSE, Codex stdio, Claude per-turn).
- No component-render test harness. This repo tests pure layers; React surfaces are covered by
  `tsc`, lint and the existing suites.
- The capability editor screen stays reachable. Only its secret field is guarded.
- No new dependencies.

---

## F1 — v2 providers in the manifest

`computeState()` passes `await providerService.list()` into `buildManifest`. The builder emits one
manifest entry per provider carrying what a client needs to decide whether it is usable:

```
{ id, label, basePath, models, capabilities: { chat, streaming },
  readiness: { state, code? }, auth: { state }, catalog: { state, source, count } }
```

Legacy registry entries are still emitted. **A v2 record wins on id collision** — that is the
duplicate `nvidia` on this desktop. Ordering is v2 first, then legacy, each sorted by id, so the
manifest is stable across reads.

`providerService.list()` failing must not take the manifest down: it is caught the same way
`backendManager.describe()` already is, falling back to legacy-only providers.

**Credential safety:** the manifest is served to any paired device. Entries carry state, never
key material, `credentialRef`, or `baseUrl`. A test asserts no manifest entry matches a
credential-shaped string.

## F2 — backend health in the manifest

`backendManager.describe()` gains `state` (the record's lifecycle state) and `cliVersion` (from the
last probe, when present). The shape stays wire-safe — no executable paths, no environment.

`GatewayBackend` in `src/lib/portal/manifest.ts` gains the matching optional fields.

## F3 — capabilities scoped to the selected backend

`buildManifest` keeps the OR: with no backend selected, the Gate's advertisement is "some backend
here can do this", which is true.

The app narrows it. A new pure helper in `src/lib/gateway/`:

```ts
capabilitiesForBackend(manifest, selectedBackendId): { sessions: boolean; tools: boolean }
```

Returns the selected backend's own capability list when one is selected, the manifest-level OR
otherwise. The capability snapshot builder consumes it so the Sessions and Tools tiles describe the
backend actually in use. Tiles gain a note naming the backend they came from.

The Providers tile stops reporting readiness from endpoint existence and reports it from the F1
data instead: ready when at least one provider is ready, degraded when providers exist but none is,
with a note counting them (`2 of 3 ready`). This is the difference between a Gate whose providers
all lack keys and one that can actually answer, which today look identical.

## A — backend in the chat header

`ChatHeader` gains optional `backendLabel` and `onBackendPress`.

- With a backend: title is the backend, subtitle is `via {gateway} · {statusDetail}`.
- Without: renders exactly as today, so direct-provider chat (NVIDIA-only, no CLI) is untouched.

Model and session chips stay; the gateway name vacating the title row is what makes space.

New `BackendPickerSheet` (`src/components/chat/backend-picker-sheet.tsx`) on `BaseSheet`, modelled
on `ModelPickerSheet`: one row per backend with adapter id, capability badges (F2/F3 data), health
from `state`, workspace root, current-selection highlight, `EmptyState` when the Gate advertises
none. Selecting calls the existing `selectBackend`, which already releases the session, clears
messages and reloads history.

## B — per-backend model memory

A Codex model id is meaningless to OpenCode. `GatewayProfile` gains optional
`backendModels?: Record<string, string>`.

```
effective model = backendModels[selectedBackendId] ?? gateway.model
```

`selectModel` writes into the map when a backend is active, and to `gateway.model` otherwise.
The field is optional, so persisted profiles migrate by doing nothing. Resolution lives in a pure
helper so it is testable without a device.

No change is needed to model *fetching*: `setBackendId` already appends `backendId` to routes and
bodies, so `models.list` and the session routes are backend-scoped once a backend is selected.

## C — provider and environment cards

Both cards take the same shape:

- **One primary action, driven by state.** Provider: Set key → Authorize → Refresh, by
  `providerUiState`. Environment: Start/Stop by `state`. Everything else moves behind an overflow
  sheet of `ListRow`s.
- **Destructive actions confirm.** `Alert.alert` plus warning haptic, matching `confirmDelete` in
  `gateway-home-dashboard.tsx`.
- **Errors become `ErrorCard`** with cause / affected / next action, replacing bare captions.
- **`Skeleton` rows** during first load, replacing the current blank-then-populate.
- **Key entry moves into a `BaseSheet`** anchored to the tapped provider, instead of rendering
  below the entire list.
- **Meta lines humanized:** `98 models · live` rather than `catalog live/fresh (98)`.

Primary-action selection lives in `lib/` beside `providerUiState`, and is tested.

## D — secret-ref guard

The vault names each file after its ref, so a ref that is itself a key writes the secret into a
filename. This happened on 2026-08-14.

- **Gate:** `registry.secrets.set` rejects a `refName` that looks like a credential — a known key
  prefix (`sk-`, `sk_`, `gsk_`, `xai-`, `ghp_`), or ≥32 chars with no separator — with a message
  pointing at the value field.
- **App:** `capabilities.tsx` labels the field as a name rather than the key, and validates before
  sending.

The guard rejects; it does not sanitize. A silently-renamed ref would strand the secret under a
name no adapter reads.

---

## Testing

TDD on the pure layers, where this repo's coverage already lives.

| Unit | Test |
|---|---|
| `buildManifest` with v2 providers | v2 wins on id collision; legacy retained; stable order; no credential-shaped values |
| `computeState` provider merge | `providerService.list()` rejection falls back to legacy-only |
| `backendManager.describe()` | carries `state`/`cliVersion`; omits executable path |
| `capabilitiesForBackend` | selected backend narrows the OR; no selection returns the OR |
| effective-model resolution | per-backend value wins; falls back to `gateway.model`; absent map is safe |
| card primary action | each provider/environment state maps to the expected action |
| refName guard | each key prefix and the length rule reject; ordinary names pass |

Standing gates: `npx tsc --noEmit`, `npm run lint`, `npm test` (jest + gate).

## Sequence

F1 and F3 first — they fix the data every other surface displays — then F2, A, B, C, D.

## Risks

- **F1 changes a wire shape the app already parses.** New fields are additive and optional;
  `isGatewayManifest` only validates `manifest` and `kind`, so an older app ignores them.
- **Duplicate `nvidia`** is real on this desktop. The collision rule is exercised by a test rather
  than assumed.
- **P3 is mitigated, not solved.** `state` reflects the last probe, not this instant. A backend can
  still fail a turn after reporting ready — which is why Claude Code's revoked token surfaces as a
  failed run rather than as an assistant message.
