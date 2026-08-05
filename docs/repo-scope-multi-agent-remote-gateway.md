# Versutus — Repo Scope & Gap Analysis: Multi-Agent Remote Gateway

Date: 2026-08-05
Author: Hermes (repo reconnaissance, evidence-based — every claim below cites a file)

## 1. What the repo actually is

**Versutus is a mobile/web *client* for the Hermes API server** (OpenAI-compatible REST + SSE on port 8642, Bearer-token auth). It is NOT a gateway server. The "gateway" it controls is an external Hermes/agent process running on the user's PC; this repo contains no server, relay, or push component.

- Core transport: `HermesGatewayClient` — HTTP + SSE (`src/lib/gateway/client.ts:46-52`, `streamSSE` at :196)
- Legacy OpenClaw WebSocket v4 pairing machinery still present but mostly dormant: Ed25519 device identity (`device-identity.ts`), signed auth payload v3 (`auth-payload.ts`), per-role device tokens (`device-auth-token.ts`), mDNS beacon for `_openclaw-gw._tcp` (`discovery/beacon.ts`)
- README (`README.md:10`, :233-244) still documents the **old** OpenClaw WS v4 protocol while the code speaks Hermes HTTP — **docs drift confirmed**

### Built (evidence)

| Capability | Evidence |
|---|---|
| Streaming chat (`/v1/chat/completions`, SSE deltas) | `client.ts:320-363` |
| Async runs (`/v1/runs` start/status/events/stop/approval) | `client.ts:368-431` |
| Sessions CRUD + message history | `client.ts:244-272` |
| Models, skills, toolsets, capabilities catalog | `client.ts:235-242,436-455`; `dashboard.ts` (885 lines) |
| Slash-command center (~30+ commands: health, status, sessions, channels, usage, cost, stability, logs, models/model, config, plugins, approvals, memory, skills, env, cron, agent status, stop, rpc) | `slash-commands.ts` (1452 lines); `docs/openclaw-gateway-followup.md:26-56` |
| Terminal (Shell/RPC/Agent modes) via `/better-gateway/terminal/stream` SSE | `lib/terminal/client.ts:68-156` |
| Multi-gateway profile store, single active at a time, auto-reconnect w/ backoff, 30s health monitor | `storage.ts`, `client.ts:467-504`, `gateway-provider.tsx` (1212 lines) |
| Discovery: mDNS/zeroconf (LAN), Tailscale host candidates, manual URL, last-success, platform fallbacks | `discovery/scanner.ts`, `candidates.ts`, `url.ts` |
| Crypto device identity (Ed25519), SecureStore token persistence | `device-identity.ts`, `device-auth-token.ts` |
| Capability snapshot (fresh/stale/warming/partial/offline) + feature-family groups | `types.ts:262-268`, `dashboard.ts` |
| EAS build profiles, config plugin, optimization-loop ops scripts | `eas.json`, `plugins/with-openclaw-discovery.js`, `scripts/optimization-loop/` |
| Smoke harness for gateway commands | `scripts/smoke-gateway-commands.mjs` (`npm run smoke:gateway-commands`) |

### Known-dead / blocked state

- Live command smoke: **0/18 passed** — every live gateway call timed out from shell (`openclaw-gateway-followup.md:600-601`)
- `npm run lint` fails (set-state-in-effect, Reanimated shared-value, unused imports) — backlog item `lint-cleanup` P3
- 12 modified files uncommitted on `master` (all in `src/lib/gateway/*`, `gateway-provider.tsx`, terminal client, add-screen variants)

---

## 2. Gap analysis — what's missing for a *comprehensive multi-agent remote gateway*

### A. Multi-agent (the biggest conceptual gap)

Today the app is **one chat ↔ one session ↔ one agent** with a command center bolted on. "Multi-agent" exists only as slash-command fragments.

| Missing | Evidence / current state |
|---|---|
| **Agents registry UI** — no Agents tab; agent list/identity/status only via `/model agent <id>` and `/agent status` text output; no per-agent model/tool/capability summary screen | Tabs are Home/Chat/Terminal only (`src/app/(tabs)/`); `slash-commands.ts` `AgentListSnapshot` is text-formatting only |
| **Agent sessions** — no per-agent session scoping in UI; session selector exists but is chat-global, not per-agent | `components/chat/session-selector-sheet.tsx`; client session is a single `currentSessionId` (`client.ts:59`) |
| **Run management UI** — client has full runs API (`startRun`, `streamRunEvents`, `stopRun`, `resolveApproval`) but no run list screen, no live run monitor, no run history, no per-run cost/tokens view | `client.ts:368-431`; no runs UI anywhere in `src/app` |
| **Approvals UI** — `resolveApproval` exists in client; the only "approval" UI is the *pairing* panel (device pairing), not *run-exec* approval; pending approvals are slash-command text only | `client.ts:426-431`; grep of `src/app` finds approvals only in pairing contexts |
| **Delegation / orchestration** — no way to spawn sub-agents, fan out parallel tasks, or view agent hierarchy from the phone | absent entirely (Hermes `delegate_task` runs on the server; nothing exposes it) |
| **Concurrency & queues** — no queued/parallel run model in the UI, no "agents working now" activity feed | absent |
| **Fleet / cross-gateway view** — profiles exist but exactly one gateway is active at a time; no aggregated view of agents across multiple PCs/gateways | `gateway-provider.tsx` single-active design |

### B. Remote connectivity (the "remote" gap)

"Remote" today = **Tailscale or LAN only**. There is no public-internet path, no wake, no background delivery.

| Missing | Evidence |
|---|---|
| **Push notifications** — `expo-notifications` not in `package.json`; no FCM/APNs. A run finishing or an approval being requested while the app is backgrounded is invisible until the user opens the app | package.json deps (grep confirms zero push/background packages) |
| **Background execution** — no `expo-background-fetch`/`expo-task-manager`; SSE streams die when the app backgrounds; no keepalive job | package.json |
| **NAT traversal / relay** — no TURN/STUN, no wss relay, no Cloudflare-Tunnel/Tailscale-Funnel integration, no rendezvous server. Off-LAN = dead unless the host runs Tailscale | `candidates.ts` (ts.net + LAN + fallbacks only) |
| **TLS enforcement** — `shouldUseTlsForHost` always returns false (`url.ts:20-24`); bearer tokens travel plain HTTP on LAN/tailnet; `tlsFingerprint` from beacons is displayed ("pinned" label) but **never verified** | `url.ts:20-24`; `discovered-gateway-row.tsx:70` cosmetic only |
| **Cloud device enrollment / QR onboarding** — no hosted rendezvous; discovery is mDNS-only (LAN); no shareable add-link | `discovery/scanner.ts` |
| **Offline outbox** — messages fail when disconnected; no queue-and-retry, no command persistence while offline | `transcript.ts` is read-only history |
| **Deep-link onboarding** — `expo-linking` present, scheme `versutus`, but no documented `versutus://add?url=...` flow | app.json:8; no link handling code found |

### C. Security & identity

| Missing | Evidence |
|---|---|
| No per-device token issuance in the HTTP path — HTTP client uses a single shared Bearer `profile.token`; the Ed25519 identity/signed-payload machinery is effectively dead code for Hermes gateways | `client.ts:133-141` vs `device-identity.ts` |
| No cert pinning verification (fingerprint parsed but unused) | `url.ts:61-64` → cosmetic label |
| No token rotation / revoke UX; no scope/role display after connect (hello carries scopes but UI shows no role summary) | `types.ts:179-188`; UI grep |

### D. Reliability, testing, ops

| Missing | Evidence |
|---|---|
| **Zero automated tests** — no jest/vitest, no component tests, no API-mock tests for the client state machine | package.json; no `.github` (no CI) |
| **Lint red** — known debt list in followup doc | `openclaw-gateway-followup.md:130-148` |
| **Live verification blocked** — smoke harness 0/18; most endpoints never live-verified; command verification flags (`verified`/`unverified`) exist but unfilled | `openclaw-gateway-followup.md:600-601` |
| **No observability** — no crash reporting, no analytics, no structured logs | absent |
| **Docs drift** — README/app.json say OpenClaw WS v4 + `openClawGatewayHosts`; code is Hermes HTTP; `GatewayProfile` comment says "Hermes API server" | `README.md:10` vs `types.ts:9-13` |
| **Uncommitted work** — 12 modified files not committed | `git status` |

### E. Platform completeness

| Missing | Evidence |
|---|---|
| iOS is a thin re-export of the web variant (`settings.ios.tsx` = 1 line); native iOS splits exist only for a few components; Android is the only fully-native target | `src/app/gateway/settings.ios.tsx:1` |
| Web NativeTabs fallback still a backlog item | `features-backlog.json` `web-native-tabs-fallback` (P3) |

---

## 3. What is NOT missing (build on this)

- Strong crypto identity foundation (Ed25519, SecureStore, challenge/response) — ready to repurpose for device-scoped API keys
- Real streaming stack (SSE parser, abort/stop plumbing, run event stream) — push-style delivery is half-built
- Full slash-command framework with scopes, danger levels, verification flags, compact formatters — the "API surface" of the gateway is largely mapped
- Auto-connect candidate resolution with graceful degradation — the hardest UX problem is largely solved
- Capability dashboard architecture — ready to become an agent/fleet dashboard
- Operational automation loop (optimization pipeline) and EAS builds

## 4. Prioritized path to "comprehensive multi-agent remote gateway"

**P0 — make it actually usable remotely (product-defining)**
1. Push notifications (expo-notifications + FCM): run-complete, approval-requested, agent-error, gateway-down
2. Run approval UI (native sheet) wired to `resolveApproval` — this is the killer feature of a remote agent gateway: approve actions from the phone
3. Background SSE keepalive / task-manager heartbeat, or lean fully on push + poll-on-foreground

**P1 — make it multi-agent**
4. Agents tab: registry (list, identity, status, per-agent model/tool/capability), per-agent session picker, activity feed of running/queued runs
5. Run monitor screen (events stream, stop, cost/tokens) + run history
6. Fleet view: multiple gateways simultaneously connected, cross-gateway agent directory

**P1 — make it truly remote & safe**
7. Relay path: Tailscale Funnel or a small wss relay server (this repo would need its first server component, or a companion repo) + HTTPS-only mode
8. TLS pinning enforcement (use the beacon fingerprint already collected) + token rotation UX
9. Device-scoped tokens: issue per-device API keys via the existing Ed25519 identity instead of sharing one Bearer

**P2 — make it shippable**
10. Tests (jest + client-state-machine tests with a mock gateway), CI (GitHub Actions: tsc + lint + smoke against a real gateway), fix lint debt
11. Live-smoke every slash command, fill `verified/unverified/experimental` flags
12. Commit the 12 dirty files; rewrite README/protocol section; rename `openClawGatewayHosts` → `gatewayHosts`
13. iOS parity pass, web tabs fallback, deep-link add-gateway

## 5. Bottom line

Versutus is a **polished single-gateway remote *console*** with a mapped-out command surface, solid crypto foundations, and a good auto-connect story — but it is **client-only, LAN/tailnet-bound, single-agent, and unverified** (no tests, lint red, smoke blocked). To become a *comprehensive multi-agent remote gateway* it needs, in order: **push notifications + run approvals (P0)**, an **Agents surface with run monitoring (P1)**, a **public relay/TLS path (P1)**, and **tests/CI/docs hygiene (P2)**.
