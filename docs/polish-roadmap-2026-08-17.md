# Versutus Polish & Stability Roadmap — 2026-08-17

Status: **long-running living list**. Milestone context: end-to-end loop proven today
(gate connect → remote CLI environment start → task completion → streamed reply to phone).
This roadmap is what turns that working baseline into a luxury-minimal product.

Compiled from a full sweep of `src/`, `__tests__/`, and prior audit docs. Each item has
**Why** (impact) and **Fix** (recommended approach). Ordered by impact-per-effort.

---

## Tier 1 — Trust breakers (fix first; these silently corrupt the experience)

### 1.1 Unbounded message list in memory
- **Why:** Every send/delta appends to `messages` with no bound (`gateway-provider.tsx:1113,1254,1263`); only a history reload (limit 80) trims it. Long sessions grow the FlatList data unboundedly — jank, memory pressure, and eventual OOM on exactly the long-running agent tasks this app exists for.
- **Fix:** Cap the in-memory window (e.g. last 200 messages) with a "load earlier" prepend from persisted history. Same pattern already used for transcripts (`transcript.ts:27`), runs and events.

### 1.2 Partial streams never reconciled on reconnect
- **Why:** Mid-stream disconnect leaves a partial assistant bubble; `onHealthCheck` deliberately skips history reload on reconnect (`gateway-provider.tsx:670-675`), so partial text is never merged with gateway history — duplicates or gaps on the next reload. User sees a ghost message that disagrees with the session.
- **Fix:** On reconnect with an in-flight assistant message, mark it "interrupted" (distinct visual state, offer resume/retry) and reconcile against history on next reload by message/run id.

### 1.3 `executeRun` can report a false finish
- **Why:** If the SSE event stream closes while run status is unchanged, the loop breaks and reports a non-terminal status as final (`runs.ts:128-136`). Conversely a never-closing stream blocks until abort. Runs are the core remote-work primitive — misreporting "done" is a trust killer.
- **Fix:** Define terminal states explicitly; only exit on a terminal status or explicit abort; on unexpected stream close, poll the run status endpoint once before deciding.

### 1.4 Approval detection is regex string-matching
- **Why:** `/approv/i` on status/event types (`runs.ts:64-70`). A gateway wording change silently drops approval prompts — the single worst silent failure this app can have.
- **Fix:** Contract work with the gate/Hermes: typed approval signals (structured event type or status enum), keep the regex as fallback only. Update `docs/opencode-backend-contract.md`.

### 1.5 Reconnect policy drift between dialects
- **Why:** Hermes path uses `ConnectionMonitor` (jittered backoff, no cap); `openclaw-client.ts:345-349` has its own backoff with **no jitter** and no cap. Neither escalates reconnect → auto-connect retry after sustained failure, and the auto-connect retry loop re-probes forever every 12–30s (`gateway-provider.tsx:657,891,902,975`) — battery and thundering-herd concerns.
- **Fix:** Route both dialects through `ConnectionMonitor`; after N consecutive reconnect failures, escalate to auto-connect retry (which re-probes candidates); add an escalating cap with user-visible "sleeping" state and a manual reconnect affordance.

### 1.6 Small correctness leaks
- **Why (each):** `cancelCommand` doesn't abort in-flight work — transcript says cancelled, server keeps running, completion re-updates the message (`gateway-provider.tsx:1921-1931`). Abort detection is `message.includes('abort')` — conflates user cancel with any error mentioning "abort" (:1336). `clearTranscriptsForGateway` is an empty stub — deleting a gateway profile leaks its transcript keys forever (`transcript.ts:54-58`). `gatewayRequest` throws based on stale React `status` state — same-tick race on disconnect (:1014-1038).
- **Fix:** Send a real cancel RPC where the dialect supports it; typed abort reasons; implement transcript key cleanup on profile delete; track connection state in a ref consulted by request functions.

---

## Tier 2 — Luxury minimal (the "clunky and tab heavy" complaint)

### 2.1 Consolidate the setup/gateway information architecture
- **Why:** Biggest discoverability problems: `/gateway/setup` (the consolidated hub) is **not registered as a Stack.Screen** and reachable only from the Home dashboard button — Settings never links to it. `/gateway/capabilities` is buried 3+ taps deep (Home → Setup → Advanced → "Open capability editor"). `/gateway/providers` and `/gateway/environments` are redirect stubs still registered as titled modals (`_layout.tsx:100-119`). Discovery + gateway list are duplicated across Home, dashboard, and Settings (`settings.tsx:115-177`).
- **Fix:** One "Gateway" surface: register `/gateway/setup` properly, merge Settings' gateway management into it, delete the redirect stubs, promote capabilities to a first-class tab in the setup hub. Settings keeps only app-level preferences.

### 2.2 Chat sheet overload — one command surface
- **Why:** Chat orchestrates 8 separate sheets (approval, backend-picker, overflow, confirmation, message-actions, model-picker, pairing, session-selector — `chat-screen.tsx`, 429 lines). Sheet-on-sheet stacking is the main source of "clunky". Chat approval duplicates Activity's inline approval card.
- **Fix:** Consolidate pickers (session/model/backend) into a single contextual sheet driven by the composer; approvals live only in Activity (chat shows a compact banner that deep-links there); message actions fold into the overflow sheet. Target: 3 sheets max in chat.

### 2.3 Kill raw error text and `Alert.alert`
- **Why:** `lastError` is rendered verbatim in the chat banner, dashboard, and empty state — including dev-speak like "Cause: … Affected: … Next: …" (`chat-screen.tsx:189,224-234`; `gateway-home-dashboard.tsx:108-115`). Five `Alert.alert` call sites bypass the sheet/ErrorCard system entirely. Nothing says "not luxury" like a raw exception in a banner.
- **Fix:** Map known error classes to short human strings + one action (Reconnect / Open setup / Copy details for nerds); route everything through `ErrorCard`/sheets; delete all `Alert.alert` calls.

### 2.4 Route raw primitives through the UI kit
- **Why:** Solid token system (`constants/tokens.ts`) and 24-primitive UI kit exist, but raw `TextInput` in `activity.tsx:114`, `chat-composer.tsx`, `terminal-screen.tsx`, `approval-sheet.tsx`; raw `Switch` in `settings.tsx:48`; ~64 files carry per-screen `StyleSheet.create` with copy-pasted patterns (the `eyebrow` block alone is cloned across activity/settings/dashboard); some components import `Palette` directly instead of `useTokens`.
- **Fix:** Migrate to `TextField`/kit controls screen by screen (chat first, then settings, activity, terminal); extract the repeated eyebrow/hero patterns into kit components; enforce via lint or just delete the inline styles as screens get touched.

### 2.5 Unify the Home fork
- **Why:** `index.tsx` is a hard fork between "no gateway" and "dashboard" with duplicated status/pairing/discovery UI — two layouts to maintain, and the transition between them is jarring.
- **Fix:** Single dashboard where the empty state *is* the dashboard with a connect CTA in the hero slot; pairing/troubleshooting become sheets off the hero card.

### 2.6 Channel/slash-command discoverability
- **Why:** Channel repair only appears when degraded; `/channel …` and other slash families are chat-only with no UI entry. Slash suggestions exist in the composer but there's no browsable command reference.
- **Fix:** Slash-command palette (type `/` → filtered sheet with descriptions from the manifest); channel status as a persistent, subtle row on the dashboard, not only-when-degraded.

### 2.7 Model picker: collapse by provider
- **Why:** The picker renders one flat `FlatList` of every model the gateway knows (`model-picker-sheet.tsx:132-138`) — a gigantic, unscannable list once multiple providers are registered. Models already carry `provider`/`providerId`; the grouping data exists but is unused.
- **Fix:** Group into collapsible provider sections (SectionList or flat list with section headers + expanded state): provider header with count, current model's group auto-expanded, others collapsed by default. Keep per-model cards as-is inside sections.

### 2.8 Capabilities derived from the selected backend/CLI — comprehensively
- **Why:** Today the app's capability surface is mostly **hardcoded Hermes-RPC assumptions**: 51 static slash commands (`dashboard.ts:66+`), `capabilitiesForBackend` collapsing every backend to `{sessions, tools}` (`backend-capabilities.ts:16-27`), chat approvals wired only to Hermes runs, and the model catalog fetched gate-wide instead of per-backend. Meanwhile the gate's machinery for the real thing already exists but is unused: kind-declared `commands`→manifest plumbing (`registry.mjs:159-187`), adapter `operations` with JSON schemas (never serialized into the manifest), and normalized `approval.required`/`usage`/`diagnostic` backend events that the SSE relay **drops on the floor** (`server.mjs:52-119`). Result: most of what a backend/CLI can actually do is missing or not cleanly usable in chat.
- **Fix (multi-phase contract + UI work):**
  1. Gate: `backend-manager.describe()` serializes per-backend `operations` (schema-bound), declared slash commands, approvals flag, and tool catalog; manifest `backends[]` carries them (`portal/manifest.ts` `GatewayBackend` type extended to match).
  2. Gate: SSE relay emits typed frames for `approval.required` / `usage` / `diagnostic` instead of dropping them; `ManifestClient` gains `replyApproval`/typed event handling.
  3. App: `capabilitiesForBackend` returns the full per-backend record; chat re-derives its surfaces on backend selection — slash palette from the backend's declared commands (hardcoded list shrinks to gateway-local only), model picker via `GET /v1/models?backendId=`, approvals rendered through the existing ApprovalSheet from typed events (this also replaces roadmap 1.4's regex), composer availability per-backend instead of gate-wide union.
  4. `environment-run-launcher.tsx:105` stops hardcoding `['prompt','status']` and renders from adapter `operations` schemas.

### 2.9 QoL sweep (small, high-feel fixes)
- **Why (each):** "Gateway down" local notification is never dismissed on recovery and there's no reconnect-success signal (`gateway-provider.tsx:648-651`). Terminal can open on a dead shell with only a silent fallback (`terminal-screen.tsx:49-55`). Reachability probes run sequentially — 1.8s × N gateways per wave (`use-gateway-reachability.ts:59-107`). Onboarding and `/gateway/add` are two overlapping URL+token flows.
- **Fix:** Dismiss the down-notification on reconnect (optionally replace with a transient "reconnected" toast); surface unsupported-shell as a proper EmptyState with a switch-to-RPC action; parallelize probes with a small concurrency cap; merge onboarding into the add flow (onboarding = add + first-run framing).

---

## Tier 3 — Engineering foundation (enables everything above)

### 3.1 Test the provider/streaming seam
- **Why:** 34 Jest suites cover `src/lib` well, but `gateway-provider.tsx` — the 2146-line state machine that is the riskiest file in the app — plus all hooks, screens, SSE parsing in `client.ts`, and the OpenClaw client/adapter have **zero** coverage. Every Tier 1 fix lands in exactly this untested zone.
- **Fix:** Extract pure reducers from `gateway-provider.tsx` (connection state, message list, run lifecycle) and unit-test those; add SSE chunker tests for `client.ts`. Don't test the React wiring — test the extracted logic.

### 3.2 Live verification debt
- **Why:** `smoke:gateway-commands` was 0/18 against a live gateway (`roadmap-capability-ui-overhaul.md` M6); handoff §6.2–6.4 noted live acceptance had never run. Today's milestone closes the conversation loop, but the command map and provider child-sync remain unproven live — the largest *unverified claims* in the project.
- **Fix:** Re-run `smoke:live` and `smoke:gateway-commands` against the now-working gate; fix or delete each failing command mapping; make the smoke part of the pre-release checklist in AGENTS.md/CI.

### 3.3 Split `gateway-provider.tsx`
- **Why:** 2146 lines mixing connection lifecycle, chat, commands, runs, sessions, and the offline outbox. It accrues every bug class found in Tier 1 and blocks confident refactoring.
- **Fix:** After 3.1's reducers exist, split into per-domain hooks/modules (`useConnection`, `useChat`, `useRuns`, outbox) behind the same provider facade. Mechanical, test-guarded.

### 3.4 Cleanup residue
- **Why:** `dist/` build output sits at repo root (verify whether intentionally committed — it bloats every clone and greps); dev-only `/dev/preview` still labeled "PHASE 0"; vestigial platform re-export files (`chat.tsx`/`chat.android.tsx` etc.) remain "so platforms cannot diverge again" but add navigation noise.
- **Fix:** Gitignore/remove `dist/` if not intentional; retitle or gate the preview lab; collapse the thin re-export files once metro/typed-routes config allows.

---

## Tier 4 — Strategic (queued, not now)

- **True push / relay delivery (Phase D)** — run completion and approvals when the app is backgrounded or offline. Currently local notifications only while connected; `notifyGatewayDown` is never dismissed on recovery. Big architecture; revisit after Tier 1.
- **TLS fingerprint TOFU verification** — fingerprint is displayed as "observed, not verified" (C6.16 descoped in M5). Verify-on-first-use pinning closes the MITM gap on LAN discovery.
- **Hermes `WinError 64` watchdog (upstream)** — server accept-loop dies silently; client cannot recover. Needs an upstream fix or supervisor; document the failure mode in-app until then.
- **Light theme** — `useTokens` is an intentional fixed-dark stub. Postpone until dark mode is truly polished; half a light theme would undercut the luxury goal.
- **Fleet view** — multiple gateways at once. Activity's `AgentTargets` switcher covers the 90% case for now.

---

## Suggested execution order

1. Tier 2.7 (model picker provider grouping) — immediate visible win, self-contained.
2. Tier 1.1–1.3 (message bound, stream reconcile, run terminal states) — one focused pass on the chat/run pipeline.
3. Tier 3.1 (extract + test reducers) — de-risks everything after.
4. Tier 2.1–2.3 (IA consolidation, sheet reduction, error humanization) — the visible "luxury minimal" jump.
5. Remaining Tier 1, Tier 2.4–2.6, 2.9, Tier 3.2–3.4 in parallel as screens get touched.
6. Tier 2.8 (backend-derived capabilities) as its own contract-first phase; then Tier 4.
