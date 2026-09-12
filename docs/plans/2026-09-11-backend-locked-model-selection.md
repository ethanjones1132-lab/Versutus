# Backend-locked model selection

Date: 2026-09-11. Branch: sprint/features-functions-ui.

## Bug

`GET /v1/models` on a Versutus Gate (gate/core/server.mjs ~1867-1875) flattens every
registered backend's models into one list, tagging each with `backendId`. The app's
model picker renders that flat list unfiltered, so tapping a model owned by another
backend silently re-routes chat, sessions and runs to that backend. Observed in
production: the operator was moved onto `opencode` (capabilities
`['acp','run-json','mcp','sessions','tools','models']`) from `hermes`
(`['chat','tools','mcp','sessions','models','runs','skills','diagnostics','cron','bots']`).
`runs` is Hermes-only, so /run answered "This gateway does not support agentic runs"
and skills/cron/bots/diagnostics greyed out. Nothing was broken — the operator had
been moved. (`run-json` on opencode is a transport format, not the `runs` capability.)

Required behaviour: model options are locked to the currently selected backend until
the operator deliberately changes backend; changing backend is never a side effect of
picking a model.

## Decision

**Filter client-side by `backendId`; no Gate change.** Every backend-sourced model in
the Gate's `/v1/models` response already carries `backendId`; the app simply drops it
(`ModelInfo` in src/lib/gateway/types.ts does not declare it, and chat-screen's
`modelRows` map discards it). A backend-scoped Gate endpoint would be a protocol
change that other clients (CLI, desktop) would then have to adopt, and the constraint
is to prefer an app-side fix when both work. Client-side filtering changes nothing on
the wire and cannot break any other client.

**Models with no `backendId` never vanish.** The visibility rule is: a row shows iff
`row.backendId` is absent OR equals `selectedBackendId`. That covers the direct-Hermes
dialect (`/api/model/options` rows, which carry provider identity but no backend) and
the non-backend branch of the Gate handler. When `selectedBackendId` is undefined —
direct Hermes connection, or a manifest that has not landed yet — no filtering is
applied at all. An empty filter result is therefore only possible when a backend is
selected and genuinely serves no models, which is a true fact worth showing.

**Backend switching semantics are already correct; keep them.** `selectBackend`
(src/context/gateway-provider.tsx:1859) already does the deliberate-act teardown:
clears Bot scope, releases the session (`sessionIdRef` + `currentSessionId` +
`client.setSessionId(undefined)`), restores the per-backend remembered model from
`backendModels[backendId]` into `model`, persists `backendId` on the profile, and
reloads history. `effectiveModel` already reads `backendModels[selectedBackendId]`
first, so per-backend memory survives the switch in both directions. The stale-pin
sweep (gateway-provider.tsx:1426-1472) already validates `effectiveModel(current,
backendId, botId)` against the live catalog, and `staleModelPin` only condemns a pin
on an explicit `available: false` — an absent match proves nothing, so a pin that is
simply invisible in another backend's scope is never wrongly replaced. One real gap
remains: the connect-time default pin (gateway-provider.tsx:1407-1415) picks the
first available model from the **unfiltered** catalog, so a fresh profile can be born
pinned to another backend's model; step 4 scopes it.

**Surfacing the active backend and its capabilities.** No new machinery: the chat
header already names the routing backend (chat-screen.tsx:941-942, `activeBackend` /
`backendLabel`), and the Backends section of the thread-config sheet already renders
each backend's advertised `capabilities` joined into the row subtitle
(thread-config-sheet.tsx:875-882) — the hermes/opencode asymmetry is visible there
today. What is missing is that the Models section says nothing about why its list is
scoped. Add one caption line naming the backend the list is locked to, pointing at
the Backends tab for switching. Feature gating stays exactly where it is:
`capabilitiesForBackend` (src/lib/gateway/backend-capabilities.ts) gates on
advertised capability, never on a backend name; nothing in this fix hard-codes
"hermes" or "opencode" anywhere.

## Steps

### 1. Declare `backendId` on the wire type

File: `src/lib/gateway/types.ts` (ModelInfo, ~lines 104-117).

Add an optional field with a doc comment:

```ts
/** Owning CLI backend, when the catalog is a Gate's cross-backend /v1/models list. */
backendId?: string;
```

Verify: `npx tsc --noEmit` passes (no reader changes yet; the field is additive).

### 2. Pure scope helper in the model-selection lib

File: `src/lib/gateway/model-selection.ts`.

Add and export:

```ts
/**
 * Narrow a catalog to the backend currently routing chat.
 *
 * A Gate's /v1/models flattens every backend's models into one list tagged
 * with backendId; offering them all lets a model tap silently switch backend.
 * Rows with no backendId (direct Hermes /api/model/options, the non-backend
 * branch of the Gate handler) belong to no backend and always stay visible.
 * With no backend selected there is nothing to scope to — return the catalog
 * unchanged, same reference, so memoised pickers do not re-render.
 */
export function scopeModelsToBackend<T extends { backendId?: string }>(
  models: T[],
  selectedBackendId: string | undefined,
): T[] {
  if (!selectedBackendId) return models;
  return models.filter((m) => !m.backendId || m.backendId === selectedBackendId);
}
```

Verify: step 6's unit tests.

### 3. Apply the scope in the picker's row build

File: `src/components/chat/chat-screen.tsx` (`modelRows` memo, lines 899-914).

- Carry `backendId` through the map: `backendId: model.backendId as string | undefined`.
- Wrap the mapped rows: `scopeModelsToBackend(mapped, selectedBackendId)`.
- Add `selectedBackendId` to the memo's dependency array (it is already destructured
  from the context at line 329, and `effectiveModel` from model-selection is already
  imported at the top for line 935 — add `scopeModelsToBackend` to that import).
- Extend the `ModelItem` type in `src/components/chat/thread-config-sheet.tsx`
  (lines 78-87) with `backendId?: string` so the shaped row type-checks.

This is the entire behavioural fix: the sheet only ever receives models the selected
backend serves (plus unattributed rows), so `selectModel` → `withSelectedModel` can
only ever pin a model of the current backend into `backendModels[selectedBackendId]`.

Verify: `__tests__/thread-config-test.ts` and the picker tests still pass; step 6
adds a test that the rows handed to the sheet exclude other backends' models.

### 4. Scope the connect-time default pin

File: `src/context/gateway-provider.tsx` (lines 1407-1415).

The default pin runs only when `!gateway.model` (a fresh profile). Today it picks
the first available row of the cross-backend catalog. Change to:

```ts
const models = await client.getModels();
const scoped = scopeModelsToBackend(models, selectedBackendIdRef.current ?? gateway.backendId);
const first = scoped.find((m) => m.available !== false)?.id ?? scoped[0]?.id ?? models[0]?.id;
```

The `?? models[0]?.id` tail preserves today's last-resort behaviour when the scope is
empty (backend known but catalog momentarily unattributed) rather than sending
`model: undefined`, which the existing comment says the Gate 404s on.

Verify: existing connect-path tests pass; `npx tsc --noEmit`.

### 5. Name the locking backend in the Models section

Files: `src/components/chat/thread-config-sheet.tsx`, `src/components/chat/chat-screen.tsx`.

- `ModelsSection` gains an optional `backendLabel?: string` prop. When present,
  render one caption above the search field, reusing the `styles.blurb` caption
  pattern the Backends section already uses
  (thread-config-sheet.tsx:905-907):
  `Models served by {backendLabel}. Switch on the Backends tab to see another
  backend's models.`
- `ThreadConfigSheet` threads `backendLabel` from its own props into `ModelsSection`.
- chat-screen.tsx passes `backendLabel={activeBackend?.label}` (already computed at
  line 942) into `ThreadConfigSheet`, and only when `backends.length > 1` — a
  single-backend gate has nothing to be locked against, so the line would be noise.

No backend name is hard-coded; the label comes from the manifest entry. Capability
gating of features stays with `capabilitiesForBackend`, unchanged.

Verify: `__tests__/thread-config-test.ts` (render assertions) still pass; add one
render assertion to it (or the nearest thread-config test) that the caption shows
the backend label when provided.

### 6. Tests

New file: `__tests__/backend-locked-models-test.ts` (jest, pure-lib style like
`__tests__/model-selection-test.ts`).

1. `scopeModelsToBackend` returns the same reference when `selectedBackendId` is
   undefined.
2. With a backend selected, rows tagged with another `backendId` are excluded.
3. Rows with no `backendId` survive every selection.
4. Rows tagged with the selected backend survive.
5. Shaping regression for chat-screen: replicate the `modelRows` field mapping on a
   fixture catalog containing one hermes model, one opencode model and one
   unattributed model; assert that with `selectedBackendId: 'hermes'` the opencode
   row is gone, the hermes and unattributed rows remain, and each surviving row still
   carries `id`, `providerId`, `available`.

Update `__tests__/thread-config-test.ts` (or add a focused case) asserting the
Models section renders the lock caption with the backend label.

Do not weaken existing tests: `model-selection-test.ts`,
`model-switch-announce-test.ts`, `setup-backend-freshness-test.ts` pin the
per-backend memory and adoption behaviour this fix relies on.

### 7. Full gate

Run `npm run verify` (verify:config, `tsc --noEmit`, lint, `jest --coverage`,
coverage ratchet, gate tests). The new test file must keep the coverage ratchet
satisfied — it adds covered lines in model-selection.ts, so the ratchet moves the
right way.

## Final verification

Automated: `npm run verify` green, including the new
`__tests__/backend-locked-models-test.ts`.

Manual repro (the production scenario, inverted):

1. Connect the app to a Versutus Gate fronting both `hermes` and `opencode`.
2. Confirm the header chip names the current backend (hermes).
3. Open the thread-config sheet → Models. Confirm the caption names hermes, and that
   the list contains only hermes-tagged models (plus any unattributed rows) — no
   opencode models appear, including under search.
4. Pick any model. Confirm the header chip still names hermes, `/run` still works,
   and skills/cron/bots affordances stay enabled (`capabilitiesForBackend` still
   sees hermes).
5. Switch to the Backends tab and deliberately select opencode. Confirm the session
   restarts, the Models list now shows opencode's models, the remembered hermes
   model is restored on switching back (`backendModels` round-trip), and the
   runs-dependent affordances honestly grey out while opencode is selected — the
   difference is now visible and deliberate, not a silent side effect.

## Out of scope

- No change to gate/core/server.mjs or any Gate protocol surface.
- No change to `selectBackend`, `effectiveModel`, `withSelectedModel`,
  `staleModelPin` semantics — they are already per-backend-correct.
- No per-backend feature hard-coding; capability gating remains advertised-capability
  driven via `capabilitiesForBackend`.
