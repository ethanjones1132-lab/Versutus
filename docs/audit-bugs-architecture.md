# Versutus — Comprehensive Bug & Architecture Audit

Date: 2026-08-05
Method: full read of provider, portal layer, storage, discovery, command engine + targeted greps. Every finding cites `file:line` evidence. Verified against HEAD (pre-migration) where dialect behavior matters.

## Resolution status (2026-08-05, same day)

| Finding | Status |
|---|---|
| P0-1 cleartext HTTP blocked in release builds | **FIXED** — `expo-build-properties` `android.usesCleartextTraffic: true` (verified in generated AndroidManifest via real prebuild) + ATS `NSAllowsArbitraryLoads`/`NSAllowsLocalNetworking` via the config plugin (merge logic verified; full iOS prebuild not possible on Windows) |
| P0-2 secrets in plaintext AsyncStorage | **FIXED** — `secure-key-value.ts` (SecureStore) now backs gateway profiles + device identity + active id; stale `scripts/test-gateway.mjs` (hardcoded token) and `verify-client.mjs` deleted |
| P0-3 slash commands unmapped for Hermes | **FIXED** — pure `rpc-routes.ts` map (23 methods, docs-evidence-based) incl. `session.fork/chat/chat.stream`, `responses.get/delete`, `jobs.run`; path-placeholder interpolation (previously broken for `session.get`/`session.messages`); **per-method `METHOD_GUIDANCE`** for all 40+ genuinely-unmapped methods (config/channels/approvals-list/env/artifacts/agents/devices/talk/logs/session-abort-compact) — commands now answer with an actionable next step instead of a bare failure; `X-Hermes-Session-Key` header; per-request model override; sessions group detected via `endpoints.session_*` |
| P1-1 OpenClaw chat event shape | **FIXED** — `handleChatEvent` reads `message.content`/`errorMessage`/`runId` per the verified dialect; signal listeners detached on completion |
| P1-2 model picker sends literal `/model set` | **FIXED** — Hermes: per-request model override persisted on the profile; OpenClaw: routes to `/model set` command |
| P1-3 stopStreaming dead branch | **FIXED** — dead `stopRun` branch removed; abort path documented (OpenClaw additionally issues `session.abort`) |
| P1-4 terminal without auth | **FIXED** — Bearer header on stream/input/resize; web unified onto fetch+reader (EventSource dropped, so auth works on web too) |
| P1-5 agentId silently dropped | **FIXED** — `GatewayProfile.agentId` persisted end-to-end, sent in OpenClaw `chat.send` |
| P1-6 agent-command output discarded | **FIXED** — agent-transport slash commands stream deltas into the running command bubble and return full text |
| P2-1 pairing UI decorative | **FIXED** — device identity loaded at bootstrap; `onPairingRequired` wired to `pairingDetails` |
| P2-2 capability catalog static | **FIXED** — `/v1/capabilities` fetched on connect + refresh; `buildCapabilitySnapshot` uses feature flags when the hello carries no scopes (fixes perpetual "warming" on Hermes) |
| P2-3 beacon kind dead + no OpenClaw auto-discovery | **FIXED** — TXT `kind` parsed into `DiscoveredGateway`; auto-connect connects kind-flagged WS beacons directly; `resolveGatewayForUrl` preserves kind |
| P2-4 unbounded chat context | **FIXED** — last-20 real turns, command payloads excluded |
| P2-5 identification up to ~18s | **FIXED** — per-stage remaining-budget enforcement |
| P2-8 no session creation | **FIXED** — `createSession` fallback in `reloadHistoryFor` (Hermes REST; OpenClaw `sessions.create`) |
| Verification | tsc 0 errors; `smoke:portal` 36/36 (identification, mapping, route map, capability snapshot); lint unchanged at 15 pre-existing errors (0 new) |

Remaining (roadmap features, not regressions): push notifications, run-approval UI, relay server (Phase D), manifest-driven custom transport (Phase E), remaining unmapped command families, repo-wide lint debt (`lint-cleanup`).

---

## Original findings (for reference)

---

## P0 — Release-blocking

### P0-1. Production builds cannot reach gateways (cleartext HTTP blocked)
The entire product talks **plain `http://`** to gateways (LAN, tailnet, `127.0.0.1` — `candidates.ts:72-84`, `normalizeGatewayUrl` defaults to `http`, `url.ts:38`). Nothing anywhere enables cleartext:
- Android 9+ blocks cleartext by default in **release** builds; no `android.usesCleartextTraffic`, no `networkSecurityConfig` in `app.json` (checked), `eas.json` (no `buildProperties`), or `plugins/with-openclaw-discovery.js` (adds only INTERNET/NETWORK/WIFI permissions).
- iOS ATS blocks plain HTTP in release; no `NSAllowsArbitraryLoads` / `NSAllowsLocalNetworking` in the InfoPlist plugin.
- **Effect:** the APK/AAB that ships cannot connect to any gateway. Debug/Expo Go works (dev exceptions), which is why this has not surfaced. `tailnetServe` https would work — but `shouldUseTlsForHost` always returns false (`url.ts:20-24`).
- Fix: `expo-build-properties` with `android.usesCleartextTraffic: true` + iOS `NSAllowsLocalNetworking` (scoped) or a network security config permitting RFC1918 + `100.64/10` + `*.ts.net`.

### P0-2. Secrets in plaintext AsyncStorage
- `GatewayProfile.token` (the Hermes `API_SERVER_KEY` bearer) — `storage.ts:21` → `keyValueStorage` → **AsyncStorage** (`key-value.ts:31,39`), unencrypted on device.
- The Ed25519 device **private key** — `device-identity.ts:80` → same plaintext store.
- The codebase already has the right pattern: `device-auth-token.ts:64-66` uses SecureStore. Gateway tokens + identity should move there (AsyncStorage fallback only in dev).
- Also: `scripts/test-gateway.mjs` contains a **committed, hardcoded gateway token** (`'ce297599f3dbed257b3ffc5d8ce249201dd14bc5d51d13fc'`) plus imports of openclaw dist internals — a stale OpenClaw relic; delete or strip.

### P0-3. Slash-command center speaks OpenClaw dialect; Hermes (the primary target) can't run most of it
`GATEWAY_COMMANDS` + handlers reference **42 distinct RPC methods** (`dashboard.ts` registry + `slash-commands.ts` handlers); `HermesGatewayClient` maps only **10** (`client.ts:533-544` METHOD_TO_ROUTE). Unmapped (32): `agents.list`, `config.get`, `config.patch`, `config.schema`, `channels.*`, `approvals.*`, `cron.*`, `env*`, `skills.*`(detail), `artifacts.*`, `session.abort/compact/restore/usage`, `logs.tail`, `devices.*`, `talk.*`, `diagnostics.*`, `model.*` (agent routing)…
- **Effect:** on a Hermes gateway, `/model`, `/config`, `/session abort`, `/approvals`, `/cron`, `/env`, `/agents`… all throw `Unknown method: X`. The 0/18 smoke result in the followup doc was this exact gap.
- The method names themselves are OpenClaw-shaped (`config.patch {raw, baseHash}` — `slash-commands.ts:341`). Dual-dialect execution is the single biggest functional gap: needs either a Hermes route map for every command (REST paths exist: `/v1/config`, `/api/sessions/{id}/abort`…) or an adapter-level `rpcRequest` translator.

---

## P1 — High-impact bugs

### P1-1. OpenClaw chat streaming is broken in the new adapter (field-shape mismatch)
`OpenClawAdapterClient.handleChatEvent` (`openclaw-adapter.ts:180-207`) reads `payload.deltaText` (deltas) and `payload.text` (final fallback). The **verified** OpenClaw dialect (old handler, `de4bb57:src/context/gateway-provider.tsx:380-432`, plus the old `ChatEventPayload` type) is:
```ts
{ runId?, sessionKey?, state?: 'delta'|'final'|'error'|'started',
  deltaText?, errorMessage?,
  message?: { role?, content?: string|Array<{type?,text?}>, timestamp? } }
```
The authoritative handler extracts text via `extractMessageText(payload.message?.content)` — the payload is nested under `message`, and `errorMessage` carries the error text. My adapter never reads `message.content`/`errorMessage` →
- deltas dropped (no streaming UI), `final` resolves `''` → **blank assistant bubble on every OpenClaw reply**;
- errors surface as "Chat failed on gateway" instead of the real message;
- no `runId` correlation (single-slot pendingChat instead of keyed by run id);
- the `payload.state === undefined && payload.text` branch can misfire as terminal.
- Fix: `const chunk = payload.deltaText ?? extractMessageText(payload.message?.content);` for delta; `final` resolves `payload.deltaText ?? extractMessageText(payload.message?.content) ?? ''`; `error` rejects with `payload.errorMessage ?? …`; key pending chats by `runId` when present.

### P1-2. Model picker sends `/model set …` as a literal chat message
`selectModel` (`gateway-provider.tsx:1133-1136`) → `sendMessage(...)` → `streamChat` — the gateway receives the text `/model set x` as a user message. Picker sheet `onSelect={selectModel}` (`chat.android.tsx:198`). Must be `sendChatInput` (which routes to the command engine). As-is, every picker selection produces a chat reply about the command instead of changing the model.

### P1-3. stopStreaming: dead stop-run branch + no server-side stop for Hermes chat
- `activeRunIdRef.current = null` is executed **before** the `if (client && activeRunIdRef.current)` check (`gateway-provider.tsx:957` vs `967`) — `client.stopRun` is unreachable dead code.
- Even if reached: `activeRunIdRef` holds a local message id (`run-<ts>-<rand>`, `:735`), not a server run_id — `POST /v1/runs/{fake}/stop` 404s. For Hermes chat streams, "stop" only aborts the local fetch (`abortController.abort()`); **the server keeps generating** (tokens keep burning). Only `/v1/runs` tasks have a real stop. Gap: chat-completion cancellation needs a server endpoint or a runs-based path.

### P1-4. Terminal client sends no auth
`terminal/client.ts` — stream/input/resize fetches carry only `Content-Type` (`:162,177`), no `Authorization`. On a token-protected gateway (the standard Hermes setup), terminal is 401-dead. Web path uses `EventSource` which cannot set headers at all (needs `?token=` or cookie).

### P1-5. `agentId` silently dropped — multi-agent direction lost
`add.tsx` collects Agent ID (`:19,:212`) but `createGatewayProfile` (`storage.ts:53-78`) never persists it (`GatewayProfile` has no `agentId`), and the OpenClaw adapter's `chat.send` sends only `sessionKey` (`openclaw-adapter.ts:169-174`) — the old flow targeted `gateway.agentId` (HEAD). User input is discarded; you cannot pick which agent on the gateway you're talking to.

### P1-6. Agent-transport commands discard their output
`runAgentCommand` (`gateway-provider.tsx:607-623`) streams chat with an **empty onDelta** and returns immediately; `runCommand` then reports "complete" with `summarizeCommandResult(command, {})` — an empty summary (`slash-commands.ts:273-276`). Commands like `/agent status` appear to succeed with no output, and history reload is the only reconciliation.

---

## P2 — Medium

### P2-1. Pairing UI is decorative
`deviceId` (`gateway-provider.tsx:206`) and `pairingDetails` (`:207`) are `useState` with **no setter ever called** — the PairingSheet shows an empty device id and null details even during OpenClaw `pairing` status.

### P2-2. Capability snapshot is static, not live
`refreshCapabilities` (`:1102-1114`) only calls `healthCheck()`; the snapshot is derived from hello scopes (`dashboard.ts:726-757`). `client.getCapabilities()` (`client.ts:235`) and `/v1/capabilities` are never called — the "live capability catalog" feature is unimplemented.

### P2-3. Beacon kind fast-path is dead + OpenClaw auto-discovery impossible
`DiscoveredGateway` (`discovery/types.ts`) has no `kind`; `beaconFromZeroconfService` doesn't parse TXT `kind`; `identifyGateway`'s `beaconKind` option (`identify.ts:75`) has zero callers. All discovered URLs are built as `http://` (`url.ts:57-79`) regardless of TXT `transport` → auto-connect HTTP-probes OpenClaw beacons and skips them. OpenClaw gateways are manual-add-only.

### P2-4. Unbounded chat context
`sendMessage` re-sends the **entire** message history as conversation context on every send (`gateway-provider.tsx:749-754`) — long chats become huge prompts; no windowing/compaction anywhere.

### P2-5. Identification can take ~18s in the add flow
`identifyGateway` runs manifest (4s) → hermes (5s) → openclaw WS (6s) → http-alive (3s) sequentially with no early-exit budget enforcement (`identify.ts`); the add screen spinner can hang 10-18s on an unresponsive host.

### P2-6. Reconnect policy drift + dead constant
`MAX_RETRIES = 3` (`client.ts:29`) unused; reconnect caps at **5 attempts** (`:493`) vs README's "12 attempts"; README/`app.json` still describe the OpenClaw WS protocol and `openClawGatewayHosts` naming (doc drift — partially addressed, residue remains).

### P2-7. Reachability probe waves
`useGatewayReachability` re-probes **all** saved gateways sequentially (1.8s timeout each) on every `status`/`gateways` change; overlapping waves aren't cancelled between runs (`use-gateway-reachability.ts:31-112`).

### P2-8. No explicit session creation
`reloadHistoryFor` comment says "or create one" but never calls `createSession` (`gateway-provider.tsx:252-262`) — first-run chats run without a session id until the server auto-creates one.

---

## Architecture gaps (confirmed with evidence)

| Gap | Evidence |
|---|---|
| **Single-active gateway, no fleet view** — one `activeId`, one client at a time | `storage.ts:39-49`, `clientRef` single slot |
| **Not actually remote** — tailnet/LAN only; no push, no background, no relay; SSE dies when app backgrounds | no `expo-notifications`/`task-manager`/`background-fetch` in `package.json` |
| **No TLS enforcement** — `tlsFingerprint` displayed ("pinned") but never verified | `url.ts:61-64`, `discovered-gateway-row.tsx:70` |
| **No run-approval UX** — `resolveApproval` client-ready, zero UI | `client.ts:426-431` |
| **No tests / CI** — no jest/vitest, no `.github`; lint 15 errors (pre-existing debt) | `package.json`, repo root |
| **iOS is a web re-export** — `settings.ios.tsx` = 1-line re-export; native splits Android-only | `src/app/gateway/settings.ios.tsx:1` |
| **custom/unknown kinds fall back to the Hermes HTTP client** — manifest-driven generic transport (Phase E) unbuilt; a custom gate with `chat:true` manifest connects but chat hits Hermes-shaped endpoints | `adapters.ts:83-90` |
| **Dual-dialect command engine incomplete** (P0-3) — one registry, one route map, two dialects | `client.ts:533-544` vs `dashboard.ts` |
| **Discovery is OpenClaw-branded, Hermes-shaped** — service type `_openclaw-gw._tcp`, HTTP probe | `beacon.ts:5-6`, `probe.ts:20` |
| **No offline outbox / queue** — messages fail when disconnected; local-only command transcripts can't be retried across gateways | `transcript.ts` |

## Strengths (verified, not assumed)
- Clean adapter seam: `PortalClient` surface + kind dispatch works; Hermes unchanged, OpenClaw salvaged.
- Reconnect/backoff + health monitor are solid; auto-connect candidate fallback chain is well-designed.
- Ed25519 identity + challenge/response machinery is correct crypto; SecureStore pattern exists (just not applied to profile tokens).
- No TODO/FIXME/console.log litter; typed routes + strict TS; `tsc` clean.

## Prioritized fix plan
1. **P0-1** cleartext config (5 min, unblocks every release build) + **P0-2** move secrets to SecureStore + scrub `test-gateway.mjs`
2. **P1-1** delta field fix (3 lines, unblocks OpenClaw chat) + **P1-2** selectModel → sendChatInput (1 line)
3. **P0-3** Hermes route map for the 32 unmapped methods (biggest surface — do per-command-family: models/config/sessions first, then channels/approvals/cron/env)
4. **P1-3/4** terminal auth + real chat-stop path; **P1-5/6** agentId persistence + agent output surfacing
5. P2s + architecture phases (push/notifications/approvals UI, relay, capability catalog live wiring)
