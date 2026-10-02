# Failure audit 2026-10-01 - round 3: provider errors, speed, drawer

Round 3 came from the operator's own report (phone screenshots, 2026-10-01), not from a code scan. Three areas, in the operator's priority order:

1. **Provider errors.** In Hermes threads: `Unknown provider "kilo"`, `Unknown provider "opencode-go-session"`, and `chat failed: 400 ... The model provider behind this chat refused it (400)` for `opencode-go/deepseek-v4.1-flash`. In OpenCode threads: the operator's own words glued in front of the reply (`Hey budHey! What are we working on?`), `New session opened. Was opencode-go/mimo-v2.6-pro, now opencode-go/mimo-v2.6-pro.`, and a free model failing after five minutes with `could not reach http://127.0.0.1:4096/session/.../message (Headers Timeout Error)`. The operator also suspected the Hermes provider catalogue needed cleaning.
2. **Speed and latency.** "Sitting and waiting on the app to load screen after screen is excruciating." The phone also disconnects from Tailscale often.
3. **Responsiveness.** The left drawer is often laggy or slow to start opening - with the hard constraint that nothing about its look or animation may change.

## Decisions the operator made before the round started

| Question | Decision |
|---|---|
| Model catalogue | Auto-curate: offer only models that can run - hide unauthenticated, duplicate and broken providers; health from real turns only, no probes that burn quota |
| Hermes's 6.2 GB `state.db` | The Gate keeps its own session index; Hermes's data is not touched |
| Network | Fix Tailscale first (router port-forward, Android battery settings, server-side speedups); revisit alternatives only if drops continue |
| Extras | Delete the old `state.db.pre-update-emergency-*` backups (the operator runs the delete; ~18 GB) |

## What was measured on the live host (2026-10-01)

| Measurement | Result | What it meant |
|---|---|---|
| A Hermes-thread turn after any reconnect | Request body had no `backendId`/`bot`, only `providerId: "kilo"` | The rebuilt app client had lost the thread's environment, so the turn went to the Gate's own provider list (SCOPE-1) |
| Gate's own providers | `my-openai`, `nvidia`, `opencode-go`, `opencode-zen` | `kilo`/`opencode-go-session` exist only in Hermes, hence 404; the Gate's own `opencode-go` lacks the `x-opencode-session` header OpenCode Go now requires, hence the 400 |
| Hermes `/api/model/options` | 55 providers, 42 not signed in (0 models), 3.9 s per read | `kilo` (user-config, aliases `kilocode`) shadows built-in `kilocode`; `opencode-go-session` (user-config) shadows built-in `opencode-go` (30 of 42 models overlap); image/audio models listed as chat models (CAT-*) |
| `GET /v1/models` | 1,154 rows, 241,473 bytes, 3.7 s, uncompressed | NET-1, CAT-4 |
| `GET /v1/sessions?backendId=hermes-local&limit=50` | 3.0 s warm; 30 s timeout (502) cold; Hermes alone 38.5 s cold | The Gate's 30 s bound meant a cold list could never load (SPD-1/2) |
| Bot session lists / any session's messages | 0.4-3.3 s / ~0.1 s | Session lists, not message reads, are the slow screens |
| Gate log `auth refused ... no authorization header` | 88 lines since 2026-09-27, from the phone's tailnet IP, in connect-shaped bursts | A token-less duplicate gateway profile was being created and connected (AUTH-1) |
| `tailscale ping ethans-a54` (phone on home Wi-Fi) | Direct path (`192.168.1.235`), 3 ms to 1.2 s; plain LAN ping 3-118 ms | The tunnel is direct at home; the swings come from the phone's power saving, which is the operator's Samsung settings step |
| `tailscale netcheck` | UDP yes, no UPnP/PCP/NAT-PMP, `MappingVariesByDestIP: false` | Away from home a direct path is likely but not guaranteed; the router port-forward (operator step) makes it reliable |

## How the round was run

Seven work packages, each written by a free `opencode` model (`opencode/space-bunny-free`) in its own worktree behind a harness it cannot edit (tsc, eslint, verify-config, jest, Gate tests), then reviewed by a separate free-model session that traced the real code path. Every package that failed review was sent back with the reviewer's findings; one package (R3A1) was restarted with the integrator's own root-cause trace after two unproductive attempts, and the last review round of R3P2 was repaired by the integrator directly. Packages landed one commit each on branch `claude/round3-providers-speed`.

## Findings

Totals: **17 fixed**, **1 fixed in part**, **0 not fixed**.

| Finding | Area | Sev | Status | Package | Commit |
|---|---|---|---|---|---|
| [SCOPE-1](#scope-1) | Provider errors | S1 | Fixed | R3P1 | `3b21e87` |
| [SCOPE-2](#scope-2) | Provider errors | S2 | Fixed | R3P1 | `3b21e87` |
| [SCOPE-3](#scope-3) | Provider errors | S2 | Fixed | R3P1 | `3b21e87` |
| [OCB-1](#ocb-1) | Provider errors | S2 | Fixed | R3P3 | `c717daa` |
| [OCB-2](#ocb-2) | Provider errors | S2 | Fixed | R3P3 | `c717daa` |
| [OCB-3](#ocb-3) | Provider errors | S3 | Fixed | R3P3 | `c717daa` |
| [CAT-1](#cat-1) | Provider errors | S2 | Fixed | R3P2 | `4e8f5e9` |
| [CAT-2](#cat-2) | Provider errors | S2 | Fixed in part | R3P2 | `4e8f5e9` |
| [CAT-3](#cat-3) | Provider errors | S3 | Fixed | R3P2 | `4e8f5e9` |
| [CAT-4](#cat-4) | Provider errors | S2 | Fixed | R3P2 | `4e8f5e9` |
| [CAT-5](#cat-5) | Provider errors | S3 | Fixed | R3P2 + integrator | `4e8f5e9`, `9df4acb` |
| [SPD-1](#spd-1) | Speed | S1 | Fixed | R3S1 | `538fa94` |
| [SPD-2](#spd-2) | Speed | S2 | Fixed | R3S1 | `538fa94` |
| [NET-1](#net-1) | Speed | S2 | Fixed | R3S2 | `481c888` |
| [AUTH-1](#auth-1) | Speed / connect | S1 | Fixed | R3A1 | `c013d0a` |
| [DRW-1](#drw-1) | Responsiveness | S2 | Fixed | R3D1 | `78f13d5` |
| [DRW-2](#drw-2) | Responsiveness | S2 | Fixed | R3D1 | `78f13d5` |
| [DRW-3](#drw-3) | Responsiveness | S3 | Fixed | R3D1 | `78f13d5` |

## Diagnosis and fix per finding

### SCOPE-1
*Provider errors - package R3P1*

**Status:** Fixed (commit 3b21e87)
**What the operator saw:** In a Hermes (`hermes-local`) thread, turns started failing with the Gate's own provider errors - `Unknown provider "kilo"`, `Unknown provider "opencode-go-session"` - or a 400 from a vendor that was never meant to serve the model, even though the same models had worked in Hermes before.
**Diagnosis:** CONFIRMED. `attachClient` (`src/context/gateway-provider.tsx`) built a brand-new client via `createClientForKind(...)` and installed it with `clientRef.current = client`, and nothing re-applied the thread's scope to it: `setBackendId`/`setBotId` are the client's own state and were only set by `selectBackend`, the first-adoption effect and `openBot`, while `selectedBackendId`/`selectedBotId` live in provider state and survive a rebuild. So after any re-attach the UI still showed the Hermes thread but the new client sent no `backendId`, no `bot`, no `sessionId`, and fell back to `providerId: 'kilo'` (which `streamChat` in `src/lib/gateway/manifest-client.ts` fills in from `gateway.providerId`).
**Fix:**
- New pure module `src/lib/gateway/client-scope.ts`: `gatewayScopeKey(gateway)` (parent id when there is one) and `scopeForAttach(...)` -> `{ backendId, botId, reset }`, so the keep-or-drop decision is testable on its own.
- `applyClientScope(client, gateway)` in the provider reads `selectedBackendIdRef`/`selectedBotIdRef` and calls `client.setBackendId?.(...)` / `client.setBotId?.(...)`.
- It runs once, right where the client is created, before `clientRef.current = client` and before `client.connect()`, so it precedes the install on every path (reconnect, Retry, resume, gateway switch, late-manifest upgrade). `attachClient` is otherwise untouched; only its `useCallback` dep list grew.
- A scope with no recorded owner is kept rather than reset - incomplete bookkeeping is not evidence the operator's thread moved, and stranding a live thread is the worse failure.
**What you'll notice:** Turns keep working in your Hermes thread after the phone's connection drops and comes back, instead of suddenly reporting an unknown provider.
**Tests:** New `__tests__/client-attach-scope-test.ts` (9 tests) covers the pure decision, including same-Gate keeps backend+bot and a child profile of the scope's own Gate. New `__tests__/gateway-provider-client-scope-test.tsx` (5 tests) drives the real provider with a mocked `@/lib/portal/adapters` and asserts the *new* client instance got `setBackendId('hermes-local')` / `setBotId('scout')` before its first send, and that the rebuilt client's turn names the environment instead of a provider. Red proof: deleting the single `applyClientScope(client, gateway)` call and re-running gave 5 failed / 5 total; restored.
**Review:** passed review first time
**Residual:**
- The scope's owner is only recorded where the scope is set today (`selectBackend`, the adoption effect, `openBot`, the bot reset). A future path that sets it another way would leave the owner unknown, and the scope would be kept rather than reset - the deliberately safer direction, documented in `client-scope.ts`.

### SCOPE-2
*Provider errors - package R3P1*

**Status:** Fixed (commit 3b21e87)
**What the operator saw:** The same thing from the other side - switching to a different gateway risked leaving the previous gateway's Hermes environment and Bot attached to the new gateway's thread.
**Diagnosis:** CONFIRMED. `selectedBackendId`/`selectedBotId` were never reset on a gateway switch (`setSelectedBackendId(` is called only from `selectBackend` and the adoption effect), and nothing recorded which Gate the scope belonged to. Once SCOPE-1 starts handing the scope to each new client, gateway A's `hermes-local` and Bot would otherwise land on gateway B's client.
**Fix:**
- New ref `scopeGatewayKeyRef` plus `rememberScopeGateway(gateway)` in `src/context/gateway-provider.tsx`, written wherever the scope is set: `selectBackend`, the first-adoption effect, `openBot`, and the bot reset / `clearBot`.
- `applyClientScope` on a different Gate returns `reset: true`, which clears `selectedBackendId`/`selectedBotId` state *and* refs and hands the new client `undefined` for both, then records the attaching gateway as the owner.
- With state back to `undefined`, the existing adoption effect resolves gateway B's own default through the unchanged `resolveDefaultBackend(backends, gateway.backendId)`. Same-Gate attaches keep the scope untouched.
- The adoption effect now also mirrors the resolved backend into `selectedBackendIdRef` immediately, not only on the next commit, because an attach that installs a client mid-tick reads that ref to hand the scope over.
**What you'll notice:** Switching gateways gives you that gateway's own environment and no leftover Bot from the one you left.
**Tests:** The pure helper's "a different gateway drops both and reports the reset" case, plus the bot-only and nothing-remembered cases. The provider test `gateway A's environment and Bot are not carried onto gateway B's client` mounts on A with `hermes-local`, opens Bot `scout`, calls `connectGateway(beta)`, and asserts B's client got no Bot, `selectedBotId` is `undefined` afterwards, and B's own turn names the environment resolved from B's manifest with no Bot. Covered by the same revert proof as SCOPE-1.
**Review:** passed review first time
**Residual:** none

### SCOPE-3
*Provider errors - package R3P1*

**Status:** Fixed (commit 3b21e87)
**What the operator saw:** `kilo/kilo-auto/free` in a Hermes thread came back as `Unknown provider "kilo"` - a hard error from the Gate - instead of reaching Hermes.
**Diagnosis:** CONFIRMED. In `gate/core/server.mjs` `/v1/chat/completions`, a body with no `backendId` and no `bot` but a `providerId` went straight to `dispatchChat(body.providerId, ...)`, which answers 404 `unknown_provider` for an id the Gate holds no record of. The Gate never asked its attached environments, although `/v1/models` already aggregates every environment's `listModels()` and Hermes files ids as `${providerId}/${modelId}`. Older APKs in the field keep sending exactly this turn.
**Fix:**
- New `gate/core/backend-model-route.mjs`: `qualifiedModelId(model, providerId)` builds the id an environment files the model under (the model itself when already `${providerId}/`-prefixed).
- `pickBackendForModel(backends, catalogues, qualified)` is the pure selection - an `available !== false` row beats an unavailable one, then the `hermes` kind/adapterId, then `backendManager.list()` order (stable sort).
- `createBackendModelRouter` owns the cache: per-backend catalogue for 60 s (`CATALOGUE_TTL_MS`), each read bounded at 5 s (`CATALOGUE_READ_TIMEOUT_MS`), and a read that fails, hangs or returns a non-array is cached as "serves nothing" so a slow environment or a retry storm cannot hold a turn open.
- In `server.mjs`, `modelRouter` is built once per Gate over `backendManager.list()`; the handler asks it only when the body names no `backendId`, no Bot, and a `providerId` that `gateOwnsProvider(providerId)` says the Gate does not hold (same two sources `dispatchChat` resolves: the `providerStore` record and the legacy `state.providers` entry).
- The backend branch is not duplicated: its condition became `body.backendId || botForTurn || routedBackendId` and `resolveConversationBackend(body.backendId || routedBackendId, botForTurn)` is the same call, so a routed turn runs identical code.
- The 404 keeps `code: 'unknown_provider'` and now reads `Model "<model>" is not on this Gate's providers or any of its environments. Pick another model.`
**What you'll notice:** If an old app build sends a turn without naming its environment, the Gate still gets it to Hermes instead of refusing it with an unknown-provider error.
**Tests:** New `gate/__tests__/backend-model-route.test.mjs` (10 tests) in the style of `backend-routes.test.mjs`/`hermes-scope-routing.test.mjs`, on a real Gate with two fake environments: `kilo/kilo-auto/free` with no backendId/bot is answered by the hermes backend (200, explicitly not the environment that sorts first); the unqualified `deepseek-v4.1-flash` under `opencode-go-session` also routes; two quick turns read each catalogue once (cache); `kilo/ghost-model` still 404s with the new message and `unknown_provider` and asks no environment to run a turn; the Gate-owned `opencode-go` still goes to `dispatchChat` unchanged with zero `listModels` reads; a turn naming no provider at all still 400s `scope_required` with no catalogue read. Red proof: restoring `server.mjs` to its HEAD content gave 4 failed / 6 passed (`actual: 'Unknown provider "kilo"'`); the fixed file then passed 10/10.
**Review:** passed review first time
**Residual:**
- The cache is not invalidated when an environment's catalogue changes inside the 60 s window. `forget()` is exported as the escape hatch but nothing calls it today; wiring it to roster changes would be a behaviour change beyond this brief.

### OCB-1
*Provider errors - package R3P3*

**Status:** Fixed (commit c717daa)
**What the operator saw:** They typed "Hey bud" and the assistant bubble read `Hey budHey! What are we working on?` — their own words glued in front of the reply.
**Diagnosis:** CONFIRMED. `streamEvents` in `gate/core/cli-environments/backends/opencode.mjs` published any `text`/`reasoning` part through `normalizeOpenCodeEvent`/`tracker.snapshot`, and any `field:'text'` `message.part.delta` as `message.delta`, with no check on which message the part belonged to; the role only ever arrives on `message.updated` (`info.id` → `info.role`), and the bus does not order that before the message's own parts.
**Fix:**
- `streamEvents` now keeps a `messageRoles` map (`info.id` → `info.role`), filled from `message.updated` and cleared in `cleanupStreamState`.
- New `publishesText`/`holdForRole` gate: a part whose message role is `assistant` flows unchanged (no added delay), a non-assistant role is dropped for good, an unknown role is held in `roleHeld` instead of emitted.
- A held part also triggers `recoverMessageParts`, the existing bounded `GET /session/<id>/message/<messageID>` lookup, so a role that never arrives as an event is still learned inside the same 1 s `METADATA_LOOKUP_TIMEOUT_MS` window.
- `releaseRoleHeld` publishes held text when the role turns out to be `assistant` (still through the type gate) and clears the queue, pending deltas and recovered snapshot when it does not; at the terminal `releaseRoleHeld(undefined, true)` runs before `flushPendingDeltas`, so anything still undecided falls back to the previous routing rather than being published on a guess.
- `scopeToSession`, tool/approval/usage frames and every existing frame shape are unchanged.
**What you'll notice:** The assistant now just answers — your typed message never appears in its bubble.
**Tests:** New section "whose text is the answer" in `gate/__tests__/opencode-backend.test.mjs` (4 tests): a user `message.updated` then its text part then the assistant's emits only the assistant text; a prompt that arrives before its `message.updated` is still not published; the bounded message lookup settles a prompt whose `message.updated` never arrives; an assistant part held for its role is published once, not doubled. Re-pointed: `part metadata that arrives while the recovery lookup is in flight wins` gained one `message.updated` line carrying `info.role:'assistant'` because the fixture never said who wrote message `m`; no assertion changed.
**Review:** passed review first time — the integrator accepted the OCB-1 role hold as is and left it untouched in repair r1.
**Residual:**
- If no role reaches the Gate for a message at all (neither carrier present), the text is classified by type at the terminal, as before; on 1.18.18 both role carriers exist.
- Deltas that name no `messageID` cannot be gated and keep flowing as they did.

### OCB-2
*Provider errors - package R3P3*

**Status:** Fixed (commit c717daa)
**What the operator saw:** On a free model that accepted the turn and never answered, the turn failed after about five minutes with `opencode: could not reach http://127.0.0.1:4096/session/<id>/message (Headers Timeout Error)`.
**Diagnosis:** CONFIRMED. `sendMessage` POSTed `/session/<id>/message`, which OpenCode holds open until the whole turn is done, so undici's 300 s headers timeout reported the failure as an unreadable transport error and nothing ever called `/abort`, leaving the turn running server-side. The live feed (`streamEvents`) already saw `session.idle`; nothing used it.
**Fix:**
- `sendMessage` now opens the bus first — `openTurnBus` (`opencode.mjs`) subscribes to `/event` and returns `{ ready, wait, close }` — awaits the subscription's `done.ready` under the new `BUS_READY_TIMEOUT_MS` (3 s), then POSTs `/session/<id>/prompt_async`; a ready that fails or times out still sends, via `boundedValue`.
- `awaitTurnOnBus` completes the turn from the bus: `session.idle` → `readTurnMessages` (`GET /session/<id>/message`) → `thisTurnAssistantMessage(messages, sentAt)` → `turnResult`, which keeps the existing `info.error` refusal; `session.error` throws with the upstream message. The `{ message, text }` shape is unchanged.
- Silence is bounded by activity: `OPENCODE_FIRST_OUTPUT_IDLE_MS` (60 s) until the first `message.delta`, `OPENCODE_IDLE_MS` (180 s) after; a `running` tool part suspends the bound; a `session.status` of type `retry` is not progress and its reason is kept for the message.
- On expiry the wait first re-reads the session (`TURN_MESSAGES_TIMEOUT_MS` 5 s) and returns a finished (`info.time.completed`) assistant message of this turn instead of failing; only then `stopTurn` POSTs `/session/<id>/abort` (bounded, `TURN_STOP_TIMEOUT_MS`) and throws `silentTurnReason`'s `<model> did not answer within <n> s. OpenCode stopped the turn - try another model.`
- `lastAssistantMessage` is replaced by `thisTurnAssistantMessage`, which requires `info.time.created >= sentAt - TURN_START_SLOP_MS` (2 s), so the previous turn's reply can never be served as this one's; with no such message it returns `{ message: null, text: '' }` and the Gate reports `empty_turn` as before. `sentAt` is taken just before the POST.
- A 404 on `prompt_async` (older server) falls back to today's blocking POST; any other refusal propagates, since re-sending could run the turn twice. The subscription is closed in a `finally` on every path, a caller abort still stops the turn, and the bounds are injectable via `createOpenCodeBackend({ firstOutputIdleMs, idleMs })`. A dead feed re-arms the bound rather than parking the wait.
**What you'll notice:** A model that never answers gives up in about a minute and says which model gave up and that the turn was stopped, instead of a five-minute "could not reach" error.
**Tests:** New section "a turn that never answers" (9 tests) — `prompt_async` + `session.idle` completes the turn and asserts the route and body; `session.error` and an `info.error` fail with the upstream message; a silent bus fails on the injected bound with the model named and calls `/abort`; steady deltas longer than the bound complete; a running tool 3× the bound does not fail; repeated `retry` statuses do not re-arm and their reason is in the message; caller abort stops the server turn; 404 falls back. Repair r1 added 4 more: terminal frames broadcast from the `prompt_async` route resolve as the answer / fail as upstream (never "did not answer"), a silent bus that already holds this turn's finished message answers it, and an idle turn with no message of its own returns empty rather than the old reply. Re-pointed: `sending a message posts parts and returns the assistant text`, `a turn is submitted to prompt_async and completed from the bus` and `a server without the async prompt falls back to the blocking send` now select their POST by path because the `/event` GET is the server's first call (same bodies asserted), and `a refused fetch rejects naming the baseUrl` accepts `prompt_async|message` — its subject, a named base URL, is unchanged.
**Review:** The integrator's r1 review found three OCB-2 defects — a missed completion race (the POST preceded the subscription, so a fast turn reported "did not answer within 60 s"), trusting the bus alone on silence, and `lastAssistantMessage` serving the previous turn's reply. All three were repaired in r1 (bus-before-post with a bounded ready wait, read-back before declaring silence, `thisTurnAssistantMessage`); OCB-1 and OCB-3 were accepted unchanged.
**Residual:**
- A turn whose answer spans several assistant messages returns the last one, as before; the live deltas still carry the whole answer.
- If the event feed itself dies mid-turn, the turn ends at the bound with the silence reason rather than a feed one; no test pins that case.
- The pre-post `ready` wait can cost up to 3 s per turn when the bus is slow to answer its GET.

### OCB-3
*Provider errors - package R3P3*

**Status:** Fixed (commit c717daa)
**What the operator saw:** After picking a model, the system line read `New session opened. Was opencode-go/mimo-v2.6-pro, now opencode-go/mimo-v2.6-pro.`
**Diagnosis:** CONFIRMED. `modelSwitchAnnouncement` in `src/lib/gateway/model-selection.ts` always rendered `Was <previous>, now <next>`, and its only caller, `selectModel` in `src/context/gateway-provider.tsx`, passed `previous: previousModel ?? modelId` — substituting the new model when the thread had no known previous one. The release itself is correct: `shouldReleaseSessionForModel` treats "nothing proves the open session serves `next`" as a change.
**Fix:**
- `modelSwitchAnnouncement({ previous, next })` now takes `previous?: string | null` and returns `New session opened on <next>.` when previous is missing, blank, or the same model by `sameModelId` (qualification-insensitive, like the rest of the file).
- A real change keeps `New session opened. Was <previous>, now <next>.` — no wording change there.
- `selectModel` passes `previous: previousModel` (possibly undefined) instead of `previousModel ?? modelId`; that one line is the only change in the provider.
**What you'll notice:** When the model isn't actually changing, the line just names the new model instead of saying it was already that model.
**Tests:** New `__tests__/model-switch-announce-test.ts` (4 new of 8 tests): missing/`null`/blank previous names only the new model, a same-model previous (`kimi-k3`, and `moonshot/kimi-k3` vs `kimi-k3`) is not a change, a real change names both, and a source-level assertion that `selectModel` passes `previousModel` and contains no `previousModel ??`. All four fail with the two source changes reverted.
**Review:** passed review first time — the integrator accepted the OCB-3 change as is.
**Residual:** none.

### CAT-1
*Provider errors - package R3P2*

**Status:** Fixed (commit 4e8f5e9)
**What the operator saw:** providers the host is not signed into, and a configured provider sitting next to the built-in it replaces, were all offered as ordinary choices.
**Diagnosis:** CONFIRMED. `hermes.mjs` `listModels` flattened `/api/model/options` and dropped `source`, `is_user_defined`, `aliases`, `is_current`, so nothing downstream could tell the operator's `kilo` from the built-in `kilocode`, or `opencode-go-session` (the only provider sending the `x-opencode-session` header OpenCode Go now requires) from the built-in `opencode-go` whose every turn was `400 MissingSessionID`. ADDED: the twin comparison has to be scoped, because a provider id is only unique inside one environment's list.
**Fix:**
- `hermes.mjs` `listModels` now adds `providerSource`, `providerUserDefined`, `providerAliases`, `providerCurrent` to every row; no other field or backend changed.
- `model-curation.mjs` `shadowedProviders` / `namesProvider`: a `user-config` provider that aliases a twin (case- and `custom:`-insensitive) or is named `<twin>-` hides every row of the built-in, reason `Replaced by your <name> provider`, `available: false`.
- `providerScopeKey` keys providers by environment, and `curateModels`' `scopeId` supplies a Bot's scope, so a Gate provider or another Bot's twin is never caught; a `user-config` provider is never hidden by this rule.
- `/v1/models` stamps `backendId` per row (scoped branch) or per descriptor (aggregate) so the comparison has a scope; rows keep their order and fields.
**What you'll notice:** each configured provider appears once, and the dead built-in twin under it is gone.
**Tests:** `model-curation.test.mjs` covers alias, prefix, `custom:`/case, two environments, two configured providers, and "rule b also runs inside a Bot's picker"; `model-catalogue-curation.test.mjs` covers the aggregate mix of a Gate `opencode-go` with Hermes's twins; `hermes-backend.test.mjs` gained a metadata test, its two catalogue assertions were extended (not weakened) with a `providerFacts()` helper.
**Review:** not first time — accepted by review r1, then the integrator's third round found a Bot's rows carry no `backendId`, so rule b was inert in the operator's everyday picker; fixed with `healthScopeId` scoping plus the Bot-scope tests.
**Residual:** `providerCurrent` travels but nothing reads it here.

### CAT-2
*Provider errors - package R3P2*

**Status:** Fixed in part — the Gate's own provider path records no verdicts, so its models are never hidden for refusing turns (left under Residual).
**What the operator saw:** a model that refused every turn stayed in the list forever; nothing said which models actually work here.
**Diagnosis:** CONFIRMED — no catalogue kept score. ADDED: the streamed path is the one that actually runs (the app always sends `stream: true`) and it can only judge a refusal from the text that streamed, so a thrown backend turn, a refusal-as-text and a contentless turn are the three failure shapes.
**Fix:**
- New `model-health.mjs` `createModelHealth`: key `<scope>|<qualifiedModelId>`, two consecutive failures hide the model for 6 h, any success clears it, an expired verdict is dropped so the model is offered again; state kept in `<gateHome>/model-health.json` via `writeFileAtomic` on a 250 ms coalescing timer, corrupt/unreadable file = empty table, never a failed request.
- `server.mjs` `recordTurnOutcome` (one call, chat route not restructured): `backendUpstreamRefusal`, `empty_turn` and a thrown backend error are failures, assistant content is a success.
- Streamed hooks at `server.mjs:273` and `:295`; nothing recorded when the turn was stopped, the phone disconnected (`clientDisconnected`) or the Gate's own bound fired.
- Keyed per environment and per Bot (`healthScopeId`), so one Bot's refusals cannot hide a model for another Bot, the bare environment, or a Gate provider row of the same id.
**What you'll notice:** a model that keeps refusing drops out of the list for a few hours and returns on its own once it answers again.
**Tests:** `model-health.test.mjs` (two failures vs one, clear, 6 h expiry on a fake clock, restart round trip, corrupt file, one write per burst) and `model-catalogue-curation.test.mjs` route tests (refusal, empty turn, thrown turn, streamed throw/refusal/empty, cancel and walk-away record nothing, per-Bot scoping).
**Review:** r1 item 1 (S1) caught that `streamBackendTurn`'s `catch` recorded nothing, so the path the app really uses was never scored; r2 item 3 caught the rule-(d) claim for the provider path was false; the integrator's third round added per-Bot scoping and made a non-streamed turn whose phone left, or that threw after answering, record nothing and write no second response.
**Residual:** the Gate's own providers are never hidden for refusing turns; a detached turn answered after the phone left records nothing; the 2-failure and 6 h values are constants, not measured.

### CAT-3
*Provider errors - package R3P2*

**Status:** Fixed (commit 4e8f5e9)
**What the operator saw:** image and audio generation models were offered as chat models and could not hold a conversation.
**Diagnosis:** CONFIRMED — `kilo/google/gemini-3.1-flash-image`, `openai/gpt-5.4-image-2`, `openai/gpt-audio`, `openai/gpt-audio-mini`, `openai/gpt-5-image-mini` and `google/gemini-2.5-flash-image` were offered; `deepseek-v4-flash-vision-exp` is a chat model with vision and must stay.
**Fix:**
- `model-curation.mjs` rule (c) `hiddenReasonFor`: whole-token match on the model token only (`modelId`, else `id` minus a leading `provider/`), using the brief's image/audio/embed/speech pattern.
- Such a row gets `hidden: true` + `hiddenReason: 'Not a chat model'` and keeps the `available` it came with: the rule is about what a model is, not whether this host can run it.
- Matching the model token rather than the whole id keeps a provider named after a capability from condemning its own chat models.
**What you'll notice:** picture- and sound-making models are gone from the chat list; vision-capable chat models are still there.
**Tests:** `model-curation.test.mjs` hides the six live ids plus `text-embedding-3-large` while keeping their availability, and leaves `deepseek-v4-flash-vision-exp`, `gpt-5.6-sol`, `kilo-auto/free`, `claude-sonnet-4-5`, `grok-4.6` untouched; the route test asserts `kilo/google/gemini-3.1-flash-image` is `Not a chat model` and still `available: true`.
**Review:** accepted unchanged by reviews r1 and r2; r2 item 3 required the rule-(c)-only claim for Gate provider rows to be stated truthfully in `model-curation.mjs`, `server.mjs` and the test name.
**Residual:** a chat model whose id carries a whole `image`/`audio` token (e.g. `vendor/audio-chat-experimental`) would be hidden.

### CAT-4
*Provider errors - package R3P2*

**Status:** Fixed (commit 4e8f5e9)
**What the operator saw:** every open of the model picker paid 2.7-3.9 s (Hermes `/api/model/options` alone measured 3.9 s) and re-asked every backend live.
**Diagnosis:** CONFIRMED. R3P1's 60 s per-backend cache existed but only the routing lookup used it (`catalogueFor`); `/v1/models` called `backendManager.get(id).listModels()` directly, scoped and aggregate.
**Fix:**
- `backend-model-route.mjs` `cataloguesFor` reuses that one cache: younger than 60 s answered as-is, older but younger than `CATALOGUE_STALE_MS` (30 min) answered immediately and refreshed behind the request, past that or absent read live; `?refresh=1` forces a live read.
- `loadCatalogue` never files a failure as an answer: a failed or timed-out read keeps the copy already held, or returns `null` so the caller reports the failure; routing still remembers an unusable environment in a separate `unreadable` map.
- `readCatalogue` bounds the shared read itself (60 s for `/v1/models`, 5 s for the routing lookup) and releases the `inflight` slot when that bound fires, so one read is shared per environment without a hung read holding the slot for the life of the process.
- `server.mjs` answers each way the route did before the cache: the scoped branch 502s `backend_error` when the environment is absent from the map, the aggregate omits that environment's rows; Bot catalogues are cached under their own `${environmentId}@bot:${botId}` key through the Bot's profile-scoped backend.
**What you'll notice:** the model list opens instantly, and keeps working when one environment is down.
**Tests:** `model-catalogue-curation.test.mjs` (three reads = one `listModels`; stale answered under 500 ms with one background refresh; `?refresh=1` live; a refusing read answers 502 twice with no empty answer cached; a hanging read is waited for, then 502s and does not poison the next request; five concurrent cold reads = one read) and `backend-model-route.test.mjs` (a throwing environment does not blank the rest; a failed background refresh keeps the copy; a hung read releases the slot).
**Review:** r1 items 3 and 4 caught that a read over the 5 s routing bound was cached as an empty list for 60 s (Hermes reads take 3.9 s, so a slow read blanked the picker with no error) and that the cold read was not single-flighted; r2 item 4 caught the hung read poisoning the slot; the integrator's third round moved the stale-while-refresh read onto the 60 s catalogue bound and gave Bot catalogues their own cache key.
**Residual:** a genuinely dead environment makes a cold `/v1/models` wait the full 60 s before 502; a routing lookup that starts a read which then overruns 5 s ends that shared read, so a `/v1/models` joining it gets an honest 502.

### CAT-5
*Provider errors - package R3P2*

**Status:** Fixed (commits 4e8f5e9 and 9df4acb)
**What the operator saw:** the picker showed every row the environment listed, with no way to tell a signed-out provider, a replaced twin or a failing model apart from a working one.
**Diagnosis:** CONFIRMED. `chat-screen.tsx` `modelRows` mapped every row of `modelCatalog` into the picker, and `thread-config-sheet.tsx` only locks a row carrying `modelLock`, so a hidden row had no notion of existing. The stale-pin repair in `model-selection.ts` `staleModelPin` needs its row to arrive flagged, not deleted.
**Fix:**
- `model-selection.ts` `visibleModelRows`: drops `hidden === true` rows except the thread's pinned model (compared with `sameModelId`), returning the same array when the Gate flagged nothing so the memoised picker does not re-render.
- `chat-screen.tsx:1144` `modelRows` maps `visibleModelRows(modelCatalog, threadModel)`; `modelCatalog` itself stays whole, so `staleModelPin` still sees a hidden `available: false` row and repairs the pin.
- `staleModelPin`'s `fallbackFor` now requires `available !== false && !hidden`, so a repair cannot move a thread onto a row the picker refuses.
- `chat-screen.tsx:2867` `catalogueLock` puts the device's own lock first, otherwise shapes `hiddenReason` into the `modelLock` slot the sheet already renders (`recordedAt: 0`) — no new component, prop or visual change.
**What you'll notice:** the model list only shows things that can run, and a thread already on a hidden model keeps that row, dimmed and locked, with the reason on it.
**Tests:** `__tests__/model-hidden-rows-test.ts` (new: drops flagged rows, keeps the pin, qualified match, no pin, same-array identity; hidden `available: false` still condemned by `staleModelPin`; never falls back onto a hidden row) plus three source-wiring pins. `chat-screen-derivations-test.ts` and `model-lock-wiring-test.ts` were re-pointed at the new call shape (`visibleModelRows(modelCatalog, threadModel).map(`, the widened deps, `catalogueLock(model, modelLockFor(...`) because they asserted the pre-CAT-5 source; no assertion was removed or loosened.
**Review:** r1 item 5 caught `staleModelPin` falling back onto a hidden-but-runnable row; r2 items 1 and 2 caught the device-lock arm (`modelLockFallback` in `run-failures.ts`) and the Gate-verdict `Clear`/wording, but the attempt to fix those edited `run-failures.ts` and `thread-config-sheet.tsx`, which the integrator's guard rejected as outside the allowed list — both were reverted in r3 with their tests deleted rather than left half-delivered; the integrator then made those two changes directly (commit `9df4acb`).
**Residual:** none. The integrator finished the two items the package could not reach (commit `9df4acb`): `modelLockFallback` (`src/lib/gateway/run-failures.ts`) skips hidden rows, a Gate-derived lock is marked `source: 'gate'` so `modelLockNote` shows the Gate's reason ("Not a chat model. Pick another model.") and `thread-config-sheet.tsx` offers `Clear` only for this device's own locks; three tests in `__tests__/model-hidden-rows-test.ts` fail on the old code.

### SPD-1
*Speed - package R3S1*

**Status:** Fixed (commit 538fa94)
**What the operator saw:** Every screen that lists Hermes threads (chat session sheet, Bot roster chat, drawer, "load older") sat 3-30 s, and often failed outright with a 502 "backend timeout".
**Diagnosis:** CONFIRMED. `GET /v1/sessions` in `gate/core/server.mjs` called `backend.listSessions(limit)` live on every request and answered only when it returned; no cache existed, so each screen re-paid the Hermes query against the 6.2 GB `state.db`. The author's addition: the Gate keeps its own copy per `${environmentId}|${botId}` and Hermes's data is never written or SQLite-read.
**Fix:**
- New `gate/core/session-index.mjs`: `createSessionIndex({ dir, now, maxRows, maxKeys, writeDelayMs, rowTemplate, log })` with `get`, `refresh`, `upsert`, `remove`, `rename`, `flush`; one JSON file per key under `<gateHome>/state/session-index/`, atomic write via `.tmp` + rename, debounced (250 ms), corrupt files ignored, 500 rows per key, 64 keys LRU.
- `readIndexedSessions` (`server.mjs:1568`) answers a Hermes-kind list from that copy and starts an unawaited refill when the copy is older than `sessionIndexStaleMs` (30 s); `indexesSessions` (`:1533`) and `readIsIndexable` (`:1546`) restrict it to `kind === 'hermes'` and to requests carrying only `limit`/`bot`/`backendId`, so OpenCode stays live and a cursor-bearing read stays live.
- Write-through so the operator's own actions show at once: `POST /v1/sessions` → `upsert` (`:2563`), `DELETE /v1/sessions/{id}` → `remove` (`:2636`), a chat turn on Hermes → `upsert({ id, last_active, title?, model? })` placed before the stream/non-stream branch so both are covered (`:2929`).
- Responses add `index: { refreshedAt, stale }` and, on a short page, `partial: true`; `object`/`data` keep their meaning and the app was not changed (`manifest-client.ts` `getSessions` reads only `data`).
**What you'll notice:** Once a Hermes thread list has been read once, reopening the chat list, the drawer or a Bot's chat is instant instead of a multi-second wait.
**Tests:** New `gate/__tests__/session-index.test.mjs` (18) and `gate/__tests__/session-index-route.test.mjs` (17, controllable fake Hermes backend) prove the second read answers in < 100 ms while the backend is held open with exactly one refill, that created/streamed/non-streamed-chat sessions and deletions appear or vanish with no session read, that per-Bot keys are separate, and that OpenCode and cursor reads still go live. Pre-fix proof: 9 of 11 route tests fail against the old `server.mjs`; the 2 that pass are the "must keep working" guards (OpenCode live, cursor read live), which cannot fail when everything is live. No existing assertion was changed; the pre-existing unit tests that call the now-`async` mutators were `await`ed only.
**Review:** Independent review failed the first attempt with four reproduced defects: write-throughs on a key not yet loaded were no-ops after a Gate restart (a delete did nothing, the first chat turn replaced a real 30-row window with a one-row `fetchedLimit: 0` copy); a 20-row refill could answer a `limit=200` read unmarked, so `sessionListMayHaveOlder` read it as "no older" and Bot Chat could open a duplicate; `resolveConversationScope` returning `{ backend: null }` was dereferenced at four call sites, logging 5 new `ERR_HTTP_HEADERS_SENT` "Request handler error" lines; and chat rows were merged with `{ ...row, ...session }`, wiping measured fields and storing rows without `started_at`/`preview`/`message_count`. Repairs: a `live(key)` helper that loads the file before every mutator (mutators now `async`, all three write-throughs awaited) plus a bounded `flush()` in `close()` (`:3222`); `inFlight` holds `{ promise, window }` so a join never satisfies a bigger ask, and `isShort` (`:1577`) marks any narrow answer `partial: true`; `if (!scope?.backend) return;` at all four sites; `mergeRow` field-by-field merge plus a `rowTemplate` supplied from the backend's own `toGatewaySession` in `createGateSessionIndex` (`:664`). Each repair has a test that fails on the pre-repair code.
**Residual:**
- Only `kind === 'hermes'` is indexed; a future slow backend must declare that kind.
- A brand-new write-through row's `started_at` is when the Gate first heard of the session; the next live read replaces it.
- Verified on this host against stubs only — Hermes's own data was deliberately not touched.

### SPD-2
*Speed - package R3S1*

**Status:** Fixed (commit 538fa94)
**What the operator saw:** A cold Hermes session list (measured at 38 s) could never load: the Gate gave up at 30 s and returned 502 `backend_timeout` every time until the OS cache happened to be warm.
**Diagnosis:** CONFIRMED. `READ_TIMEOUT_MS` (30 s) in `gate/core/cli-environments/backends/hermes.mjs` was the only bound, so `readCall` aborted a read that needed 38 s before it could land. The author's addition: two bounds — the screen waits 30 s, but the refill behind the index is given 180 s and is never cancelled at the screen bound.
**Fix:**
- `listSessions(limit, { timeoutMs })` and `readCall(path, what, { timeoutMs })` (`hermes.mjs:218`, `:164`) accept a per-call bound; the default stays `READ_TIMEOUT_MS` for every other caller and the timeout message names the bound actually applied.
- The route passes `timeoutMs: sessionRefreshTimeoutMs` (`DEFAULT_SESSION_REFRESH_TIMEOUT_MS`, 180 s, `server.mjs:100`) for its refill and waits only `sessionReadBoundMs` (30 s, `:99`); both are injectable for tests.
- `boundedOutcome` (`:1651`) lets the screen stop waiting without cancelling: it resolves `{ settled: false }` at the bound and never rejects, so the abandoned read still fills the copy and cannot surface as an unhandled rejection.
- Out of time with rows in the copy → 200 with `partial: true`; out of time with an empty copy → the existing 502 `backend_timeout` with `SESSION_LIST_SLOW_MESSAGE` (`server.mjs:108`), while the refill keeps running and a later read is served from the copy it filled.
**What you'll notice:** A thread list that used to fail with "backend timeout" now either shows what the Gate already knows or says Hermes is slow and is still reading — and the next attempt succeeds even on the first cold read.
**Tests:** New `gate/__tests__/hermes-read-timeout.test.mjs` cases (+2) show a listing given `{ timeoutMs: 2_000 }` waits for a 120 ms answer while the same read under the 40 ms default is still the old `backend_timeout`, and that the default stays 30 s with `180s` named for the refill. Route tests prove a read past an injected 60 ms screen bound returns 502 with the new words yet a later read is served from the copy the abandoned read filled with one backend call total, and that a copy holding rows answers 200 + `partial: true`. Pre-fix: both hermes tests fail against the old backend file, the 8 pre-existing hermes tests still pass.
**Review:** The independent review's second defect is the SPD-2 half: `refresh` was single-flight per key regardless of window, so a `limit=200` read joining an in-flight `limit=20` refill was answered with 20 rows and no `partial: true`, and the app then decided nothing was older — Bot Chat `getSessions(200)` could miss an existing session and create a duplicate. Repair: a join is honoured only when the running read is at least as wide as the ask, otherwise the wider read waits for the running one and then makes its own (the backend is still asked once), and `isShort` marks both the landed-refill and out-of-time answers `partial: true` (previously the out-of-time path said `partial` unconditionally, which was wrong in the other direction). Tests: unit "a join never answers a read that asked for a bigger window" and route "a load-older read that lands on a running refill still gets the bigger window".
**Residual:**
- A request wider than the 500-row cap is answered `partial: true` honestly, because the copy cannot hold more.
- Write-throughs now wait on one cached file read per key per process, so a filesystem that stops answering would stall a create/delete/turn too.

### NET-1
*Speed - package R3S2*

**Status:** Fixed (commit 481c888)
**What the operator saw:** every Gate read cost full price in bytes over a slow relayed phone link — the model catalogue alone came back as 241,473 bytes per fetch, and the phone was paying for all of it while already asking for and able to read a compressed answer.
**Diagnosis:** CONFIRMED. Nothing between the socket and the routes in `createGate`'s `createServer` handler looked at `Accept-Encoding`, so every route's `res.writeHead(...)` + `res.end(JSON.stringify(...))` went out as plain bytes, even though `rg -n "Accept-Encoding" src` finds nothing, i.e. React Native's OkHttp `fetch` sends `Accept-Encoding: gzip` and inflates the reply itself. The author ADDED one constraint the brief did not name: exactly two routes read `res.headersSent` (server.mjs:2551 in the `/v1/models` catch, server.mjs:2920 in the handler's last line of defence) to mean "a streaming route already committed its status line", and `writeHead` therefore could not be passed through — it is held back and replayed, with `headersSent` answered from that held state.
**Fix:**
- New `gate/core/http-compress.mjs`: `enableJsonCompression(req, res, { minBytes = 1024, gzip = gzipSync } = {})` plus `acceptsGzip(req)`. Returns `res` untouched for `HEAD`, a missing `Accept-Encoding`, or `gzip;q=0`; `*` is deliberately not read as consent.
- Streams are never touched: an `text/event-stream` `Content-Type` (via `writeHead` or `setHeader`), an existing `Content-Encoding`, or the first `res.write(...)` restores the original methods and hands the response straight back to `node:http`, so SSE frames go out as they are written.
- Only a body finished by one `res.end(body)` at 1 KB or more, and not on 204/304, is gzipped: stale `Content-Length` removed, `Content-Encoding: gzip` set, `Accept-Encoding` appended to an existing `Vary` (CORS's `Origin` survives), compressed `Content-Length` set. A throwing or non-Buffer `gzip` falls back to the original body.
- `writeHead` is held back (`pending`) rather than replayed through, `flushPending({ withHeaders: false })` writes the status line alone on the compressed path, and `res.headersSent` is redefined on the instance to stay true the moment a route calls `writeHead` — that is what keeps the two `headersSent` readers behaving.
- `server.mjs`: 5 lines — one import beside `./cors.mjs`, one `enableJsonCompression(req, res)` right after `webCors(req, res)` and before `res.setHeader('Content-Type', ...)`. No route logic touched.
**What you'll notice:** the app loads its model list and history many times faster on a weak cellular link, and nothing about streaming replies or error messages changes.
**Tests:** new `gate/__tests__/http-compress.test.mjs` (25 tests, all pass) — 19 unit tests over a fake `req`/`res` (gzip above threshold inflates to the same JSON; stale `Content-Length` from `setHeader` and from `writeHead` replaced; `Vary` extended not replaced; small answer, no header, `gzip;q=0`, `HEAD`, 204 unchanged; `writeHead(502)` + `end(json)` keeps status and other headers; `headersSent` true right after `writeHead`; `setHeader` after `writeHead` still works; injected throwing `gzip` yields the exact original bytes; SSE `writeHead` + three writes stay byte-identical with no `Content-Encoding`; `end(body, cb)` still fires the callback) and 6 over a real socket (gzip on `/v1/models` more than 2× smaller and deep-equal to the uncompressed JSON; `gzip;q=0` uncompressed; `/health` plain; 401 unchanged; a route with no `writeHead` still gets a status line; a `stream: true` chat turn relayed with no `Content-Encoding` and ≥2 separate `data` events ≥100 ms apart). No existing assertion was re-pointed or weakened. Pre-fix proof recorded without `git stash`: with the `enableJsonCompression(req, res)` call commented out, the `/v1/models` gzip test fails (`expected 'gzip', got undefined`) while the other 20 pass.
**Review:** passed review first time — no repair-request file was raised.
**Residual:**
- `gzipSync` blocks the event loop for its span (~0.9 ms measured on a 269 KB catalogue); the `gzip` option is injectable so async `zlib.gzip` can drop in later.
- Installed after the CORS preflight, so the `OPTIONS` 204 is never wrapped and gets no `Vary: Accept-Encoding`; and only `gzip` is honoured — a client preferring `br` or `deflate` still gets gzip or plain.

### AUTH-1
*Speed / connect - package R3A1*

**Status:** Fixed (commit c013d0a)
**What the operator saw:** The phone's connect bursts hit the Gate with no key at all, the Gate answered "no authorization header", and the app read that as "your API key was rejected" - so it stopped retrying and the operator sat on screen after screen.
**Diagnosis:** CONFIRMED the integrator's trace. A Tailscale blip on the Gate's MagicDNS name fails `runAutoConnect`'s probe of the saved active profile, so the cycle probes other candidates (including the tailnet IP from `appSettings.tailscaleHost` via `buildGatewayCandidates`, `src/lib/gateway/candidates.ts`); `resolveGatewayForUrl` in `src/context/gateway-provider.tsx` then matched a saved profile by exact URL string only, and `mergeIntoExistingGateway` (`src/lib/gateway/profile-dedupe.ts`) dedupes on protocol+host+port+path, so the same Gate under a second host form became a NEW profile from `createGatewayProfile` (`src/lib/gateway/storage.ts`) with no token. `attachClient` then built a `HermesGatewayClient` (`src/lib/gateway/client.ts`) with `token: undefined` and its fan-out (`/v1/sessions`, `/v1/environments` or `/v1/models`, `POST /v1/capabilities/rpc`) went out with no `Authorization`; the Gate's 401 raised `authFailureRef`, which stops auto-retry. The author ADDED a second cause: the poisoned roster itself - the token-less twin is saved and usually made active, so even with the match fixed the exact-URL branch kept re-picking it.
**Fix:**
- `matchSavedGateway` (new, `src/lib/gateway/candidates.ts`) resolves a probe winner to the saved top-level profile that can authenticate: same `gatewayIdentityKey`, or the winner's host is in that profile's `alternateIpv4`, or in the host its cached manifest advertised, or the winner is the configured `tailscaleHost` and the profile is the active/only Gate profile. The port must match (Gate `:8760` and Hermes `:8642` are different services); child profiles and token-less copies are never matched.
- `resolveGatewayForUrl` consults it ahead of the exact-URL branch, which now only settles when the exact-URL profile carries a token, so a wave won by the tailnet IP reconnects the paired profile instead of saving a new one. `cachedManifestIpv4ByProfileId` (new, `src/lib/portal/attach-manifest.ts`) supplies the cached `transport.ipv4` evidence, read only when a winner matched nothing by URL.
- `reachableAlternateIpv4` (same file) is the choice of persistence: the address that answered is appended to the saved profile's `alternateIpv4` (what requests already fall back to) and the operator's saved URL is never rewritten.
- `mergeTokenlessTwinGateways` (same file), called at bootstrap in `gateway-provider.tsx` beside the existing `repairDuplicateGateways` pass, folds a token-less twin into the one token-bearing profile for that Gate (survivor keeps id, URL, token and pins, the twin fills gaps as `collapseDuplicateGateways` does, active id remapped) and writes only when something changed.
- `attachClient` in `gateway-provider.tsx` captures the profile's saved `kind` and, if that profile wants a token (saved as `kind: 'custom'`, or the fetched/cached manifest says `manifestRequiresToken`) while its own token is empty, it first connects the paired same-Gate profile if one is in the roster; otherwise it stops through the existing `abandonAttach()` with `GATEWAY_TOKEN_REQUIRED` ("Setup token required for this gateway...", read by `isGatewayTokenRequiredMessage`) and never sets `authFailureRef`. A bare Hermes with no token is neither branch, so it connects unchanged.
**What you'll notice:** When the phone reconnects on a bad link it either comes back to the Gate straight away or tells you a setup token is missing - it no longer counts through screens or claims your key was rejected.
**Tests:** New `__tests__/saved-gateway-match-test.ts` (9 cases: which saved profiles a winner may resolve to, including the must-not-match ones) and `__tests__/gateway-twin-roster-repair-test.ts` (11 cases: the roster heal rules, and that a wave's address becomes an alternate rather than a new URL). New `__tests__/gateway-provider-token-fanout-test.tsx` (9 cases) drives the real provider with the real client factory and a recording `fetch` answering as the Gate does: every fan-out request carries `Bearer t` and the saved URL does not move, a poisoned ACTIVE twin is healed before anything connects (and loses to the paired profile when no merge is safe), a Gate with no token records zero requests - the one allowed unauthenticated `GET /.well-known/...` is named explicitly in the assertion - and never matches /rejected the api key/i, and a token-less bare Hermes still connects sending no `Authorization`. No existing test or assertion was re-pointed or weakened; the notes record pre-fix proof by temporarily reverting (match call removed / helper matching nothing -> `Expected "Bearer t" / Received undefined`; guard disabled -> `GatewayHttpError: Bearer token required` thrown out of `connectGateway`), each restored; the commit's gate line records tsc, eslint, verify-config and jest ok.
**Review:** Failed independent review at r2 after an r1 restart that supplied the integrator's own root-cause trace (confirmation of the trace, `matchSavedGateway`, the token flow and the token-less-Hermes requirement was accepted). r2 caught four things and all four are in the commit: (1) the roster the bug had already poisoned - now healed at startup and, in `resolveGatewayForUrl`, the token-bearing match beats an exact-URL token-less twin; (2) the transient winner URL being written back - not persisted, the address goes to `alternateIpv4` instead and a test pins the stored `url`; (3) the guard only firing for `kind: 'custom'` with no manifest - widened to `savedKind === 'custom' || identityForClient?.auth.requiresToken`, with the paired-profile connect so it is not a dead end; (4) imprecise "no request" assertions - now exact request lists naming the well-known fetch.
**Residual:**
- A host form nothing saved vouches for is still treated as a new gateway (Android emulator `10.0.2.2` for a PC saved as a LAN IP; a saved `https://` Tailscale-Serve `:443` profile whose tailnet-IP winner is on `:8760` and whose cached manifest names no IPv4). The port rule is deliberate, so these fall back to a new profile plus the "Setup token required" stop instead of an anonymous fan-out.
- `cachedManifestIpv4ByProfileId` costs one cached-manifest read per saved top-level profile, on the "winner matched nothing by URL" path only.
- The commit message points at `docs/failure-audit-2026-10-01-round3.md`, and r2 asked for a "Repair r2" entry in `.fix-notes.md`; neither file exists in the tree, so the repair record lives only in the fix log.

### DRW-1
*Responsiveness - package R3D1*

**Status:** Fixed (commit 78f13d5)
**What the operator saw:** The left drawer often felt laggy or slow to start opening, worst on the older Android phone with a busy JS thread.
**Diagnosis:** CONFIRMED as briefed. `SideDrawerContent` in `src/components/nav/side-drawer-content.tsx` drew every leaf inline and nothing below it was memoised, so each OPEN_DRAWER (the navigator hands the drawer a fresh `props`) rebuilt `DrawerLight`'s two SVG gradients, the brand mark, the three `PRIMARY` `DrawerRow`s, up to six `BotAvatar` figures and the Gate footer with `PulsingDot` on the frame the slide animation starts on.
**Fix:**
- `DrawerLight`, `BrandBlock`, `NewChatButton`, `DrawerRow`, `PrimaryNavSection`, `TeamRow`, `TeamSection` and `DrawerFooter` are now `memo` components taking primitives or stable props; styles, labels, order and the haptics wait are untouched.
- `go`, `startNewChat` and `openTeammate` are `useCallback`; the one value that changes on every state move, `props`, is read through `propsRef` so their identity stays stable.
- One memoised `presses` map (`NavPresses`) is handed whole to the nav rows, team rows and footer, replacing the inline `onPress={() => ...}` closures.
- `src/app/(tabs)/_layout.tsx` passes a module-level `renderDrawerContent`; the rest of the `Drawer` config is unchanged.
**What you'll notice:** Opening the drawer no longer redraws its gradients, avatars and rows, so on a busy phone the slide should start sooner (proven by render counts in tests, not yet timed on the device).
**Tests:** New `__tests__/drawer-render-memo-test.tsx` counts renders of mocked `react-native-svg`, `bot-avatar` and `PulsingDot`: an OPEN_DRAWER with grown `state.history` moves no counter (failed pre-fix, light went 2 to 3). No existing assertion was changed.
**Review:** passed review first time
**Residual:**
- `SideDrawerContent` itself still re-runs its body on each navigator move, by design; no device benchmark was run, the claim is counted renders.

### DRW-2
*Responsiveness - package R3D1*

**Status:** Fixed (commit 78f13d5)
**What the operator saw:** The drawer was sluggish to open, and it stayed busy in the background while Gate activity and approvals came in.
**Diagnosis:** CONFIRMED as briefed. `useGateway()` is read at the top of the drawer's one unmemoised node, and the provider rebuilds its context value on every connection status/detail change, activity-run event, pending approval, session-list update and model-catalogue load; with nothing memoised below, each of those redrew the whole closed drawer.
**Fix:**
- `useStablePresence` memoises `teamPresence(runs)` on `activityRunsForActiveGateway` and hands back the previous map whenever the new one says the same thing (state adjusted during render, so no stale frame is painted).
- `samePresence` added to `src/lib/activity/presence.ts`: size plus per-Bot state, order-blind, so a run event that moves nobody is recognised as no change.
- `routableTeam` is a `useMemo` on `team`, and `team` itself only changes when the roster content changes (DRW-3).
- `TeamRow` keys on `bot` identity plus a `TeamPresence | undefined` primitive, so an unrelated gateway value cannot reach the rows.
**What you'll notice:** Gate updates happening in the background no longer make the next drawer opening slower.
**Tests:** In the same new file: a new gateway value with a new `sessionList` and a new activity-runs array of the same presence moves no light or avatar counter while the row still reads "working" (pre-fix: light 2 to 3, avatar 2 to 4); the counter-test shows a presence change bumps only the teammate it is about (pre-fix the untouched row also redrew).
**Review:** passed review first time
**Residual:**
- The gateway provider still rebuilds its value on every update and `SideDrawerContent` still re-renders on each; only the work below it is gone, which is the provider's own package.

### DRW-3
*Responsiveness - package R3D1*

**Status:** Fixed (commit 78f13d5)
**What the operator saw:** Nothing on screen changed, but the team list was rebuilt on every answer from the Gate and on every re-read of the roster.
**Diagnosis:** CONFIRMED as briefed. The roster read's `.then` called `setTeam(bots)` with a fresh array whatever the Gate answered, so a re-read returning the list already shown repainted every team row; `routableTeam` was rebuilt with `filter`/`slice` each render and `teamPresence` returned a new `Map` each render, which would have defeated memoised children.
**Fix:**
- `sameRoster` in `side-drawer-content.tsx` compares id, display name and the two fields `botReportedRoutable` reads (`routable`, `routingIssue`), in order.
- Both `setTeam` calls - the cached paint and the live read - now keep the array already painted when `sameRoster` says it matches.
- `routableTeam` is a `useMemo`; presence is memoised and compared with `samePresence`.
- `liveAnsweredRef`, `cachedAtRef`, `writeCached`, `drawerRosterReadDue`, the failed-re-read note and the retry press are unchanged, so a fresh answer still ages the shared cache.
**What you'll notice:** The team list settles instead of quietly repainting whenever the Gate answers again with the same names.
**Tests:** `drawer-render-memo-test.tsx` "a re-read that answers with the same roster repaints nothing": disconnect, advance 60s, reconnect, so the throttled ledger owes one more `/v1/bots`; `listBots` is asserted called twice and no avatar counter moves (added after the first pre-fix run; it fails pre-fix for the same reason as the other two). New `__tests__/drawer-presence-stability-test.ts` holds six `samePresence` unit tests, including two same-size maps of different Bots.
**Review:** passed review first time
**Residual:**
- `sameRoster` compares in order and only the fields the drawer draws, so a change to an undrawn field such as `description` or `model` will not repaint the rows; `writeCached` still stores the newer copy for the roster screen.

## Report

### What changes for you

- **Hermes threads stop failing with "Unknown provider".** Every rebuilt connection (reconnect, Retry, app resume, gateway switch, late-manifest upgrade) now carries the thread's environment and Bot, and an older app that still sends a turn without them is routed by the Gate to the environment that serves the model instead of a 404. (SCOPE-1..3)
- **The model list only offers what can run.** Not-signed-in providers, the built-in twins your own `kilo` and `opencode-go-session` providers replace (`kilocode`, the header-less `opencode-go` that answers `400 MissingSessionID`), image/audio models, and any model that failed its last two real turns (for 6 hours) are hidden - in Bot pickers too. A thread already pinned to one keeps the row, locked, with the reason. (CAT-1..5)
- **OpenCode threads:** your own message is no longer glued to the reply; a free model that never answers fails in about 60 s with "<model> did not answer within 60 s. OpenCode stopped the turn - try another model." instead of a five-minute "Headers Timeout"; picking a model on a thread with no known model says "New session opened on <model>." (OCB-1..3)
- **Faster screens:** Hermes thread lists answer from the Gate's own copy at once (previously 3 s warm, 30 s timeout cold) and refresh in the background; model lists answer from a cache (previously 3-4 s per open, Bot pickers included); every JSON answer over 1 KB is gzipped (the 241 KB catalogue shrinks to a fraction). (SPD-1/2, CAT-4, NET-1)
- **Reconnecting on a bad link no longer floods the Gate with key-less requests** or tells you your key was rejected; a key-less duplicate of the Gate already saved on the phone is folded back into your paired profile at startup. (AUTH-1)
- **The drawer** does less work when it opens and while it is closed; nothing about its look or animation changed - same elements, same styles, verified by a structural-equivalence test. (DRW-1..3)

### Verification (branch `claude/round3-providers-speed`)

- Every package passed the harness gate (tsc, eslint on changed files, verify-config, related jest, the full Gate suite) and an independent review; the packages that failed review were repaired and re-reviewed (see each finding's **Review** line).
- Full gate on the final combined branch (`9df4acb`): verify-config, `tsc --noEmit` and eslint over `src gate scripts` clean; jest with coverage **717/717 suites, 7,264/7,264 tests**; coverage ratchet pass; Gate suite **1,614/1,614 tests**. Coverage rose to statements 87.50 / branches 79.97 / functions 89.20 / lines 90.13 (round 2: 87.35 / 79.61 / 88.98 / 90.01), and the ratchet's baseline was raised to match.
- **Not yet exercised on the phone or against the live Gate.** The Gate has not been restarted onto this branch and no APK has been built from it.

### Device checks once the Gate is restarted and the APK installed

1. Open a Hermes thread on `kilo/kilo-auto/free`, toggle airplane mode for ~10 s, send again: the reply comes from Hermes (no "Unknown provider").
2. Open the model picker in a Hermes thread and a Bot: no `kilocode`, no built-in `opencode-go`, no `*-image`/`*-audio` rows; a second open is instant.
3. Open the Hermes session list twice: the first may take a few seconds after a Gate restart (the index fills on its first read); the second is instant.
4. In an OpenCode thread, say "Hey bud": the reply does not start with "Hey bud". Pick `opencode/longcat-2.5-preview-free` and send: a clear failure in about a minute if it stays silent.
5. Open and close the drawer repeatedly while a Bot is replying: same look, same animation.
6. After a few reconnects, check the Gate log for `auth refused ... no authorization header` from the phone: there should be none.

### What still needs you

- **Router:** DHCP reservation for the PC (`192.168.1.107`) and a UDP 41641 port-forward to it, so the phone gets a direct Tailscale path away from home; then `tailscale ping ethans-a54` from the PC should say `via <public ip>` rather than `via DERP`.
- **Samsung settings for Tailscale and Versutus:** battery Unrestricted, never sleeping, and Tailscale as Always-on VPN. At home the path is already direct but swings 3 ms-1.2 s, which points at the phone's power saving.
- **Delete the old Hermes backups (~18 GB):** `Get-ChildItem "$env:LOCALAPPDATA\hermes" -Filter "state.db.pre-update-emergency-*" | Remove-Item` (they are not used by anything; Hermes keeps its live `state.db`).

### Left on purpose / not done

- **One-call startup endpoint** (bootstrap): deferred until the startup waterfall can be measured with the session index, catalogue cache, gzip and the key-less-request fix deployed; those removed the measured waits it was meant to hide.
- **The Gate's own provider path records no health verdicts** (CAT-2 residual): your chats go through Hermes, which is covered; the Gate's direct providers are only curated by rule (c).
- **Hermes `/v1/skills` TypeError:** not investigated in this round (it lives in the Hermes install, a host change that needs its own care).
- **Hermes `state.db` (6.2 GB):** untouched by decision; the Gate's index works around its slow reads but Hermes itself still pays them.
- **S2's first attempt hung the Gate suite for 15 minutes:** the cause was not established. It ran while four agents and their test runs loaded the machine; afterwards every test file finished alone, the repaired package passed, and the combined suite runs in ~30 s. (The repair agent later started a background loop of full-suite runs to hunt it, which the integrator stopped.)
