# Failure audit — 2026-09-30 (running list)

Theme of the day: **remove failures.** The app must work as intended every time — no failed
fetches or data retrievals, faster retrievals, a connection that persists, and the rest.

This document started as a **list** (nothing was changed while scanning) and now also records
the fix for each entry. Every entry says *where* it is, *what* fails, and *why* it fails; the
*Fix status* line under it, and the companion fix log, say what was done. Entries are appended as
the scan continues (see the second-pass sections at the end); IDs are stable so fix commits can cite them.

- Branch/commit scanned: `claude/app-failure-audit-fc957c` @ `67306a9` (== `master`).
- Scan method: read the connection path end to end (client, transport, monitor, provider),
  the Gate server and its supervisors, storage, notifications, the voice path (JS + Kotlin) and
  samples of the UI; ran `tsc`, ESLint, jest and the Gate test suite for an objective baseline.
- Prior audits (`docs/audit-bugs-architecture.md`, `docs/gap-and-bug-audit-2026-08-19.md`) were
  read first. Their findings are recorded as fixed; nothing below repeats a finding they closed.

## Update - fixes landed

Of the 60 findings: **52 fixed**, **1 partly fixed** (a part rides on another package or a follow-up is named), **7 not fixed** (each is a decision or needs your action - see the entries). The full diagnosis and fix for every finding is in [failure-audit-2026-09-30-fixes.md](failure-audit-2026-09-30-fixes.md); each finding below carries a *Fix status* line linking to it. The fixes are commits on branch `claude/app-failure-audit-fc957c` (not pushed, not deployed). Verification on the integration branch: `tsc`, ESLint (0 errors), full jest with coverage and the coverage ratchet, the Gate suite and the Kotlin unit tests (in a scratch Android tree) all pass; the `[device?]` items still need a phone to confirm the real-world effect.

**Confidence labels**

| Label | Meaning |
|---|---|
| `[read]` | Traced by reading the code path; no runtime reproduction. |
| `[run]` | Reproduced or measured by running a command. |
| `[device?]` | The mechanism is clear from code but the trigger depends on Android/network behaviour the Node-based gates cannot see (the class `gap-and-bug-audit` §0 warned about). Needs a phone to confirm. |
| `[known]` | Already recorded elsewhere in the repo; listed here only for completeness. |

**Severity**

| S | Meaning |
|---|---|
| **S1** | Crash, data loss, or a failure on a common path the user hits. |
| **S2** | Failure under realistic conditions, or a large avoidable delay. |
| **S3** | Edge case, hardening gap, or inert/misleading behaviour. |

---

## 0. Baseline (what the automated gates say)

| Gate | Result |
|---|---|
| `tsc --noEmit` | **Clean** (0 errors) — with a complete `node_modules` (see ENV-1). |
| `jest` (parallel run) | 634/636 suites, 6284/6286 tests pass. The 2 failures are 5 s timeouts under load (TEST-1); both pass alone. |
| Gate tests (`node --test`) | **1185/1185 pass.** |
| ESLint (`src gate scripts modules`) | 7 errors, 13 warnings. The 7 errors are all in `scripts/` (not covered by `npm run lint`) — LINT-1. |

The gates are green; every S1/S2 below survives them, which is the point — they are all in paths
the Node test apparatus cannot exercise (device runtime, real sockets, thread timing, process
lifecycle).

## 1. Index

| ID | S | Area | One line |
|---|---|---|---|
| BG-1 | S1 | Background | A chat turn lives exactly as long as the phone's socket; locking the phone cancels it and no push follows. |
| LIFE-1 | S1 | Lifecycle | Foreground recovery can blank the visible chat and the capability hello, and nothing repopulates them. |
| LIFE-2 | S1 | Lifecycle | A rejected token is retried forever and its error message is erased after ~12 s. |
| GATE-1 | S1 | Gate | Unhandled child-process / stdin errors and no process-level handler: one bad spawn or EPIPE kills the whole Gate. |
| VOICE-1 | S1 | Voice (Kotlin) | Uncaught `InterruptedException` in the playback thread on hang-up — process-fatal on Android. |
| NET-2 | S2 | Transport | No SSE keepalive (Gate) and no idle detection (phone): a half-open socket leaves the composer locked. |
| NET-3 | S2 | Transport | The phone's 8 s session-list timeout is shorter than the read the Gate is documented to need; retries multiply load. |
| LIFE-3 | S2 | Lifecycle | No network-change signal; a dead path is found by a 30 s poll × 2, up to ~70 s. |
| SPD-1 | S2 | Speed | Cold connect is a serial chain with duplicated fetches (manifest ×3, health ×2, models ×2). |
| SPD-2 | S2 | Speed | The probe wave waits for the slowest candidate before the fastest can win. |
| SPD-3 | S2 | Speed | A 200-session list is read at the start **and** end of every chat turn. |
| SPD-4 | S2 | Speed | ~10 reads fan out on every `connected` transition, including self-heals. |
| SPD-5 | S2 | Data | Only the manifest is cached; every other retrieval blanks the UI while loading or offline. |
| SPD-7 | S2 | Gate | Resolving a backend for a route starts every backend server in order; a dead one stalls 30 s per request. |
| GATE-2 | S2 | Gate | The Codex (stdio) backend never recovers after its process dies. |
| GATE-6 | S2 | Gate | Auth stores write non-atomically and swallow read errors → spurious 401s, possible loss of paired devices. |
| GATE-7 | S2 | Gate | Unauthenticated pairing endpoint reads unbounded bodies and grows unbounded state. |
| SEND-2 | S2 | Chat | A streamed turn with no session id creates a new Hermes session per message, silently. |
| SEND-7 | S2 | Runs | A run driver gives up on the first transient status failure. |
| STORE-1 | S2 | Storage | Command transcripts persist per streamed delta through an unserialized read-modify-write. |
| UI-1 | S2 | UI | A single failed roster re-read wipes the Bot list down to "configurable chat". |
| UI-2 | S2 | UI | Pausing/resuming a routine folds an empty list as a successful read. |
| VOICE-2 | S2 | Voice (Kotlin) | `JitterBuffer` is shared by three threads with no synchronization. |
| VOICE-3 | S2 | Voice | The native error frame is hand-built JSON; a quote in the message defeats the reconnect path. |
| ENV-1 | S2 | Env | The main checkout's `node_modules` is incomplete; `npm run verify` cannot pass there. |
| NET-1 | S2 | Transport | Request timeout is cleared when headers arrive; a stalled body is unbounded. |
| NET-4 | S3 | Transport | Saved-gateway reachability uses a 1.8 s timeout the codebase itself calls too short. |
| NET-5 | S3 | Transport | Terminal input POST: no timeout, no DNS fallback, no ordering. |
| NET-6 | S3 | Transport | `authorizedFetch` has no timeout for non-stream calls. |
| NET-7 | S3 | Transport | A broken MagicDNS name pays a failed lookup before every request. |
| LIFE-5 | S3 | Lifecycle | `disconnect()` does not cancel an in-flight `connect()`; a connect that lands afterwards restarts the monitor. |
| LIFE-6 | S3 | Lifecycle | Switching gateway leaves the UI "connected" to the old client for up to ~21 s. |
| LIFE-7 | S3 | Security | The TLS fingerprint "change" guard compares a profile's fingerprint to itself and can never fire. |
| LIFE-8 | S3 | Lifecycle | Deleting the active gateway waits on a best-effort deregister for up to 30 s. |
| SPD-6 | S3 | Speed | Bot roster is re-read on every roster visit and reconnect with no cache. |
| SPD-8 | S3 | Speed | A known Gate that is down takes ~21 s before its cached manifest is used. |
| SEND-3 | S3 | Chat | Stop removes the partial reply from view. |
| SEND-4 | S3 | Chat | `/agent` commands can't be cancelled and leave `activeRunIdRef` set. |
| SEND-5 | S3 | Chat | `/model <name>` computes a validation and throws it away. |
| SEND-6 | S3 | Chat | 14 fire-and-forget profile writes have no `.catch` and several write a stale copy. |
| STORE-2 | S3 | Storage | One SecureStore item holds every gateway; any Keystore hiccup reads as "SecureStore unavailable". |
| STORE-3 | S3 | Storage | Transcript/queue loads are unguarded; one throw fails all of bootstrap or history. |
| UI-3 | S3 | UI | `HandsfreeCallBanner` runs a 1 Hz timer for the whole app lifetime. |
| UI-4 | S3 | UI | No root error boundary, no global JS error handler, no crash/failure telemetry. |
| UI-5 | S3 | UI | Terminal: any status blip closes the live shell; input is cleared before the send succeeds. |
| NOTIF-1 | S3 | Notifications | `ensurePermission` re-asks on every notice and asks from the background. |
| PUSH-1 | S3 | Gate | Push receipts are requested immediately after send, before they exist. |
| GATE-8 | S3 | Gate | Provider-path chat isn't aborted on client disconnect and has no upstream timeout. |
| GATE-9 | S3 | Gate | Environment run-event SSE loop never notices the client leaving. |
| GATE-10 | S3 | Gate | `DELETE /v1/jobs/:id` and `DELETE /v1/sessions/:id` fall through to a generic 500. |
| GATE-11 | S3 | Gate | `/health` is process liveness only; backend outages are invisible to the app's monitor. |
| GATE-12 | S3 | Gate | `gate/` imports `ws` but declares no dependencies. |
| VOICE-4 | S3 | Voice (Kotlin) | No WebSocket ping; a half-open call link is undetected on the phone. |
| VOICE-5 | S3 | Voice (Kotlin) | Capture/VAD loops spin without backoff on a failing `AudioRecord.read`. |
| VOICE-6 | S3 | Voice | Hands-free calls never open `[known]` (PENDING.md). |
| TEST-1 | S3 | Tests | Two suites time out (5 s) when jest runs in parallel. |
| LINT-1 | S3 | Tooling | `scripts/` and `modules/` are outside the lint gate; 7 real `no-undef` errors live there. |
| COV-1 | S3 | Tooling | Coverage is measured for `src/lib/gateway/**` only. |
| CFG-1 | S3 | Config | The fallback host list is hard-coded in `app.json`. |
| DEAD-1 | S3 | Dead code | mDNS discovery is disabled but its code paths remain on the connect path. |

---

## 2. Background & persistence

### BG-1 · S1 · A chat turn lives exactly as long as the phone's socket `[read]` `[device?]`

> **Fix status:** Fixed - package(s) G4, P1, P2b, commit(s) `203821b`, `19de6a2`, `4a9e3cc` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#bg-1)

**Where:** `gate/core/server.mjs:85-90` (`res.on('close') → controller.abort()`),
`gate/core/server.mjs:2235-2246` (push only when the turn completed while connected),
`gate/core/voice/turn-runner.mjs` (abort races the backend turn), `src/context/gateway-provider.tsx:3677-3703`
(background handling), `:2652-2655` (interrupted bubble).

**What fails:** Send a message, lock the phone (or switch app/network). The turn is cancelled or its
result is never delivered, and no notification arrives.

**Why:**
1. The Gate treats *any* response close as "the client walked away" and aborts the upstream turn
   (`server.mjs:80-90`). Android suspends/kills the socket of a backgrounded app within seconds to
   minutes, which the Gate reads as a Stop.
2. The completion push is sent only `if (streamed)`, and `streamBackendTurn` returns `null` for a
   dropped turn on purpose (`server.mjs:138`, "silence, not a finished notice"). So a turn that
   *did* finish upstream after the phone dropped produces no push either.
3. On the phone, a non-active `AppState` only suspends reconnect (`gateway-provider.tsx:3677-3684`).
   Nothing keeps a socket alive, and on return the handler only health-checks
   (`:3687-3703`) — it does not re-read history. The stream's rejection lands in the `catch`
   as `markInterrupted` (`:2652`), and the transcript is only reconciled by a full reconnect
   cycle (`onHealthCheck` → `reloadHistoryFor`, `:1556-1626`). If the client never noticed a
   disconnect there is no such cycle.

`/v1/runs` is the detachable pattern (start, poll, replay from archive). Chat turns are not.
This is the structural reason "persist the connection in the background" cannot work today.

### LIFE-3 · S2 · No network-change signal `[read]`

> **Fix status:** Fixed - package(s) P1, W1, commit(s) `19de6a2`, `5d2d9c0` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-3)

**Where:** `package.json` (no `@react-native-community/netinfo` / `expo-network`),
`src/lib/gateway/connection-monitor.ts:1,26,110-144`, `src/lib/gateway/client.ts:55`.

**What fails:** Wi-Fi ↔ cellular ↔ Tailscale changes are not observed. The only detector is the
health interval: `HEALTH_INTERVAL_MS = 30 s`, `HEALTH_FAILURE_THRESHOLD = 2`, each probe up to
`HEALTH_CHECK_TIMEOUT_MS = 12 s`. Between ≈ 42 s and ≈ 72 s pass from
path loss to `reconnecting` (path dies just before a tick: 30 + 12; just after one: 60 + 12). Meanwhile every request runs into a dead path with a 30 s timeout
(`DEFAULT_TIMEOUT_MS`), and an in-flight stream has no watchdog (NET-2).

**Why:** Reconnect is driven only by polling and by app foreground; no event says "the network
changed".

---

## 3. Connection lifecycle

### LIFE-1 · S1 · Foreground recovery can blank the chat and the capability hello `[read]` `[device?]`

> **Fix status:** Fixed - package(s) P2a, commit(s) `a59aeb2` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-1)

**Where:** `gateway-provider.tsx:3701-3703` → `:3648-3664` → `:1744-1757` (`connectGateway`) →
`:1375-1385` (`attachClient` early return).

**What fails:** Return to the app after a while, first `/health` (6 s) misses, then the chat shows
empty, `activeHello` is `null`, `isSending` is reset, and the live session id is replaced by the
profile's stored one. Nothing re-fills them until something else forces a reconnect or a manual reload.

**Why:**
1. The foreground handler sees `status === 'connected'`, runs `client.healthCheck(6000)`, and on a
   miss calls `reconnectLastKnownGateway()`.
2. That probes (12 s) and, if it answers, calls `connectGateway(active)`.
3. `connectGateway` unconditionally does `setActiveHello(null)`, `setMessages([])`,
   `setLastError(null)`, `setIsSending(false)`, `activeRunIdRef.current = null`,
   `sessionIdRef.current = gateway.sessionId` (`:1746-1752`) **before** calling `attachClient`.
4. `attachClient` returns immediately when the existing client for the same gateway is
   `connected`/`connecting`/`reconnecting` (`:1375-1385`). The client's own status never left
   `connected` (a failed `healthCheck` does not change it), so no `onHello`/`onHealthCheck` fires
   and `reloadHistoryFor` never runs.

The trigger is the exact condition the code documents as routine: the first request after a
radio wake on a Tailscale/DERP path is lossy (`client.ts:44-54`).

### LIFE-2 · S1 · A rejected token is retried forever and its message is erased `[read]`

> **Fix status:** Fixed - package(s) P1, P2a, commit(s) `19de6a2`, `a59aeb2` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-2)

**Where:** `gateway-provider.tsx:1512` vs `:1669`; `src/lib/gateway/client.ts:183-188`;
`src/lib/gateway/manifest-client.ts:212-216`; `gateway-provider.tsx:3595-3602`, `:1830-1832`.

**What fails:** After the Gate's token changes (rotate; a regenerated `.tokens.json`, see GATE-6),
the phone retries the bad token indefinitely (12 s doubling to 5 min), and after ~12 s the
"Gateway rejected the API key" message is replaced by "Looking for your gateway…" with the error cleared.

**Why:** Both clients call `setStatus('disconnected', message)` **before** `throw`. The provider's
`onStatus` runs first and schedules an auto-retry because `authFailureRef.current` is still `false`
(`:1512`); the flag is only set in the `catch` after the throw (`:1669`), and is reset to `false` at
the start of every `attachClient` (`:1372`). The scheduled cycle then runs `runAutoConnect`, which
sets `setProbeMessage('Looking for your gateway…')` and `setLastError(null)` (`:1831-1832`), reconnects,
is rejected again and throws out of `void runAutoConnectCycle()` (`:3600`) — an unhandled rejection
that nothing shows. The bootstrap path guards this case (`:2019`) but the status-callback path it races
does not.

### LIFE-5 · S3 · `disconnect()` does not cancel an in-flight `connect()` `[read]`

> **Fix status:** Fixed - package(s) P1, commit(s) `19de6a2` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-5)

**Where:** `client.ts:157-204,206-216`; `manifest-client.ts:183-227,229-235`.

**What fails:** Disconnect (switch gateway, delete, unmount) while `attemptConnect` is awaiting
`/health` (≤12 s), capabilities or models (≤30 s). When those resolve it calls `setStatus('connected')`
and `monitor.start()` on a client the provider already discarded. The provider ignores its callbacks
(generation guard), but the 30 s health interval keeps probing the old gateway for the rest of the
session.

**Why:** `this.closed` is written in `attemptConnect`/`disconnect` and read only in `resumeReconnect`
(`client.ts:231`, `manifest-client.ts:243`); nothing checks it after an `await`.

### LIFE-6 · S3 · Gateway switch leaves the UI "connected" to the old client `[read]`

> **Fix status:** Fixed - package(s) P2a, commit(s) `a59aeb2` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-6)

**Where:** `gateway-provider.tsx:1404` (old client disconnected), `:1428-1435` (manifest fetch, ≤~21 s),
`:1655` (`clientRef.current = client`).

**What fails:** During the manifest fetch for the new gateway the old client is already disconnected
and its callbacks are ignored (generation bumped at `:1389`), so `status`/`connectionPhase` still read
`connected` while `clientRef` still points at the old client. A send in that window goes to the old gateway
under the new gateway's name.

### LIFE-7 · S3 · The TLS fingerprint guard is inert `[read]`

> **Fix status:** Not fixed (decision needed) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-7)

**Where:** `gateway-provider.tsx:1635` — `checkTlsFingerprintTofu(gateway, gateway.tlsFingerprint)`;
`src/lib/gateway/security.ts:66-90`.

The "observed" fingerprint passed is the profile's own stored fingerprint, so `stored !== observed` can
never be true; `changed` never fires and `TlsFingerprintGuard` is unreachable. Nothing in the app reads a real
certificate fingerprint (React Native fetch cannot). Not a failure by itself, but the UI implies a check that
does not exist. (The 08-05 audit listed "tlsFingerprint displayed pinned but never verified"; it is still true.)

### LIFE-8 · S3 · Deleting the active gateway waits on a best-effort call `[read]`

> **Fix status:** Fixed - package(s) P2a, commit(s) `a59aeb2` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#life-8)

**Where:** `gateway-provider.tsx:2389` — `await deregisterWithGate(leaving)`.

The comment says best-effort, but it is awaited before `leaving.disconnect()` and the state reset (`:2394-2405`),
so an unreachable Gate holds the teardown for the request timeout (30 s) with the deleted gateway still shown
as active. `disconnectGateway` does the same call as `void … .catch(…)` (`:2433`).

---

## 4. Transport, fetch and data retrieval

### NET-1 · S2 · Request timeout is cleared when headers arrive `[read]` `[device?]`

> **Fix status:** Fixed - package(s) A1, commit(s) `e21db1c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-1)

**Where:** `src/lib/gateway/http-transport.ts:98` (`clearTimeout(timer)` right after `await fetch`),
`:111` (`await response.text()`); `node_modules/expo/src/winter/runtime.native.ts:44-53`.

**What fails:** A gateway that sends headers and then stalls (or a path that dies mid-body) leaves
`request()` pending forever — no timeout, no abort.

**Why:** Expo SDK 57 replaces the global `fetch` with `expo/fetch` unless `EXPO_PUBLIC_USE_RN_FETCH` is set;
its `Response` is headers-first with a streaming body. The timer that aborts the controller is cleared as soon
as `fetch` resolves, so the body read runs unguarded. The platform's own read timeout may mask this — needs a
device check. (`probe.ts:38,50` has the same shape and additionally never consumes/cancels the body of a
successful `/health`.) `manifest.ts:fetchGatewayManifestRaw` and `access.ts` do it correctly (timer cleared in
`finally`, after the body).

### NET-2 · S2 · No keepalive, no idle detection `[read]` `[device?]`

> **Fix status:** Fixed - package(s) A1, G4, commit(s) `e21db1c`, `203821b` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-2)

**Where:** every SSE route in `gate/core/server.mjs` (`streamBackendTurn` `:73-139`, run events `:1334-1372`,
env run events `:2041-2057`, terminal `:1445-1479`) — none writes a heartbeat (`grep` for `: ping`/keepalive: none);
client side `client.ts:546-573`, `manifest-client.ts:390-450`, `http-transport.ts:135-219`.

**What fails:** When the socket goes half-open (Wi-Fi drop, Tailscale path change), the phone never learns
it: `reader.read()` never settles, `isSending` stays `true`, and the composer is locked until the user
presses Stop. The connection monitor will eventually declare `reconnecting` (LIFE-3) but nothing aborts the
stream.

**Why:** The Gate deliberately has no *turn* silence bound (`turn-runner.mjs:9-31`, from the 2026-09-19
incident) and that decision is sound for a slow model — but with no *transport* keepalive the client cannot tell
"model is thinking" from "socket is dead". The two are separable (SSE comment lines vs. content frames).

### NET-3 · S2 · The phone's session-list timeout is shorter than the read it depends on `[read]`

> **Fix status:** Fixed - package(s) P1, commit(s) `19de6a2` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-3)

**Where:** `src/lib/gateway/get-sessions-retry.ts:22` (8 s per attempt, 3 attempts),
`gateway-provider.tsx:4316` (`openBot` → `getSessions(200)`), `chat-screen.tsx:1690` + `session-analytics.ts:298`
(`sessions.list` 200), `gate/core/cli-environments/backends/hermes.mjs:103` (Gate ceiling 30 s) and the comment
above it (≈11 s for `limit=200`, 141 KB, on the operator's own host; 9–12 **minutes** during the 2026-08-26
contention).

**What fails:** On the host whose measurements the repo records, a 200-row read takes ~11 s. The phone aborts at 8 s,
retries (0.5 s, 1.5 s), and aborts again — every attempt fails, "Bot chat could not open" / spend glance fails, and
each attempt has already started (or queued behind) an ~11 s query on the Gate.

**Why:** The three timeouts were tuned independently (8 s phone, 30 s Gate, 30 s default for `gatewayRequest`), and the
Gate does not tie a plain GET to the client's socket, so an aborted attempt keeps running. Retries therefore multiply load on
exactly the dependency (`state.db`) that is already slow.

### NET-4 · S3 · Reachability verdicts use a timeout the codebase calls too short `[read]`

> **Fix status:** Fixed - package(s) A1, commit(s) `e21db1c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-4)

**Where:** `src/hooks/use-gateway-reachability.ts:15` (`PROBE_TIMEOUT_MS = 1800`) vs `probe.ts:8-12` and
`client.ts:44-54` (DERP path measured 0.9–1.7 s RTT with loss; 3–3.5 s already produced false negatives).

Saved tailnet gateways can show "unreachable" while reachable.

### NET-5 · S3 · Terminal input `[read]`

> **Fix status:** Fixed - package(s) A1, commit(s) `e21db1c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-5)

**Where:** `src/lib/terminal/client.ts:151-162`, `terminal-screen.tsx:166-178`.

`sendTerminalInput` is a bare `fetch`: no timeout, no host-lookup fallback, and each submit is an independent HTTP
request (no ordering guarantee between two quick submits). On failure the input is already cleared and the screen
marks the terminal disconnected although the SSE stream may be fine.

### NET-6 · S3 · `authorizedFetch` has no timeout `[read]`

> **Fix status:** Fixed - package(s) A1, commit(s) `e21db1c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-6)

**Where:** `manifest-client.ts:937-942` → `streamingFetch` (no timer). Used for CLI-environment run submission; a
stalled POST never settles.

### NET-7 · S3 · A broken MagicDNS name pays a failed lookup on every request `[read]`

> **Fix status:** Fixed - package(s) A1, A2, commit(s) `e21db1c`, `790a799` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#net-7)

**Where:** `src/lib/gateway/host-lookup.ts:78-96`. The IPv4 rewrite is tried only *after* the hostname attempt
fails, per request, with no memory of which candidate last worked.

---

## 5. Speed

None of these timings were measured on a device; they are structural.

### SPD-1 · S2 · Cold connect is a serial chain with duplicate fetches `[read]`

> **Fix status:** Fixed - package(s) S1a, commit(s) `511b310` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-1)

**Where:** `gateway-provider.tsx:1428-1435` (manifest) → `manifest-client.ts:189-210` (health, then models) →
`:1556-1560` → `reloadHistoryFor` (`:1146-1268`: session list, then messages).

Order: probe wave → `manifestForAttach` (live fetch, retry, cached fallback) → `client.connect()`: `/health` → capabilities
(local) → **`getModels()` as an auth proof** → `connected` → history: sessions list (20) → messages.

Duplicated work on the same connect:
- Manifest: fetched by the probe wave (`probe.ts:137-157`), again by `manifestForAttach` (`attach-manifest.ts:49`), and a third
  time right after connect (`gateway-provider.tsx:1702`, even when the live copy was just served).
- `/health`: probed by `probeGatewayUrl`, then again by `attemptConnect`.
- Models: `getModels()` in `attemptConnect` (result discarded, `manifest-client.ts:210`), and again in `attachClient`
  when the profile has no model (`gateway-provider.tsx:1678`).
- The auth proof is the full model catalog (aggregated across providers and backends on the Gate,
  `server.mjs:2081-2171`, which itself may start backends — SPD-7) rather than a cheap authenticated call.

### SPD-2 · S2 · The fastest probe waits for the slowest `[read]`

> **Fix status:** Fixed - package(s) A1, A2, commit(s) `e21db1c`, `790a799` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-2)

**Where:** `probe.ts:104-135` — `Promise.allSettled` over the wave, *then* a manifest fetch fan-out.

If any of the ≤4 candidates black-holes (a tailnet name while off-tailnet, a stale LAN IP), it holds the wave for its full
`GATEWAY_PROBE_PARALLEL_TIMEOUT_MS = 10 s` even when another answered in tens of milliseconds. The same is true again for
`hasGatewayManifest` (≤10 s).

### SPD-3 · S2 · A 200-session read at both ends of every turn `[read]`

> **Fix status:** Fixed - package(s) S1b, commit(s) `6dca43c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-3)

**Where:** `chat-screen.tsx:1424-1433,1687-1715`, `session-analytics.ts:226-234,298`.

`threadSpendRefreshKey` includes `sending`, so the spend glance re-reads `sessions.list` (limit 200 ≈ 141 KB, ~11 s on
the recorded host) when a turn **starts** and when it **ends**. The first read runs concurrently with the turn's own
request on a host documented as single-threaded and `state.db`-bound. Each read also goes through `gatewayRequest` (30 s
timeout) with no abort (the effect only sets a `cancelled` flag).

### SPD-4 · S2 · Connect-time fan-out on every `connected` transition `[read]`

> **Fix status:** Fixed - package(s) S1a, commit(s) `511b310` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-4)

**Where:** `gateway-provider.tsx`: models `:1678`, manifest refresh `:1702`, approvals `:2750-2765`, workflows `:3042-3049`,
routine re-arm `:4031-4035`, `cron.list` `:4071-4088`, `listBots` `:4099-4111`, push registration `:1519`, plus
`reloadHistoryFor` (sessions + messages).

Roughly ten reads fire together on each transition to `connected`, **including** the monitor's silent self-heal, against a
gateway the code documents as single-threaded. Two of them read the same thing twice (`botJobs.list()` at `:4021-4029` and
`cron.list()` at `:4071-4088` are two different routes to the routine list).

### SPD-5 · S2 · Only the manifest is cached `[read]`

> **Fix status:** Fixed - package(s) S1b, commit(s) `6dca43c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-5)

**Where:** `grep` for cache use: `src/lib/portal/attach-manifest.ts` is the only data cache. Chat history, sessions, Bot
roster, models, routines and spend are fetched fresh for every visit, and are empty/loading (or absent) offline or while
the Gate is slow.

This is the direct cause of "fetches or data retrievals" feeling unreliable: there is no last-known-good to paint, so a
slow or failed read is always visible.

### SPD-6 · S3 · Roster re-read on every visit `[read]`

> **Fix status:** Fixed - package(s) S1b, commit(s) `6dca43c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-6)

**Where:** `chat-screen.tsx:1397-1416` — depends on `[surface.kind, status, listBots]`, so each return to the roster and
each reconnect issues `/v1/bots` (which enumerates Hermes profiles on the Gate) with no cache. Failure handling is UI-1.

### SPD-7 · S2 · Resolving a backend starts every backend `[read]`

> **Fix status:** Fixed - package(s) G2, commit(s) `8063ac7` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-7)

**Where:** `gate/core/server.mjs:1097-1119` (`resolveBackendFor`), `:1160-1163`, `:1046-1050`, `:2152-2162`;
`gate/core/cli-environments/backend-manager.mjs:96-142`; `native-server.mjs:6,74-112`.

**What fails:** `/v1/bots`, `/v1/skills`, `/v1/jobs`, `/health/detailed`, run routes etc. walk the backend list in order
and `await backendManager.get(id)` for each **before** checking whether it implements the method. `get()` starts the
environment's server (`ensureRunning`), so the first roster/skills read after a Gate restart cold-starts every earlier
backend just to learn it doesn't do Bots. A backend that fails to start is not remembered: each request re-spawns it and
waits up to `DEFAULT_START_TIMEOUT_MS = 30 s`, then the walk continues.

**Why:** Capability is discovered by *starting* the backend instead of reading the adapter's static capability list, which
`describe()` already exposes (`backend-manager.mjs:64-80`).

### SPD-8 · S3 · The cached manifest is the last resort, not the first `[read]`

> **Fix status:** Fixed - package(s) S1a, commit(s) `511b310` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#spd-8)

**Where:** `attach-manifest.ts:49-53` — live fetch (10 s) → sleep 0.9 s → live fetch (10 s) → *then* the cache. With a
known Gate that is down or slow, `client.connect()` cannot start for ~21 s although a usable manifest is on disk.

---

## 6. Chat and runs

### SEND-2 · S2 · A streamed turn with no session id creates a session per message `[read]`

> **Fix status:** Fixed - package(s) G4, P1, P2b, commit(s) `203821b`, `19de6a2`, `4a9e3cc` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#send-2)

**Where:** `gate/core/server.mjs:2230-2234` (`body.sessionId ?? createSession(...)`), `:2233-2247` (stream returns no id),
`gateway-provider.tsx:2529-2538`.

The Gate forwards only the last user message to a native session (`lastUserText`, `server.mjs:56-65`) and the session
holds the history. If the phone has no `sessionId` (session list failed at connect — NET-3 makes that likely), each turn
opens a **new** Hermes session, the streamed response never tells the phone its id (only the non-stream JSON carries
`session_id`, `:2276`), and the assistant has no memory of earlier turns. The provider heals this only when
`resolveResumeSession` succeeds; when it does not, chat proceeds statelessly with no notice.

### SEND-3 · S3 · Stop discards the partial reply `[read]`

> **Fix status:** Fixed - package(s) P2b, commit(s) `4a9e3cc` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#send-3)

**Where:** `gateway-provider.tsx:3438-3450` — `setMessages(prev => prev.filter(m => !m.streaming))`. The text already streamed
is removed from view, and the `catch` in `sendMessage` then runs `convertStreamError` (`:2648-2651`) on a message that no
longer exists.

### SEND-4 · S3 · `/agent` commands can't be cancelled `[read]`

> **Fix status:** Fixed - package(s) P2b, commit(s) `4a9e3cc` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#send-4)

**Where:** `gateway-provider.tsx:2217-2248`. `runAgentCommand` passes no `signal`, sets `activeRunIdRef.current = runId`
(`:2231`) and never clears it. `cancelCommand` (`:3729-3749`) aborts `abortControllerRef`/`runAbortControllerRef`, neither of
which this call uses, so Cancel only edits the transcript. A stale `activeRunIdRef` is later consumed by
`onHealthCheck` (`:1566-1569`).

### SEND-5 · S3 · `/model <name>` throws its validation away `[read]`

> **Fix status:** Fixed - package(s) U1, commit(s) `3de607a` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#send-5)

**Where:** `src/lib/gateway/slash-commands.ts:1049` — `const validation = await validateModelId(...)` is never read
(ESLint: `'validation' is assigned a value but never used`). The bare form sets the override with none of the "not in the
live catalog" warning that `/model set` (`:1063`) gives, and still pays the catalog read.

### SEND-6 · S3 · Fire-and-forget profile writes `[read]`

> **Fix status:** Fixed - package(s) P2b, commit(s) `4a9e3cc` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#send-6)

**Where:** `gateway-provider.tsx` — 14 × `void upsertGateway(x).then(setGateways)` with no `.catch`
(`:1471,1645,1684,2133,2179,2595,2645,2689,3904,3939,4338,4416,4444,4635`); stale bases at `:2589`, `:2642`, `:2686`
(`{ ...gateway, modelLocks }` where `gateway` is the closure from the start of a turn).

A failed write (storage, Keystore — STORE-2) is silently lost; a long turn writes back the profile as it was when the turn
began, undoing a model/session pin the user changed meanwhile.

### SEND-7 · S2 · The run driver gives up on the first transient failure `[read]`

> **Fix status:** Fixed - package(s) M1, commit(s) `143d3f7` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#send-7)

**Where:** `src/lib/gateway/runs.ts:281-352` — three `getRunStatus` sites each return `{ status: 'unknown', unresolved: true }`
on one failure; `:328` swallows a stream error and immediately polls once.

A single lost request during a run ends the driver. The run is then only reconciled by `settleUnresolvedRuns`, which runs from
`onHealthCheck` (`gateway-provider.tsx:1603-1624`) — i.e. only after a full reconnect. A blip that never trips the monitor
leaves the run "unresolved" until the next reconnect.

---

## 7. Storage

### STORE-1 · S2 · Transcripts: unserialized read-modify-write, written per streamed delta `[read]`

> **Fix status:** Fixed - package(s) ST1, commit(s) `79b7305` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#store-1)

**Where:** `src/lib/gateway/transcript.ts:31-55`; `gateway-provider.tsx:2324-2352` (`updateLocalMessage`),
`:3218-3224` (`onAgentDelta`).

Every streamed delta of an `/agent` command calls `updateLocalMessage` → `updateTranscript` → `getItem` + `JSON.parse` +
`JSON.stringify` of up to 200 entries + `setItem`, then `setTranscripts(...)` (a provider-wide state write). There is no queue
(contrast `storage.ts:18-26` and the activity-runs write queue in `session-persistence.ts`, which serialize precisely to avoid this), so concurrent
updates can land out of order and leave a stale summary, and the I/O rate follows the token rate.

### STORE-2 · S3 · All gateways live in one SecureStore item `[read]`

> **Fix status:** Partly fixed - package(s) ST1, ST2, commit(s) `79b7305`, `49b7026` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#store-2)

**Where:** `src/lib/gateway/storage.ts:36-38`, `src/lib/storage/secure-key-value.ts:52-63,65-91`.

- The whole profile array (tokens, per-backend/Bot model maps, locks, fingerprints) is one value. Expo v57's SecureStore
  docs warn that "some iOS releases refused values above roughly 2048 bytes" — an iOS-only, historical risk that grows with
  saved gateways (Android is the shipping target).
- `secureKeyValueStorage` catches **any** error from SecureStore and then, in a release build, throws a "SecureStore is
  unavailable … refusing" error. A transient Keystore exception therefore reads as a policy refusal; `loadGateways()` rejects and
  `bootstrap` reports "Could not load saved gateway settings" (`gateway-provider.tsx:2021-2027`).

### STORE-3 · S3 · Loads are unguarded `[read]`

> **Fix status:** Fixed - package(s) ST1, commit(s) `79b7305` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#store-3)

**Where:** `transcript.ts:13-22` (only `JSON.parse` is in the `try`), `session-persistence.ts:124-134,211-221`,
`gateway-provider.tsx:1975-1982` (`Promise.all` of four loads).

If `getItem` throws (AsyncStorage on Android has a 2 MB row-read limit and a 6 MB total DB default), one key aborts either
bootstrap (all four loads) or a session's history reload (`reloadHistoryFor` awaits `loadTranscripts` in a `Promise.all`,
`:1199-1204`). Transcript entries are capped at 200 with `raw` cut at 4000 chars (`slash-commands.ts:3031`), so reaching the
limit needs a heavy user — `[device?]`, unverified.

---

## 8. UI

### UI-1 · S2 · One failed roster read empties the Bot list `[read]`

> **Fix status:** Fixed - package(s) S1b, commit(s) `6dca43c` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#ui-1)

**Where:** `chat-screen.tsx:1407-1412` — the `catch` does `setRosterRows([{ kind: 'configurable' }])`.

This effect re-runs on every `status` change (each reconnect) and each return to the roster. A transient failure after a
blip replaces a good roster with the configurable-only row plus an error. The pull-to-refresh path (`:1745-1758`) and its
comment ("a failed RE-read never wipes rows") show the intended behaviour; the mount path does not follow it.

### UI-2 · S2 · Pause/resume folds an empty routine list as a success `[read]`

> **Fix status:** Fixed - package(s) U1, commit(s) `3de607a` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#ui-2)

**Where:** `chat-screen.tsx:1517-1542` (`handleRoutineTogglePause`), wired at `:2218` and `routines-pane.tsx:119`.

The first `.then((jobs) => { … })` block returns nothing, so the next `.then((jobs) => foldRoutineRead(…, routineJobsFromList(jobs)))`
receives `undefined`; `routineJobsFromList(undefined)` returns `[]` (`routines.ts:121-123`), which is folded as `{ ok: true }`.
After every pause/resume the Bot's Routines pane reads "no routines" until something re-reads. (`handleRoutineCreate`
right above it is correct.)

### UI-3 · S3 · A 1 Hz timer for the whole app lifetime `[read]`

> **Fix status:** Fixed - package(s) U1, commit(s) `3de607a` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#ui-3)

**Where:** `src/components/voice/handsfree-call-banner.tsx:38-45`, mounted unconditionally at `src/app/_layout.tsx:720`.
`useSyncExternalStore` subscribes with `setInterval(onStoreChange, 1000)` and a snapshot that changes every second, and the
`if (!active) return null` comes after the hooks, so an idle app re-renders this component 60×/minute.

### UI-4 · S3 · No safety net and no field telemetry `[read]`

> **Fix status:** Fixed - package(s) U2, commit(s) `6017230` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#ui-4)

There is no exported `ErrorBoundary` in `src/app` (the providers above the Stack are uncovered), no
`ErrorUtils.setGlobalHandler`, and no crash/failure reporting dependency (`grep` for sentry/crashlytics/bugsnag: none). The
only boundaries are four `componentDidCatch` classes around canvases. The one field check is the on-demand
"Runtime environment" screen. A failure in the field is invisible until the user reports it.

### UI-5 · S3 · Terminal `[read]`

> **Fix status:** Fixed - package(s) U1, commit(s) `3de607a` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#ui-5)

**Where:** `terminal-screen.tsx:94-100,140`. The effect that owns the live shell has `[gatewayId, status]` in its dependency list
and closes the session in cleanup, so any `status` flip (a health blip → `reconnecting` → `connected`) closes the stream (the Gate
kills the shell on stream close, `server.mjs:1474-1477`) and the effect opens a new empty one. `sendToTerminal` clears the input
before the request succeeds (`:164-178`).

---

## 9. Notifications & push

### NOTIF-1 · S3 · Permission handling `[read]`

> **Fix status:** Fixed - package(s) M1, commit(s) `143d3f7` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#notif-1)

**Where:** `src/lib/notifications/local.ts:35-44,70`. `permissionGranted` caches only `true`, so a denied state re-calls
`requestPermissionsAsync()` for every notice; and `present()` returns early while foregrounded, so the request is issued when the
app is backgrounded — where Android 13+ cannot show the dialog. `syncPushRegistration` requires an already-granted permission
(`push-registration.ts:157-161`); the only user-facing request is the Settings toggle
(`use-notification-preferences.ts:146`). By design (A5) but worth knowing when "push never arrived".

### PUSH-1 · S3 · Receipts are requested before they exist `[read]` (medium confidence)

> **Fix status:** Fixed - package(s) G3, commit(s) `97f25f0` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#push-1)

**Where:** `gate/core/push-send.mjs:91` — `collectReceipts` runs immediately after `send`. Expo generates receipts asynchronously
(its docs advise waiting ≥15 minutes), so the poll normally returns nothing: `DeviceNotRegistered` is only learned from the
synchronous ticket, dead tokens found by receipt are never pruned, and every notification pays a second round trip.

---

## 10. Gate (server, supervision, stores)

### GATE-1 · S1 · One unhandled child-process error takes the Gate down `[read]`

> **Fix status:** Fixed - package(s) G1, G2, commit(s) `3399f6e`, `8063ac7` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-1)

**Where (no `error` listener on a spawned child):** `gate/core/cli-environments/native-server.mjs:114`,
`stdio-server.mjs:50`, `gate/core/voice/engines/local-engine.mjs:18` (only `exit` is handled, `:106`).
**Where (no `stdin` `error` listener):** `jsonrpc-stdio.mjs:65`, `terminal.mjs:123`, and every voice frame via
`local-engine` → `rpc.notify`.
**Where (no process-level handler):** `grep -rn "uncaughtException\|unhandledRejection" gate/` → nothing.

**What fails:** (a) A configured executable that is missing or moved (`ENOENT`/`EACCES`) emits `error` on the ChildProcess;
with no listener Node throws it as an uncaught exception. (b) Writing to a child that is dying (the Codex app-server, the voice
worker mid-call at 16 kHz, a shell after `exit`) raises an asynchronous `EPIPE` on `child.stdin`; the existing `closed`/`exitCode`
guards only cover a child whose `exit` was already delivered. Either way the whole Gate process exits.

**Why it matters:** The supervisor restarts it (backoff 1–60 s, `service/supervisor.mjs:14`), but every phone stream, hands-free call,
terminal and in-flight turn drops at once, and (b) is exactly the failure the local voice engine's restart-with-backoff was written to
survive. `voice-worker` restart logic assumes the Gate outlives the worker.

### GATE-2 · S2 · The Codex backend never recovers `[read]`

> **Fix status:** Fixed - package(s) G2, commit(s) `8063ac7` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-2)

**Where:** `stdio-server.mjs:33` (`if (handle) return handle;`), no `exit` hook anywhere in the file;
`backend-manager.mjs:96-128` caches the server forever.

After the app-server process dies, `ensureRunning()` keeps returning the dead handle. `jsonrpc-stdio.mjs:65` then rejects every
request ("app-server is not running") until the Gate restarts. The HTTP variant re-validates health (`native-server.mjs:39-56`);
the stdio variant has no equivalent.

### GATE-6 · S2 · Auth stores: non-atomic writes and swallowed read errors `[read]`

> **Fix status:** Fixed - package(s) G3, commit(s) `97f25f0` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-6)

**Where:** `gate/core/device-tokens.mjs:20-33` (read swallows to `[]`; `writeFile` truncates), `tokens.mjs:36-42`,
`pairing.mjs:17-28,41-51`, `push-tokens.mjs:29-45`. Contrast `providers/store.mjs`, `credentials/vault.mjs`, `cli-environments/store.mjs`,
`bot-groups.mjs`, all tmp-file + `rename`.

- `DeviceTokenStore.verify()` re-reads the file on every authenticated request (deliberately, so an out-of-process revoke takes
  effect) while `issue`/`revoke` truncate-then-write with no lock. A read in that window parses `''`, returns `[]`, and the caller gets
  a 401 — the phone reads that as a rejected key (LIFE-2).
- Worse, `issue()` after such a read writes `{ devices: [newOne] }`, dropping every other paired device.
- `TokenStore` (`.tokens.json`): an empty/corrupt file after a crash mid-write makes `ensureToken()` **mint a new bootstrap token**,
  invalidating the phone's saved one (the file says `writeFile` with no atomic rename).
- `PushTokenStore` serializes its mutations but its free-running reads (`listEnabled`, `get`) see the same truncation window, so
  notifications can be silently skipped.

### GATE-7 · S2 · The unauthenticated pairing endpoint is unbounded `[read]`

> **Fix status:** Fixed - package(s) G3, commit(s) `97f25f0` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-7)

**Where:** `gate/core/server.mjs:784-795` (`readJsonBody` collects the whole stream, no size limit — for every route),
`:819-875` (`/.well-known/gateway/access`, unauthenticated), `:767` (`replayCache = new Set()`, never pruned),
`pairing.mjs:41-51` (pending list grows per distinct device id, whole-file read/rewrite each time).

Any device that can reach the port can send a multi-gigabyte body, or a stream of validly self-signed requests from fresh
keypairs, to exhaust memory/disk. The Gate is reachable on the tailnet and LAN by design. Independently, a concurrent `cli pair approve`
and a request lose updates (read-modify-write across processes).

### GATE-8 · S3 · Provider-path chat outlives the client `[read]`

> **Fix status:** Fixed - package(s) G4, commit(s) `203821b` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-8)

**Where:** `server.mjs:163-282` (`proxyChat`, `relayNormalizedSse`), `:198` (`fetch` with no signal/timeout). `streamBackendTurn`
aborts on `res.close` (`:90`) but this path does not, so Stop or a dropped phone lets the vendor stream keep running (and being paid for),
and a vendor that never answers holds the request for undici's default (~5 min).

### GATE-9 · S3 · Environment run-event SSE ignores disconnect `[read]`

> **Fix status:** Fixed - package(s) G4, commit(s) `203821b` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-9)

**Where:** `server.mjs:2041-2057` — `for await (const event of environmentService.events(...))` with no `close` hook. A viewer that leaves
keeps a subscription until the run ends; for a run parked on approval, that is indefinitely.

### GATE-10 · S3 · Two DELETE routes have no error mapping `[read]`

> **Fix status:** Fixed - package(s) G4, commit(s) `203821b` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-10)

**Where:** `server.mjs:1882` (`removeJob`), `:1986` (`deleteSession`). Unlike their siblings they are not wrapped, so a backend refusal
(unknown id, host error) becomes a generic `500 Internal Server Error` with a stack logged, and the app cannot tell "already gone" from
"Gate broken".

### GATE-11 · S3 · `/health` cannot see a dead backend `[read]`

> **Fix status:** Not fixed (decision needed) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-11)

**Where:** `server.mjs:801-809` returns `{status:'ok'}` without touching a backend. The app's connection monitor uses only this
(`client.ts:246`, `manifest-client.ts:252`), so a Gate whose Hermes is wedged (the documented `state.db` failure) reads as `connected`
while chat, sessions and Bots fail.

### GATE-12 · S3 · `ws` is imported but not declared by `gate/` `[read]`

> **Fix status:** Fixed - package(s) G1, commit(s) `3399f6e` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#gate-12)

**Where:** `gate/core/voice/media-socket.mjs:18`; `gate/package.json` has no `dependencies` (root `package.json` carries `ws`). A
Gate deployed from `gate/` alone, or a root install skipped after a pull, fails at import when the media socket loads.

---

## 11. Voice (JS + Kotlin)

### VOICE-1 · S1 (latent) · Uncaught `InterruptedException` on hang-up `[read]` `[device?]`

> **Fix status:** Fixed - package(s) K1, commit(s) `4466fd9` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#voice-1)

**Where:** `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeGateMedia.kt:93`
(`playbackThread?.interrupt()` in `stop()`), `:245` (`Thread.sleep(5)` in the playback loop, no `try/catch`).

When the buffer is empty — most of a call — the playback thread is in `Thread.sleep(5)`. `stop()` sets `running = false` then
interrupts; the sleep throws `InterruptedException`, which the thread's lambda does not catch. An uncaught exception on a non-main
thread reaches Android's default handler and kills the process. Effect: the app closes on hang-up of a Gate-engine call. Not seen
on device only because Gate calls don't currently open (VOICE-6).

### VOICE-2 · S2 · `JitterBuffer` is not thread-safe `[read]` `[device?]`

> **Fix status:** Fixed - package(s) K1, commit(s) `4466fd9` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#voice-2)

**Where:** `JitterBuffer.kt:21-60` (`ArrayDeque`, `totalBytes`, `primed`, `activeGen` — no lock), used from the OkHttp reader thread
(`push`, `cancel` via `handleTextFrame`), the playback thread (`drain`) and the caller thread (`flush` in `start`/`stop`).

`drain()` checks `queued.isEmpty()` then calls `removeFirst()`; a barge-in `cancel()`/`clear()` between the two throws
`NoSuchElementException` on the playback thread (process-fatal, as VOICE-1). `push`→`trimToCap` racing `drain` can do the same on the
OkHttp thread (surfacing as a socket failure). The JVM tests are single-threaded.

### VOICE-3 · S2 · The native error frame is hand-built JSON `[read]`

> **Fix status:** Fixed - package(s) K1, commit(s) `4466fd9` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#voice-3)

**Where:** `HandsfreeGateMedia.kt:143` interpolates `error.message` into a JSON string (`:137` is a fixed string and is fine); the consumer is
`src/context/handsfree-voice-provider.tsx:186-194` (`isRetryableSocketFailure` → `parseGateFrame`, `catch → false`).

A message containing `"` or `\` breaks the JSON. OkHttp's DNS failure reads `Unable to resolve host "…": No address associated with hostname`
— the same MagicDNS class the app handles elsewhere (`host-lookup.ts`). The frame then fails to parse, the socket failure is not treated
as retryable, and the Gate's 20 s resume window (`media-socket.mjs:26`) is never used; the call ends instead of re-attaching.

### VOICE-4 · S3 · No ping on the media socket `[read]`

> **Fix status:** Fixed - package(s) K1, commit(s) `4466fd9` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#voice-4)

**Where:** `HandsfreeGateMedia.kt:42-44` (`readTimeout(0)`, no `pingInterval`). A half-open link is never detected by the phone;
reconnect only triggers from `onFailure`. The Gate's 30 s no-audio timeout closes only its side.

### VOICE-5 · S3 · Read loops spin `[read]`

> **Fix status:** Fixed - package(s) K1, commit(s) `4466fd9` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#voice-5)

**Where:** `HandsfreeGateMedia.kt:201` capture loop (`if (read <= 0) continue`), `HandsfreeCallService.kt:773` (same). A failing
`AudioRecord.read` (mic taken by another app, audio focus loss) returns an error code immediately and the loop busy-waits at full CPU
until `running`/`vadRunning` flips.

### VOICE-6 · Hands-free calls never open `[known]`

> **Fix status:** Known / open (unchanged) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#voice-6)

`PENDING.md:23-24` (2026-09-18, handed to another agent). Listed so VOICE-1/2 are read with the right expectation: the Gate media path is
under-exercised on device.

---

## 12. Environment, tests, tooling

### ENV-1 · S2 · The main checkout can't run the gate `[run]`

> **Fix status:** Not fixed (needs your action, nothing touched) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#env-1)

`C:\Projects\Versutus\node_modules` (709 packages) is missing `@babel/code-frame`, `@eslint-community/eslint-utils` and
`@expo-google-fonts/instrument-serif`; `Versutus-ui-audit` is the same. `Versutus-build` and `Versutus-nocturne` (716) are complete.
Consequences: `tsc` fails (`font-provider.tsx:10`, TS2307), `jest` and `eslint` can't start. Separately, the npm cache directory
`E:\Data\pkg-caches\npm` does not exist, so `npx`/`npm install` fail with `ENOENT` in this environment. The repo's own note
(`versutus-verification-gate` memory) is that `npm run verify` *is* the gate; on the main checkout it cannot pass.

(For this audit `node_modules` in the worktree is a git-ignored junction to `Versutus-nocturne\node_modules`.)

### TEST-1 · S3 · Load-sensitive suites `[run]`

> **Fix status:** Fixed - package(s) M1, commit(s) `143d3f7` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#test-1)

`__tests__/fleet-roster-state-test.ts` and `fleet-route-test.ts` exceeded jest's 5 s timeout in a parallel full run (each suite took
~20 s to load) and pass alone in 4 s. `npm test` uses `--runInBand`, which may hide it; a slower machine or CI may not.

### LINT-1 · S3 · The lint gate skips `scripts/` and `modules/` `[run]`

> **Fix status:** Fixed - package(s) M1, manual, commit(s) `143d3f7`, `a699ddd` - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#lint-1)

`npm run lint` = `expo lint && eslint gate`. Linting `scripts/` shows 7 `no-undef` errors for `Buffer`
(`register-desktop-agent.mjs:10,13,17,23`, `smoke-provider-runtime.mjs:29,30`, `voice-spikes/s1-codex-realtime.mjs:44`) — the same
class §1.4 of the 08-19 audit fixed for `gate/` — plus dead variables (`hasFlag`, `activityRuns` in `fleet.tsx`/`runs.tsx`, SEND-5's
`validation`) and missing hook dependencies (`noteWaiting` ×2 in `handsfree-voice-provider.tsx:295,432`, `onClearLock` in
`thread-config-sheet.tsx:803`, `job?.name/nextRunAt/schedule` in `cron-job-sheet.tsx:142`) — stale-closure candidates.

### COV-1 · S3 · Coverage is narrow `[read]`

> **Fix status:** Not fixed (decision needed) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#cov-1)

`package.json` `jest.collectCoverageFrom = ["src/lib/gateway/**/*.ts"]` with thresholds only there. `gateway-provider.tsx` (4.9k lines), the
UI, the Gate (node:test, no coverage) and the Kotlin/Swift modules are unmeasured. Nearly every S1/S2 above lives in an unmeasured place.

### CFG-1 · S3 · Fallback hosts are compiled in `[read]`

> **Fix status:** Not fixed (low value, your call) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#cfg-1)

`app.json` → `extra.gatewayHosts` hard-codes `ethanspc.tail3a1a8a.ts.net`, `100.95.137.83`, `192.168.4.30`, `192.168.4.28`. The saved
profile and `lastSuccessfulUrl` mask this normally; a changed PC address or a second user needs a rebuild for the fallback list.

### DEAD-1 · S3 · Discovery is off but still in the connect path `[read]`

> **Fix status:** Not fixed (refactor, out of scope) - [diagnosis and fix](failure-audit-2026-09-30-fixes.md#dead-1)

`src/lib/discovery/scanner.ts` — `isNativeDiscoveryAvailable()` is `false`, so `discoverForProbe` returns `[]` at once and the beacon
branches (`gateway-provider.tsx:1855-1873`, `mergeDiscoveredProbeUrls`) never run. Not a failure; it means OpenClaw gateways cannot be
auto-discovered and this code is untested by reality.

---

## 13. Checked and found fine / retracted (so it isn't re-litigated)

- **Discovery adds 4.2 s to every cold start** — retracted: `discoverForProbe` returns immediately (DEAD-1).
- **SecureStore 2 KB limit breaks Android** — retracted for Android; kept as an iOS-only note under STORE-2 (Expo v57 docs).
- **Probe candidates are serial** — retracted: `probeGatewayCandidates` uses a capped concurrent pool (`probe.ts:78`).
- **Gate `lastUserText` duplicates the client's 20-turn context** — fine: the Gate forwards only the last user message to native sessions.
- **Supervisor restart policy** — sound (backoff, stable-window reset, health-kill after 4 misses, graceful IPC stop).
- **Storage write ordering for gateways and activity runs** — correctly serialized (`storage.ts:18-26`, activity-runs queue in `session-persistence.ts`).
- **Streaming with no turn-silence bound** — an explicit, documented decision (`turn-runner.mjs:9-31`); NET-2 is about *transport* liveness, not that bound.

## 14. Not yet scanned (the list continues here)

> **Update 2026-10-01:** the second pass covered the OpenClaw client, the Gate's provider/OAuth/credential code, the rest of the Gate, the iOS module, the widget and plugins, phone notifications and the non-chat screens - see [failure-audit-2026-10-01-second-pass.md](failure-audit-2026-10-01-second-pass.md) (135 findings) and its [fix log](failure-audit-2026-10-01-second-pass-fixes.md). The bullets below are what remained unscanned after round 1; the device pass and the accessibility / dark-mode / worklet items are still open.

- `src/lib/gateway/openclaw-client.ts` (WebSocket dialect) and `src/lib/portal/identify.ts`.
- `gate/core/providers/**` (OAuth refresh, catalogs), `hermes-profiles.mjs`, `bot-groups.mjs` beyond the store, `voice-worker/` (Python), `voice/runtime.mjs` (installer).
- iOS Swift module (`HandsfreeVoiceModule.swift`), the widget module, `plugins/`.
- Most UI screens outside chat/terminal (home, activity, runs, fleet, settings, onboarding, gateway/*) for list virtualization, keyboard/insets, empty/error states.
- Accessibility, dark-mode/contrast, and animation-thread (worklet) correctness beyond the existing `worklets-must-call-worklets` gate.
- A device pass for every `[device?]` item above; the highest-value ones to confirm first are BG-1, LIFE-1, NET-1, NET-2, VOICE-1.
