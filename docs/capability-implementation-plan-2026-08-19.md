# Capability Implementation Plan — 2026-08-19 (v2, re-audited)

Companion to `docs/capability-gap-audit-2026-08-19.md`. That audit is the
evidence; this is the build order. Every step names the file, the extension
point, and the pattern to reuse.

**v2 changes.** v1 was audited against the repo at HEAD and several of its
claims did not survive. The corrections are inline below and summarised in §0 —
including one blocker (the authenticated-route allowlist) that would have made
Phase 1's routes dead code, and one capability (`tools`) that the audit lists
as *ready* while nothing implements it.

**Status (2026-08-19).** Phases 0, 1 and 2 are implemented and `npm run verify`
is green (410 gate tests, 468 jest tests, tsc, lint, ratchet). Phases 3–7 are
untouched. Decisions taken where the plan left a choice: the allowlist got a
drift test rather than a route-table collapse; `tools` was implemented rather
than un-advertised; agent-transport commands are gated on their own capability
and never on the method table.

Format per phase: **Goal** → **Changes** (file-by-file) → **Tests** → **Gate**.
Ordered by impact-per-effort. Phases 1+2 ship together or not at all (audit
§1b: a ready tile over an unroutable command is the `tools: true` trap again).

---

## 0. Corrections carried into this revision

| v1 claim | Verdict | What is actually true |
|---|---|---|
| New routes go "beside the existing sessions block" | **Blocker** | Handlers there are unreachable. `isKnownAuthenticatedRoute` (`server.mjs:555-585`) 404s anything not explicitly allowlisted, ~180 lines earlier. Every new path needs an allowlist entry. See Phase 0. |
| "Return 422 (`backend_unsupported`) — the runs routes set this precedent" | **False** | No `422` and no `backend_unsupported` exists anywhere in `server.mjs`. The real precedent is **501 / `runs_unsupported`**, written inside `resolveRunBackend` (`:662-686`). |
| `:712`/`:745` are a usable pattern | **False, and a latent bug** | Both guard with `typeof backend.runEvents !== 'function'` and then bare-`return`. When the backend exists but lacks the method, nothing is written to `res` and the socket hangs. Do not copy. Fix in Phase 0. |
| `tools.list` implements over "backend toolsets" (audit §3b) | **False** | No `listTools`/`listToolsets` on the Hermes backend; no tools route on the Gate. `tools` is advertised anyway (the adapter declares the capability) and reads *ready* in the app. See Phase 0. |
| Phase 2: `rpcMethods` recomputed in `computeState()` | **Not implementable as written** | `computeState()` (`:315`) calls `buildManifest` at `:327` *before* `dispatch` is built at `:335`; `registryMethods` does not exist until `:445`. Requires reordering — see Phase 2. |
| "Record in `AGENTS.md` per the existing convention" | **No such convention** | `AGENTS.md` is four lines about Expo docs. Nothing records pass rates. Establish the convention deliberately or drop the instruction. This plan drops it. |
| `streamBackendTurn`, `server.mjs:1021` | **Wrong line** | Definition is `server.mjs:52`; `:1021` is the call site. |
| Phase 4: "update the two path builders" | **Three** | `client.ts:78`, `:142`, `:158`, each rebuilding `httpBase` independently. |
| Audit §6: C1 is half-shipped | **Fully shipped** | `getSessionMessagePage(sessionId, limit, before)` already threads the cursor (`manifest-client.ts:433`), and `loadEarlierMessages` already prefers it, keeping the growing-limit refetch only as a documented fallback (`gateway-provider.tsx:647-688`). Nothing remains. |

Everything else in v1 verified clean: `call()` (`backends/hermes.mjs:81-100`),
the adapter capability array (`adapters/hermes.mjs:9`), `backendCan`
(`manifest.mjs:69-71`), the 21 group defs and their `skills` / `health_detailed`
/ `jobs_admin` match keys, the boolean pass-through
(`manifest-client.ts:218-223`), the RPC dispatch seam (`server.mjs:1106`), the
conpty stub and its self-referential test, the complete terminal wire protocol,
and the streaming shape mismatch.

---

## Phase 0 — Make the extension points honest (prerequisite)

**Goal:** four defects that would silently corrupt every later phase. Small,
independent, landable on their own.

### Changes

1. **`gate/core/server.mjs:711,744`** — replace the bare `return` in the
   `typeof backend.runEvents !== 'function'` guard with an explicit response.
   Use the existing 501 / `runs_unsupported` shape from `resolveRunBackend`
   (`:662-686`) so there is exactly one convention for "backend cannot do
   this", not two. Same for the `replyApproval` guard.
2. **`gate/core/server.mjs:555-585`** — the `isKnownAuthenticatedRoute`
   allowlist is a second, hand-maintained copy of the route table, and drift
   between it and the handlers is invisible until a request 404s. Either add a
   test that every handled path is allowlisted, or (better) collapse the two
   into one table the handler dispatches from. **Decide this before Phase 1**,
   because Phase 1 adds five paths to both and Phase 4 adds three more.
3. **`tools` is advertised with nothing behind it.** `adapters/hermes.mjs:9`
   declares `'tools'`, so `backendCan('tools')` sets `capabilities.tools: true`
   (`manifest.mjs`), which the app renders as a *ready* Tools tile — over a Gate
   that serves no tools route and a backend with no tools method. Pick one:
   - **Implement it** (preferred, and required by Phase 1's `tools.list`): add
     `listToolsets()` to `createHermesBackend`, a `GET /v1/toolsets` Gate route,
     and `endpoints.toolsets` in the manifest.
   - **Or stop claiming it**: drop `'tools'` from the adapter declaration until
     something implements it.
4. **`gate/__tests__/manifest-capabilities-advertised.test.mjs:23-35`** — the
   `backing` map is five hardcoded entries, so `tools`, `sessions`, `runs` and
   `approvals` are exempt from the endpoint-backing check. That is why (3) went
   unnoticed. Derive the check from the manifest's own capability keys, or at
   minimum add the four missing entries. This test is the plan's dead-config
   detector; right now it does not cover the capability that is lying.

### Gate

`npm run verify`. Item 3 changes the manifest, so
`manifest-capabilities-advertised.test.mjs` must be updated in the same change.

---

## Phase 1 — Gate fronts `skills`, `diagnostics`, `cron` (+ their RPC methods)

**Goal:** three capability groups flip ready on a Gate, with working slash
commands behind them, and zero app changes.

All three upstream surfaces were verified live: Hermes answers `GET /v1/skills`,
`GET /health/detailed`, `GET /api/jobs` (full CRUD + `pause`/`resume`/`run`)
with 200. The app's own route table documents the exact upstream paths:
`src/lib/gateway/rpc-routes.ts:12-37`.

### Changes

1. **`gate/core/cli-environments/backends/hermes.mjs`** — add methods to the
   object returned by `createHermesBackend`, each a thin `call()` passthrough
   (`call()` at `:81-100` already does auth, error mapping, JSON):
   - `listSkills()` → `/v1/skills`
   - `healthDetailed()` → `/health/detailed`
   - `listJobs()` → `/api/jobs`
   - `runJob(jobId)` → POST `/api/jobs/{id}/run`
   - `setJobPaused(jobId, paused)` → POST `/api/jobs/{id}/pause` or `/resume`
   - `listToolsets()` → `/v1/toolsets` — **new in v2**, required by `tools.list`
     in step 5 and by Phase 0 item 3.
2. **`gate/core/cli-environments/adapters/hermes.mjs:9`** — extend the static
   capabilities declaration from
   `['chat','tools','mcp','sessions','models','runs']` by adding `'skills'`,
   `'diagnostics'`, `'cron'`. This is what makes `backendCan(...)`
   (`manifest.mjs:69-71`) true for them.
3. **`gate/core/server.mjs` — allowlist first, then handlers.**
   **3a. `isKnownAuthenticatedRoute` (`:555-585`)** — add every new path, or the
   handlers below are unreachable: `/v1/skills` (GET), `/health/detailed` (GET),
   `/v1/toolsets` (GET), `/v1/jobs` (GET), and a regex for
   `/v1/jobs/{id}/(run|pause|resume)` (POST).
   Note `/health/detailed` does **not** match the unauthenticated `/health`
   check (`pathname === '/health'`), so it lands in the authenticated block.
   That is the right call — detailed diagnostics should require a token — but it
   is a deliberate divergence from `/health`, so say so in a comment.
   **3b. Handlers** beside the existing sessions block (`:765-783`), same
   `resolveBackend(...)` shape (`:637`), one per path above.
   When the resolved backend lacks the method, answer **501 with
   `code: 'backend_unsupported'`** — mirroring `resolveRunBackend`'s
   `runs_unsupported` (`:662-686`), which is the only such precedent in the
   file. Write the response; never bare-`return` (Phase 0 item 1).
   Factor this into a `requireBackendMethod(backend, name)` helper rather than
   repeating the guard six times.
4. **`gate/core/manifest.mjs:73-123`** — advertise, gated on `backendCan`:
   - `endpoints.skills` when `backendCan('skills')`
   - `endpoints.health_detailed` when `backendCan('diagnostics')`
   - `endpoints.toolsets` when `backendCan('tools')`
   - `capabilities.jobs_admin: true` when `backendCan('cron')` — boolean
     capabilities pass through verbatim as app-side feature flags
     (`manifest-client.ts:218-223`), and the cron group def matches exactly that
     key (`dashboard.ts:849`).
   The Gate advertises `jobs_admin: true` from *its own* observed fronting,
   bypassing Hermes' under-reported flag (audit §1c).
   Housekeeping while here: `manifest-client.ts:216-218` is an `if` block
   containing only a comment — dead code in the synthesis path this phase
   depends on. Delete it or implement it.
5. **New `gate/core/capabilities/gateway-methods.mjs`** —
   `createGatewayMethods({ resolveBackend })` returning a method map for the
   Hermes-dialect names the app's registry already sends, implemented over the
   new backend methods: `health`, `status`, `diagnostics.full`, `skills.list`,
   `skills.status`, `cron.list`, `cron.status`, `jobs.run`, `jobs.pause`,
   `jobs.resume`, `sessions.list`, `models.list`, `tools.list`.
   Merge into the dispatch at `server.mjs:1106`:
   `registryMethods[m] ?? gatewayMethods[m] ?? state.dispatch.get(m)`.
   The app's `rpcRequest` already POSTs these names to `/v1/capabilities/rpc`
   (`manifest-client.ts:469-470`) — no client change.
   `jobs.pause` / `jobs.resume` have no `METHOD_TO_ROUTE` entry
   (`rpc-routes.ts`), so they are Gate-only methods. That is fine, and is
   exactly what Phase 2's per-gateway availability is for — but it means the two
   gateways diverge, so do not assume a shared method set.

### Tests

- Route tests after the `backend-routes.test.mjs` pattern: each new route
  proxies, maps errors, and 501s on a backend without the method.
- **An allowlist test**: each new path reaches its handler rather than the
  `:583` catch-all 404. This is the regression v1 would have shipped.
- Dispatch tests after `capabilities-rpc-route.test.mjs`: each new method name
  dispatches; unknown names still 404 with `unknown_method`.
- Extend `manifest-capabilities-advertised.test.mjs`: new capability↔endpoint
  backing pairs (including the `tools`/`toolsets` pair from Phase 0), and an
  advertised-when-backend-present / absent-when-not pair (fake backends array).

### Gate

`npm run verify` + `npm run smoke:live` against the running Gate: the three
groups render ready, and `/skills`, `/cron`, `/diagnostics` slash commands
return real data.

---

## Phase 2 — Live dispatch-table filtering (app) — ships with Phase 1

**Goal:** delete dialect guessing. A command button renders iff the connected
gateway claims the method.

### Changes

1. **Gate advertises its dispatch keys — after fixing the build order.**
   As written in v1 this does not work: `computeState()` (`:315`) calls
   `buildManifest` at `:327`, but `dispatch` is not built until `:335` and
   `registryMethods` does not exist until `:445`. Required reordering:
   - Move `const dispatch = buildInstanceHandlers(kinds, instances)` **above**
     the `buildManifest` call inside `computeState()`.
   - Hoist `registryMethods` (`:445`) **above** `computeState()`. Safe:
     `createRegistryMethods` takes `getState: () => state` and reads it lazily,
     and `providerRpc`/`environmentRpc` already sit at `:268`/`:282`.
   - Then pass `rpcMethods` into `buildManifest` as the sorted union of
     `registryMethods`, `gatewayMethods` and `dispatch` keys. Recomputed per
     `computeState()`, so instance methods appear without a restart.
2. **`src/lib/gateway/manifest-client.ts`** — carry `manifest.rpcMethods` onto
   the synthesized capabilities object (e.g. `capabilities.rpcMethods`).
3. **`src/lib/gateway/dashboard.ts`** — in `buildCapabilitySnapshot`
   (`:1038-1053`, where the `methods` availability map is built):
   - **Mind the keyspaces.** `methods` is keyed by `command.id`; `rpcMethods`
     holds RPC *method names*. Go through `GatewayCommand.method` (`:44`).
     v1's `rpcMethods.includes(m)` conflates the two.
   - **Agent-transport commands need their own rule.** `agent-status` and
     `agent-stop` (`:557`, `:569`) carry `agentCommand` and no `method`. If
     availability derives from `rpcMethods` alone and `filterExecutableCommands`
     becomes the single filter, both go unavailable on *every* gateway and the
     Agent tab drops from 2 commands to 0. Decide explicitly: gate them on the
     `agent` capability, or leave `transport: 'agent'` unfiltered.
   - Gate (manifest present): `reason: 'not dispatched by this gateway'`.
   - Hermes: the keys of `METHOD_TO_ROUTE` in `rpc-routes.ts` *are* the Hermes
     dispatch table — build availability from it, **`&&` the existing
     `commandAllowed(command, hello)` scope check**, not instead of it.
   - Delete `speaksHermesRpcDialect` and `filterCommandsForDialect`
     (`:1134-1152`) and their call site in
     `src/components/terminal/terminal-screen.tsx:202-208`.

### Tests

- Update the dialect-filter tests (they assert the old static behavior — they
  invert: a Gate advertising `skills.list` now keeps the command).
- Snapshot tests: command unavailable when absent from `rpcMethods`; available
  when present; Hermes path keyed off `METHOD_TO_ROUTE`; **agent-transport
  commands survive the new filter**.
- A Gate test that `manifest.rpcMethods` is non-empty on first boot — the
  ordering bug above produces an empty array, which would silently blank the
  RPC tab rather than fail loudly.

### Gate

`npm run verify`; RPC tab on a Gate shows exactly the buttons that work.

---

## Phase 3 — Resolve `conpty.mjs`

**Goal:** the fake-terminal stub stops masquerading as machinery (audit §2c).

**Recommendation: delete.** `gate/core/cli-environments/conpty.mjs` and
`gate/__tests__/cli-conpty.test.mjs`. The `start/acceptChunk/exit` shape is
three lines to recreate when Phase 4 needs it; a tested stub buys false
legitimacy, not speed.

**v1's "check first" is answered: leave `schema.mjs:4` alone.** The `'conpty'`
entry in `PROTOCOLS` is a protocol-name string for the environment schema,
unrelated to `createConptyFallback`; no registry JSON declares it. The module's
only non-test reference is its own test.

**Gate:** `npm run verify`.

---

## Phase 4 — Terminal endpoint on the Gate

**Goal:** the Shell tab works. The transport half already exists — the client
speaks a complete protocol (`src/lib/terminal/client.ts`): SSE stream with
`session`/`error`/`exit` events plus base64-UTF8 chunks (`:42-64`),
`POST input {sid,data}` (`:135`), `POST resize {sid,cols,rows}` (`:150`),
Bearer on all three. The app gates the tab on the `terminal` group and falls
back honestly (`terminal-screen.tsx:54-60`).

### Changes

1. **`gate/core/cli-environments/terminal.mjs`** (new) — ConPTY session
   manager: spawn/resize/write/kill, keyed by `sid`. Reuse the process patterns
   in `supervisor.mjs` and `windows-job.mjs`; non-Windows platforms get a
   `node-pty`-free `child_process` shell with a documented capability
   reduction, or 501 — decide explicitly, don't silently degrade.
2. **`gate/core/server.mjs`** — three routes, **plus three
   `isKnownAuthenticatedRoute` entries** (`:555-585`) or they 404 before
   reaching the handler. Prefer Gate-native paths
   `/v1/terminal/stream|input|resize` over inheriting the OpenClaw
   `/better-gateway/*` naming.
3. **App-side work is not zero** — audit §2b/§7 say "none", which is only true
   if the Gate serves the OpenClaw paths verbatim. Choosing Gate-native paths
   means updating **three** call sites in `src/lib/terminal/client.ts` (`:78`,
   `:142`, `:158`), each of which rebuilds `httpBase` independently. Extract
   that derivation while you are there. Reconcile the two documents on whichever
   path choice lands.
4. **`gate/core/manifest.mjs`** — `endpoints.terminal` plus
   `capabilities.terminal: true` when the platform can spawn a shell.
5. **`gate/__tests__/manifest-capabilities-advertised.test.mjs:38-44`** — the
   "must not be advertised" test names `terminal`. Note *why* it currently
   passes: that manifest is built with **no backends**, so `sessions`/`runs`/
   `approvals` are absent via `backendCan`, not by hard exclusion. If
   `terminal: true` is gated on *platform* (as step 4 says) rather than on a
   backend, this test fails on Windows. That is the tripwire working — but the
   fix is to settle the gating condition first, not to move the assertion.

### Tests

Session lifecycle (spawn → chunks → input → resize → exit → cleanup), auth
rejection without a token, 501 on unsupported platform, unknown-`sid` 404, and
an allowlist test per route. Then live: Shell tab on the running Gate.

---

## Phase 5 — Streaming chat through Hermes

**Goal:** token-by-token on backend turns, the most visible daily-use gap.

The mismatch (`backends/hermes.mjs:238-244`): the Gate's shape is
subscribe-then-send (`streamBackendTurn`, **`server.mjs:52`** — `:1021` is the
call site, which v1 cited by mistake); Hermes' is one POST that sends *and*
streams (`/api/sessions/{id}/chat/stream`).

### Changes

1. **`backends/hermes.mjs`** — replace the empty `streamEvents()` with
   `sendMessageStreaming(sessionId, {text, model})`: POST the stream endpoint,
   return the raw `response.body` reader. The send *is* the subscription; model
   it that way rather than faking a two-step handshake.
2. **`server.mjs` `streamBackendTurn` (`:52`)** — prefer `sendMessageStreaming`
   when the backend exposes it (start it and relay deltas as SSE); fall back to
   the current subscribe-then-send for the CLI backends. Relay, don't re-parse —
   the runs-events relay (`:719-726`) is the pattern. The existing
   `clientDisconnected` / `AbortController` wiring (`:63-67`) is the teardown
   hook to extend, not to reinvent.
3. Confirm the app's SSE delta handling needs nothing new — `streamChat` already
   consumes chat deltas on the Hermes direct path.

### Tests

Backend unit test with a mocked `fetchImpl` emitting a chunked stream; route
test asserting SSE framing and client-disconnect teardown (abort the upstream
reader when `res` closes — the leak to watch for).

---

## Phase 6 — Fix the capability denominator

**Goal:** the headline "N of 21" counts only capabilities that exist.

### Changes

1. **`src/lib/gateway/dashboard.ts:852-855,871-872`** — the six aspirational
   groups (`channels`, `plugins`, `logs`, `devices`, `artifacts`, `nodes`).
   Two options, pick per group: give it real match keys (pattern in-file at
   `:856-857`), or mark it undeclared. Note the six are not uniform:
   `channels`/`plugins`/`logs`/`devices` have `commandGroups` but no
   `features`/`endpoints`; `artifacts`/`nodes` have nothing at all.
2. **The status union is bigger than v1 assumed.** `GatewayCapabilityGroup` is
   declared in **two** places — `dashboard.ts:57` and `types.ts:318` — and the
   union already carries 11 members. Adding one means reconciling both
   declarations and updating every consumer that switches on it, at least
   `capability-hive.tsx:117` (`hiveColor`) and `gateway-capabilities.tsx:67`
   (`CapabilityPill`). Budget for that, and prefer a literal that does not read
   as absence (`'undeclared'` over `'undefined'`).
3. `buildCapabilitySnapshot` sets the new status when a def has neither match
   keys nor a registered instance family; the UI renders these separately or
   omits them from the count instead of showing "Not offered."

### Tests

`__tests__/capability-snapshot-test.ts`: undeclared groups excluded from the
ready/total figures; groups with new keys still resolve; every UI consumer
handles the new status (exhaustive-switch check).

---

## Phase 7 — Bots Tier 1 (conditional)

Only if the upstream-fork commitment is accepted (audit §4). Read-only
`GET /api/bots` over `runner.adapters` in Hermes, then a Gate front
(`GET /v1/bots`, manifest-advertised, **allowlisted**) so the app's source of
truth stays in code this repo owns. Tier 2 (runtime control) is a separate
decision; Tier 3 (config CRUD) stays rejected.

---

## Deliberately not in this plan

- `config`, `memory`, `voice` — off by Hermes' own feature flags, by design.
- `artifacts`, `nodes` — exist nowhere; Phase 6 stops them distorting the count.
- Server-side abort of Hermes session turns — correctly left throwing
  (`backends/hermes.mjs:183-186`); a fake cancel is worse than an honest throw.
- **Gateway history cursor (audit §6 / successor-plan C1)** — already shipped
  end to end, contrary to both documents. The Gate serves `before`/`limit` with
  `hasMore`/`nextBefore` (`server.mjs:785-820`), `getSessionMessagePage` threads
  the cursor (`manifest-client.ts:433-437`), and `loadEarlierMessages` prefers
  it, keeping the growing-limit refetch only as a documented fallback for
  gateways that do not report paging (`gateway-provider.tsx:647-688`). No work
  remains.

## Standing verification gates (every phase)

- `npm run verify` (config checks, tsc, lint, jest with ratchet, gate tests).
- `manifest-capabilities-advertised.test.mjs` stays green — **once Phase 0
  item 4 gives it real coverage.** As it stands its `backing` map exempts
  `tools`, `sessions`, `runs` and `approvals`, which is how the unbacked
  `tools: true` advertisement survived. Phases 0, 1 and 4 all extend it.
- An allowlist-vs-handler test (Phase 0 item 2) — the drift that silently
  disables a new route.
- Live pass against the running Gate for anything user-visible. **There is no
  existing convention for recording pass rates in `AGENTS.md`** — it is four
  lines about Expo docs. If one is wanted, establish it deliberately rather
  than citing it.
