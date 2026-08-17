# Hardening & Capability Plan — 2026-08-17

Successor to `polish-roadmap-2026-08-17.md`. That roadmap diagnosed the codebase;
this plan **locks in what landed today** and pushes into quality-of-life and new
capability.

Same format: **Why** (impact) and **Fix** (approach), ordered by impact-per-effort.

---

## What landed today (the success being hardened)

End-to-end loop proven (gate connect → remote CLI environment → task → streamed
reply to phone), plus this session's Tier 1 pass:

| Item | State |
|---|---|
| 1.1 Unbounded message list | **Fixed** — `boundWindow`/`appendBounded`, cap 200, all 4 growth sites |
| 1.3 `executeRun` false finishes | **Fixed** — terminal-only exit, re-poll on early stream close, `unresolved` outcome |
| 1.4 Approval regex | **Fixed** — typed `approval.required` first, loose match as fallback |
| 1.6a Transcript leak | **Fixed** — real cleanup + wired into `deleteGateway` incl. cascaded children |
| 1.6b Abort misclassification | **Fixed** — `isUserAbort` on the signal, never on message text |
| Model picker grouping | **Kept** (Kimi's work, verified) |

Verification at time of writing: **38 jest suites / 243 tests**, **390 gate tests**,
`tsc --noEmit` clean, `eslint` clean on all touched files.

### Corrections to the polish roadmap

Verified against the repo — three of its claims have moved:

- **`dist/` is not committed.** `git ls-files dist` returns 0 files and `dist/` is
  in `.gitignore`. Tier 3.4's lead concern is already resolved; drop it.
- **CI already exists.** `.github/workflows/ci.yml` runs typecheck, lint, `npm test`
  (which chains gate tests) and `smoke:portal` on PRs. The gap is *coverage of the
  provider seam* and *live smoke*, not CI itself.
- **The approval regex was worse than described.** `/approv/i` also matches
  `approved` and `approval.resolved` — states reported *after* the user decides —
  so it re-opened the approval prompt for a settled decision and could spin the run
  against its 120-iteration poll cap. Not just a wording-drift risk; an active loop.

---

## Part A — Harden (do first)

### A1. Extract pure reducers from `gateway-provider.tsx` *(was Tier 3.1 — now the keystone)*
- **Why:** Every remaining Tier 1 item (1.2 stream reconcile, 1.5 reconnect drift,
  1.6c/d) lands inside the 2146-line provider, which still has **zero** test
  coverage. Today's fixes were all made in `src/lib/*` precisely because that is
  the testable zone; the provider wiring around them is still unverified. Doing
  1.2/1.5 before this means unverifiable edits to the riskiest file in the app.
- **Fix:** Extract three pure modules with unit tests, leaving the provider a thin
  wiring shell: `connection-reducer` (phase/status/retry escalation),
  `message-reducer` (append/patch/bound/reconcile), `run-reducer` (lifecycle incl.
  the new `unresolved` state). Do not test React wiring — test the extracted logic.
- **Status: done, scoped to the decision logic, not a full useReducer rewrite.**
  `message-reducer` and `run-reducer` were effectively already done earlier tonight
  (`messages.ts`, `runs.ts`). The new piece is `decideConnectionPhase` in
  `src/lib/connection/phase.ts` — the actual phase-transition decision table
  (given the phase before a status event and the status it just reported, what's
  the next phase, and which side effects — clear the retry timer, clear the down
  notice, clear last error, notify gateway-down, schedule a retry — does the
  caller own), pulled straight out of the `onStatus` handler and covered by 7
  tests. The provider's `onStatus` now calls it and applies the returned flags;
  every other `setConnectionPhase(literal)` site was mechanically renamed to a
  new `applyConnectionPhase` that mirrors the `statusRef`/`applyStatus` pattern
  from the A5 race fix — updating a ref synchronously alongside the state, not via
  a `useEffect` a render behind. That closes a real, if narrow, staleness window:
  previously only the `disconnected` branch's functional-updater form saw the
  true current phase inside the same tick; every direct-value call site left
  `connectionPhaseRef` stale until the next render's effect flushed.
  **Deliberately not done:** rewriting the ~19 call sites' surrounding async
  orchestration (retry timer scheduling, auto-connect probing) into the reducer,
  or moving connection state into a single `useReducer`. That's real remaining
  scope, but it's the part that needs live-device verification to change safely
  — the decision table and the ref-sync bug were both safely verifiable by test
  alone, which is why they're what shipped tonight.

### A2. Regression-lock today's fixes at the seam
- **Why:** `runs.ts`, `messages.ts` and `errors.ts` are now covered, but nothing
  asserts the provider *uses* them correctly. A future refactor can silently
  reintroduce an unbounded append or restore text-matching aborts.
- **Fix:** Once A1 lands, assert through the reducers: an `unresolved` outcome
  produces an `unresolved` card (never `complete`); streamed deltas never grow the
  list past `MESSAGE_WINDOW_CAP`; a non-abort error keeps the assistant bubble.

### A3. One-command local verification
- **Why:** Contributors (and agents) currently have to know to run three commands;
  CI runs a different set than anyone runs locally, so drift is discovered late.
- **Fix:** Add `"verify": "tsc --noEmit && npm run lint && npm test"` to
  `package.json` and call it from CI so local and CI run the identical gate. Add a
  coverage floor for `src/lib/gateway` once A1 raises it meaningfully.

### A4. Close the live-verification gap *(was Tier 3.2)*
- **Why:** `smoke:gateway-commands` was 0/18 against a live gateway and live
  acceptance has never run. This is the **largest unverified claim in the repo** —
  and it is now cheap, because the gate demonstrably works end to end.
- **Fix:** Run `smoke:live`, `smoke:gateway-commands`, `smoke:providers`,
  `smoke:environments` against the running gate. Fix or *delete* each failing
  command mapping — a mapping that has never worked is worse than an absent one.
  Record the pass rate in `AGENTS.md` as a pre-release checklist item.
- **Status: done, and it found two real, pre-existing CI bugs.**
  - **`npm run smoke:portal` — required by CI on every PR — has been silently red
    since 2026-08-05.** Commit `37ff32b` correctly removed `model.options` from
    `METHOD_TO_ROUTE` (a phantom route that 404s against Hermes 0.18.0) but never
    updated the smoke assertion that tested for it. Commit `56489d6` correctly
    reordered `buildGatewayCandidates` to prefer Gate's port 8760 ahead of
    Hermes's 8642, but the assertion still expected the old order. Both fixed;
    `smoke:portal` is now ALL PASS.
  - **`smoke:gateway-commands` was 0/18 for an unrelated reason to what the
    roadmap assumed.** It shelled out to the separate `openclaw` npm CLI's
    `gateway call` subcommand — a different product's daemon/handshake protocol
    entirely — which hung indefinitely against this repo's bespoke gate. That
    was never a mapping bug; it was the wrong transport. Rewrote it
    (`smoke-gateway-commands.mts`) to call `resolveRoute` from
    `rpc-routes.ts` directly over HTTP, the exact path `client.rpcRequest`
    takes app-side, so it can never drift from what the app does and needs no
    external CLI. It also now identifies the gateway's kind and distinguishes
    three outcomes instead of one flat pass/fail: a genuinely missing mapping
    (real bug), a method this Hermes dialect documents as unsupported by design
    (`METHOD_GUIDANCE`), and a Hermes-only route 404ing against a non-Hermes
    gate (expected — the app's capability snapshot gates these off before a
    slash command can reach them; confirmed `gate/core/server.mjs` implements
    only `/health` of the four Hermes paths this smoke test probes). Against the
    locally running gate: 2 passed, 12 unsupported by design, 4 Hermes-only on a
    non-Hermes gate, **0 failed**.
  - `smoke:live` and `smoke:providers` and `smoke:environments` all pass clean
    against the running gate (777 models, 5 sessions, full capability snapshot).

### A5. Finish the Tier 1.6 correctness leaks
- **Why:** Two remain. `cancelCommand` updates the transcript to "cancelled" but
  never aborts in-flight work — the server keeps running and the completion
  re-updates the message the user believes they cancelled. `gatewayRequest` throws
  based on stale React `status` state, a same-tick race on disconnect.
- **Fix:** Send a real cancel/abort where the dialect supports it (reuse the
  hoisted `abortController`); track connection state in a ref that request
  functions consult instead of rendered state.
- **Status:** `cancelCommand` is **done** — it now aborts both the fetch stream
  and any in-flight agentic run via a tested `abortAndClear` helper
  (`src/lib/gateway/abort.ts`), which also replaced the three hand-rolled copies of
  that teardown in `stopStreaming` and `stopActivityRun`.
- **Status:** the stale-`status` race is **done** for the three sites that throw
  *after* work is in flight — `gatewayRequest`, `gatewayFetch` and the slash-command
  execution guard now read a `statusRef` kept in step synchronously by
  `applyStatus`, instead of a value captured at last render. This also drops
  `status` from the first two callbacks' deps, making them stable and shrinking
  context-value churn.
- **Remaining:** five pre-flight guards (`gateway-provider.tsx` ~1093, 1412, 1551,
  1697, 1984) still read rendered `status`. Left deliberately — a stale read there
  only declines an action the user can retry, and converting the effect-bound ones
  changes when those effects re-run. Revisit under A1, where the connection reducer
  makes it provable rather than a judgement call. Also still open: asking the
  gateway to stop a command server-side (today's fix stops the local driver).

---

## Part B — Quality of life

### B1. "Load earlier" to pair with the message cap ⚠️ *ships with A1*
- **Why:** **This is a debt today's fix created.** Capping the window at 200 stops
  the OOM, but there is no way to see turn 201 — it silently vanishes, and history
  reload only fetches 80. The cap is correct; the missing affordance is not.
- **Fix:** A `prependEarlier` helper (pure, testable) plus a "Load earlier" row at
  the top of the chat list that pages back through gateway history.
- **Status:** `prependEarlier` is **done and tested** (dedupes by id, returns the
  same reference on full overlap, deliberately does not re-apply the cap).
- **Blocker found — the API cannot page backwards.** `getSessionMessages(sessionId,
  limit)` accepts *only* a limit; there is no offset, cursor or `before` parameter,
  so "give me the 80 turns before this one" is not currently expressible. Two ways
  out, pick one before building the UI:
  1. **Client-only (no gateway change):** keep a `historyLimit` that grows by a page
     each tap, refetch with the larger limit, and `prependEarlier` the newly
     revealed older turns. Simple, but refetches the whole window each time and
     cannot page past whatever ceiling the gateway enforces.
  2. **Gateway change (correct):** add `before`/`cursor` to
     `/api/sessions/{id}/messages` and thread it through the client. More work,
     but the only option that scales and the one worth doing if sessions get long.
- **Status: done, option 1 (client-only).** `hasEarlierHistory` (tested — a page
  shorter than requested means the beginning of the session is reached) plus
  `prependEarlier` back `loadEarlierMessages` in the provider: it grows a ref-held
  limit by `HISTORY_PAGE_SIZE` (80) per tap, re-fetches, and prepends only the
  newly-revealed older messages. Guarded against a stale response racing a fresh
  `reloadHistoryFor` via the same `historyRequestRef` generation check every other
  history path already uses. Wired into `chat-screen.tsx` as a "Load earlier
  messages" row above the list, shown only while `hasMoreHistory` is true. Not
  visually verified for the same reason as C3 — no running app to screenshot
  tonight; covered by unit tests + typecheck + lint. Option 2 (gateway cursor)
  remains open if a client ever needs history beyond what re-fetching-with-a-
  bigger-limit can reasonably cover.

### B2. Humanize errors and delete `Alert.alert` *(was Tier 2.3)*
- **Why:** `lastError` renders verbatim in the chat banner, dashboard and empty
  state — including dev-speak like "Cause: … Affected: … Next: …". Five
  `Alert.alert` sites bypass the sheet/ErrorCard system. Nothing reads less
  "luxury" than a raw exception in a banner.
- **Fix:** Now much cheaper: `GatewayHttpError`, `isAuthRejection`,
  `isGatewayTokenRequiredMessage` and the new `isUserAbort` already give typed
  classes. Map each to a short human string + exactly one action (Reconnect /
  Open setup / Copy details), route through `ErrorCard`, delete every `Alert.alert`.

### B3. Consolidate the gateway surface *(was Tier 2.1)*
- **Why:** `/gateway/setup` is not registered as a `Stack.Screen` and is reachable
  only from the Home dashboard button; capabilities sit 3+ taps deep; two redirect
  stubs are still registered as titled modals. Discoverability is the top structural
  complaint.
- **Fix:** Register `/gateway/setup`, fold Settings' gateway management into it,
  delete the redirect stubs, promote capabilities to a first-class tab there.

### B4. Slash-command palette *(was Tier 2.6)*
- **Why:** `slash-commands.ts` is 1711 lines of capability with no browsable entry
  point — the richest surface in the app is invisible unless you already know it.
- **Fix:** Type `/` → filtered sheet with descriptions sourced from the manifest.

---

## Part C — Capability

### C1. Interrupted-stream resume *(productizes Tier 1.2)*
- **Why:** A mid-stream disconnect leaves a partial assistant bubble that never
  reconciles, because `onHealthCheck` deliberately skips history reload on
  reconnect. The user sees a ghost message that disagrees with the session.
- **Fix:** Mark the in-flight message `interrupted` (distinct visual state) and
  reconcile against history by message/run id on next reload, offering resume/retry.
  Needs A1's message reducer.

### C2. Settle unresolved runs on reconnect
- **Why:** Today's `unresolved` outcome is honest but terminal in the UI — it tells
  the user "unconfirmed" and stops. The run may well have finished on the gateway.
- **Fix:** On reconnect, re-poll any run left `unresolved` and settle it to its real
  terminal state. Turns a defensive state into a self-healing one.

### C3. Model picker search
- **Why:** Kimi's provider grouping helps, but catalogs run to hundreds of models
  (`kilo` alone is 358) — collapsing groups is not enough to find one by name.
- **Fix:** A filter field above the section list, matching id and provider.
- **Status:** **Done.** `filterModels` (tested, in `model-selection.ts`) matches id,
  provider name and provider id case-insensitively and returns the same reference
  for an empty query. Wired into the picker with a "No matches" empty state, and
  **all groups auto-expand while a query is active** — otherwise a match stays
  hidden inside a collapsed section. The field is hidden when the catalog holds
  one model or none.
- **Not visually verified:** the sheet is behind a connected gateway and an open
  chat, so it is covered by unit tests on the filter plus typecheck/lint on the
  wiring, not by a screenshot. Worth an eyeball next time the app is running.

### C4. TLS fingerprint TOFU verification *(Tier 4, unchanged)*
- **Why:** The fingerprint is shown as "observed, not verified" — the MITM gap on
  LAN discovery is still open.
- **Fix:** Verify-on-first-use pinning, with an explicit change-detected prompt.

---

## Execution order

1. **A1** reducers → immediately unblocks 1.2, 1.5, A2, B1, C1.
2. **B1** load-earlier — pays off the debt this session created.
3. **A2** regression locks, **A3** one-command verify.
4. **A4** live smoke — cheap now, and retires the biggest unverified claim.
5. **A5** remaining correctness leaks.
6. **B2 → B3 → B4** the visible luxury jump.
7. **C1 → C2 → C3**, then C4 as a dedicated phase.
