# Failure audit 2026-10-01 - second pass - fix log (diagnosis and fix per finding)

Companion to [failure-audit-2026-10-01-second-pass.md](failure-audit-2026-10-01-second-pass.md), which lists each finding (where / what / why). Each package was written by a free `opencode` model behind a harness it cannot edit, reviewed by a separate session that traced the real code path, repaired where the review reproduced a defect, and landed as one commit on branch `claude/app-failure-audit-fc957c`. Entries below describe the FINAL state; the **Review** line says what the independent review caught.

Totals: **121 fixed**, **11 partly fixed**, **3 not fixed** (each a decision or needing information we do not have).

| Finding | Sev | Status | Package(s) | Commit(s) |
|---|---|---|---|---|
| R2-OC-1 | S1 | Fixed | O1b | `00073d2` |
| R2-OC-2 | S1 | Fixed | O1a | `7f89ea0` |
| R2-OC-3 | S2 | Fixed | O1a | `7f89ea0` |
| R2-OC-4 | S2 | Fixed | O1a | `7f89ea0` |
| R2-OC-5 | S2 | Fixed | O1b | `00073d2` |
| R2-OC-6 | S2 | Fixed | O1a | `7f89ea0` |
| R2-OC-7 | S2 | Fixed | O1b | `00073d2` |
| R2-OC-8 | S2 | Fixed | O1b | `00073d2` |
| R2-ID-1 | S2 | Fixed | O2 | `4769620` |
| R2-OC-9 | S3 | Fixed | O1b | `00073d2` |
| R2-OC-10 | S3 | Not fixed (needs protocol evidence) | - | - |
| R2-ST-1 | S3 | Fixed | O1a | `7f89ea0` |
| R2-AC-1 | S3 | Fixed | O2 | `4769620` |
| R2-OC-V1 | S2 | Fixed | O1a | `7f89ea0` |
| R2-OC-V2 | S2 | Partly fixed | O1b | `00073d2` |
| R2-OC-V3 | S3 | Fixed | O1b | `00073d2` |
| R2-PROV-1 | S2 | Fixed | G10, G9 | `98347a8`, `360134c` |
| R2-PROV-2 | S2 | Fixed | G10 | `98347a8` |
| R2-PROV-3 | S2 | Fixed | G9 | `360134c` |
| R2-PROV-4 | S2 | Fixed | G9 | `360134c` |
| R2-PROV-5 | S2 | Fixed | G9 | `360134c` |
| R2-PROV-6 | S2 | Fixed | G8 | `fae703a` |
| R2-OAUTH-1 | S3 | Partly fixed | G10 | `98347a8` |
| R2-PROV-7 | S2 | Fixed | G9 | `360134c` |
| R2-STORE-1 | S3 | Fixed | G7 | `37e3d56` |
| R2-CAP-1 | S3 | Fixed | G7 | `37e3d56` |
| R2-PROV-8 | S3 | Fixed | G10 | `98347a8` |
| R2-CRED-1 | S3 | Fixed | G8, G9 | `fae703a`, `360134c` |
| R2-CRED-2 | S3 | Fixed | G8, G9 | `fae703a`, `360134c` |
| R2-PROV-V1 | S2 | Fixed | G9 | `360134c` |
| R2-PROV-V2 | S2 | Partly fixed | G9 | `360134c` |
| R2-PROV-V3 | S2 | Fixed | G9 | `360134c` |
| R2-CLAUDE-1 | S1 | Fixed | G5 | `c474fa6` |
| R2-RUN-1 | S2 | Fixed | G6 | `563c335` |
| R2-RUN-2 | S2 | Fixed | G6 | `563c335` |
| R2-ENV-1 | S2 | Fixed | G7 | `37e3d56` |
| R2-CLI-1 | S2 | Fixed | G5 | `c474fa6` |
| R2-SESS-1 | S2 | Fixed | G5 | `c474fa6` |
| R2-HERMES-1 | S2 | Fixed | G7 | `37e3d56` |
| R2-VOICE-1 | S3 | Fixed | G11 | `7627c4a` |
| R2-VOICE-2 | S3 | Fixed | G11 | `7627c4a` |
| R2-VOICE-3 | S3 | Fixed | G11 | `7627c4a` |
| R2-TOKEN-1 | S3 | Partly fixed | G6 | `563c335` |
| R2-CLI-2 | S3 | Fixed | G12 | `1825045` |
| R2-HERMES-2 | S3 | Fixed | G7 | `37e3d56` |
| R2-VOICE-4 | S2 | Fixed | G11 | `7627c4a` |
| R2-GO-V1 | S3 | Fixed | G6 | `563c335` |
| R2-GO-V2 | S3 | Fixed | G5 | `c474fa6` |
| R2-GO-V3 | S3 | Fixed | G11 | `7627c4a` |
| R2-VOICEANDROID-1 | S1 | Fixed | N1 | `0072f00` |
| R2-VOICE-6 | S2 | Fixed | N3 | `001fbc9` |
| R2-VOICE-7 | S2 | Fixed | N3 | `001fbc9` |
| R2-VOICE-8 | S2 | Fixed | N1, N2 | `0072f00`, `ad55c02` |
| R2-GATEVOICE-1 | S2 | Fixed | N2 | `ad55c02` |
| R2-HANDSFREE-1 | S2 | Fixed | N2 | `ad55c02` |
| R2-HANDSFREE-2 | S3 | Fixed | N2 | `ad55c02` |
| R2-GATEVOICE-2 | S3 | Fixed | N2 | `ad55c02` |
| R2-VOICE-9 | S3 | Fixed | N3 | `001fbc9` |
| R2-GATEVOICE-3 | S3 | Fixed | N2 | `ad55c02` |
| R2-VOICE-10 | S3 | Partly fixed | N3 | `001fbc9` |
| R2-HANDSFREE-3 | S3 | Partly fixed | N2 | `ad55c02` |
| R2-NV-V1 | S2 | Fixed | N1 | `0072f00` |
| R2-WIDGET-1 | S2 | Fixed | W2 | `0280cf2` |
| R2-WIDGET-2 | S2 | Fixed | W2 | `0280cf2` |
| R2-WIDGET-3 | S2 | Fixed | W2 | `0280cf2` |
| R2-WIDGET-4 | S2 | Fixed | W2 | `0280cf2` |
| R2-WIDGET-5 | S2 | Fixed | W2 | `0280cf2` |
| R2-WIDGET-6 | S2 | Fixed | G13 | `2ff377e` |
| R2-WIDGET-7 | S2 | Fixed | G13 | `2ff377e` |
| R2-WIDGET-8 | S3 | Fixed | G13 | `2ff377e` |
| R2-NW-V1 | S3 | Not fixed (product decision) | - | - |
| R2-NW-V2 | S3 | Fixed | W2 | `0280cf2` |
| R2-NW-V3 | S3 | Fixed | W3 | `4f9d1cf` |
| R2-NOTIF-01 | S2 | Partly fixed | G13 | `2ff377e` |
| R2-NOTIF-02 | S2 | Fixed | NT2 | `94407e4` |
| R2-NOTIF-03 | S2 | Fixed | NT1 | `afc3b82` |
| R2-NOTIF-04 | S2 | Fixed | NT1 | `afc3b82` |
| R2-NOTIF-05 | S2 | Fixed | NT1 | `afc3b82` |
| R2-NOTIF-06 | S3 | Not fixed (design needed) | - | - |
| R2-NOTIF-07 | S3 | Fixed | NT1 | `afc3b82` |
| R2-NOTIF-08 | S3 | Fixed | NT1 | `afc3b82` |
| R2-NOTIF-09 | S3 | Fixed | NT2 | `94407e4` |
| R2-NOTIF-10 | S3 | Partly fixed | NT2 | `94407e4` |
| R2-NOTIF-11 | S3 | Partly fixed | NT1 | `afc3b82` |
| R2-NN-V1 | S2 | Partly fixed | G13 | `2ff377e` |
| R2-NN-V2 | S3 | Fixed | NT1 | `afc3b82` |
| R2-NN-V3 | S3 | Fixed | NT2 | `94407e4` |
| R2-NN-V4 | S3 | Fixed | NT2 | `94407e4` |
| R2-ACT-1 | S2 | Fixed | SC6 | `bc44045` |
| R2-ACT-2 | S2 | Fixed | SC5 | `e82654f` |
| R2-ACT-3 | S2 | Fixed | SC6 | `bc44045` |
| R2-ACT-4 | S2 | Partly fixed | SC6 | `bc44045` |
| R2-ACT-5 | S2 | Fixed | SC5 | `e82654f` |
| R2-ACT-6 | S2 | Fixed | SC5 | `e82654f` |
| R2-ACT-7 | S2 | Fixed | SC6 | `bc44045` |
| R2-ACT-8 | S3 | Fixed | SC6 | `bc44045` |
| R2-ACT-9 | S3 | Fixed | SC6 | `bc44045` |
| R2-SH-V1 | S2 | Fixed | SC6 | `bc44045` |
| R2-SH-V2 | S3 | Fixed | SC6 | `bc44045` |
| R2-HAPTIC-1 | S2 | Fixed | H1 | `f0fbdd1` |
| R2-RUNS-1 | S2 | Fixed | SC8 | `771616e` |
| R2-RUNS-2 | S3 | Fixed | SC8 | `771616e` |
| R2-RUNS-3 | S3 | Fixed | SC8 | `771616e` |
| R2-SR-V1 | S3 | Fixed | SC8 | `771616e` |
| R2-SR-V2 | S2 | Fixed | H1 | `f0fbdd1` |
| R2-SR-V3 | S3 | Fixed | SC9 | `55c99a2` |
| R2-LOCK-1 | S1 | Fixed | SC1 | `f696847` |
| R2-IMPORT-1 | S2 | Fixed | SC3 | `1d89c50` |
| R2-SRUN-1 | S2 | Fixed | SC3 | `1d89c50` |
| R2-REACH-1 | S2 | Fixed | SC4 | `329962d` |
| R2-CAPS-1 | S2 | Fixed | SC3 | `1d89c50` |
| R2-SETTINGS-1 | S2 | Fixed | SC1 | `f696847` |
| R2-SVOICE-1 | S2 | Fixed | SC1 | `f696847` |
| R2-SPEND-1 | S2 | Fixed | SC2 | `958a455` |
| R2-DIAG-1 | S2 | Fixed | SC2 | `958a455` |
| R2-SVOICE-2 | S2 | Fixed | SC1 | `f696847` |
| R2-LINK-1 | S3 | Fixed | SC4 | `329962d` |
| R2-PRIV-1 | S3 | Fixed | SC1 | `f696847` |
| R2-BUDGET-1 | S3 | Fixed | SC2 | `958a455` |
| R2-DRAWER-1 | S3 | Fixed | SC4 | `329962d` |
| R2-SG-V1 | S3 | Fixed | SC1 | `f696847` |
| R2-SG-V2 | S3 | Fixed | SC1 | `f696847` |
| R2-SG-V3 | S3 | Fixed | SC7 | `e9a7a8b` |
| R2-FLEET-1 | S2 | Fixed | SC10 | `e93099f` |
| R2-ONB-1 | S2 | Fixed | SC10 | `e93099f` |
| R2-ONB-2 | S2 | Fixed | SC10 | `e93099f` |
| R2-CNCL-1 | S2 | Fixed | SC9 | `55c99a2` |
| R2-CNCL-2 | S2 | Fixed | SC9 | `55c99a2` |
| R2-ONB-3 | S2 | Fixed | H1 | `f0fbdd1` |
| R2-CNCL-3 | S3 | Fixed | SC9 | `55c99a2` |
| R2-CNCL-4 | S3 | Fixed | SC9 | `55c99a2` |
| R2-CNCL-5 | S3 | Fixed | SC9 | `55c99a2` |
| R2-FLEET-2 | S3 | Fixed | SC10 | `e93099f` |
| R2-FLEET-3 | S3 | Fixed | SC10 | `e93099f` |
| R2-FLEET-4 | S3 | Fixed | SC10 | `e93099f` |

### R2-OC-1
**Status:** Fixed (commit 00073d2)
**Diagnosis:** CONFIRMED, and the author ADDED why the `chat.send` rejection could not cover the gap: that RPC's pending entry is resolved by the ack frame, so `flushPending` finds an empty map; and the adapter registered only `onHello`/`onChatEvent` on the inner client, so `setStatus('reconnecting'|'disconnected')` never reached a pending turn.
**Fix:**
- The constructor now wraps the caller's `onStatus` (`openclaw-adapter.ts:128`), forwarding all three arguments first, then `failChatOnStatusChange` rejects a pending turn when the status leaves `connected`.
- `armStallTimer` fails a turn that has heard no frame for `CHAT_STALL_MS` (150 000, injectable via the new `chatStallMs` constructor option): best-effort `abortChat`, `inner.nudge('chat stalled')`, reject. Re-armed by every frame in `handleChatEvent`.
- `settleChat` is the single door out: it latches on `pending.settled`, clears the stall timer, detaches the abort listener, empties the slot, retires the run id, then resolves or rejects. `final`, `error`, abort, request failure and "superseded by a newer turn" all route through it.
- An answer the gateway finished is recovered by the provider's own interrupted-turn reconcile on the next healthy reconnect, not by this adapter.
**Tests:** `__tests__/openclaw-adapter-settle.test.ts` over a fake WebSocket and fake timers — a drop after the ack rejects with the connection-lost message and a later frame is ignored; silence past an injected 1 000 ms budget sends one `session.abort` and calls `nudge('chat stalled')`; a frame inside the budget keeps the turn alive; `jest.getTimerCount()` is back to its pre-send value after `final`. Both settle tests hang for 20 s on pre-fix code.
**Review:** failed review 1 — two defects (see R2-OC-8 and R2-OC-9); for this finding the reviewer traced the status machine end to end and took two cheap minors: the stall message now matches `isConnectionError`, and Stop aborts the ack-adopted session.
**Residual:** the stall timer does not pause when the app backgrounds, so a turn the OS kills fails on the next tick instead of on a lifecycle signal; connection loss deliberately fails the bubble rather than holding it pending.

### R2-OC-2
**Status:** Fixed (commit 7f89ea0)
**Diagnosis:** CONFIRMED. `OpenClawGatewayClient.handleTerminalFailure` called `setStatus('disconnected', message)` and `setStatus` forwarded two arguments, so the provider's `info?.authRejected` was always `undefined`, `authFailureRef` never rose and the auto-retry re-armed every cycle, each cycle's `connectGateway` clearing the message `onError` had just set. Author ADDED: an `AUTH_DEVICE_TOKEN_MISMATCH` that arrives after its single retry falls into the generic terminal branch, so it needed its own auth-rejection branch — the stored credential is wrong, not stale. `OpenClawAdapterClient` also had no `authRejected` getter although `PortalClient` declares it optional.
**Fix:**
- `GatewayClientCallbacks.onStatus` gains the optional third `info?: { authRejected?: boolean }`; `setStatus(status, detail, info?)` forwards it.
- `handleTerminalFailure(message, authRejected = false)` sets `authRejectedState` and emits `setStatus('disconnected', message, { authRejected: true })` for `isGatewayAuthMissing(code)` and for the exhausted mismatch. It still sets `closed` and stops the monitor, so no retry is scheduled.
- Public `authRejected` getter on the client, reset at the top of `connect()`; delegating getter on `OpenClawAdapterClient`.
- `PAIRING_REQUIRED` / `DEVICE_IDENTITY_REQUIRED` untouched (status `pairing`, no flag); every other terminal failure keeps its old two-argument `setStatus`. `src/lib/portal/adapters.ts` needed no change.
**Tests:** new `__tests__/openclaw-client-auth-rejected.test.ts` (7, all red before): `AUTH_TOKEN_MISSING` gives `onStatus('disconnected', msg, { authRejected: true })`, `client.authRejected === true` and no further socket in 10 min of fake time; `AUTH_TOKEN_NOT_CONFIGURED` likewise; mismatch-after-retry sets the flag; a new `connect()` clears it; `PAIRING_REQUIRED` is `pairing` with the flag false; a generic failure carries no flag; the adapter's delegating getter.
**Review:** passed review first time
**Residual:**
- The refusal text is still the OpenClaw one ("Gateway requires setup token or pairing approval"); the provider appends its own probe copy on top.
- `connect()` is `void`, so the provider's `catch` is never reached on this dialect — the status channel is the only signal, as intended.

### R2-OC-3
**Status:** Fixed (commit 7f89ea0)
**Diagnosis:** CONFIRMED. The `ConnectionMonitor` in the client's constructor was built with `onStatus`/`reconnect` only and `monitor.start()` was never called anywhere, and `OpenClawAdapterClient.healthCheck()` returned `{ status: 'ok' }` from the local status flag with no I/O, so the provider's foreground `healLiveClient` treated a half-open socket as verified.
**Fix:**
- `probeLiveness(timeoutMs = OPENCLAW_PROBE_TIMEOUT_MS /* 5 s */)` sends a `capabilities` frame — the method the adapter already calls on connect, no new endpoint — on the live socket and settles true on ANY response frame (the pending entry carries `settleOnAnyResponse`, honoured in `handleMessage`, so an `ok:false` "unknown method" reply still proves the socket); false on timeout, on a send that throws, or with no socket.
- The monitor gets `probe` and `recentlyServedUs` (over a new `lastResponseAt` stamped on every response frame) and is `start()`ed at the end of a successful handshake, mirroring Hermes' `noteConnected()` → `start()`; `stop()` on `connect()`, `disconnect()` and `handleTerminalFailure` is unchanged.
- `nudge(reason)` and `forceReconnect()` added to the client and delegated from `OpenClawAdapterClient`; `forceReconnect` reports `reconnecting` / "Checking the connection" then re-opens the socket in place.
- `request()` now nudges the monitor when its timeout budget runs out — the WS analogue of `onNetworkTrouble`.
- `OpenClawAdapterClient.healthCheck(timeoutMs?)` runs the same probe and returns `{ status: 'ok', platform: 'openclaw', version }` only when the gateway answers, `null` otherwise (and `null` when not connected).
**Tests:** `__tests__/openclaw-client-liveness.test.ts` (12; 11 red before — the unconnected-`healthCheck` case was folded into the silent-socket test as a guard so nothing passes vacuously): the probe frame is asserted on the fake socket and an `ok:false` reply settles true; a silent socket times out and two samples drive `reconnecting` with "Gateway became unreachable" plus `onHealthCheck(false)`; two nudges reach `reconnecting` in ~12 s of fake time; an unanswered request buys a probe and the same verdict; `forceReconnect` retires the old socket; `disconnect()` stops the interval; adapter-side `healthCheck` ok / null / null, `nudge`+`forceReconnect` delegation and `onHealthCheck` forwarded to the wire.
**Review:** passed review first time
**Residual:**
- One extra `capabilities` frame per 30 s interval while connected (plus one per nudge); a gateway that ignores two intervals is declared unreachable — `recentlyServedUs` is the same mask Hermes uses.
- Whether RN's OkHttp surfaces a silent Tailscale path change as `onclose` rather than a stall still needs a device to confirm; the probe covers the stall case.
- The monitor is deliberately not stopped in the socket-close handler (`monitor.stop()` resets `attempts`, which the existing "sustained failures escalate" test pins), so a nudge within 30 s of the last answer is forgiven once: the fastest honest escalation after a drop is "last answer > 30 s ago, then two quick probes".

### R2-OC-4
**Status:** Fixed (commit 7f89ea0)
**Diagnosis:** CONFIRMED. `onHealthCheck` was invoked only from `client.ts` and `manifest-client.ts`; the OpenClaw client published `onHello` and nothing else, and a mid-session drop recovers inside the same client object, so the other history path (`attachClient`) never ran either. Author ADDED: the provider ignores the `healthy` argument and branches on `historyLoadedForRef !== gateway.id`, so firing on every handshake mirrors Hermes exactly — the first connect loads history once, every later one reconciles the interrupted bubble.
**Fix:**
- `onHealthCheck?.(true, this.healthReport(hello.server?.version))` at the end of every completed handshake — after `onHello`, before `monitor.start()` — the same point as `HermesGatewayClient.attemptConnect`.
- `onHealthCheck?.(false)` when the monitor declares the path down, through a new optional `onDeclaredDown(reason)` on `ConnectionMonitorCallbacks` fired from the monitor's failure escalation, so the loss is reported on the health channel instead of being string-matched out of the status detail. No provider edit was needed.
**Tests:** in `__tests__/openclaw-client-liveness.test.ts`, both red before (no `onHealthCheck` member existed on this dialect): "onHealthCheck(true) fires on every completed handshake" — one sample on the first handshake, a second after a drop plus a recovered handshake, each with `platform: 'openclaw'`; the silent-socket test asserts `onHealthCheck(false)` on the declared loss; an adapter test asserts the provider's callback reaches the wire.
**Review:** passed review first time
**Residual:** none.

### R2-OC-5
**Status:** Fixed (commit 00073d2)
**Diagnosis:** CONFIRMED as described. `timeoutMs: 120000` was a wire field inside `chat.send`'s params, not a client timeout: the adapter called `inner.request('chat.send', {...})` with two arguments, so `OpenClawGatewayClient.request`'s 30 s default bounded both the connect wait and the ack, and that rejection cleared `pendingChat`, so every later delta was dropped by the handler's "no pending" early return.
**Fix:**
- `CHAT_SEND_ACK_MS = 120_000` is exported from `openclaw-adapter.ts` and passed as the third argument to `request`.
- `OpenClawGatewayClient.request` takes a fourth optional `options: { connectTimeoutMs?: number }` and bounds the wait for a live socket separately: `waitUntilConnected(options.connectTimeoutMs ?? Math.min(timeoutMs, 30000))`. The adapter passes no options, so a dead path still fails in 30 s while an acknowledged turn gets its full 120 s.
- No other caller changed; with the default `timeoutMs` the new bound resolves to `min(30000, 30000)`, the old number.
**Tests:** settle suite "chat.send timeouts" — the `chat.send` call's third argument is `120000` while the wire params keep `timeoutMs: 120000`; a send into a never-connected client rejects with `Gateway not connected` after 31 s of virtual time, not 120 s; `connectTimeoutMs` works on its own on the client.
**Review:** the reviewer verified OC-5 explicitly — the split bound, that every other caller is behaviourally identical, and that no positional caller passes a fourth argument — and raised no defect against it.
**Residual:** whether a real OpenClaw gateway acknowledges `chat.send` before starting work is unverified; if it always acks first, the new bound is never reached and the surviving exposure was OC-1's unbounded stream.

### R2-OC-6
**Status:** Fixed (commit 7f89ea0)
**Diagnosis:** CONFIRMED at S3 — the audit list's verification correction stands: the provider's auto-retry builds a fresh client once the ladder escalates, so the app self-heals in ~45 s and no restart is needed. `getIdentity()` memoised `identityPromise` and only ever assigned it, so one failed SecureStore read was re-awaited by every later handshake rung of that client object.
**Fix:**
- `getIdentity()` attaches a `.catch()` that nulls `identityPromise` only if it is still the same promise, then lets the rejection through to `sendConnect`'s existing `catch`, which schedules the next rung and re-reads the identity.
- Nothing else changed: no key material logged, the storage error text still reaches only `onError`, never the status.
**Tests:** `__tests__/openclaw-client-identity.test.ts` — "a failed identity read is retried on the next rung instead of poisoning the client": the module mock rejects once, the first rung puts nothing on the wire, and the scheduled retry rung calls `loadOrCreateDeviceIdentity` again and sends a signed `connect` frame (red before: the second rung produced no frame).
**Review:** passed review first time
**Residual:**
- `__tests__/openclaw-client-handshake-test.ts` used `mockRejectedValueOnce` in two pairing-read cases, which only ever saw a failure because the rejected promise was memoised; both are now `mockRejectedValue` so every read fails. Assertion intent unchanged, nothing skipped or weakened.
- An identity that regenerates still discards every stored device token (keyed by `deviceId`) — pre-existing behaviour, outside this finding.

### R2-OC-7
**Status:** Fixed (commit 00073d2) for the three reads on this adapter; no Hermes or manifest file was touched.
**Diagnosis:** CONFIRMED. `getSessions`, `getSessionMessages` and `getModels` each wrapped their RPC in `try { … } catch { return [] }`, and `resolveResumeSession` (`session-resume.ts:120-127`) only declines to create a session when the list THROWS — its own comment states that invariant — so a swallowed timeout arrived as "the gateway hosts no sessions" and fell through to `createSession`.
**Fix:**
- All three reads now let the underlying error propagate. `readOpenClawCollection` is untouched, so a genuinely empty or absent collection still yields `[]` — the case the brief distinguishes from a failure.
- Every call site was checked and needed no change: `resolveResumeSession`, both provider history reads (through `readHistory`), `readSessionList`, `loadBotChat`, and the three `getModels` callers all already catch and surface an error.
**Tests:** `__tests__/openclaw-adapter-reads.test.ts` — a refused `sessions.list` rejects; through the real `resolveResumeSession` a failed list yields `{sessionId: undefined}` with zero `sessions.create` calls (the exact failure described); a failed `session.messages` and a failed `models.list` both reject; an empty-but-successful read is still `[]`. All four rejection assertions fail on pre-fix code.
**Review:** the reviewer re-checked this independently — all three reads rethrow, `readOpenClawCollection` is untouched, and it traced every call site as guarded — and raised no repair for it.
**Residual:** a gateway whose `sessions.list` is legitimately unavailable now leaves the thread sessionless (stateless chat) instead of silently opening a fresh session; that is the trade `session-resume.ts` was already written to make.

### R2-OC-8
**Status:** Fixed (commit 00073d2) for the OpenClaw adapter's part; the Hermes and manifest clients' own profile pins are dead for the same reason but those files were not in this package's allowed list.
**Diagnosis:** CONFIRMED on both halves, and the author CORRECTED the brief's chosen mechanism: `disconnect()` writing the pin onto `this.profile` cannot work, because `createClientForKind` passes `profileWithAlternateIpv4(gateway)` — a fresh `{...profile}` copy — and `updateProfile` is never called in `src`, so the pin lands on an object nobody reads. `normalizeOpenClawSession` also stamped every row `source: 'openclaw'` while `pickAppSession` accepts only `APP_SESSION_SOURCE = 'api_server'`, so no owned session could ever match.
**Fix:**
- `getSessions` re-tags a row `APP_SESSION_SOURCE` when the adapter owns the id; `normalizeOpenClawSession` is untouched so its pure-mapping test still holds. Rows belonging to the gateway's other surfaces (TUI, cron) keep `source: 'openclaw'`.
- Ownership is a bounded set of 8 (`rememberOwnedSession`), seeded from `profile.sessionId` and extended by `setSessionId`, `createSession` (which adopts the id it just created), `streamChat`, and a gateway-adopted id.
- The set is durable, which is what actually crosses an adapter rebuild: `loadOwnedSessions` reads it lazily once per adapter from `keyValueStorage` under `versutus:openclaw-owned-sessions:<profile.id>`, `persistOwnedSessions` writes on every change, both best-effort and never throwing.
- `disconnect()` now deliberately does not pin to the profile; the comment there records why.
**Tests:** `__tests__/openclaw-adapter-session.test.ts`, all through the real `resolveResumeSession` — connect → reconnect resolves the same id with one `sessions.create`; an adapter rebuilt from its own `{...profile}` copy (the production shape) resumes the same id with no second create; ids land under this gateway's key bounded to the newest 8; a foreign session is not adopted; no owned id still opens exactly one session; an unwritable store costs continuity but not the connect.
**Review:** failed review 1 — the profile pin was inert in production and the "rebuilt from the pinned profile" test passed only because it shared one mutable `stored` object between adapters, which is exactly the fixture that hides the copy. Repair: the storage-backed owned ids above, the profile pin removed, and the test rewritten to build two adapters from separate profile copies sharing only fake storage.
**Residual:** ownership is inferred from what this phone has handled, not from anything the gateway asserts, so a session also used from the TUI counts as the app's; `ownsSession` is the single place to change if an owning-surface field appears. A brand-new install still creates one session on first connect.

### R2-ID-1
**Status:** Fixed (commit 4769620)
**Diagnosis:** CONFIRMED. `identifyGateway` wrapped steps 2, 3 and 5 in `withHostLookupRetry(baseUrl, alternateIpv4, …)` while step 4 called `probeOpenClaw(baseUrl, …)`, whose socket URL came from `httpToWsBase(baseUrl)` alone, so a MagicDNS miss filed a reachable WS-only gateway as `unknown`. Author CORRECTED the brief's framing: the list cannot go *into* `probeOpenClaw` and still get the retry — `withHostLookupRetry` only advances when an attempt throws a lookup-class failure, and the probe never threw, so the probe has to reject with wording `isHostLookupFailure` recognises.
**Fix:**
- `identify.ts:143-146` — step 4 is now `withHostLookupRetry(baseUrl, alternateIpv4, (candidate) => probeOpenClaw(candidate, Math.min(6000, remaining()))).catch(() => null)`, the same shape as the Hermes probe, so each candidate draws from what is left of `timeoutMs` and an exhausted probe still never throws out of `identifyGateway`.
- `probeOpenClaw`'s promise takes `reject`; a `close(settle)` helper replaces `finish` so the socket is released identically either way, and `unreachable()` rejects with `Unable to resolve host <hostnameOf(baseUrl)>`.
- Only `socket.onerror` rejects; `onclose`, the per-attempt timer, a constructor throw and a non-JSON frame still resolve `null` exactly as before.
**Tests:** new `__tests__/portal-identify-openclaw-ipv4-test.ts` (5; 1 red before — a gateway reachable only on `100.64.0.9` came back `unknown`): the reachable-on-IPv4 case now identifies as `openclaw`; the four guards pass before and after — no advertised address still reads `unknown`, a gateway failing everywhere resolves honestly, a hostname that answers the challenge is never dialled on the IPv4, an https base keeps its wss probe on the hostname.
**Review:** passed review first time
**Residual:**
- A WS error event carries no error object, so a dead name and a refused port both retry; worst case is one extra bounded probe and the same `unknown` result.
- The rejected message is the platform's lookup wording because `isHostLookupFailure` matches on text and `host-lookup.ts` is outside the allowed files; it is swallowed by `.catch(() => null)`.
- Only `onerror` triggers the retry — a dial that never opens always raises it per spec/OkHttp, but no speculative `onclose(1006)` handling was added without a test to pin it. Not verified on a device.

### R2-OC-9
**Status:** Fixed (commit 00073d2)
**Diagnosis:** CONFIRMED. The guard `payload.runId && pending.runId && payload.runId !== pending.runId` was inert because `PendingChat.runId` was declared optional and never assigned, and `pendingChat` is a single slot, so a stopped run's late deltas were appended to the next turn's bubble and its late error rejected that turn.
**Fix:**
- `pending.runId` is set from the `chat.send` acknowledgement when the gateway sent one (`readChatAck` reads it, nothing is guessed).
- `retireRun` keeps the 8 most recent finished run ids, retired inside `settleChat` on every settle path, and `handleChatEvent` drops a frame whose `runId` disagrees with a known `pending.runId` or sits in the retired set.
- A frame carrying the pending turn's own `runId` is accepted before the retired set is consulted, and the ack handler deletes its own id from `retiredRuns`, so a gateway that reuses one run id across a session's turns still works.
- Frames with no `runId`, or a pending whose run id the ack never named, behave exactly as before.
**Tests:** settle suite "stale run frames" — run A acked `run-a`, aborted, run B acked `run-b`: a late delta for A leaves B's text empty, a late error for A does not reject B, and B then resolves `fresh`; two turns whose ack and frames carry the SAME `runId` both complete; a frame with no `runId` still streams.
**Review:** failed review 1 — the retired set was checked before the pending match and the ack never un-retired its id, so a gateway reusing a run id had every frame of the next turn dropped until the 150 s stall fired and the turn rejected itself (a regression the dead pre-fix guard had hidden). Repair: the guard reorder, `retiredRuns.delete(acked.runId)`, the reuse test, and `touch()` fixed so the entry it just added is no longer the one evicted next.
**Residual:** a gateway that sends no `runId` on the acknowledgement keeps the old single-slot behaviour — there is nothing to correlate on, and nothing regresses for it.

### R2-OC-10
**Status:** Not fixed (needs protocol evidence)
The operator's model pick never reaches the OpenClaw `chat.send` wire. The repo holds no protocol documentation showing a `model` field on `chat.send`, and inventing a wire field is not safe; the model is only honoured when a session is created (`sessions.create`). Left unchanged; the fix needs the OpenClaw protocol (or a visible 'model not supported here' state, a product call).

### R2-ST-1
**Status:** Fixed (commit 7f89ea0)
**Diagnosis:** CONFIRMED. `void this.storeHelloDeviceToken(hello)` had no `.catch` — `saveDeviceAuthToken` awaits the SecureStore write and throws on failure (`device-auth-token.ts`) — and the `AUTH_DEVICE_TOKEN_MISMATCH` chain was `.then(...).finally(...)` with no `.catch`, so a rejected `getIdentity()` or `clearDeviceAuthToken` escaped as an unhandled rejection while the retry still happened.
**Fix:**
- The token write gets `.catch(() => callbacks.onError?.('Could not save the gateway pairing token. Versutus will have to pair again.'))` — fixed copy, no raw storage text and no key name — and never rethrows.
- The mismatch chain gets a `.catch` reporting "Could not clear the stored pairing token. Versutus will retry the connection.", with `.finally(scheduleReconnect)` still after it, so the retry rung is never lost.
**Tests:** `__tests__/openclaw-client-identity.test.ts`, both red before (no error reported, unhandled rejection captured): the write case asserts the message matches /pairing token/ and contains neither the raw storage text nor the key name, that the connection still reports `connected`, and that a `process.on('unhandledRejection')` collector captured nothing; the clear case asserts the same plus that the retry socket is still dialled.
**Review:** passed review first time
**Residual:**
- A failed write still costs the pairing — the message is the whole fix; a token that could not be persisted cannot be kept.

### R2-AC-1
**Status:** Fixed (commit 4769620)
**Diagnosis:** CONFIRMED. `AccessRequestResult` had no "unreachable" member, and both paths collapsed every failure into `denied`: `requestOpenClawAccess`'s `onError` fired for the client's own transport facts ("Could not reach gateway at …", 1005 "closed before handshake completed", "Gateway handshake timed out") as well as the local 15 s timer, and `postSignedAccessRequest`'s catch-all turned `HostLookupError`, `AbortError`, timeouts and network errors into the same verdict. The probe profile also carried no `alternateIpv4`. Author ADDED, after reading the client: the only verdict signal reachable from `access.ts` is `info.authRejected` on `onStatus`, and `handleTerminalFailure` raises it one statement *after* `onError` returns — so the flag has to be read a microtask later.
**Fix:**
- `access.ts:28` adds `{ status: 'unreachable'; reason: string }`; the result contract at the top now reads `denied` as "a verdict it actually gave" and `unreachable` as "nothing answered".
- The signed POST's IPv4 derivation is lifted into `fallbackIpv4()`, overridable through the new optional `RequestGatewayAccessOptions.alternateIpv4`; `requestOpenClawAccess` puts it on the profile it builds, so the WS probe gets the addresses the POST already retried over.
- A new `onStatus` records `info.authRejected`; `onError` defers one microtask and files `denied` only if that flag was raised, `unreachable` otherwise. The 15 s timer is `unreachable`.
- `postSignedAccessRequest`'s catch-all is `unreachable` with the same message text; 403, an explicit `denied` body and any other unexpected HTTP status stay `denied` (the gateway did answer). `device-identity` handling untouched.
- `add.tsx:87-91` renders `unreachable` as `setSaveError(reason)` + `setSaving(false)` + `return`, exactly like `device-identity`, never touching `accessNote`; the warm `accentWarm` note stays gated on `accessStatus === 'denied'`.
**Tests:** new `__tests__/portal-access-unreachable-test.ts` (7; 4 red before) drives the **real** `OpenClawGatewayClient` against a fake socket with fake timers: 1006-before-any-frame, 1005, the 15 s timer and an unflagged connect error are `unreachable`; `AUTH_TOKEN_MISSING` stays `denied` with the client's own wording; `PAIRING_REQUIRED` still `pending-approval` with `requestId`; a `hello-ok` frame still `granted` with the device token. `portal-access-test.ts` gains HTTP cases (network throw, `AbortError` → `unreachable`; `denied` body on a 401, 500 → `denied` with "Unexpected access response (HTTP 500).") and a new describe pinning the probe profile's `alternateIpv4` (manifest advertisement first, then configured hosts; explicit set used verbatim). Two existing assertions pinned the defect and were changed: `an https base is never rewritten onto an IPv4` now expects `unreachable` instead of `denied`, and `a non-lookup failure is not retried and resolves denied once` was renamed to `…reports the dead path once` and now expects `{ status: 'unreachable', reason: 'Network request failed' }` with a realistic throw. Nothing deleted, skipped or weakened. New `__tests__/gateway-add-unreachable-test.ts` (6; 2 red before) is a source scan — no renderer exists in this repo — pinning the branch's `setSaveError`/`setSaving(false)`/`return`, that it never calls `setAccessNote`, and that `denied` still takes the note and the `accentWarm` colour.
**Review:** passed review first time
**Residual:**
- The OpenClaw verdict signal is one flag, so a connect error the client does not flag (`PROTOCOL_VERSION_UNSUPPORTED`, a malformed handshake, the catch-all `else`) now reads `unreachable` rather than `denied`. That is the brief's conservative rule and is pinned by the `conservative side` test; a real fix needs `onError(message, { transport })` in `openclaw-client.ts`, outside this package's allowed files.
- The probe profile's fallback is largely inert within one request: the first pre-handshake transport error settles the request and `finish` calls `client.disconnect()`, so the client's dial rotation never gets a rung. Letting the ladder retry inside the 15 s budget would contradict the brief's explicit "onError → unreachable" rule.
- An OpenClaw device-identity failure (SecureStore fault while signing the connect) arrives on the same channel with no verdict flag, so it reads `unreachable`, not `device-identity`; the HTTP path's `device-identity` classification is unchanged.
- `add.tsx` is verified by source assertions plus `tsc`, not at runtime — `@testing-library/react-native` and `react-test-renderer` are not installed here. The manual path is written out in the notes.

### R2-OC-V1
**Status:** Fixed (commit 7f89ea0)
**Diagnosis:** CONFIRMED. `adapters.ts` computes `profileWithAlternateIpv4` for every dialect and `OpenClawAdapterClient` already forwards it, but `openSocket` built the WebSocket from `this.profile.url` alone, so a MagicDNS name that missed while the advertised tailnet IPv4 worked could never connect — first attempt or any reconnect. Author ADDED: `host-lookup.rewriteHttpUrlHost` refuses anything that is not `http:`, so it could not be reused for a `ws://` URL.
**Fix:**
- `openSocket()` dials `nextDialUrl()`; `dialUrls()` builds `[profile.url, ...ipv4SocketUrls(profile.url, alternateIpv4)]` with the address that last completed a handshake moved to the front (IPv4-first memory, as in `host-lookup.ts`), and a completed handshake resets the cursor and records the URL.
- New module helper `ipv4SocketUrls()` rewrites the ws URL onto each advertised IPv4 keeping the same scheme, port, path and query; `isIpv4` is imported from `host-lookup.ts` rather than re-implemented.
- The rotation trigger is the lookup-class failure: an `onclose` with code 1006 before any `onopen`, or a `WebSocket` constructor throw.
- Deliberate behaviour change: when an advertised address exists, a constructor throw now reports and `scheduleReconnect`s instead of calling `handleTerminalFailure`, so a later rung can try the IPv4. With no `alternateIpv4` the old terminal failure is unchanged.
**Tests:** `__tests__/openclaw-client-ipv4-dial.test.ts` (5; the three rotation tests red before, the two "unchanged" guards pass before and after by design): with `alternateIpv4: ['100.64.0.9']` and `ws://gate.tailnet.ts.net:8642/openclaw`, a 1006-before-open dial makes the next rung construct `ws://100.64.0.9:8642/openclaw`; a constructor throw on the name reports, retries and lands on the IPv4; once the IPv4 completes a handshake it is the URL used by the next reconnect; a socket that opened then closed 1000 is not treated as a lookup failure; a profile without alternates dials the saved URL only and still fails terminally.
**Review:** passed review first time
**Residual:**
- The remembered address is sticky for the life of that client object (no two-minute expiry like `host-lookup.ts`), so a client that connected over the IPv4 keeps using it until the provider builds a fresh client; the cursor still walks the other candidates after a dial that never opens.

### R2-OC-V2
**Status:** Fixed in part — the whole option surface is now typed and `onSession` is wired; `onToolCall`, `onReasoning`, `onTelemetryWarning`, `onModelReport` and `onTurnId` are accepted and deliberately never called, because this dialect emits no frame for them and the brief forbids calling `onTurnId` (the provider would POST `/v1/chat/cancel` to the Gate).
**Diagnosis:** CONFIRMED. `PortalClient.streamChat` declares six more callbacks that the provider passes on every send; the OpenClaw implementation accepted only `{model?, sessionId?, signal?}`, and bivariant interface method parameters meant tsc never complained. A session the gateway adopts for a turn was never reported, so the thread stayed sessionless on this dialect.
**Fix:**
- `streamChat`'s options type is now the interface's own — `NonNullable<Parameters<PortalClient['streamChat']>[2]>` — with no `any`, so a callback the provider starts passing cannot be dropped here in silence again.
- When the ack carries a `sessionId` different from the id the turn started with (including a sessionless turn), the adapter adopts it as `currentSessionId`, updates the pending chat's session id so the stall path aborts the right session, marks it owned, and calls `options.onSession?.(id)` exactly once.
- Stop on this dialect already works through `session.abort` in `abortChat`, so nothing calls `onTurnId`; the doc comment on `streamChat` states why.
**Tests:** settle suite "the provider's streamChat options" — an ack with `sessionId: 'oc_adopted'` on a sessionless turn fires `onSession` exactly once with that id, `adapter.sessionId` reports it and `onTurnId` never fires; an ack repeating the turn's own session id leaves `onSession` silent. The `onSession` assertions fail on pre-fix code.
**Review:** the reviewer verified this finding independently — the interface-derived type, the once-only `onSession` matching the provider's own `if (sessionIdRef.current) return;` guard, and `onTurnId` never called — and raised no repair for it.
**Residual:** tool cards, reasoning, telemetry warnings and model-substitution reporting remain unavailable on this dialect; that is a wire-capability question, not a typing one, and inventing a frame is not allowed. The widened signature makes the gap visible instead of silent.

### R2-OC-V3
**Status:** Fixed (commit 00073d2)
**Diagnosis:** CONFIRMED, and the audit's "load-bearing" framing held: `ChatEventPayload` declared `state?: 'streaming'|'complete'|'error'` with `text`/`error`, while the only consumer (`handleChatEvent`) and `docs/audit-bugs-architecture.md` P1-1 use `started|delta|final|error` with `deltaText`, `message.content`, `errorMessage` and `runId`; the frame arrived through an `as ChatEventPayload` cast, so anything written against the type compiled and then never settled a turn. It is also why OC-9's guard had nothing to read.
**Fix:**
- `ChatEventPayload` (`openclaw-types.ts`) now declares `runId?`, `message?: { content?: unknown }`, `errorMessage?` and `state?: 'started' | 'delta' | 'final' | 'error'`. `sessionId?`, `deltaText?`, `text?`, `error?` and `command?` are kept so no caller loses vocabulary.
- `handleChatEvent(payload: ChatEventPayload)` now takes the shared type instead of its inline structural copy.
- The `as ChatEventPayload` cast at the client's frame boundary remains — the type it casts to is now the one the handler actually implements, and `runId` finally has a declaration for OC-9 to read from.
**Tests:** no suite of its own; every frame in the three new suites is written in the now-declared dialect, and a frame in the old vocabulary (`state: 'complete'`) no longer compiles, which is the defect made visible. `tsc --noEmit` over the project is the compile-time half; the settle suite is the runtime half.
**Review:** the reviewer diffed the new union against P1-1 and confirmed `rg ChatEventPayload` shows no other reader of `text` or `command`, so nothing else loses vocabulary and no existing test file needed changing; no repair for this finding.
**Residual:** the cast is still a cast, so a frame whose `state` is some future fifth value compiles and is silently ignored. A typed parse that rejects an unrecognised state would be the stronger fix but changes the client's frame handling and no finding in this package required it.

### R2-PROV-1
*Package G10*
**Status:** Fixed in part (commit 98347a8) — the `/v1/models` half only. The service-layer halves named in the same audit entry (`update()` carrying `existing.state` through, `chat()` never reading `config.enabled`) landed earlier in commit 360134c, outside this package.
**Diagnosis:** CONFIRMED for the model-list half. The `/v1/models` loop over `providerService.list()` (`server.mjs:2526`) pushed every snapshot's catalog models with no readiness check, so a provider whose `readiness.state` was `disabled` was still offered in the picker. No corrections.
**Fix:**
- One guard: `if (snapshot.readiness?.state === 'disabled') continue;` at `server.mjs:2529`, so a disabled provider contributes no models.
- Nothing else changed — enabled providers, the `state.providers` config fallback, the legacy twin fallbacks, the `catalogSource`/`provider` fields and the response envelope are as they were.
**Tests:** `gate/__tests__/provider-models-disabled.test.mjs` (new, 1 test) seeds one enabled provider with a live catalog, one disabled provider with a catalog, and a legacy `registry/twin.json` twin with bootstrap models so the fallback path runs too. It asserts the enabled provider's two models are listed, the disabled provider contributes zero, and the legacy twin's model is still present. Pre-fix it fails with the disabled provider's `off-1` present in `body.data`; post-fix it passes.
**Review:** Harness passed first time (tsc, eslint, verify-config, whole Gate suite 1469 tests); the only defect the review reported was the missing `.fix-notes.md`, so no code repair was needed.
**Residual:**
- Only `readiness.state === 'disabled'` is filtered, so a provider disabled in config whose stored readiness has not yet caught up is still listed for one reload window — the pre-existing shape of readiness, not a new gap.

*Package G9*
**Status:** Fixed (commit 360134c), this part only - `/v1/models` still lists a disabled provider's models (server.mjs has no `enabled` filter, out of scope)
**Diagnosis:** CONFIRMED. `update()` merged config and wrote `existing.state` straight back, so readiness kept the last probe's verdict; `chat()` read no `enabled` field, so a disabled provider kept answering turns. The neutral re-enable value `unavailable` was taken from the app's own union in `src/lib/gateway/provider-types.ts:24`.
**Fix:**
- `service.mjs` `update()` derives the new state via new `stateAfterUpdate()`: disabling stores `readinessFromAuthAndError({enabled:false,...})` at once, re-enabling stores `{state:'unavailable', checkedAt}`.
- Neither transition calls the vendor.
- `chat()` in `service.mjs` rejects with `code: ProviderErrorCodes.disabled` before `adapterFor()` is reached.
- `resolveModel` untouched.
**Tests:** `gate/__tests__/provider-service-disable.test.mjs` - disabling marks the record disabled at once; a disabled provider refuses a turn (`calls.chat === 0`, stored auth untouched); re-enabling clears `disabled` without claiming ready. All three fail on the pre-fix sources.
**Review:** passed review first time.
**Residual:**
- `/v1/models` (server.mjs:2457-2471) still offers a disabled provider's models.
- The HTTP status the phone sees for a refused disabled turn is server.mjs's business.

### R2-PROV-2
**Status:** Fixed (commit 98347a8)
**Diagnosis:** CONFIRMED as written. `chatViaProviderService` (`gate/core/server.mjs:1015`) awaited `providerService.noteChatOutcome(providerId, null)` right after `providerService.chat()` resolved — at headers — and both relays swallowed a mid-stream death locally through `endProviderStreamWithError`, so a stream that died after its first byte recorded nothing. No corrections to the audit's diagnosis.
**Fix:**
- `relayNormalizedSse` (`server.mjs:449`) now resolves with how the turn ended: `{ ok: true }`, `{ ok: false, error }` or `{ abandoned: true }`; the oversized-line guard builds a real Error with `code: 'upstream_error'` and returns `{ ok: false, error }`.
- The inline iterator loop became `relayIteratorSse` (`server.mjs:512`) returning the same three outcomes; the frames it writes are unchanged.
- `chatViaProviderService` (`server.mjs:1081-1087`) awaits the relay and records success only on `ok`, the error only on `ok: false`, nothing on `abandoned`, so Stop marks a provider neither failed nor ready. A non-streaming turn still records right after its body is written.
- `noteTurnOutcome` (`server.mjs:1009`) is the single recording entry point; it swallows store errors and schedules the debounced reload on `{ changed: true }`. The relays `res.end()` before it is awaited, so the final write is never delayed by the store.
- Pre-header `catch` (`server.mjs:1042-1045`): `disabled`, `missing_credentials`, `credential_unreadable` (`CONFIGURATION_ERROR_CODES`, `server.mjs:82`) become HTTP 409 `{ error: { message, code } }` with no outcome written; everything else keeps `error.status` when it is a valid 4xx/5xx, else 502, and records.
- Legacy twin `proxyChat` (`server.mjs:418`) awaits and discards the new return value, so its behaviour and readiness semantics are unchanged.
**Tests:** `gate/__tests__/provider-stream-outcome.test.mjs` (new, 7 tests; real Gate on port 0, real `ProviderStore`, mocked `ProviderService.chat`). An iterator dying after two deltas and an upstream `body.getReader` dying the same way each assert the client received the delta frames plus the error frame and the stored outcome is `ok: false` with `readiness.code: 'transient_network'` and a `lastError` matching the stream error; a completed stream stores `ok: true` / `ready`; a mid-stream client disconnect leaves `lastChatOutcome` undefined; a non-streaming success still records; `disabled` and `missing_credentials` each answer 409 with the exact `code` and write nothing.
Pre-fix run: 5 of 7 fail (both mid-stream deaths, the disconnect case, both 409s); the two that pass are the unchanged-behaviour ones by design.
**Review:** Harness passed first time (tsc, eslint, verify-config, whole Gate suite 1469 tests); the only defect the review reported was that `.fix-notes.md` was never written — no code repair was needed.
**Residual:**
- `abandoned` is decided by `clientGone()` (socket destroyed/ended, or the upstream call's own signal); a client that vanishes in the same tick the upstream throws is recorded as a failure, which is invisible from the client side.
- No schema or response shape changed.

### R2-PROV-3
**Status:** Fixed (commit 360134c)
**Diagnosis:** CONFIRMED and executed. Four writers with three orderings: `check` had no queue at all, chat outcomes had `chatOutcomeQueues`, catalog refreshes a different `refreshQueues`, `update` a fourth unqueued writer. `store.put` only serialises its own file writes, so each commit landed a record built from a stale read.
**Fix:**
- One per-provider queue `commit(id, run)` in `service.mjs`, used by `check`, `noteChatOutcome`, `refreshCatalog`, `update` and `delete`.
- Slow work stays outside: credential probe, `inspect` and `listModels` run before `commit`; only the re-read-decide-write step is inside, applying just that operation's fields.
- `supersededByFailedTurn()` keeps a failed turn's verdict when the probe went out first; every outcome stamps `lastChatOutcome = {at, ok, seq}`.
- `check`/`refreshCatalog` coalesce while one is in flight (same promise, one vendor call); `noteChatOutcome` now resolves to `{changed}` via `verdictChanged()`; a throwing queue entry does not poison the ones behind it; a probe finishing after `delete` does not resurrect the provider.
**Tests:** `provider-service-concurrency.test.mjs` (6 tests) - failed turn survives an in-flight check; failed turn during a refresh keeps both verdict and models; two overlapping checks make one vendor call; post-delete probe does not restore; an already-ready successful turn reports no change. 5 of 6 fail pre-fix; the sixth guards the opposite ordering.
**Review:** passed review first time.
**Residual:**
- Two assertions in `provider-catalog.test.mjs` pinned the old non-coalescing behaviour and were rewritten, not weakened (both fail pre-fix); its one serialised-refresh test became two.
- `lastChatOutcome` carries an extra `seq` because `Date.now()` cannot order two facts in the same millisecond.
- A forced tap landing beside an in-flight non-forced refresh joins it and may get the TTL-skipped answer.

### R2-PROV-4
**Status:** Fixed (commit 360134c), this part only - the local-interface adapter (`local/adapter.mjs`) health/models fetches are still unbounded, explicitly out of scope
**Diagnosis:** CONFIRMED and executed pre-fix: `requestPolicy.timeoutMs` was validated and written by three callers and read nowhere; `profiles/registry.mjs` fetched with `{headers}` only, so a fetch that never answers outlives any test timeout (the process itself had to be killed).
**Fix:**
- `factory.mjs` passes `config.requestPolicy?.timeoutMs ?? 120_000` into `createProfileAdapter`.
- `profiles/registry.mjs` `listModels` wraps its fetch in new `boundedRequest()`: `Math.min(timeoutMs, 30_000)`, `unref`'d timer, always cleared in a `finally`, expiry raised as an `Error` with `code:'ETIMEDOUT'` so it classifies `transient_network`.
- `authenticate` performs no fetch and `health` delegates to `listModels`, so both inherit the bound.
- Chat's own timeout is left to server.mjs' `providerUpstreamCall`; no second abort was added to the streaming path.
**Tests:** `provider-vendor-timeout.test.mjs` - a models fetch that never answers rejects with `code === 'ETIMEDOUT'` and `transient_network` in under 5s with no leaked timer; an answered request clears its budget timer; a registration's own `requestPolicy.timeoutMs` bounds the call through `createProviderAdapter` against a real socket that accepts and never answers. Two fail/hang pre-fix (`exit=124`).
**Review:** passed review first time.
**Residual:**
- The 30s ceiling caps the catalog path even where a registration asks for 120s; the chat path keeps its own upstream timer.
- `local/adapter.mjs` fetches remain unbounded.

### R2-PROV-5
**Status:** Fixed (commit 360134c)
**Diagnosis:** CONFIRMED. `credentialPresent` asked only the vault while `factory.mjs` `resolveCredential`, used by chat, also accepts `process.env[record.state.legacyApiKeyEnv]` (the name `migrate-v1.mjs` records). Such a migrated provider read `auth: missing`, was skipped before `listModels`, and contributed nothing to `/v1/models`.
**Fix:**
- `credentialPresent(config, record)` in `service.mjs` now agrees with the adapter's resolver: vault hit, or `record.state.legacyApiKeyEnv` names a variable that is set.
- `inspect` passes the record it already holds.
- No secret is copied into the vault; env name and secret stay in `state` as before.
**Tests:** `provider-credential-state.test.mjs` - a key living in the environment counts as present (`auth: ready`, and `refreshCatalog` really calls `listModels`); guard that a named but unset variable is still missing. The first fails pre-fix.
**Review:** passed review first time.
**Residual:** none - the two answers can still differ only in the direction where an unreadable vault file with a valid env fallback now reports ready, which matches what the adapter would send.

### R2-PROV-6
**Status:** Fixed (commit fae703a). Also carries the vault half of R2-STORE-1 (the atomic `set`); the provider-store half is another package.
**Diagnosis:** CONFIRMED. `runHelper` in `gate/core/credentials/windows-dpapi.mjs` spawned a fresh `powershell.exe -NoProfile -Command` per call with no timer, settling only from `child.on('close')`, and `CredentialVault.get` called `backend.unprotect` on every invocation with no memoisation; `ProviderService.inspect` calls `authenticate()` then `health()`, so one readiness tap paid two JIT `Add-Type` compiles and a hung PowerShell hung the request forever. ADDED by the notes: pre-fix `set` was `writeFile(tmp)` → `rm(dest)` → `rename`, so the ref did not exist on disk between `rm` and `rename`.
**Fix:**
- `windows-dpapi.mjs:53-96` `runHelper`: a hard `setTimeout` (default `20000`, injectable through `createWindowsDpapi({ timeoutMs, spawnImpl })`); on expiry `child.kill()`, plus `taskkill /T /F /PID <pid>` on `win32`, then reject with `code: 'dpapi_timeout'`. A `settled` latch guards `fail`/`succeed` so a late `close` cannot re-settle. Non-zero exit keeps the `DPAPI <op> failed: <stderr|code>` message and adds `code: 'credential_unreadable'` (unprotect) / `'credential_protect_failed'` (protect); the `HELPER` script and base64 payload are untouched, so existing `.dpapi` files still decrypt.
- `vault.mjs:44-51` `set` calls the shared `writeFileAtomic(dest, protectedValue)` from `core/atomic-file.mjs` (tmp + rename-over-target with its EPERM/EBUSY retry); the tmp/rm/rename logic is gone, so a concurrent `has`/`get` never answers "missing".
- `vault.mjs:53-95` `get` coalesces concurrent reads per ref through an `inFlight` map (one decrypt for N waiters, stored as `{ promise }` so identity can be compared) and `readThrough` serves a per-ref plaintext cache keyed to the file's `mtimeMs`+`size` with `cacheTtlMs` (default 5 min, `0` disables). A stat failure, a changed mtime/size or expiry drops the entry; a missing file returns `undefined`; a decrypt failure propagates with its code and is never cached. Comment at `vault.mjs:7-11` records why the cache adds no exposure beyond what the adapters already materialise.
- `vault.mjs:36-42` `invalidate(ref)` (called by `set` and `delete`) now also drops the `inFlight` entry, and `readThrough` caches only while its own entry is still the ref's current one, so a decrypt that started before a write cannot repopulate the cache with the replaced value.
**Tests:** new `gate/__tests__/credential-vault-dpapi.test.mjs` (19 tests; injected fake `spawnImpl` + counting fake backend, no PowerShell needed). DPAPI: timeout kills and rejects `dpapi_timeout`, a late `close` is ignored, unprotect/protect map to `credential_unreadable`/`credential_protect_failed` with the original message, a normal run resolves, a spawn `error` rejects. Vault: 5 concurrent gets → 1 `unprotect`, TTL hit → 0, `set` invalidates, a rewritten file invalidates, TTL expiry re-decrypts, `cacheTtlMs: 0` always decrypts, a failure is not cached and is rethrown with its code, a missing file → `undefined`. "set is atomic" runs a 200-iteration reader loop against 200 `set`s — 0/200 "missing"; the author replayed the old rm-then-rename sequence standalone and saw 48/200 (the reviewer measured 44/200). Round 2 added "a get issued after a set does not join a decrypt started before it", which fails with `vault.mjs` reverted (18 pass / 1 fail). No existing assertion changed.
**Review:** failed first review. Round 1 caught that `invalidate()` cleared the cache but not `inFlight`, so a post-`set` `get` could join a pre-write decrypt and return the old plaintext; round 2 added the in-flight drop plus the discriminating test. The same review also failed CRED-1 and CRED-2 (below), and a `taskkill` stdio note, which the author declined.
**Residual:**
- Cache validation is `mtimeMs`+`size` only. Two same-length credentials produce same-length DPAPI blobs, so on a coarse-mtime volume (FAT32/exFAT, network share) a credential swapped by another process can be served stale for up to 5 minutes. Fine on NTFS; fixing it means hashing the ciphertext on every read (an extra file read), which the author judged worth it only if the Gate home can live on a share — unconfirmed.
- `windows-dpapi.mjs:78` spawns `taskkill` with default piped stdio and never drains it; the output is tiny so nothing blocks, left alone to keep the diff minimal, and that path only runs on a timeout that already rejects.
- The provider layer still classifies the raw `inspect` error via `classifyProviderError` as `transient_network`; that is G9's file.

### R2-OAUTH-1
**Status:** Fixed in part (commit 98347a8) — the attempt/listener leak only. The rest of the finding (no shipped OAuth profile, `releaseOAuthProfiles` empty, no `authorizationUrl` on the attempt, `getAccess` uncalled) is a documented decision deferred until a desktop-client contract exists, and the brief says not to build it.
**Diagnosis:** CONFIRMED, leak half. `createPkceAttempt` opens an `http.createServer` on 127.0.0.1 per attempt; pre-fix the expiry timer only called `rejectCallback(new Error('attempt expired'))`, so the listener stayed bound and the attempt stayed in the in-memory `AttemptStore` for the life of the process, and the listener also stayed open after serving its one callback.
**Fix:**
- `pkce-callback.mjs:40-56` adds one memoised `release()`: `clearTimeout`, `server.close(...)`, `server.closeAllConnections?.()` (so the browser that just ran the callback is not left on a socket being torn down), then `store.delete(attempt.id)`. Idempotent and never throws.
- Three callers reach it: the expiry timer (`pkce-callback.mjs:95-98`), the served callback in the `res.end` completion callback (`:78-85`), and `attempt.close` (`:102`).
- `AttemptStore.delete` already existed (`attempt-store.mjs:15`), so `attempt-store.mjs` is unchanged; `consumePkceAttempt` is untouched and the expired attempt's `callback` still rejects `attempt expired` behind its existing `.catch(() => {})`.
**Tests:** `gate/__tests__/pkce-attempt-cleanup.test.mjs` (new, 4 tests): an expired attempt's loopback port refuses a TCP connect and `store.get(id)` is `undefined`; a real `fetch` of the redirect URI resolves `callback`, after which the port refuses and the store entry is gone; `close()` twice, and after an expiry, is safe; `consumePkceAttempt` still binds state, is one-use and enforces `expiresAt`. Pre-fix run: all 4 fail (ports still accept, or the store entry remains).
Existing assertion that pinned the defect: `gate/__tests__/oauth-pkce.test.mjs` waited a real 1 ms ttl and asserted `consumePkceAttempt` threw `/expir/i`; an expired attempt now releases itself, so `consume` reports it as unknown first, and the test moves `expiresAt` back by hand instead — same rule, without depending on the timer winning a race.
**Review:** Harness passed first time (tsc, eslint, verify-config, whole Gate suite 1469 tests); the only defect the review reported was the missing `.fix-notes.md`, so no code repair was needed.
**Residual:**
- A client reaching the callback a few milliseconds after the ttl now gets connection refused instead of the expiry error page; intended, since the attempt is already dead to `consume` too, but a visible change at that boundary.
- `attempt.close()` after expiry now resolves through the same memoised promise as the expiry path.

### R2-PROV-7
**Status:** Fixed (commit 360134c)
**Diagnosis:** CONFIRMED. `rpc.mjs` called `service.refreshCatalog(id)` with no argument, so the 300s freshness guard and the 30s-15min backoff window both applied to the user's own tap; `update()` carried `existing.state`, so a corrected base URL kept the backoff, and `sanitizeSnapshot` had no `backoff` field. Callers checked with `rg refreshCatalog src`: the only app caller is the explicit "Refresh catalog" control, so forcing is safe.
**Fix:**
- `rpc.mjs` `providers.catalog.refresh` calls `service.refreshCatalog(id, { force: true })`.
- `stateAfterUpdate()` (via `reachesElsewhere()`) clears `state.backoff` and marks the catalog `stale` when `baseUrl`, `resourceBaseUrl`, `credentialRef` or `providerType` changes.
- `toSnapshot` in `runtime.mjs` carries `state.backoff`; `sanitizeSnapshot` projects `backoff: { nextRetryAt }` only while one is active.
- Every other sanitized field unchanged.
**Tests:** `provider-rpc-refresh.test.mjs` - refresh inside the catalog TTL and inside a failure backoff both call the vendor; a sanitized snapshot carries `backoff` only while active; editing the base URL drops the backoff the old endpoint earned. Four fail pre-fix.
**Review:** passed review first time.
**Residual:**
- The client's `ProviderSnapshot` type has no `backoff` field, so it is ignored until a client reader exists (src out of scope); `nextRetryAt` is the stored epoch number.

### R2-STORE-1
**Status:** Fixed (commit 37e3d56)
**Diagnosis:** CONFIRMED, and the same defect as ENV-1 one package over. `atomicWrite()` in `gate/core/providers/store.mjs` did `writeFile(<f>.tmp)` → `rm(<f>, {force:true})` → `rename`, for *both* the config and the state file, so every `put()` opened the window twice; `get()` collapsed ENOENT and every parse/read error into `null`, `list()` skipped those nulls silently, and `service.require()` turned the null into `provider_not_found` for a live provider. The brief's verified-by-execution symptom (`get()` null ~20% of the time under write load) is reproduced by the tests below. The author also keeps the audit's point that the `rm` was there because Windows `rename` refuses an existing destination — a premise that is wrong, since `MoveFileEx` replaces.
**Fix:**
- `providers/store.mjs:131`: `atomicWrite()` is now a one-line `writeFileAtomic` call keeping the `JSON.stringify(value, null, 2) + '\n'` formatting; `put()` (`:104`) still writes config then state, each through its own temp+rename, both inside one `serialize()` queue, both `mkdir`s and the validation unchanged.
- New `readRecord()` (`:31`) — the same classify → wait out a transient code → one 25 ms retry → one loud `console.error` policy as the environment store, with the store's own wording — used by `get()` (`:84`). The legacy `config.id` backfill (`:91`) is kept verbatim including its comment.
- The state read goes through `readRecord` too (`:97`), so a state file caught mid-replace cannot masquerade as a legacy provider; `missing` still yields a fresh `legacy_bootstrap` verdict per read (callers annotate it), and `list()` (`:65`) is untouched.
**Tests:** same new file (8 tests here). "a provider's two records are never absent from their directories while they are being saved" checks the config and state directories separately, because the two writes are sequential and pooling the names would let one mask the other's absence (pre-fix: "absent 594 times"). A reader loop across 400 `put()`s asserts zero nulls *and* zero `legacy_bootstrap` verdicts (pre-fix: "vanished 5 times"); plus renames-not-unlinks, no-orphan, a refused save leaving both records parseable, unreadable → null/logged-once/untouched-on-disk, `list` skipping it, absent-state-still-reads with nothing logged, and the transient-vs-damaged pair. No existing assertion changed: the stale-but-still-valid `provider-store.test.mjs:59` `openai-main.json.tmp` orphan fixture still tests the property that matters (a non-`.json` name is ignored).
**Review:** same failed first review and same repair round as R2-ENV-1 (this part): the CI cleanup fix, the transient-read fix in `providers/store.mjs` alongside the environment store, and the two broken assertions in `hermes-bot-lookup.test.mjs`. The reviewer verified no `rm` of a live record survives in any of the three stores and that `legacy_bootstrap` is still a fresh object per read.
**Residual:**
- A *corrupt* state file still degrades silently to `legacy_bootstrap` with no log line, as before; the brief scoped retry-and-log to the record `get()` answers `null` for, and returning `null` because of a bad state file would break `get()`'s contract. Follow-up, alongside the CAP-1 `skipped` note.
- `credentials/vault.mjs:30-33` carries the same rm-then-rename shape (named in the audit); it was not in this package's allowed file list.

### R2-CAP-1
**Status:** Fixed (commit 37e3d56)
**Diagnosis:** CONFIRMED. `writeInstanceFile()` in `gate/core/capabilities/registry-methods.mjs` called plain `fs.writeFile(filePath, …)`, opening the live `registry/<id>.json` with `O_TRUNC`; a kill between truncate and last byte leaves a short file, and `loadInstances()` (`gate/core/capabilities/registry.mjs:100-106`) catches the parse failure, pushes `{id, reason: 'invalid JSON: …'}` into `skipped`, `continue`s, and the instance is simply absent from `state.instances` — its manifest entry, commands and every configured field gone, with the reason in an array nothing logs.
**Fix:**
- `registry-methods.mjs:26`: `writeInstanceFile()` now calls `writeFileAtomic` (`:34`) with `{ encoding: 'utf8' }`; the old call passed no mode, so none is passed. The serialisation `JSON.stringify({ kind, label, config }, null, 2) + '\n'` is unchanged, so a reader sees the old record or the new one, never a truncated one.
- The rest of the module was audited as the brief required: `mkdir` (`:28`) and `unlink` (`:98`, the delete path) are its only other filesystem calls and neither writes content, so there is no other non-atomic write here.
- The companion half stays open on purpose: `loadInstances` still swallows the reason. `loadCapabilities` (`registry.mjs:216-217`) hands the array on as `skippedInstances` and its only consumer anywhere is the assertion in `gate/__tests__/capabilities-registry.test.mjs:239`, so an instance dropped for any reason (bad JSON, unknown kind, failed validation, reserved id, misplaced v2 record) still vanishes at load time in silence. Fixing that means editing `registry.mjs` or its consumers, which this package was not allowed to touch.
**Tests:** new `gate/__tests__/store-atomic-writes.test.mjs` (3 tests), driven through the real `createRegistryMethods` surface (`registry.instances.create` / `.update`) with a minimal `cron` kind: one write to a sibling of `registry/standup.json` with only `standup.json` left after; the same on the update path with the new config on disk; and the simulated crash — the record locked against replacement, the update rejects, the write named only a temp sibling, and the previous record is still readable *and still parses* (`JSON.parse` is called in the assertion). All three failed pre-fix with "the live instance file was written in place: …\registry\standup.json". No existing assertion changed.
**Review:** the reviewer independently confirmed the fix and the follow-up — `loadInstances` filters `isFile() && name.endsWith('.json')` (`registry.mjs:84`) so the new temp siblings are invisible to it, and no consumer of `skippedInstances` exists in `gate/core`. The `lockAgainstReplacement` cleanup repair from the first review applies to this finding's "refused instance save" test too.
**Residual:**
- `skippedInstances` is still never logged, so an instance damaged outside the Gate (or by an unknown kind) disappears silently. Follow-up, not in this package.

### R2-PROV-8
**Status:** Fixed (commit 98347a8)
**Diagnosis:** CONFIRMED. `reload` was `state = await computeState()` with no serialisation and two RPC surfaces call it (`providers.*` and the capability registry), so a run that read the disk first but finished last assigned its older snapshot and hid a just-created provider or instance from the manifest. No corrections.
**Fix:**
- New `gate/core/serial-reload.mjs`: `createSerialReload(compute)` returns `reload()` where runs cannot overlap at all (each `compute` starts a turn of the loop after the call), answers are handed back in start order, and callers overlapping a live run share at most one queued follow-up, so N overlapping calls cost two computations.
- A rejected run rejects only the callers waiting on it and the queue still advances, so an unreadable registry cannot wedge later reloads; each run's promise carries a no-op `.catch` so an abandoned caller cannot produce an unhandled rejection.
- `server.mjs:948` builds `reload` with it and still assigns `state` inside the compute closure, so every existing caller (`onChanged`, `registryMethods`) keeps working; `registryMethods` passes `() => reload()` (`server.mjs:802`) because the registry wants a function, not a promise.
- `createDebouncedReload` (same module, wired at `server.mjs:957`) collapses a burst of chat outcomes into one `unref`'d, error-swallowing reload `outcomeReloadDelayMs` later (default 1000, injectable so tests need not wait), and `noteTurnOutcome` calls it on `{ changed: true }` so the manifest's readiness follows a real turn (this is the rebuild-after-outcome half; the check/catalog-refresh halves of R2-PROV-V3 already went through `snapshotAndReload` in commit 360134c).
**Tests:** `gate/__tests__/serial-reload.test.mjs` (new, 9 tests). Seven unit tests on controllable promises: an older snapshot cannot win, five overlapping calls cost exactly 2 runs, a call made during a run is answered by a computation that started after it, a failed run rejects only its own callers and is followed by a real one twice over, and a debounced reload coalesces three schedules into one run and swallows a failed one. Two through a real Gate: two overlapping reloads still leave the manifest advertising both new providers, and a real failing chat turn reaches the manifest as `degraded` on its own.
Pre-fix run: the 2 Gate-level tests fail (the older snapshot hides `beta`; the manifest still says `ready`). The 7 unit tests cannot fail pre-fix — `serial-reload.mjs` did not exist.
**Review:** Harness passed first time (tsc, eslint, verify-config, whole Gate suite 1469 tests); the only defect the review reported was the missing `.fix-notes.md`, so no code repair was needed.
**Residual:**
- A caller arriving microseconds before a run settles waits one extra disk read; that is the cost of the guarantee and is bounded to one queued run.
- The debounced reload swallows its errors, so a failed rebuild leaves the manifest one burst behind until the next change.

### R2-CRED-1
*Package G8*
**Status:** Fixed in part (commit fae703a) — the vault side is fixed, but the user-visible symptom survives: its two production consumers (`core/providers/errors.mjs`, `core/providers/service.mjs`) are outside this package's ALLOWED list and are G9's job.
**Diagnosis:** CONFIRMED (the audit's "partly confirmed (corrected)" claim holds). `has` is an `access()` probe and deliberately still is, and pre-fix an `unprotect` failure was a bare `Error('DPAPI unprotect failed: …')` with no `code`, which `classifyProviderError` (`core/providers/errors.mjs:25-26`) falls through to `transient_network`, so the record ends up `auth: ready` + `readiness: degraded`. The notes split the remedy: the `code` comes from `windows-dpapi.mjs`, the reporting surface from `vault.mjs`.
**Fix:**
- `windows-dpapi.mjs:85-92`: a non-zero `unprotect` exit rejects with `code: 'credential_unreadable'`; the message is unchanged. (Protect failures get `credential_protect_failed`.)
- `vault.mjs:113-122` new `inspect(ref)` returns `{ present, readable, error? }`: not present → `readable: null`; present → a `get` through the cache gives `readable: true`, or `readable: false` with `error: { code, message }` and no secret.
- `vault.mjs:124-127` `describe(ref)` now returns `{ present, readable }`, with `readable` taken from `inspect` only when `present`.
- `has()` stays the cheap `access()` existence check; its one production caller, `core/providers/service.mjs:285`, is unchanged.
**Tests:** `credential-vault-dpapi.test.mjs` adds "inspect reports present and readable", "inspect reports present and unreadable" (a fake backend throws `credential_unreadable`; asserts `readable === false` and that the code and message survive) and "inspect reports missing" (`{ present: false, readable: null }`). One existing assertion changed: `credential-vault.test.mjs:42` deep-equalled `describe()` to `{ present: true }`, pinned to the pre-CRED-1 contract, and is now `{ present: true, readable: true }` — the author checked every `describe` caller (`rg "\.describe\(" gate`) and the only vault consumer in the tree is that test (the other hits are `backendManager.describe()`); no test was deleted, skipped or weakened.
**Review:** failed first review on this finding: the vault API was correct but nothing in the tree called `inspect` / `describe().readable`, so the new field was dead code and no surface could say "this key cannot be read on this machine". The review and the harness owner then confirmed `errors.mjs` and `service.mjs` are G9's work and outside ALLOWED, so the API was left exactly as it is; unchanged in round 2.
**Residual:**
- Until G9 lands, `inspect` / `describe().readable` are correct but unused in production. `errors.mjs` still needs a `credential_unreadable` branch in `ProviderErrorCodes` and `service.mjs:265-278` still needs to read the new field; neither file was touched.

*Package G9*
**Status:** Fixed (commit 360134c)
**Diagnosis:** CONFIRMED with the verifier's correction accepted - `vault.has` is a bare `access()`, so an undecryptable `.dpapi` file counts as present, and the decrypt error had no code so it fell through `classifyProviderError` to `transient_network`, ending at `auth: ready` + `readiness: degraded` with nothing saying the key cannot be read here.
**Fix:**
- `errors.mjs` adds `credential_unreadable` to `ProviderErrorCodes`; `classifyProviderError` maps it ahead of the status branches so a stray status cannot reclassify a local decrypt failure; `authStateForCode` sends it to `missing`.
- `health.mjs` reports `unavailable` with that code and a message telling the operator the stored key is protected per Windows account and must be set again.
- `service.mjs` `unreadableCredential()` asks `vault.inspect(ref)`; `inspect()` returns auth `missing` + that readiness + the code without calling the vendor.
**Tests:** `provider-credential-state.test.mjs` - an undecryptable credential is named, not filed as a network fault (auth `missing`, readiness `unavailable`/`credential_unreadable`, a "set the key again" message, zero vendor probes); the code survives classification. Both fail pre-fix.
**Review:** passed review first time.
**Residual:**
- `unreadableCredential` decrypts on every check of a present credential; the vault's 5-minute decrypt cache makes the adapter's later decrypt free and both readiness paths agree.
- A DPAPI `dpapi_timeout` still classifies `transient_network`, which is right for a hung helper.

### R2-CRED-2
*Package G8*
**Status:** Fixed in part (commit fae703a) — the helper is fixed and `redactSensitiveText` exists, but its single production call site (`core/providers/rpc.mjs:16`) is outside ALLOWED and is G9's job.
**Diagnosis:** CONFIRMED. Pre-fix `SENSITIVE_KEYS` held snake_case literals matched on `key.toLowerCase()` alone, so `accessToken`/`apiKey`/`clientSecret` — the spellings `oauth/refresh.mjs:87-92` persists — passed through, `bearer`/`x-api-key` were absent, and there was no text redactor at all. ADDED by the notes: the round-1 attempt got the key matching right but its literal-secret pass was broken.
**Fix:**
- `redaction.mjs:1-16` `SENSITIVE_KEYS` is now a normalised set: apikey, accesstoken, refreshtoken, idtoken, clientsecret, token, password, secret, credential, authorization, bearer, xapikey, privatekey, sessiontoken.
- `redaction.mjs:18-20` `normaliseKey` lower-cases and strips `_`, `-` and spaces, so camelCase, snake_case, kebab-case and spaced variants all hit; the output shape (`[redacted]`, original key preserved) and the array/object recursion are unchanged.
- `redaction.mjs:22-43` `redactSensitive` takes a `WeakSet`, so a cyclic object yields `'[redacted]'` instead of recursing forever.
- `redaction.mjs:73-89` new exported `redactSensitiveText(text, secrets = [])`: `Bearer`/`Basic` case-insensitively, `sk-`/`sk_`/`gsk_`/`xai-`/`ghp_`/`github_pat_` tokens of 20+ chars, quoted `"apiKey":"…"` and unquoted `api_key=…` pairs, then every literal in `secrets` (≥ 6 chars, longest first). Pure function, no I/O.
- `redaction.mjs:80-87` literals go through `out.split(secret).join('[redacted]')` with `escapeRegExp` dropped — `split` takes a *literal* separator, so escaping made the search string unmatchable. A `(?!\s*(?:bearer|basic)\b)` and a `(?!\s*\[redacted\])` guard in the unquoted pass stop the passes double-redacting (`Authorization: Bearer sk-…` came out as `Authorization: [redacted]]`).
**Tests:** new `gate/__tests__/redaction-keys.test.mjs` (12 tests): camelCase/snake_case/kebab redacted at depth, arrays, cyclic input does not throw, non-sensitive keys untouched; `redactSensitiveText` removes `Bearer`, `Basic` case-insensitively, a quoted JSON key, an unquoted `api_key=`, a literal secret, and leaves ordinary text alone. Round 2 added "removes literal secrets containing regex metacharacters" (`.`, `+`, `=`, `[`) and "removes a JWT-shaped literal secret"; both fail on the pre-fix code (10 pass / 2 fail, each returning its input unchanged). No existing assertion changed.
**Review:** failed first review on a blocking defect — `redactSensitiveText` redacted no literal secret containing a regex metacharacter, because `split(escapeRegExp(secret))` searched for a backslashed string that never occurs; 5 of 5 such fixtures leaked and the round-1 fixture `hunter2hunter2` was metachar-free, which hid it. Round 2 dropped the escaping and added the two metachar/JWT tests. The review also noted CRED-2's production symptom remains; confirmed as G9's `rpc.mjs` work.
**Residual:**
- `redactSensitiveText` has no production caller yet. `core/providers/rpc.mjs:16` still does `redactSensitive({ message, code })`, whose keys match nothing, so an upstream error message quoting the credential still reaches the phone.
- `redactSensitive` returns the string `'[redacted]'` where a cyclic object was (`redaction.mjs:26`); tested and accepted, but a cyclic error object serialises with a type change.

*Package G9*
**Status:** Not fixed - the brief for this package did not cover CRED-2; the finding is about the key spellings in `gate/core/credentials/redaction.mjs`, which is outside this package's allowed files and unchanged by commit 360134c.
**Diagnosis:** Not re-examined here. The audit reports the helper's sensitive-key set lacks the camelCase spellings (`accessToken`, `refreshToken`, `idToken`) that `oauth/refresh.mjs` persists, and its one call site (`rpc.mjs`) passes a two-key object it never matches.
**Fix:** none in this package.
**Tests:** none added. (V-3's redaction work in `rpc.mjs` is described under R2-PROV-V3, this part.)
**Review:** passed review first time (for the covered findings).
**Residual:**
- The camelCase token spellings stay unredacted; `redaction.mjs` needs a separate package.

### R2-PROV-V1
**Status:** Fixed (commit 360134c)
**Diagnosis:** CONFIRMED and executed. For a disabled provider `refreshCatalogNow` skipped `listModels` but still ran `applyCatalogResult` with no models and no error, taking the success branch and committing `{source:'live', state:'fresh', models: []}` - replacing a good model list and deleting the backoff.
**Fix:**
- `runRefreshCatalog` in `service.mjs` returns before any of that for a disabled provider: readiness `disabled`, catalog and backoff exactly as stored, no write at all.
- No vendor call.
**Tests:** `provider-service-disable.test.mjs` - refreshing the catalog of a disabled provider keeps its model list (asserts both the returned snapshot and the stored record still hold the good model and `source: 'live'`, and that `listModels` was never called). Fails pre-fix.
**Review:** passed review first time.
**Residual:** none.

### R2-PROV-V2
**Status:** Fixed in part (commit 360134c) - the Gate now refuses the turn and keeps `auth.state = 'missing'`; the HTTP status the phone receives is still server.mjs's, which this package does not own.
**Diagnosis:** CONFIRMED and executed. `service.chat` never consulted `credentialPresent`, so the profile built `Authorization: Bearer undefined`; the vendor's 401 classified `invalid_credentials` and `authStateForCode` wrote `needs_reauth`, flipping an api_key provider's action from "Set key" to "Sign in again".
**Fix:**
- `service.mjs` `chat()` refuses the turn before any network call for a non-local provider with no credential (vault miss and no `legacyApiKeyEnv`), with `code: ProviderErrorCodes.missing_credentials`.
- The error deliberately carries no `status`, because `classifyProviderError` reads status first.
- server.mjs still records the refusal through `noteChatOutcome`, and `authStateForCode('missing_credentials') -> 'missing'` keeps the stored auth as `missing`.
**Tests:** `provider-service-disable.test.mjs` - a turn with no credential is refused before any request (`calls.chat === 0`, `error.status === undefined`, stored auth still `missing`, never `needs_reauth`); a refused turn leaves readiness `missing`, not a sign-in. The first fails pre-fix.
**Review:** passed review first time.
**Residual:**
- `chatViaProviderService` (server.mjs:940-971) maps these to HTTP 502 with body `code: "missing_credentials"` (and `code: "disabled"` for a disabled provider). Mapping them to 401/409 there is the honest follow-up; server.mjs is out of scope. The code is in the body, so the app can branch on it.

### R2-PROV-V3
**Status:** Fixed (commit 360134c), this part only - a chat outcome recorded by server.mjs still does not reload the manifest, and the local-interface adapter's timeouts remain unbounded
**Diagnosis:** CONFIRMED and executed end-to-end pre-fix: after a failed check answering `readiness:{state:'degraded'}`, `/.well-known/gateway.json` still advertised `readiness:{state:'unavailable'}, auth:{state:'missing'}`. Only `statusAndReload`, used by create/update/delete, called `onChanged`.
**Fix:**
- `rpc.mjs` adds `snapshotAndReload`, used by `providers.health.check` and `providers.catalog.refresh`; it awaits `onChanged`, swallows its errors exactly as `statusAndReload` does, then returns the sanitized snapshot.
- `redactSensitiveText` is applied to `error.message` in `status()` and to `readiness.message` in `sanitizeSnapshot`, so a vendor message quoting the key cannot reach the phone.
- No `lastError` field was added to the wire shape.
**Tests:** `provider-manifest-after-check.test.mjs` - a failed check and a catalog refresh are what the manifest then says, through a real `createGate` against a closed loopback port (both fail pre-fix). `provider-rpc-refresh.test.mjs` - check and refresh both rebuild the manifest (`onChanged` counted), a rebuild that throws does not fail the call, and a vendor error quoting the key is redacted in both the RPC error and `readiness.message`. 5 of the 6 fail pre-fix.
**Review:** passed review first time.
**Residual:**
- `noteChatOutcome` now returns `{changed}` for exactly this decision, but server.mjs ignores the return value, so a chat outcome still does not rebuild the manifest.
- `sanitizeSnapshot` does not project `lastError`, so there was no `lastError.message` on that path to redact.

### R2-CLAUDE-1
**Status:** Fixed (commit c474fa6)
**Diagnosis:** CONFIRMED, with one detail corrected: there is no job object on this path at all — `backend-manager.mjs:147-153` builds a per-turn backend with `{ record }` only, so the `abort()` stub's claim that "cancellation is handled by the job that owns it" was never true. Author also found no extra guard was needed in the runner: `ABORTED_OUTCOME`'s `settle` listener is registered on `controller.signal` at `turn-runner.mjs:298`, before `sendMessage` is called, so the race settles as aborted and the backend's later rejection is dropped.
**Fix:**
- `turn-runner.mjs` `runBackendTurn` sends `{ text, model, signal: controller.signal }`; `signal` is a new key on the existing options object, no positional parameter moved. `codex.mjs`, `hermes.mjs`, `opencode.mjs` destructure `{ text, model }` only and drop it.
- `claude-code.mjs` `sendMessage` reads `signal`, creates a job per turn via a new `jobFactory` option (default `createWindowsJob`) and `job.add(child)` immediately; `cancel()` kills the tree first, then rejects with `name: 'AbortError'`, `code: 'aborted'`. An already-aborted signal is killed at once.
- `child.on('error')`/`('close')` are ignored once cancelled, so a killed child's exit code cannot surface as `claude-code exited with code null`.
- The abort listener is `{ once: true }` and removed in a `finally` that also clears `inflight`: no listener stack-up, no second kill of a dead pid.
- `abort()` is implemented — awaits the in-flight turn's `cancel`, idempotent, no-op between turns.
- `stream-json` parsing, the argv/model/permission flags, session continuity and the auth-failure text path are untouched.
**Tests:** new `gate/__tests__/claude-code-abort.test.mjs` (6 tests) with a fake spawn that never exits: the promise rejects `AbortError` with `terminate` and `kill` each called once and no `unhandledRejection`; an already-aborted signal is killed immediately; a normal exit leaves `getEventListeners(signal, 'abort').length === 0` and a later abort kills nothing; `abort()` is idempotent and a no-op when idle; one end-to-end `runBackendTurn` test asserts a Stop ends the turn once with `aborted === true`, no `turn.failed` stage. Four were red before (hangs, or `kill` count 0).
**Review:** passed review first time
**Residual:**
- `backend.abort()` has no production caller (`server.mjs` is outside the allowed files); the path that matters in production is `signal`.

### R2-RUN-1
**Status:** Fixed (commit 563c335)
**Diagnosis:** CONFIRMED. `createRunArchive`'s `load()` sorted on `meta.startedAtMs`, a field no writer produced — `archive.record(...)` in `supervisor.mjs` emitted only `startedAt` (an ISO string), so every comparison was `NaN`, the sort was a no-op and `runs.slice(-maxRunsPerEnvironment)` deleted an arbitrary tail that could include the newest run. ADDED: `run-archive.test.mjs` names its fixtures `run-1..run-3`, which sort chronologically by accident, which is why the suite never caught it.
**Fix:**
- New exported `runStartedAtMs(meta)` (`run-archive.mjs:32`): `Date.parse(meta.startedAt)` first, then a finite `meta.startedAtMs`, else 0.
- `olderRunFirst` (`run-archive.mjs:43`) sorts ascending on that key, tie-broken on `runId`; the prune now deletes the oldest files and keeps the newest `maxRunsPerEnvironment`.
- `supervisor.mjs`'s `record(...)` also writes `startedAtMs`, so new meta files carry the field; older files without it sort correctly through `startedAt`.
**Tests:** new `gate/__tests__/run-archive-prune.test.mjs` (4 tests). "Prunes by start time, not by file name": five runs whose ids sort the opposite way from their start times, cap 2 — the two newest survive; fails on the old code (run-3/run-4 survived). A second test uses metas with only `startedAtMs`; two more cover the new `readRun` (hit, unknown id, hostile id, missing directory → `null`). No existing assertion changed: `run-archive.test.mjs` still passes unchanged, now for the right reason.
**Review:** passed review first time
**Residual:**
- The `runId` tie-break is not separately observable (when every run shares a timestamp, "by id" and "by readdir" coincide); covered by the comparator and a comment. The author wrote such a test and deleted it because it could not fail.

### R2-RUN-2
**Status:** Fixed (commit 563c335)
**Diagnosis:** CONFIRMED. `this.runs` (`supervisor.mjs:151`) had three writers and no `delete` anywhere in `gate/`; `finish()` cleared only `timeLimitTimer`, so every finished run kept its whole event log, `workspace`/`adapter`, `childEnv` (the decrypted vault credentials `resolveRunCredentials` produced) and `child`/`job` handles, while start and finish each spread the whole map and `run-protocol.mjs` grew `events` unbounded. ADDED: the only readers of `run.childEnv`/`child`/`job` are inside `supervisor.mjs` — `execute()`, `listRuns()` (already guarded by `!run.done`), `cancel()` and `stopTimedOutRun()` (both return early once done); `server.mjs` reaches only the public methods.
**Fix:**
- `finish()` (`supervisor.mjs:797-801`) sets `run.childEnv = run.child = run.job = null` after the terminal event and the push observer, so the heap stops holding the operator's provider keys.
- New constructor option `maxRetainedRuns` (default 100) plus `retainFinishedRuns(environmentId)` evict oldest finished runs at the end of `finish()`; a live run is never a candidate and `Math.max(1, …)` clamps a nonsense cap.
- `events(runId)` falls back to the new `readRun(runId)` and streams from disk; an id held by neither memory nor archive still throws `unknown run <id>` as before.
- A `liveRuns` map (environment id → run ids) with `trackLive`/`untrackLive` replaces the full-map spreads in `startRun`, `finish`, `stop()` and `activeRuns()`.
- `listRuns` makes one filtered pass and reads `run.log.lastEvent()` instead of `log.events().at(-1)` (which copied up to 5000 events per run); order is `newestFirst` (time, `startSeq`, run id).
- `run-protocol.mjs` caps a run's retained events at `MAX_RETAINED_EVENTS = 5000`, surplus taken from the middle so index 0 and the verdict survive; `onEmit` still sees every event.
**Tests:** new `gate/__tests__/supervisor-retention.test.mjs` (9 tests). Bounded retention: 33 finished plus 1 held run with `maxRetainedRuns: 3` → size 4, the held run's `childEnv`/`child`/`job` intact, the newest three kept, every retained finished run's set to `null`; fails on the old code (34 runs, `sk-live-provider-key` still resident). Also: an evicted run replays `run.started`…`run.completed` from the archive while an unissued id still throws; the same without an `archiveDir`; 6002 events retain exactly 5000 (starts at `run.started`, ends at the verdict, strictly increasing) with `onEmit` seeing all 6002; a caught-up subscriber over 6000 emissions sees sequences 1…6002 exactly once. No existing assertion changed.
**Review:** passed review first time
**Residual:**
- A subscriber that falls further behind than the cap removed cannot get those events back; it skips them by sequence, so what it sees is strictly increasing but may have gaps.
- `retainFinishedRuns` walks that environment's finished runs on each finish (bounded by the cap); `events()` for an evicted run does a synchronous per-environment directory scan.
- Nothing was measured on a real Gate; all timings are test timings on the author's host.

### R2-ENV-1
**Status:** Fixed (commit 37e3d56)
**Diagnosis:** CONFIRMED. `CliEnvironmentStore.put()` wrote `<id>.json.tmp`, then `rm(dest, {force:true})`, then `rename`, so the record did not exist on disk between the two calls; the leftover `.tmp` is invisible to `list()` (names ending `.json` only) and nothing cleans it. ADDED by the author: `get()`'s `catch { return null }` could not tell "absent" from "unreadable", which is why the fix needed a read-side change too. Post-review ADD: `readJsonFile` reports *every* non-ENOENT failure as `corrupt`, so a Windows sharing violation during a rename was still answered "not found" — the audit's symptom, one layer down.
**Fix:**
- `gate/core/cli-environments/store.mjs:95`: `put()` calls the shared `writeFileAtomic`; the hand-rolled tmp/`rm`/rename is gone, so the live path is never unlinked. `mkdir`, `validateCliEnvironmentRegistration`, the `JSON.stringify(record, null, 2) + '\n'` form, the `serialize()` queue and `delete()` are unchanged.
- New `readRecord()` (`store.mjs:31`), used by `get()` (`:79`), classifies with `readJsonFile`: `ok` → value, `missing` → `null` (unchanged), `corrupt` → one 25 ms retry (`CORRUPT_RETRY_MS`, `:7`), then one `console.error` naming the file and `null`. The damaged file is left on disk; nothing throws, so `list()` (`:63`) still skips it, now loudly.
- `TRANSIENT_READ_CODES` (`:13`, EPERM/EBUSY/EMFILE/ENFILE/EAGAIN) are waited out first, 5 × 20 ms, so a read that raced a rename resolves instead of reporting not-found; a parse failure is not a transient code and still costs exactly two reads.
**Tests:** new `gate/__tests__/store-atomic-writes.test.mjs` (11 tests here of 22). A `readdir` watcher asserts the record name is present on every sample during 300 concurrent `put()`s (pre-fix: "absent from the directory 553 times"); a paced `get()` loop across 400 `put()`s sees zero nulls (pre-fix: "vanished 4 times"); plus rename-not-unlink, no-`.tmp`-orphan, a refused save leaving the old record parseable, unreadable-reads-absent-logs-once-stays-on-disk, and two tests pinning the transient-vs-damaged split. No existing assertion changed.
**Review:** failed first review, which caught five defects: three tests chmod'd a directory to `0o555` and then failed cleanup on Linux CI (EACCES is not in `fs.rm`'s retry set); a `hermes-bot-lookup.test.mjs` readdir assertion depended on NTFS name order; `readJsonFile` still answered "not found" for a transient refusal (the package's own concurrency test failed 1 of 10 suite runs); `.env` lost its mode; and stray `.fix-notes.md` debris. Repairs: `lockAgainstReplacement` registers a mode-restoring undo drained in `afterEach` before `rm(root)`, the readdir expectation is `.sort()`ed, `readRecord` gained the transient wait-out with the log naming the code instead of calling it "not readable JSON", `.env` is `mode: 0o600`. A second round fixed two wrong assertions in the author's own new test file (`await getHermesBot(...)?.listenKey` bound the optional chain before the await; the mode test read `rest[0]` as the options instead of the last argument).
**Residual:**
- The `console.error` on the corrupt path is a deliberate behaviour change: that silence was the defect.
- The reader loop is paced (20 ms), not free-running, because on Windows a free-running reader starves the writer's own rename and the test then measures file locking; the watcher's `readdir` count is the un-paced evidence.

### R2-CLI-1
**Status:** Fixed (commit c474fa6)
**Diagnosis:** CONFIRMED. `stdio-server.mjs` `start()` threw out of `await Promise.race([ready, failed])` via `throw spawnFailure ?? error` without touching `child`; `handle` is only assigned on success, so `ensureRunning()`'s `if (handle)` guard always re-entered `start()`. The author confirmed the verifier's correction: `isOwned()` does report true for the leaked child, but nothing in production reads it, so the leak is real either way. `native-server.mjs` already `await stop()`s on its equivalent paths.
**Fix:**
- The `catch` in `start()` now `await stop()` — the same child kill, job terminate and `child`/`handle` reset `stop()` does — before rethrowing, so a retry starts from nothing.
- `spawnFailure ?? error` is unchanged, so the missing-executable refusal still names the binary and its OS error code.
- `handshakeTimeoutMs` is now a defaulted option (30 s, as hard-coded before) so the timeout path can be tested; shipped behaviour is identical.
**Tests:** new `gate/__tests__/stdio-server-handshake.test.mjs` (2 tests, both red before), using the real `createWindowsJob({ platform: 'linux' })`: a child whose `initialize` is never answered makes `ensureRunning()` reject on a 25 ms handshake timeout with the child dead, `isOwned()` false, and the second `ensureRunning()` spawning exactly one new child with both reaped; an early `exit` mid-handshake likewise leaves no live child and the next `ensureRunning()` answers rpc from one fresh child. Red before: `kills === 0`.
**Review:** passed review first time
**Residual:**
- `stop()` in both servers still does `child.kill()` and then `job.terminate()` (a second kill) — pre-existing, left alone; the tests assert a kill happened rather than counting it.

### R2-SESS-1
**Status:** Fixed (commit c474fa6)
**Diagnosis:** CONFIRMED. `listSessions()` took no parameter, so `server.mjs:2211`'s limit never reached it and the caller sliced at `server.mjs:2218` instead. It awaited `stat` and then `readTranscript` (full `readFile` plus `JSON.parse` of every line) for every `*.jsonl` inside a `for…of`, fully serialised, building previews for rows it then discarded.
**Fix:**
- `listSessions(limit = 50)` — same signature and default as `codex.mjs`, so the caller's positional limit now arrives and the zero-argument call still works.
- Every `*.jsonl` is `stat`ed with bounded concurrency (`STAT_CONCURRENCY = 8`) through a new module-local `mapConcurrently`, sorted newest-first on `mtimeMs`, then sliced to `limit`.
- Only those are read, at `READ_CONCURRENCY = 4`; `readTranscript` itself is unchanged.
- The row object, the `reserved` merge and the final `sort((a, b) => b.last_active - a.last_active)` are byte-for-byte the old ones. An unreadable transcript still lists with `preview: null` (the old catch pushed the row anyway); a `stat` failure still drops the file entirely.
**Tests:** new `gate/__tests__/claude-code-sessions.test.mjs` (6 tests; 3 red before) with 200 fake transcripts given distinct mtimes via `utimes` and previews naming their own index, so read count is observable: `listSessions(20)` returns 20 rows reading only the newest (red before: 200 rows, 200 reads); a zero-argument call yields the 50-row default page (red before: 200); a corrupt newest file lists with `preview: null` and, unlike before, no longer falls off the page silently. Three further tests are invariant guards: newest-first order, the `reserved` merge surviving the limit, and the exact row key order. No existing test file was edited.
**Review:** passed review first time
**Residual:**
- Claude Code session lists are now capped at 50 rows by default, the same contract `codex.mjs` already had; the id-lookup and cron callers in `gateway-methods.mjs` pass 200 or `undefined`.
- A corrupt transcript is still listed preview-less rather than dropped, so a bad file consumes one of the page's slots.

### R2-HERMES-1
**Status:** Fixed (commit 37e3d56)
**Diagnosis:** CONFIRMED. `createBot` in `gate/core/cli-environments/backends/hermes.mjs` read the CLI-created `.env`, called `ensureDistinctListenKey(envText, defaultKey)` to mint a key, then wrote the result with a bare `writeFile(join(botHome, '.env'), ensured.envText, 'utf8')`. That file is the only place the listen key and the inherited provider keys exist, so a truncating write interrupted by a kill leaves a Bot with no `API_SERVER_KEY` — `parseListenKey` returns null, the roster reports `routingIssue: 'listen_key_missing'`, and every `forBot` throws `bot_not_routable` with no recovery path, since a retry mints a different key. `updateBot`'s `profile.yaml`, `SOUL.md` and `config.yaml` writes had the same shape, and `withBotEditRollback` covers a *thrown* edit, not a process death. ADDED by the author: `hermes-profiles.mjs:260-288` already stated and used the tmp-sibling-and-rename invariant for the memory files, so the knowledge was in the package and not applied.
**Fix:**
- `hermes.mjs:700` (`.env` after `ensureDistinctListenKey`) and `:702` (`SOUL.md` in `createBot`), plus in `updateBot` `:777` (`profile.yaml`), `:783` (`SOUL.md`) and `:798` (`config.yaml`) — all through `writeFileAtomic` (imported at `:22`). Both `if` guards are preserved verbatim (the `config.yaml` one gained braces to match the block above it); encoding stays `utf8`, serialisation unchanged.
- Two mode decisions the brief's "keep its current file mode" wording forced: `.env` and `config.yaml` carry secrets (the minted key; the provider API keys Hermes puts in `config.yaml`) and the rename lands a *fresh* temp file, so the mode of the file Hermes created is not inherited — both now ask for `0o600`, the convention already in `tokens.mjs:63`, `pairing.mjs:93`, `device-tokens.mjs:76,92`. `SOUL.md` and `profile.yaml` carry no secret and keep the umask default.
- `hermes-bot-edit.mjs:38`: the rollback restore inside `withBotEditRollback` also became `writeFileAtomic` — the author's judgement call beyond the brief, on the grounds that a truncating restore during a *rollback* destroys the very bytes the rollback exists to bring back. The rollback contract is otherwise untouched: same snapshot, same `Promise.allSettled`, same `bot_update_rollback_failed` error and message, same `unlink` for files the CLI had not created.
- `writeHermesMemory` (`hermes-profiles.mjs:266-289`) was deliberately left on its existing tmp+rename: swapping it for `writeFileAtomic` would remove a tested `io.writeFile`/`io.rename` seam for no behavioural gain.
**Tests:** new `gate/__tests__/hermes-bot-lookup.test.mjs` (4 tests here of 10). A stubbed `runCliImpl` stands in for the Hermes CLI while a recorder watches `fs.writeFile`: `createBot` makes exactly two writes, both to siblings of the live files, with content assertions that the inherited key survived (`OPENAI_API_KEY=sk-keep`), the old key is gone and the new one parses as 64 chars (pre-fix: ".env was written in place"). `.env` is checked twice — the options handed to `fs.writeFile` must ask for `0o600` (Windows has no POSIX modes) and off Windows the file on disk must be `0o600`. A refused `.env` write leaves the original bytes and the same `parseListenKey`. `updateBot` makes three sibling writes with content assertions and no debris (pre-fix: "profile.yaml was written in place"). No existing assertion changed.
**Review:** failed first review on the `.env` mode — the rename lands a fresh `0o666 & ~umask` temp file, so on a POSIX host the file carrying the minted listen key and every inherited `sk-…` key went from 0600 to group/world-readable, which the brief's "keep its current file mode" had forbidden. Repaired with `mode: 0o600` (and the same for `config.yaml`), plus the two wrong assertions in this same test file noted under R2-ENV-1. The reviewer confirmed both `if` guards, the utf8 encoding, the unchanged serialisation and the whole `withBotEditRollback` contract.
**Residual:**
- `writeFileAtomic`'s rename retry gives up after ~1 s of EPERM/EBUSY and then throws; the caller turns that into the same error it always turned a write failure into and the rollback still runs. Unchanged.
- The "refused `.env` write" test also passes against the pre-fix code (a direct write onto a read-only file throws too); it is a guard against a new delete-then-rename regression in the rotation path, not a reproduction of HERMES-1. The author says so.
- `config.yaml` edits are still last-write-wins against whatever the CLI wrote. Pre-existing, out of scope.

### R2-VOICE-1
**Status:** Fixed (commit 7627c4a)
**Diagnosis:** CONFIRMED. `VoiceSessionRegistry.sessions` had one writer, `create`, and no delete anywhere; `end()` only set `ended`/`endedReason`, and `liveForDevice()` iterated every record ever created, skipping ended ones one at a time, on every `voice.session.start`. The author's correction is that the brief's line numbers were off and the retention is load-bearing - `media-socket.mjs` refuses a late socket upgrade on `session.ended`, which needs the record to exist.
**Fix:**
- `voice-rpc.mjs`: `ENDED_RETENTION_MS` (10 min) and `MAX_ENDED_SESSIONS` (200) added as constructor options (`endedRetentionMs`, `maxEndedSessions`) alongside the injected `now`.
- `_ended` (an ordered `Map<voiceSessionId, endedAtMs>` in end order) plus `_prune()`, which drops ended records past their window then past the cap, oldest ended first; `_prune()` runs lazily from `create()`, `end()` and `liveForDevice()` - no timer.
- `liveForDevice()` walks `_liveByDevice` (`Map<deviceId, Set<voiceSessionId>>`, written only by `create`/`end`) instead of the whole map, so its cost is O(this device's live calls) plus the bounded prune.
- Semantics unchanged: a lapsed grant is still `end(..., 'expired')`, an abandoned attached call still `end(..., 'abandoned')`, an ended record never answers as live.
**Tests:** `gate/__tests__/voice-registry-prune.test.mjs` (new, 10 tests) - retention window still `get()`-able inside it and `null` after; cap evicts oldest-ended-first; a live record 10 min old survives three ended records and a 1 s window; 1 000 create+end cycles leave exactly 200 records; `liveForDevice` still ends with its named reasons and returns the live one. 7 of 10 fail pre-fix; the two that pass on pre-fix code are the "behaviour must not change" guards.
**Review:** passed review first time.
**Residual:**
- The bound is a window plus a cap, not a strict count: an idle Gate can sit on up to 200 ended records indefinitely (no timer, by choice).
- `end()` is a third `_prune()` call site, beyond the two the brief named, so the bound holds the moment a call ends rather than after the next start.

### R2-VOICE-2
**Status:** Fixed (commit 7627c4a)
**Diagnosis:** CONFIRMED, with the scan's arithmetic corrected: `RpcServer._write` appended every line to `self.written` before the `self._out` sink check, so it ran in production (`main()` built `RpcServer(pipeline, out=sys.stdout)` with no way to turn it off). A frame is a whole synthesised sentence of base64 24 kHz PCM16 (`tts.py` yields per sentence), not ~1.3 KB at 50/s - fewer, much larger strings. Growth is bounded by call length rather than Gate uptime (`local-engine.mjs` spawns per `open()`), but the audio is duplicated for the worker's life and re-copied on every backoff respawn.
**Fix:**
- `server.py`: `RpcServer.__init__` gained `record=True`, so all four existing tests reading `server.written` keep working untouched.
- `_write` appends only `if self._record:`; `main()` builds with `record=False`. Nothing else in the worker changed.
**Tests:** `gate/voice-worker/tests/test_server.py` - `_pipeline` gained an optional `emit` so notifications reach `out` as `main()` wires them. New `test_a_production_server_keeps_no_copy_of_the_audio_it_writes`: three `voice.speechAudio` frames plus the response reach the sink and leave `written == []`, still `[]` after `voice.close`; `test_the_default_server_still_records_what_it_writes` pins the default. No existing assertion changed. Pre-fix (one line reverted): 1 failed, 7 passed.
**Review:** passed review first time.
**Residual:** none.

### R2-VOICE-3
**Status:** Fixed (commit 7627c4a)
**Diagnosis:** CONFIRMED. `media-socket.mjs` `startAudioTimer()` assigned the single `audioTimer` handle without clearing what was there, and `attach()` called `clearResumeTimer()` + `startAudioTimer()` with no `clearAudioTimer()`. On the overlapping-attach path (a second upgrade while the first socket is still open - the half-open Tailscale case the 20 s resume window exists for) the first interval was orphaned, and the stale socket's `close`/`error` handlers skip themselves when `ws !== newWs`, so nothing ever cleared it: one leaked 1 Hz interval per re-attach.
**Fix:**
- `media-socket.mjs`: `startAudioTimer()` now calls `clearAudioTimer()` before arming, so it is idempotent.
- `attach()` clears it explicitly as well, on the path that replaces a socket without the old one closing. Nothing else added.
**Tests:** `gate/__tests__/voice-audio-timer.test.mjs` (new, 4 tests), reusing the `voice-socket.test.mjs` harness and counting live intervals by wrapping `globalThis.setInterval`/`clearInterval` - a leaked timer is invisible from outside since it closes the same socket and is `unref`'d. One attach leaves exactly one; a second socket attaching while the first is open leaves exactly one; `end` via a control frame leaves none; `detach` leaves none. Against pre-fix `media-socket.mjs` exactly the re-attach test fails; the other three pin behaviour that must not change.
**Review:** passed review first time.
**Residual:** none.

### R2-TOKEN-1
**Status:** Fixed in part (commit 563c335). The portless fallback endpoint and the unpruned replay set are fixed; the audit's "nothing calls `verifyInvocationToken`" and the per-restart random signing secret were left as the design/feature gaps the brief put out of scope.
**Diagnosis:** The audit's correction was followed: the portless default is confined to `startRun` (`server.mjs:701`'s backend-server path already builds a correctly ported URL and is untouched), and the missing production caller for `verifyInvocationToken` is a feature gap, not this task. Two real defects were in scope and both confirmed: `startRun`'s fallback `endpoints.chat` was `http://127.0.0.1/v1/chat/completions` (port 80, never a Gate port), and `invocation-tokens.mjs` grew `seen` with no pruning and no cap.
**Fix:**
- New `endpointsFor(request)` (`supervisor.mjs:724`): `request.endpoints` wins, else `chatEndpointForPort(process.env.VERSUTUS_GATE_PORT)` when that is an integer 1–65535, else the new constructor option `defaultEndpoints`, else `undefined`.
- `process-environment.mjs:43` omits `VERSUTUS_GATE_CHAT` rather than assigning `undefined`; Node already dropped undefined from the child's env block, so no CLI sees a difference.
- `invocation-tokens.mjs`: `seen` is now a Map from nonce to the token's `exp`, pruned by `pruneSeen(now)` on every verify (an entry dies once its token would answer `expired` anyway) and capped at `MAX_SEEN_TOKENS = 10_000`, shedding the oldest insertion first. Public API, claims and token format unchanged.
**Tests:** three tests in `supervisor-retention.test.mjs`. Four runs with no `endpoints`: `VERSUTUS_GATE_PORT=9123` → `http://127.0.0.1:9123/v1/chat/completions`; no port but `defaultEndpoints` → that URL; neither → `'VERSUTUS_GATE_CHAT' in env === false` while `VERSUTUS_CLI_INVOCATION_TOKEN` is still issued; `VERSUTUS_GATE_PORT='not-a-port'` → absent. "The invocation token replay set stays bounded": 10 050 tokens at a 10¹² ms TTL, so nothing can expire and only the cap can forget — the oldest nonce is accepted again, the newest is still `replay`; fails on the old code. A third test keeps the guarantee the pruning must not weaken (replay inside the window → `replay`, past expiry → `expired`).
**Review:** passed review first time
**Residual:**
- No production caller passes `defaultEndpoints` and `server.mjs` was not edited (outside the allowed list); only `VERSUTUS_GATE_PORT` is covered, so a Gate on an ephemeral port now hands the CLI no endpoint instead of a broken one.
- Expiry pruning is not observable through the public API (a pruned nonce and an expired token both answer `expired`); `seen` is module-private and no accessor was added for the test.
- The audit's point about a fresh per-process signing secret when `VERSUTUS_CLI_TOKEN_SECRET` is unset is unchanged by this commit — outside the brief's scope.

### R2-CLI-2
**Status:** Fixed (commit 1825045)
**Diagnosis:** CONFIRMED as written. `spawnGate` in `gate/cli.mjs` attached only `stdout`/`stderr` listeners and the supervisor's `_spawn()` watched only `'exit'`, so a ChildProcess reporting `'error'` with no exit killed the process built to survive; `serviceRun` never called `installProcessGuards` (only `handleStart` did); and `serviceStop`'s two `probeLocalGate(GATE_MANIFEST)` calls used the unbounded default fetch in `gate/core/service/diagnostics.mjs`.
**Fix:**
- `gate/core/service/supervisor.mjs` `_spawn()`: a `died` latch wraps the existing `_onExit` path and a new child `'error'` listener logs `spawn failed: <message> (code root <root>)` then calls that same path — so a spawn failure is charged to `_failures` and retried on `RESTART_BACKOFF_MS` like a crash, and a child emitting both events spends one restart. Same shape as the GATE-1 fix in `local-engine.mjs`.
- `gate/cli.mjs` `serviceRun`: `installProcessGuards({ log: say, exit: () => {} })` installed before anything else can throw; `handleStart` untouched.
- Same function: a `guard()` wrapper around the log sink (used by `say` and both Gate stream listeners) so a failing sink cannot throw inside the handler that catches throws; `writeState` catches and logs; the control-file poll body after the read is in `try/catch`; both `sup.stop()` call sites handle a rejection.
- `probeLocalGate(manifestUrl, fetchImpl, { timeoutMs = 5000 })`: with no `fetchImpl` it wraps `globalThis.fetch` with `AbortSignal.timeout(timeoutMs)`, reported as `{ reachable: false, detail }` by the existing catch; an injected `fetchImpl` is used as given. `serviceRun`'s own probe keeps its explicit 10 s bound; the 20 s wait loops are unchanged.
**Tests:** New `gate/__tests__/service-supervisor-spawn-error.test.mjs` — emitting `'error'` does not throw, yields status `restarting`, `restarts === 1`, `childPid === null`, one retry after the backoff, and a log naming the executable and code root; repeated failures escalate `[10, 20, 40]`; `'error'` then `'exit'` is one restart; a stop during a failed spawn stays stopped. New `gate/__tests__/probe-local-gate-timeout.test.mjs` (real `node:http`) — a server that never answers headers resolves `reachable: false` inside the 150 ms timeout; the default fetch receives an `AbortSignal`; a 200 is reachable, a 500 is not; an injected fetch is called with the url only. No existing assertion pinned the old behaviour; `supervisor.test.mjs` and `diagnostics.test.mjs` pass unmodified.
**Review:** passed review first time
**Residual:**
- The no-op `exit` also disarms the rejection-storm exit (>20 rejections/60 s): a genuine bug loop in `serviceRun` now logs and continues; the storm stays fatal in `gate start`.
- A stuck listener costs one 5 s timeout per probe instead of hanging, so the second 20 s stop loop can take ~4 probes.
- `SERVICE_CODE_ROOT` is still the hardcoded `C:\Projects\Versutus`, deliberate and out of scope; `serviceRun`'s helper wiring is covered only through the Supervisor seam.

### R2-HERMES-2
**Status:** Fixed (commit 37e3d56)
**Diagnosis:** CONFIRMED. `getHermesBot(hermesHome, id)` (`gate/core/cli-environments/hermes-profiles.mjs:300`) had a fast path only for `'default'`; every named id fell through to `listHermesBots`, a serial `for…of` of three `readFile`s per profile under `<home>/profiles`, and `forBot` calls it once for the named Bot and again for the default key (`hermes.mjs:608`, `:624`) per planned group step — so one group turn did roughly 135 serial reads for a 14-Bot fleet. The author adds that a fresh backend per call also throws away `hostMultiplexEnabled`'s cache, and that the same walk backs every `getBot`/`getBotMemory`/`setBotMemory`. CORRECTED (post-review): the author's *first* implementation validated the id and then resolved it with `stat`, which is case-insensitive on NTFS and APFS, so `getHermesBot(home, 'Worker-1')` started returning a record and `forBot('Worker-1')` stopped raising `unknown bot` — a regression against the old roster walk, which compared the id to the `readdir` name.
**Fix:**
- `getHermesBot` (`hermes-profiles.mjs:300`): `!id → null` first, then `'default'` keeps its exact old fast path (`botAt('default', hermesHome, readFile)`, `:303`), unchanged.
- A named id is rejected if it is not a string, starts with `.`, or contains a path separator (`:304`), then must equal an entry name `readdir(<home>/profiles)` reports (`:316`) *and* that entry must be a directory (`:318`). The name comparison — not `stat` — is the deliberate fix for the review's regression, and costs one `readdir` instead of a `stat` while keeping the `io.readdir` seam the test counts through.
- The record then comes from `botAt(id, join(hermesHome, 'profiles', id), readFile)` (`:320`), the same function the roster uses, so its shape (`displayName`, `listenKey`, `description`, `model`, `home`) is identical to what the old `find()` returned. Any rejection returns `null`, exactly as an unknown id did, because the old roster walk already skipped non-directories and dot-names.
- `listHermesBots` (`:204`) is untouched — the roster still enumerates, as it must. `forBot` needed no change: the named lookup and the one default-key lookup were already at most once each per call and in that order, and the default key is fetched only inside `if (botId !== 'default')`, on the path where it can collide. Error text unchanged, no cross-call cache added (a stale listen key would be worse than the read).
**Tests:** new `gate/__tests__/hermes-bot-lookup.test.mjs` (6 tests), fixture = 4 profiles (`worker-1`, `alpha`, `beta`, `gamma`). Counting `io.readFile`: a named id does exactly 3 reads, all under `<home>/profiles/worker-1` (pre-fix `15 !== 3`, listing every profile); `'default'` reads only the Hermes home; `'../x'`, `'a/b'`, `'a\b'`, `'.hidden'`, `'..'`, `'nope'`, `'notes.txt'` (a plain file under `profiles/`) and `''` all return `null` with the directory unchanged. Two tests pin *why* the code reads a directory instead of calling `stat`: `Worker-1`/`WORKER-1` must not find `worker-1`, and the match is asserted against injected `io.readdir` entry names — both also pass pre-fix, by design, as guards against a future `stat`. A real `createHermesBackend` with `profilesHome` wired up shows `forBot` doing exactly 6 reads, 3 from the named profile and 3 from the Hermes home, none from the other three (pre-fix it read `alpha`, `beta` and `gamma` to answer a question about `worker-1`). No existing assertion changed; the `bot_not_routable`/`unknown_bot` paths stay covered by `hermes-backend.test.mjs`, unchanged.
**Review:** failed first review on the case-insensitive regression — `stat` made a differently-cased id resolvable, `forBot` stopped failing fast with `unknown bot "Worker-1"`/404, and `toPublicBot` reported the Bot routable, so the mistyped id failed later and further away. Repaired by matching the on-disk entry name instead, with the two new tests above. The reviewer verified `getHermesBot('default')` is byte-identical to before (including the `!id` guard first), a named id does one `readdir` + three reads, `listHermesBots` is untouched, `forBot` still does at most one named + one default lookup with unchanged error text, and no cache was added.
**Residual:**
- A profile that exists as a directory but has no `.env` still returns a record with `listenKey === null` (→ `bot_not_routable`), as before; that is the correct distinction from an unknown id.
- `readHermesSoul` and `readHermesMemory` (`hermes-profiles.mjs:228-258`) still build `<home>/profiles/<id>` without this validation. They read a Bot whose id already went through `getHermesBot`, and the brief scoped the change to `getHermesBot`, so they were left alone.

### R2-VOICE-4
**Status:** Fixed (commit 7627c4a)
**Diagnosis:** CONFIRMED. `voice-backend.mjs` `resolveVoiceBackend` walked `backendManager.list()` and called `backendManager.get(id)` per candidate, and `server.mjs` `runTurn` → `runVoiceTurn` → `resolveVoiceTurnBackend` calls it per spoken turn inside `startTurn`. Each `get()` re-reads the record (`backend-manager.mjs:138`), re-resolves credential bindings through the vault (`:160`, one `vault.get` per binding) and, for an HTTP transport, re-validates with a live health fetch (`:182`) - latency that lands in the time-to-first-token of every reply. Nothing memoised `(thread → backend)`.
**Fix:**
- `voice-backend.mjs`: the resolution body moved verbatim into `selectVoiceBackend`, every branch unchanged.
- `resolveVoiceBackend` wraps it in a module-level `WeakMap<backendManager, Map<threadKey, { backend, expiresAt }>>` with a 20 s lease (`VOICE_BACKEND_LEASE_MS`; `options.now` / `options.ttlMs` injectable), refreshed on every hit; only successful non-null resolutions are stored.
- New export `clearVoiceBackendCache(backendManager)`. `server.mjs` untouched, so its two-argument call is unchanged.
- Deliberate deviation: the brief's NUL-separated `threadKey` became `JSON.stringify([botId ?? '', backendId ?? ''])` - a literal NUL byte makes the file register as binary to ripgrep and to git's text diffs; same two fields, same sharing, collision-free.
**Tests:** `gate/__tests__/voice-backend-cache.test.mjs` (new, 8 tests) counting `list()`/`get()` on a Claude-Code-then-Hermes manager - a second turn does neither; a hit refreshes the lease (ten turns at `LEASE_MS - 1` apart, one `list`); after the lease it walks again; each Bot / thread / pinned `backendId` resolves on its own; null and throwing resolutions are never cached; `clearVoiceBackendCache` forces re-resolution; a lease is per manager, not global. No existing assertion changed. Pre-fix `voice-backend.mjs` cannot load the suite (`clearVoiceBackendCache` does not exist), so the caching was pinned by a throwaway probe outside the repo: fails before, passes after.
**Review:** passed review first time.
**Residual:**
- Two threads selecting identically (same `botId` and `backendId`) share one lease, as specified - harmless because their resolution is identical and `backendManager.get()` already returns one memoised backend per environment; `forBot` revalidation and a replaced key are both bounded by the lease.

### R2-GO-V1
**Status:** Fixed (commit 563c335)
**Diagnosis:** CONFIRMED — RUN-1's missing field seen from the second consumer. `hydrateArchive` derived `startedAtMs` with its own `Number.isFinite(Date.parse(meta.startedAt)) ? … : 0` while the archive sorted on `startedAtMs`, and the hydrate expression did not honour `startedAtMs` either, so the two keys disagreed in both directions: prune order was lexicographic, list order chronological.
**Fix:**
- `runStartedAtMs` is exported from `run-archive.mjs` and used by both consumers — the prune comparator and `hydrateArchive()` (`supervisor.mjs:259`) — one derivation from one field.
- `hydrateArchive` also assigns `startSeq`, so hydrated history keeps a stable order against new runs under `newestFirst`.
- `record(...)` now writes `startedAtMs` alongside `startedAt`, so both layers read the same value.
**Tests:** one test in `supervisor-retention.test.mjs`, "the runs list and the archive prune agree on which run is newest": five archived runs whose ids sort opposite their start times, `createRunArchive(dir, { maxRunsPerEnvironment: 2 })` prunes (the two newest by clock survive), then a fresh `CliEnvironmentService` over the same directory hydrates and `listRuns` returns exactly those two, newest first, descending `startedAt`; fails on the old code, where the archive kept run-3/run-4 — the two oldest.
**Review:** passed review first time
**Residual:**
- Only the prune half is a red test; with the writer emitting the ISO string both layers derive the same number once they share the helper, so the hydrate half is covered only end-to-end.

### R2-GO-V2
**Status:** Fixed (commit c474fa6)
**Diagnosis:** CONFIRMED. `job = createWindowsJob()` is a default parameter made once per server instance in both `stdio-server.mjs` and `native-server.mjs`; `job.add()` appends on every spawn and `terminate()` (`windows-job.mjs`) keeps every pid it was handed and latches `terminated = true`. Nothing reset either, so after one stop/start cycle the next `terminate()` ran `taskkill /T /F` against the previous generation's dead, potentially recycled pids.
**Fix:**
- `windows-job.mjs` gained `reset()`: clears `children` and unlatches `terminated`.
- Both `stop()` implementations call `job.reset?.()` after the terminate (`stdio-server.mjs`, `native-server.mjs`) — the smaller of the two options the brief allowed, and it keeps the existing `createWindowsJob` injection the tests use.
- The call is optional-chained, so the `{ add, terminate }` job fakes existing tests inject keep working untouched, and `createWindowsJob` itself is unchanged for callers.
**Tests:** new `gate/__tests__/server-job-reset.test.mjs` (3 tests, red before): ensureRunning→stop→ensureRunning→stop through the stdio server leaves the job empty after the first stop and holding exactly the live child after the second start, and the final stop kills the live child while the dead one's kill count is unchanged; the same sequence through `createNativeServer`; and a unit test that `reset()` clears the pids and unlatches so a second `terminate()` works at all.
**Review:** passed review first time
**Residual:** none

### R2-GO-V3
**Status:** Fixed (commit 7627c4a)
**Diagnosis:** CONFIRMED. `voice-rpc.mjs` stored the phone's own `thread` object on each record by reference, unprojected, alongside VOICE-1's full-map scan. The author ADDED a constraint the audit did not state: one reader does run after `end()` is initiated - the media socket's `createCall` end audit effect reads `session.thread?.botId`, dispatched from inside `createCall`'s own `end()`, which the registry drives from its end fan-out. Dropping the payload before the fan-out would have written `botId: null` on every abandoned or lapsed call.
**Fix:**
- `voice-rpc.mjs` `end()` records `endedAtMs`, fans out to `_endListeners` first with the thread still in place (comment says why), then sets `session.thread = undefined`, then takes the record off the live index and into `_ended`.
- Everything the media socket reads for an ended session survives: `voiceSessionId`, `deviceId`, `engine`, `fellBackFrom`, `ended`, `endedReason`, `attached`, `grantedAt`, `lastSeenAt`.
**Tests:** `voice-registry-prune.test.mjs` - an ended session drops the phone thread immediately while those fields remain; the end fan-out still sees the thread; and end-to-end through a real media socket, a released reservation (`clock += ATTACHED_LIVENESS_MS + 1`, one `liveForDevice`) still audits `botId: 'scout'` with the record's thread `undefined`. That last one guards against reordering the two statements.
**Review:** passed review first time.
**Residual:**
- `server.mjs:570` (`runVoiceTurn`) re-reads `session?.thread?.sessionId` after awaiting backend resolution. The author could not reach a path that does it - the resolution runs under the turn's `AbortSignal`, which `end()` fires, so the turn resolves `aborted` first - and `server.mjs` was outside the allowed files.

### R2-VOICEANDROID-1
**Status:** Fixed (commit 0072f00)
**Diagnosis:** CONFIRMED. `HandsfreeCallNotification.mutedForAction`'s table was inverted (`ACTION_MUTE -> false`, `ACTION_UNMUTE -> true`), while `HandsfreeCallService.buildNotification` attached `if (state.muted) ACTION_UNMUTE else ACTION_MUTE` and labelled it `muteActionLabelFor(state.muted)` — so "Mute" wrote `false` over `false`. `HandsfreeCallState.setMuted` assigns verbatim on a live call, and the existing JVM test pinned the inversion while supplying the opposite value by hand.
**Fix:**
- `mutedForAction` is now `ACTION_MUTE -> true`, `ACTION_UNMUTE -> false`, `null` otherwise, so `mutedForAction(muteActionFor(m)) == m`.
- New pure `HandsfreeCallNotification.muteActionFor(muted)` sits beside `muteActionLabelFor`, so the label and the attached intent are one decision.
- `buildNotification` calls `muteActionFor(state.muted)` (`HandsfreeCallService.kt:227`); the intent attached is unchanged, the choice is now tested.
- `onStartCommand`'s handler stays `mutedForAction` -> `setMuted` — that is the point: the tap now reaches the state its label promised.
**Tests:** `theMuteIntentNamesTheStateItWants`'s two inverted assertions were corrected (that assertion pinned the defect; the null cases are untouched), `theMuteActionDrivesTheSameStateTheServiceHolds` now feeds the mapping's own answer and checks the flip both ways, and new `theMuteIntentAttachedAsksForTheStateItsLabelNames` plus `everyMuteActionTheNotificationAttachesFlipsTheMuteState` cover the pairing end to end. New state test `unmuteAfterEndIsRefusedToo`.
**Review:** passed review first time
**Residual:**
- The six JVM tests were written but never executed — no Android toolchain; the harness compiles them in a separate build tree.
- JS untouched: the in-app banner's Mute still goes through `setMuted` on the module (this part).

### R2-VOICE-6
**Status:** Fixed (commit 001fbc9)
**Diagnosis:** CONFIRMED. `isMuted` had exactly one writer, `setMuted` (`HandsfreeVoiceModule.swift:207`), and neither `endLocked` nor `startSession`'s success path cleared it, so the next call's `AsyncFunction("startListening")` guard and `beginRecognition`'s guard both failed on a stale `true` and the JS retry ladder in `handsfree-voice-provider.tsx:597-606` burned 8 attempts at 150 ms and ended the call with `recognition-failed` about 1.2 s in. Android is immune because `HandsfreeCallState.start()` resets `muted`.
**Fix:**
- `endLocked` (`HandsfreeVoiceModule.swift:731`) now writes `self.isMuted = false` and `self.consecutiveRecognitionErrors = 0` *before* `guard self.sessionActive else { return }`, so the early return that runs when no call was live cannot leave the flag behind.
- `startSession`'s success path (`:149-167`) resets `isMuted`, `isListening`, `isFinishingTurn` and `consecutiveRecognitionErrors` on the way to `sessionActive = true`, so a new call starts clean even if the previous end never ran.
- The speech queue is flushed with `self.stopSpeakingLocked()` (clears `pendingChunks`, forces `isSpeaking = false`) rather than hand-clearing the two speech fields — one flush path, the same one `stopSpeaking` and barge-in use.
- `startAttemptId = nil` still runs first, and the `!startEngineIfNeeded()` refusal branch still sets `sessionActive = false`.
**Tests:** Three new cases in `__tests__/handsfree-native-contract-test.ts` (describe "the iOS module is a clean slate per call"): the `isMuted` clear is present and ordered *before* the `sessionActive` guard in `endLocked` (plus a re-assert of Android's `fun start(...) { ... muted = false }`); the four resets and the `stopSpeakingLocked()` flush sit between `sessionActive = true` and the `promise.resolve("started")` dispatch; `startAttemptId = nil` is still present and still ordered first. All three fail on the pre-fix Swift. No existing assertion was changed.
**Review:** passed review first time
**Residual:**
- none

### R2-VOICE-7
**Status:** Fixed in part (commit 001fbc9) — this part is the iOS truncation. The audit also blames the JS side committing `spokenRef.current = plan.spoken` before the native call; that is R2-HANDSFREE-1, fixed in package N2 (commit 6705156).
**Diagnosis:** CONFIRMED, and the audit's second half (a cancelled utterance advancing the queue) was confirmed as a live hazard rather than a hypothetical: the delegate implemented only `didFinish` and called `speakNextChunk()` unconditionally, so any `didFinish` arriving for an utterance `stopSpeaking(at: .immediate)` had cancelled would shift a whole sentence off the queue. The author CORRECTED the brief's suggested guard: an `isSpeaking` check is not sufficient, because JS emits `stop-speaking` then `speak` for a new reply, so `isSpeaking` is true again when a stale callback lands.
**Fix:**
- `speakLocked` (`HandsfreeVoiceModule.swift:552`) appends: when `isSpeaking` it assigns `voiceIdentifier`/`speechRate`/`speechPitch`, does `pendingChunks.append(contentsOf: chunks)` and returns — no `synthesizer` call, no `speechGeneration` bump, no `isSpeaking` write, so the in-flight utterance is never touched. This matches Android's `speakInternal`, which assigns the pending voice fields and then `queuedSpeech.addAll(chunks); return`.
- The non-speaking path keeps the original order (`stopListeningLocked`, voice fields, `speechGeneration += 1`, `pendingChunks = chunks`, `isSpeaking = true`, `speakNextChunk()`) minus `synthesizer.stopSpeaking(at: .immediate)`, which is what cut the sentence mid-word.
- New `utteranceFinished(_:)` (`:616`) advances the queue only when `utterance === self.speakingUtterance` (with `isSpeaking` and `speechGeneration > 0`), and `HandsfreeSpeechDelegate.onFinish` became `(AVSpeechUtterance) -> Void` so the delegate forwards the utterance. `stopSpeakingLocked` nils `speakingUtterance` before cancelling and `speakNextChunk` reassigns it per utterance, so a cancelled utterance's late callback fails the identity test.
- `stopSpeakingLocked` (`:628`) still clears the queue and cancels; JS's `stop-speaking` before a fresh reply is what makes the append safe.
**Tests:** Five new cases (describe "iOS progressive speech queues instead of truncating") pin the append and the *absence* of `stopSpeaking(at:` from `speakLocked`, the append ordered before the start path's `speechGeneration += 1`, the voice fields assigned before the append (Android's ordering pinned as the reference), the intact fresh-start path, recognition still closed on the path that actually speaks, the `stopSpeakingLocked` flush plus barge-in routing through it, and the identity guard with the new delegate signature. All five fail on the pre-fix Swift; no existing assertion was changed.
**Review:** passed review first time
**Residual:**
- The delegate still reacts only to `didFinish`, the pre-existing shape. If some iOS version delivered `didCancel` for a normal completion the queue would stall; left alone deliberately.
- Because append now matches Android, a reply that triggers `plan.muted` re-speaks the full text appended after whatever is still queued — a JS-layer quirk (reviewer-confirmed identical on Android), not introduced here.

### R2-VOICE-8
*Package N1*
**Status:** Fixed in part (commit 0072f00) — the native emit only (this part). The JS half is another package's brief and was explicitly off-limits here: `handsfree-voice-provider.tsx` still discards the payload, `handsfree-call-copy.ts:124-125` stays dead, and the call still has no liveness probe.
**Diagnosis:** CONFIRMED, including the verifier's severity correction to S3 (the orphan needs the foreground service destroyed under a live JS runtime, not a Recents swipe, which restarts JS). `onTaskRemoved` and `onDestroy` both called `end("app-killed")`, and `end` emits nothing, so a live JS runtime kept a "Listening" call with dead controls and no timer to notice — `armWatchdog` is armed only inside `performSend`.
**Fix:**
- New `endFromPlatform(reason)` posts one block that does `state.requestEnd(reason)` and only on `true` emits `endRequested` with that reason, then `teardown()`.
- The emit precedes teardown, so the event goes out while the service is still whole.
- Reusing `requestEnd` means no new flag to keep in step: the first end wins, and a call the operator or focus loss already ended is never announced again.
- The emit is wrapped in `try/catch` — a detached bridge is already a no-op, and a throwing runtime cannot abort a teardown from a lifecycle callback.
**Tests:** none added, and honestly so: `Service` + `Handler` cannot be exercised on the JVM. The pure half is already pinned by `endIsIdempotentAndRecordsTheFirstReason` and `focusLossAndTaskRemovalBothReachTheTerminalPhase`; `__tests__/handsfree-native-contract-test.ts` asserts the event exists and passed (12 suites, 231 tests).
**Review:** passed review first time
**Residual:**
- The reason still lands as `user`: `handsfree-voice-provider.tsx:348-349` drops the payload. The call reaches its terminal phase; the copy branch stays dead until another package reads it.
- `HandsfreeVoiceModule.OnDestroy` still calls `end("app-killed")` with no emit — correct, JS is being destroyed there.

*Package N2*
**Status:** Fixed in part (commit ad55c02) — the JS half only (this part). The Kotlin emitter of `endRequested { reason: 'app-killed' }` belongs to N1 (commit 0072f00); no Kotlin was edited here.
**Diagnosis:** CONFIRMED, with the verifier's S3 correction: `'app-killed'` was an unreachable terminal reason in `reduceHandsfreeSession` (its terminal events are `end`/`endRequested`/`disconnect`/`thread-changed`/`interruption`/`fatalError`, and `endRequested` collapsed to `endCall(state, 'user')`), so the `handsfree-call-copy.ts:124` branch was dead code and `callOwnsAudio` stayed taken after such an end. The orphan still needs the foreground service destroyed under a live JS runtime — a Recents swipe restarts JS and returns the session to idle.
**Fix:**
- `handsfree-session.ts`: `endRequested` carries an optional `reason: 'app-killed'`; the reducer calls `endCall(state, event.reason ?? 'user')`, so the platform's own end is the same terminal path (`ending` plus the `stop-session` effect) as the notification's End — which is still `user`.
- That unchanged path runs `teardown`, so `endHandsfreeCall()` releases `callOwnsAudio` on the phone path, `resetSpeech()` clears the speech refs, and the finished call records `lastEndReason: 'app-killed'`, which is what `handsfreeEndReasonCopy` reads.
- `handsfree-voice-provider.tsx` forwards the native reason (`event.reason === 'app-killed' ? 'app-killed' : undefined`). No banner work was needed; the copy is reached through the existing `lastEndReason` path.
**Tests:** `__tests__/handsfree-session-mute-test.ts`, describe `endRequested carries the reason the platform gives it`: an `app-killed` end from `speaking` leaves `ending` with that reason and the `stop-session` effect, then `stopped` gives `idle`, `callsEnded === 1`, `lastEndReason === 'app-killed'` and the dedicated copy; the reason is terminal from every live phase; every reason the copy module names is reachable from a live call; the notification End is still `user`. 3 failed pre-fix. One contract assertion was changed — `End and the notification End take the same path` no longer requires the literal `dispatch({ type: 'endRequested' })`, which no longer exists, but the typed dispatch and the forwarded reason; it fails on the pre-fix provider.
**Review:** passed review first time — rounds 2 and 3 verified the forwarding, the ordinary terminal path and the audio release, and flagged the changed contract assertion as a legitimate narrowing.
**Residual:**
- If the Kotlin emitter never sends the reason, the JS side behaves exactly as before (`reason: 'user'`) — that half is N1's.
- `callOwnsAudio` is released only on the phone path, as for every other end; the Gate path never takes audio ownership. No liveness probe was added, so the rest of VOICE-8 (a call with no timer, probe or poll) is untouched.

### R2-GATEVOICE-1
**Status:** Fixed (commit ad55c02)
**Diagnosis:** CONFIRMED. `gateReconnectDelays` summed to exactly `GATE_RECONNECT_WINDOW_MS` (20 000 ms) — `[500, 1_000, 2_000, 4_000, 8_000]` plus a final `windowMs - spent` = 4 500 — and `reconnectGateMedia` slept first then re-checked `now() >= deadline`, so the sixth attempt could only start on the deadline and was always discarded. 4.5 s of the Gate's resume window was dead air and a link back at ~17 s lost a call the Gate still held.
**Fix:**
- `gate-reconnect.ts`: new `GATE_RECONNECT_SAFETY_MARGIN_MS = 2_500`; the final delay is `windowMs - margin - spent`, pushed only when positive — the 20 s schedule is now `[500, 1_000, 2_000, 4_000, 8_000, 2_000]` = 17 500 ms, so the last shot is issued inside the window rather than slept through.
- The post-sleep guard is `input.isAborted() || now() + ATTEMPT_ROUND_TRIP_MS >= deadline` (`ATTEMPT_ROUND_TRIP_MS = 1_000`): teardown still wins before every attempt, and an attempt that already started is run to its answer.
**Tests:** `__tests__/gate-reconnect-test.ts` with an injected `sleep`/`now`: changed `fits every backoff step inside the Gate resume window` (it pinned the old sum, `toBeLessThanOrEqual(window)`; now strict plus a per-attempt bound) and the custom-window test, plus 7 new ones — last attempt at 17 500 ms, a Gate that accepts only the last attempt is rejoined, sums under 20/12/45 s windows, a window too small for the margin gets no phantom shot, teardown wins mid-schedule. 7 of 13 fail on the pre-fix `gate-reconnect.ts`.
**Review:** caught in three rounds; the round-3 review verified the schedule and tests correct, but its minor finding — no clamp, so `gateReconnectDelays` yields no attempt at all for a `windowMs` near 1.5 s or less — is still in the commit (only the production 20 s window is reachable).
**Residual:**
- The skip rule is a fixed 1 s round-trip assumption, not a measured latency; a re-attach slower than that can still be started near the edge and 404.
- The monotone-backoff loop no longer covers the final, deliberately shorter, shot; the test says so.

### R2-HANDSFREE-1
**Status:** Fixed (commit ad55c02), but only by source-contract tests — the round-3 request for a driven test of the retry chain is not in the commit.
**Diagnosis:** CONFIRMED. `streamReplyText` did `spokenRef.current = plan.spoken` *before* `void module.speak(...)` and threw the boolean away; Android answers a plain `false` when the service is momentarily gone, so a refused chunk was recorded as spoken, `planHandsfreeSpeech` never re-offered it, and the phase stayed `speaking`, whose only exits a refusal emits none of (no watchdog is armed outside `performSend`).
**Fix:**
- `handsfree-voice-provider.tsx`: `HANDSFREE_SPEAK_RETRY_MS = 250`, `HANDSFREE_SPEAK_RETRY_LIMIT = 5`; `streamReplyText` parks the newest text in `speakTextRef` and offers it through one single-flight `offer(text, retriesLeft, refusedAs)`.
- `spokenRef.current = plan.spoken` is assigned only on the `true` branch of the `speak` promise (`:747`); `false` and a rejection re-enter `offer` with the chunk still unrecorded.
- Exhaustion calls `recordFailure(...)` then `dispatch({ type: 'reply-failed' })`, which the reducer maps to `stop-speaking` + `start-listening` through `afterReply` — the call reopens the microphone instead of parking on "Speaking".
- `speakBusyRef` is genuinely claimed (`:689`) so a mid-speak delta parks its text instead of starting a second speak, `speakEpochRef` drops a late answer from a retired reply, and the retry timer is cleared in `resetSpeech` and on unmount.
**Tests:** three new tests in `__tests__/handsfree-provider-contract-test.ts` pin the wiring by source text (commit index after `module.speak(` and after `if (!accepted)`, rejection re-offers the same text, the retry expression, exhaustion order, the claim, timer cleanup); all three fail on the pre-fix provider. The planner seam is covered behaviourally by the HANDSFREE-3 equivalence tests; nothing drives the module itself (no `react-test-renderer` / `@testing-library/react-native` in this repo, and none may be added).
**Review:** three rounds. Round 2 caught that `speakBusyRef` was read and cleared in seven places but never set (every delta could start an overlapping speak), that clearing it on an epoch mismatch handed a second slot to a reply already speaking, and the always-true `newest !== text` re-plan — all repaired. Round 3 still failed it: it asked for the state machine extracted into `src/lib/voice/speak-retry.ts` and driven with fake speak/timers (absent), and flagged that a provider unmounting after `speak` answered `false` but before the timer is armed still runs the chain to exhaustion and dispatches.
**Residual:**
- That unmount window stands: cleanup clears the timer, but nothing checks mounted state before arming it or before `recordFailure`/`dispatch`.
- Exhaustion is deliberately the non-fatal `reply-failed`; a platform refusing every chunk repeats it, still bounded at five tries.

### R2-HANDSFREE-2
**Status:** Fixed (commit ad55c02)
**Diagnosis:** CONFIRMED. The banner drew Mute unconditionally and dispatched `{type:'mute'}`; `reduceHandsfreeSession` handled `mute` only from `listening`, `confirming`, `speaking` and `muted`, so in `sending` and `waiting` it fell through to `stay(state)` — a silent no-op in exactly the phases where a lossy link spends tens of seconds.
**Fix:**
- `handsfree-session.ts`: new optional `muteIntent` ("a mute was tapped while a turn was in flight"), cleared by `endCall` and by the unmute that leaves `muted`.
- `sending` and `waiting` set the intent and emit the same `set-muted: true` effect every other phase emits; the in-flight turn is untouched, so the reply still arrives, is shown and is spoken. `unmute` there clears it and emits `set-muted: false`; with no intent it is still `stay(state)`, so the previously inert case stays inert.
- New `afterReply` helper is the single place a finished or failed turn returns to listening: with an intent it enters `muted` (`resumePhase: 'listening'`) and filters `start-listening` out; without one it is the old transition byte for byte. It serves the `speaking` exits and the `waiting` `reply-failed`.
- `speaking` gained an `unmute` case (a repair): the intent is still set when the reply starts playing and the banner reads "Unmute" for all of it, so the tap now clears the intent and emits `set-muted: false` while the reply plays.
- `handsfree-voice-provider.tsx` reports `muted = phase === 'muted' || (!gateLive && session.muteIntent === true)`; `handsfree-call-banner.tsx` takes `muted` from context instead of deriving `phase === 'muted'`, and the indicator, accessibility label and button follow it.
**Tests:** new `__tests__/handsfree-session-mute-test.ts` — mute/unmute while sending and waiting, unmute with no intent a no-op, a reply arriving while muted is spoken and ends in `muted` with no `start-listening` then unmute returns to `listening`, barge-in, failed reply, send failure, and the phases that already took a mute. 11 of 19 failed on the pre-fix reducer; 1 of 21 fails against the committed baseline (the new `speaking` unmute test). Two contract tests pin the provider's `muted` and the banner's control.
**Review:** caught twice. Round 2 found the newly reachable but inert control ("Unmute" with an intent pending in `speaking`); that repair is verified correct in round 3.
**Residual:**
- A mute tapped in `confirming` still cancels the armed grace send (pre-existing, deliberately unchanged).
- `muteIntent` is JS-only: a native service that dies in the gap still ends the call with its own terminal event.

### R2-GATEVOICE-2
**Status:** Fixed (commit ad55c02)
**Diagnosis:** CONFIRMED, with the verifier's correction — two independent 45 s `startDeadline()` budgets, not three. `startGateCall` minted one for the device identity read and `openGateVoiceSession` a second for the grant/prompt/media/release chain, so a Gate that black-holed both held the sheet on "Starting" for ~90 s while a comment claimed one budget. The phone-engine path has a single microphone-prompt budget and is untouched.
**Fix:**
- `handsfree-start-attempt.ts`: optional `deadline` on `OpenGateVoiceSessionInput`; the chain mints its own only when none was borrowed and disposes only that own one, so a borrowed budget stays the caller's. With no parameter the old `startTimeoutMs` path is unchanged.
- `startGateCall` mints ONE `budget`, guards `pushDeviceParams()` with `budget.guard('the device identity', …)`, hands it as `deadline: budget` to `openGateVoiceSession`, and disposes it in a `finally` (so a rethrowing chain leaves no 45 s timer) and on the identity-error path.
- The two comments claiming "the same one-shot budget" / "carries its own budget" now say what the code does.
**Tests:** new `__tests__/gate-start-budget-test.ts` (fake timers): a 40 000 ms identity read followed by a grant that never answers settles at exactly `HANDSFREE_START_TIMEOUT_MS` (45 000 ms) with `detail === 'The call did not start: the PC never answered.'` — it fails pre-fix on jest's 20 s per-test timeout, since a second budget leaves the chain 45 s from where the test stops advancing the clock. Two further tests are compatibility guards that pass before and after by design: a borrowed budget is not disposed by the callee (a later link on it still expires with its own name), and a caller with no budget still gets its own. A contract test pins exactly one `startDeadline(` in `startGateCall` and fails pre-fix.
**Review:** passed review first time — round 2 and round 3 both verified it, including tracing every return between mint and dispose and confirming the phone path is untouched.
**Residual:**
- The borrowed budget is only as good as its owner: if the whole provider unmounts mid-start, the caller of `start` still owns it (unchanged).

### R2-VOICE-9
**Status:** Fixed (commit 001fbc9)
**Diagnosis:** CONFIRMED. `handleRecognition` treated any mid-turn error as silence (`finishTurn(text: "")`), `finishTurn` emitted `noSpeech` and restarted unconditionally when nothing was speaking, and `beginRecognition`'s `endpointing.begin(at:)` reset the 10 s no-speech clock every pass, so `noSpeechTimedOut` could never trip. The author ADDED a consequence the audit did not name: delaying the restart opens a window where a cancelled `SFSpeechRecognitionTask`'s own terminal error arrives with `isListening` false and would take the branch that ends a healthy call.
**Fix:**
- `consecutiveRecognitionErrors` (`:64`) with `maxRecognitionRestarts = 5`, `recognitionRestartBase: TimeInterval = 0.25`, `recognitionRestartMax: TimeInterval = 4` (`:25-27`); reset to 0 on any `result.isFinal` and on any non-final result with non-empty text, plus in `startSession` and `endLocked` since the streak is per-call.
- The error path (`:437-463`) increments; at 5 it calls `stopListeningLocked()`, emits `fatalError` with `"reason": "recognition-failed"` and `error.localizedDescription`, and `end(reason: "recognition-failed")` — the same shape as the not-listening branch below it. Otherwise it closes the turn as silence with `emitSilence: consecutiveRecognitionErrors == 1` and `restartAfter: recognitionRestartDelay()`.
- `recognitionRestartDelay()` (`:514`) is `0.25 * 2^(n-1)` with `min(step, 4)` on the shift and `min(..., 4)` on the result, so it cannot overflow; `scheduleRecognitionRestart(after:)` (`:527`) arms `audioQueue.asyncAfter` with `[weak self]` and guards on turn token, `sessionActive`, `!isSpeaking`, `!destroyed`. Worst-case backoff is ~3.75 s across four restarts instead of an unbounded spin.
- `finishTurn` (`:474`) takes `emitSilence: Bool = true` and `restartAfter: TimeInterval? = nil`, so `emit("noSpeech")` happens once per streak and the ordinary silence path still restarts immediately. It also bumps `turnToken` where the turn closes — the extra change the brief's own guard list forced, since without it the cancelled task's error would end a healthy call during the new backoff window.
**Tests:** Six new cases (describe "a failing iOS recogniser backs off instead of spinning") pin the field, the `+= 1`, the `>= maxRecognitionRestarts` escalation and its three terminal payload parts, both reset sites plus the per-call reset, the two `TimeInterval` constants with the `Double(1 << min(step, 4))` cap and the four-condition stale guard, `emitSilence: consecutiveRecognitionErrors == 1`, the `turnToken += 1` ordering between `recognitionTask = nil` and `endpointing.reset()`, and that only the error path passes a `restartAfter`. All six fail on the pre-fix Swift. The turn-token case initially passed pre-fix because its `between()` slice ran past `finishTurn` into `stopListeningLocked`; the boundary was tightened. No existing assertion was changed.
**Review:** passed review first time
**Residual:**
- The 5-strike bound and the 250 ms base are the brief's numbers read off a failing recognizer, not device-measured; they are the tunable part. A transient network drop costing more than ~3.75 s of retries now ends the call where it previously limped along — the intended escalation.
- The delay is not persisted across calls, by design.

### R2-GATEVOICE-3
**Status:** Fixed (commit ad55c02), with the confirmation and rollback paths contract-tested rather than driven.
**Diagnosis:** CONFIRMED, with the verifier's correction: `reduceGateCall` self-corrects the banner at the Gate's next `phase` frame, so the defect is that a refused or stalled control frame had no rollback at all before that frame. `mute()`/`unmute()` folded the banner optimistically into `gateBannerRef`/`setGateBanner` and fire-and-forget `sendGateControl`, discarding its boolean.
**Fix:**
- `foldGateMute(muted)` folds immediately, remembers the pre-fold banner in `gateMuteRef`, arms `GATE_MUTE_CONFIRM_MS = 5_000`, and returns the `sendGateControl` promise.
- `rollbackGateMute(why)` restores phase/`muted` through both the ref and the state and logs one `console.warn` naming the reason and the session.
- `mute`/`unmute` wrap that promise, so `false` and a rejection both roll back; any Gate `phase` frame calls `clearGateMute()` before folding, so the Gate's own account always wins and is never undone. `clearGateMute` also runs on teardown, `abandonGateStart` and unmount.
**Tests:** `__tests__/handsfree-provider-contract-test.ts`, describes "an optimistic Gate mute is confirmed or rolled back" and "the Mute label follows the state, not the phase alone": the fold contains `rollbackGateMute(` and no longer fire-and-forgets, arms the 5 s timeout, every phase frame clears the wait first, teardown and unmount clear it, and the rollback restores phase/`muted` and re-sets the banner. Three of these fail on the pre-fix provider; the banner assertion (`does not contain "const muted = phase === 'muted'"`) fails on the pre-fix banner.
**Review:** round 3 verified the fold, the rollback and the timers correct but still failed the finding: it required the machine extracted into `src/lib/voice/gate-mute-fold.ts` and driven with fake timers (absent from the commit), and flagged that the rollback target can itself be optimistic.
**Residual:**
- `foldGateMute` snapshots `gateBannerRef.current` after an earlier unconfirmed fold, so mute → unmute inside 5 s with no `phase` frame rolls back to the optimistic mute rather than the Gate's last report (round-3 finding, unrepaired).
- Every Gate frame is still parsed twice, `isGatePhaseFrame` then `reduceGateCall` (round-3 minor, unrepaired).

### R2-VOICE-10
**Status:** Fixed in part (commit 001fbc9) — the audit's title says "three entry points"; the pre-fix file has exactly two off-queue reads of module state, `AsyncFunction("startListening")` and `AsyncFunction("speak")`, and both are fixed. The `Where` line's other sites (`startSession`'s dispatch, `setMuted`, `endLocked`) already read and write only inside `audioQueue.async` blocks. The dead `stateLock` is deleted.
**Diagnosis:** CONFIRMED. `stateLock` was declared at `:17` and referenced nowhere, while `AsyncFunction("startListening")` and `AsyncFunction("speak")` read `self.sessionActive` / `self.isMuted` on Expo's calling thread — the pattern `beginRecognition` avoided by reading inside the queue block.
**Fix:**
- `startListening` (`:173-181`) reads its guard with `let allowed = self.audioQueue.sync { self.sessionActive && !self.isMuted }` and still dispatches the work with `audioQueue.async`; `speak` (`:187-201`) splits its guard so the cheap `usable.isEmpty` check stays first and reads `let active = self.audioQueue.sync { self.sessionActive }`.
- `stateLock` deleted, replaced by a comment on `audioQueue` (`:16-22`) stating the discipline: state is read and written only from a block dispatched to `audioQueue`, and an entry point needing a decision reads it with `sync`.
- Deadlock confirmed by reading dispatch, not assumed: every `AsyncFunction` body runs on Expo's own queue (the only route to `audioQueue` is an explicit `.async`/`.sync` inside a body), no `asyncAfter` handler calls `sync`, and nothing on `audioQueue` blocks on main or on the caller (`emit`/`promise.resolve` are `DispatchQueue.main.async`, `requestAuthorization` uses a non-blocking `group.notify(queue: .main)`).
**Tests:** Three new cases (describe "iOS state is read on the queue that writes it"): `stateLock` and `NSLock` are absent from the Swift; each AsyncFunction's exact `sync` read is present and the work is still *dispatched* with `audioQueue.async`, not run inline; `end`, the interruption/route observers and `setMuted` still read and write only from dispatched blocks. Two fail on the pre-fix Swift; the third passes before and after by design (it pins existing behaviour this change must not disturb) and the notes say so rather than counting it as evidence.
**Review:** passed review first time
**Residual:**
- `audioQueue.sync` is a genuine short block on the caller's thread, sitting behind the per-buffer tap dispatch. That latency is the trade against reading unsynchronised.
- A future AsyncFunction calling `audioQueue.sync` from *inside* an `audioQueue` block would be the deadlock; the comment on the field is where that gets caught.

### R2-HANDSFREE-3
**Status:** Fixed in part (commit ad55c02) — the sentence scan is incremental, but the per-delta append-only proof is still O(n): `prefixHash(fullText, settled)` re-reads the settled prefix every delta, so end-to-end the planner stays quadratic (as does the per-delta `text.slice(0, boundary)`). The round-3 review rejected exactly this as not meeting the requirement and ordered the digest dropped in favour of a cursor-carried prefix proven with native `startsWith`; that repair is not in the commit.
**Diagnosis:** CONFIRMED for the quadratic rescan. Round 2 also caught a regression the author had introduced: with a cursor present the "spoken text is still a prefix" check degenerated to a length comparison, so from the second delta onwards a rewrite under the scan went unreported and the provider spoke a mid-sentence fragment of the rewritten text at a stale offset where it previously waited for completion.
**Fix:**
- `handsfree-reply.ts`: `HandsfreeSpeechCursor` gains `hash`, the 32-bit FNV-1a digest of `fullText.slice(0, index)`; `foldHash`/`prefixHash` fold forward as the scan passes each character, so extending the digest costs only the delta.
- `planHandsfreeSpeech` re-proves the settled prefix each delta (`prefixHash(...) !== cursor.hash` → `mutated: true`, cursor dropped from the plan) — the answer the pre-change planner gave a non-prefix. Spoken text beyond that prefix and the no-cursor path are still compared with `startsWith`; the cursor stays optional, so existing callers compile.
- The provider needed no repair-pass change: it already carried `speechCursorRef` (cleared in `resetSpeech`) and handled `plan.mutated` by setting `fallbackRef` and waiting for completion.
**Tests:** new `__tests__/handsfree-reply-incremental-test.ts` (14 tests) keeps the pre-change planner verbatim as `referencePlan`: 12 seeded replies (code fences, `1.2.3`, markdown lists, `Dr.`, `Wait...`, unterminated tails) fed one character at a time with `chunks`/`spoken`/`mutated` compared at every delta; delta size does not change the words; 4 digest tests (rewrite inside the settled prefix, rewrite of the unscanned tail, an untrusted hand-built digest, an append-only stream that must never trip) plus a 526-step randomized mix of growth and in-place rewrites counted so it cannot pass vacuously; mutation/fallback cases; and a complexity test reading a 20 000-char reply in 5-char deltas under 3× its length via `onExamine`, where the same loop without the cursor reads over 50×. 3 of 9 failed pre-fix; 4 of 14 fail against the committed baseline (the new digest tests).
**Review:** two failing rounds and a third that is not discharged. Round 2's blocking defect (the mutation guard removed) was repaired with the digest; round 3 refused the result on its own measurements (old whole-reply scan ≈416 ms vs new scan+digest ≈105 ms on a 20 000-char reply — a constant-factor win, no complexity change) and required the digest deleted, the prefix carried in the cursor, and the complexity test rewritten. The commit still ships `prefixHash`, so that round stands open.
**Residual:**
- One pass over the settled prefix per delta remains — formally quadratic, roughly an order of magnitude cheaper per character than the scan it replaced; `onExamine` counts the scan only and the test comment now says so.
- Stricter than before: a rewrite inside the scanned but not yet spoken tail is now a mutation, so such a stream loses progressive speech for that turn and is spoken whole when the message finishes.
- The digest is 32 bits: a crafted or accidental collision (~10⁻⁶ over a 20 kB reply's 4000 checks) would pass the settled prefix undetected; the spoken text itself is still compared exactly.

### R2-NV-V1
**Status:** Fixed (commit 0072f00)
**Diagnosis:** CONFIRMED, and wider than one call: not just `speakInternal`, but every main-handler entry point that can rebuild what teardown released. A `speak` posted after `teardown()` ran `ensureTts()` on a null `tts`, made a new `TextToSpeech`, set `speaking = true`, called `startBargeIn()` (a fresh `AudioRecord` and VAD thread) and spoke the rest of the reply — with nothing left to release either. The audit's remedy for the second half was CORRECTED: `teardown()` keeps its one-shot `if (destroyed) return`, and the rebuild paths refuse instead.
**Fix:**
- New pure decision `HandsfreeCallState.canSpeak(destroyed)` = `!destroyed && isActive`.
- `speakInternal`'s first statement is the guard (the hole `startListeningInternal` never had); `speak` checks too, so a torn-down call answers `false` to JS instead of an acceptance nothing carries out.
- Guarded: `ensureTts`'s engine-init post (must not set `ttsReady` or replay a chunk), `playChunk` (no speech, no `speechFinished`), utterance `onError`/`onDone` posts, `startBargeIn` (never opens the microphone), `handleBargeIn`, `playSendEarcon` (leaking a `SoundPool`) — the last one is one change beyond the brief's list.
- `teardown()`'s comment now records why the one-shot is safe.
**Tests:** `speechIsRefusedOnceTheCallEndsOrTheServiceTearsDown` (`HandsfreeCallStateTest.kt`) pins the decision; the service methods touch `Handler`, `TextToSpeech`, `AudioRecord`, `ContextCompat`, so wiring was verified by re-reading every call site. Not executed here — no Android toolchain.
**Review:** passed review first time
**Residual:**
- The audit's "make `teardown()` idempotent-clean rather than early-returning" was declined; the author took the guard-everywhere route instead.
- `destroyed` is non-`@Volatile` and `speak()` reads it off the main thread, so that check is an early refusal only; `speakInternal`'s guard is the one that binds.
- No instrumented test, so "no `AudioRecord` after End" is argued from the call graph, not measured.

### R2-WIDGET-1
**Status:** Fixed (commit 0280cf2)
**Diagnosis:** CONFIRMED. `writeWidgetSnapshot` in `src/lib/widget/widget-device.ts` ended its Android branch in `try { await module?.setPayload(json) } catch {}`, so it threw away both the `false` the native module returns for a payload the card would refuse (`modules/versutus-widget/android/.../VersutusWidgetModule.kt`) and the case of an absent module; the provider's write effect in `src/context/gateway-provider.tsx` still ran `widgetWriteRef.current = decision.last` before the await. The gate's own comment about retrying a refused write described a retry no call site performed.
**Fix:**
- `widget-device.ts`: `writeWidgetSnapshot` now resolves a boolean - `false` for an absent module, a throw, or a `setPayload` answer that is not `true`; other platforms are `true` only when `updateSnapshot` did not throw. An accepted Android write persists the exact JSON to `versutus:widget-last-payload` (`WIDGET_LAST_PAYLOAD_KEY`).
- `gateway-provider.tsx`: the effect captures its own `decision` before the await and commits `widgetWriteRef.current = decision.last` only inside `.then((accepted) => ...)` when `accepted` is true.
- A refusal commits nothing and arms `armWidgetRetry`: `WIDGET_WRITE_RETRY_MS` (30 s) doubling to `WIDGET_WRITE_RETRY_MAX_MS` (5 min), since the facts may never move again; the first accepted write resets the delay to 30 s.
- `widgetWriteRunRef` counts effect runs, so a late answer from an older write cannot commit over a newer state; two overlapping writes never both commit.
- `widget-write-gate.ts` gains the two ladder constants and a header note that a refusal is retried on a ladder as well as on the next change.
**Tests:** `__tests__/widget-device-write-test.ts` covers the seam's four answers (accepted true + payload kept, module answering `false`, no module, a throw leaving the stored payload alone). `__tests__/widget-write-retry-test.tsx` proves the ladder (30/60/120/240/300 s, one write per gap, same payload) and that the first accepted write stops it. In `__tests__/widget-target-test.ts` the source-pinned assertions that ordered the commit *before* the write were replaced by ones pinning it inside the accepted branch plus `if (run !== widgetWriteRunRef.current) return;` - they pinned the defect.
**Review:** passed review first time
**Residual:** none

### R2-WIDGET-2
**Status:** Fixed (commit 0280cf2)
**Diagnosis:** CONFIRMED. `widgetWriteGate` in `src/lib/widget/widget-write-gate.ts` is a pure function of `now`, and the only caller was the write effect in `src/context/gateway-provider.tsx` whose deps are the facts. No timer, interval or AppState listener ever fed it a later `now`, so the five-minute floor could not fire while the app sat still and the stamp aged into the card's native 12-hour stale threshold with the gate declining to write.
**Fix:**
- `gateway-provider.tsx`: `armWidgetFloor(decision.last.writtenAt)` arms one timeout for the time remaining to `WIDGET_WRITE_FLOOR_MS` after every accepted write; it bumps `widgetTick`, a dep of the write effect, so the gate is re-asked with a fresh `now` and the rewritten snapshot carries the new stamp.
- The existing single AppState listener also does `if (state === 'active') setWidgetTick(...)`, because JS timers freeze while backgrounded and the foreground return is then the only edge that moves the clock.
- Both timers are cleared before each re-arm and on unmount (`widgetFloorTimerRef`, `widgetRetryTimerRef` in one cleanup effect), and the retry timer is dropped on the first accepted write, so nothing accumulates.
- `widgetTick` is declared beside that lifecycle listener and `setWidgetTick` is in the two arming callbacks' deps, for the `react-hooks/immutability` and `preserve-manual-memoization` rules.
**Tests:** `__tests__/widget-write-retry-test.tsx` with fake timers: nothing written at 4 minutes and exactly one write (greater `writtenAt`) at 5; a foreground return past the floor writes with every timer asleep; a timer is genuinely pending while mounted and `getTimerCount()` is 0 after unmount - that last assertion is what makes it fail pre-fix, which armed no timer. `__tests__/widget-target-test.ts` pins the new deps, the absence of `setInterval`, and that there is exactly one `AppState.addEventListener('change')`.
**Review:** passed review first time
**Residual:** none

### R2-WIDGET-3
**Status:** Fixed in part (this part): the phone-side push path now merges. The Gate's `v: 2` companion body and the native whole-payload `setPayload` (the Kotlin side of R2-WIDGET-3) are another package's; the stale `v: 2` shape is worked around by pinning the merged payload to `v: 3`.
**Diagnosis:** CONFIRMED. `handleWidgetPush` in `src/lib/widget/widget-push-task.ts` forwarded the push JSON verbatim to `setPayload`, which replaces the single stored payload, and the companion's `v: 2` carries only `status/connected/work/approvalsPending/writtenAt` (+ `result`) - absent keys parse as empty in `WidgetPayload.kt`, so every delivered push wiped the Bot rows, roster, run rows, routine tallies and the pinned Bot's name.
**Fix:**
- New exported pure `mergeWidgetPushPayload(pushed, last, hidden, now)` in `widget-push-task.ts`: keeps runs, bots, configBots and the routine tallies from the last app write, takes the pushed `work`, `approvalsPending` and `writtenAt`, and pins `v: 3` because the merged payload carries what only v3 reads.
- `handleWidgetPush` reads the last app write via `readLastWidgetPayload()` (`versutus:widget-last-payload`, written by the seam) and writes the merged JSON; only what the card actually accepted is saved as the next merge's base, and a refused or absent write answers `false`.
- `androidWidgetPayloadIsDrawable` (new, `src/lib/widget/android-widget-payload.ts`) reproduces the refusals `WidgetPayload.parse` makes, so a payload the card could never draw is never written over a good one; the merge answers `null` in that case.
- `widgetPayloadFromData` keeps its old signature and meaning (test-suite use only).
**Tests:** `__tests__/widget-push-task-test.ts`: "the roster, the run rows and the tallies survive the push", "with no last payload the message alone is written, still privacy filtered", "a message the card could never draw writes nothing at all" (a `{v: 2}` push with no work line and no stamp: `setPayload` never called), "what the card took becomes the next merge base". Three existing assertions pinned the defect - `toHaveBeenLastCalledWith(JSON.stringify(body.data.widget))` in two tests and `toHaveBeenCalledWith(JSON.stringify(widget))` in a third - and now assert the merged payload; nothing was deleted or weakened.
**Review:** passed review first time
**Residual:** the Gate still sends a `v: 2` work line and the native `WidgetPayload.kt` still replaces whole values; the merge is what keeps a key absent from the push

### R2-WIDGET-4
**Status:** Fixed in part (this part): redaction is decided phone-side at merge time. The Gate's own redaction rule (`row.richBody` in `gate/core/push-notifier.mjs`) and the absence of a `redact` key in the companion body are the Gate companion's to change (G13), and are not.
**Diagnosis:** CONFIRMED. "Hide result text on the widget" is a device-local preference (`src/lib/settings/widget-privacy.ts`, key `versutus:widget-result-hidden`) that only the app's own fold read, so the headless task wrote the companion's `result` text straight to the locked home screen, and the companion's absent `redact` parses to `false` in `WidgetPayload.kt`.
**Fix:**
- `widget-push-task.ts`: the merge reads `loadWidgetResultHidden()` (the headless task runs in the app's own JS runtime, so AsyncStorage is available). When it is on, the pushed `result` is dropped and the merged payload carries `redact: true`.
- Redaction is sticky: a last payload the app itself wrote redacted keeps `redact: true` even if the switch has since been turned off, and the roster and run rows are dropped with it - a payload claiming `redact: true` while still carrying Bot names would be self-contradictory and `androidWidgetPayload` never produces one.
- Counts (`routinesFailing`, `routinesLate`) and the stamp are not names and survive, exactly as the app's own payload writes them.
**Tests:** `__tests__/widget-push-task-test.ts`: "a hidden result is kept off the card and redaction is stated" (no `result`, `redact: true`, no bots/configBots, counts and honest stamp kept) and "a visible result is written, because this device has not hidden it". Both fail on pre-fix code, where the pushed result was forwarded verbatim.
**Review:** passed review first time
**Residual:** none

### R2-WIDGET-5
**Status:** Fixed (commit 0280cf2) - the audit's corrected diagnosis, S3 not S2, confirmed and slightly worse: the roster was the surviving state, not the status/result/runs.
**Diagnosis:** CONFIRMED, and the author ADDED that `androidWidgetPayload` includes `bots` regardless of connection status, so the verifier's point that the disconnect settle already clears `status`/`result`/`runs` (`status` and `activeGateway?.id` are effect deps) does not clear the Bot names. The roster (`widgetBots`) was plain unkeyed state, never cleared, and the native `clearPayload` had no JS caller anywhere in the repo.
**Fix:**
- `widget-device.ts`: new `clearWidgetSnapshot()`, queued on the same serial queue as the writes (a payload written after the clear would describe a gateway that is gone), calling the native `clearPayload` and then `forgetLastWidgetPayload()` so the merge's base goes with it; best-effort throughout.
- `gateway-provider.tsx`: the write effect takes a no-gateway branch that resets the gate state, drops both timers, and calls `clearWidgetSnapshot()` once per absence (`widgetClearedRef`), not once per re-render.
- That branch is guarded by `isBootstrapped`: before the saved profiles are read there is no answer yet, and wiping the card the operator left from the last session would be worse than the defect.
- The roster is now keyed by the gateway that read it (`widgetBotRead = { gatewayId, bots }`, mirroring the routine read) and `widgetBots` is a `useMemo` yielding the list only when the key matches the active gateway - a switch is two renders deep, and an unkeyed list spent that window naming the old gateway's Bots.
**Tests:** `__tests__/widget-write-retry-test.tsx`: "deleting the only gateway clears the card once" (one `clearWidgetSnapshot`, no payload naming a Bot afterwards), "an absent gateway from the start is cleared once, not once per re-render", and "no payload after the switch names the old gateway Bot". The last one had to be rewritten: its first version PASSED on pre-fix code (the fake connect resolved inside one `act()`, so no write happened in the stale window); the harness now passes the gateway id to the connect script and parks beta's connect at "connecting" to hold the window open. Pre-fix that write carries `bots: [scout]`; after the fix the last write is `[keel]`. `__tests__/widget-device-write-test.ts` adds the clear's three cases (card and merge base forgotten together, a waiting write cannot land after the clear, no module still forgets the base).
**Review:** passed review first time
**Residual:** the native `clearPayload` is assumed to leave the card in its empty state; confirming the redraw would need a Kotlin change (V-3, another package)

### R2-WIDGET-6
**Status:** Fixed in part (commit 2ff377e) — the Gate no longer claims `connected` (this part); the phone-side half (package W2, landing in the same round before deployment) is what makes the write land on a card, and it is out of this package's files.
**Diagnosis:** CONFIRMED, plus the brief's assumption corrected: `widgetSnapshot({connected = true, ...})` defaulted the claim and `server.mjs`'s snapshot closure passed only `busyRuns`/`approvalsPending`, so `resolveSnapshot`'s `snap?.connected !== false` was unconditionally true — every push-written card read "Connected" with a fresh stamp. The brief said absent keys "parse as defaults"; the code says otherwise: `WidgetPayload.kt:49` returns `Parsed.Invalid` without `connected`, `setPayload` then writes nothing, and `widget-push-task.ts:29-39` hands the JSON straight through and ignores the `false`. So a companion without the key is refused today, not defaulted.
**Fix:**
- `push-notifier.mjs` `widgetSnapshot()`: dropped the `connected` parameter and the `connected` key from its output; wording of `work`/`approvalsPending` unchanged.
- Same file `widgetCompanion()`: no longer reads `snap.connected`; writes `status: GATE_STATUS_WORD` (`'Updated'`, the word the app uses for a Gate-written card) and no `connected` key on any provider path. The rest of the `v: 2` shape (`work`, optional rich-body `result`, `approvalsPending`, `writtenAt`) is unchanged.
- The refusal and the phone-side fix are documented at the call site so nobody writes a connection word back.
**Tests:** New `gate/__tests__/widget-companion-honest.test.mjs` (4 tests, all fail pre-fix): no snapshot the Gate builds contains a `connected` key; four providers (absent, `true`, `false`, throwing) cannot put a connection key or the words "Connected"/"Disconnected" on the card; a deep-equal of the whole payload including `status: 'Updated'`; a throwing provider still yields a claim-free card. Existing tests that pinned the old behaviour were changed (assertions only): in `push-notifier.test.mjs`, `the widget companion reports the Gate snapshot instead of hard-coded idle` (`'Connected'`/`connected === true` → `'Updated'` + rest of the snapshot), `a disconnected Gate reads as disconnected on the widget` (replaced by a claim-free guard), and `widgetSnapshot words the Gate state for the home-screen card` (now asserts the key is absent even when a caller passes one).
**Review:** Failed round 1, blocking: the companion without `connected` is refused by today's `WidgetPayload.kt`, so every push-written update dies until W2 lands. Resolved by decision, not code — the harness owner's DECIDED section rules out `connected: false` and returning `null` from the companion and accepts the interim refusal. The repair round acted on the review's secondary items: deleted the test that pinned the Kotlin refusal by regex over Kotlin source, and added the symmetric "no connection word" guard. The reviewer's note that key-absence assertions contradict the card contract was half acted on (the word guard was added; the key assertion stays per the owner).
**Residual:**
- Until W2 relaxes the parser, no companion write reaches the card, so WIDGET-7's and WIDGET-8's gains are visible only in the Gate's own state. One data-only push per opted-in device per event is spent for no write.
- W2 must make `status` agree with the `connected` it supplies: with `connected` absent and the parser relaxed naively, `o.getBoolean("connected")` yields `false` and the status dot would paint red next to a line reading "Updated".
- Not touched: `widget-push-task.ts:34` ignores the `false` from `setPayload` and reports the task as successful.

Integrator note: completed by package W2 (commit `0280cf2`) - the headless push task merges the push into the app's last snapshot and supplies `connected` itself, so the Gate's refusal to claim a connection and the phone's honest write now meet; both halves are landed.

### R2-WIDGET-7
**Status:** Fixed (commit 2ff377e)
**Diagnosis:** CONFIRMED. `check()`, `start()` and `startRun()`'s post-probe write each did an unconditional `this.environmentState.set(id, { state, probe })`, replacing the `busy` state a live run had written; only the run's own start and settle write `busy`, so any probe in between won and every reader of that Map (the app's Environments screen via `rpc.mjs`, `/env`, the widget's run count) read a mid-run environment as idle.
**Fix:**
- `supervisor.mjs` gained `recordState(id, state, probe)`: keeps `state: 'busy'` when the probe says `ready` and `activeRuns(id).length > 0`, and otherwise behaves exactly as before.
- `check()`, `start()` and `startRun()`'s post-probe write now go through it, so `probe` (the CLI version the manifest and backend picker read) still refreshes.
- A non-`ready` probe (`not_installed`, …) still wins — a broken CLI is a fact about the environment, not the run. `stop()`, the run's start and the run's settle keep their direct writes: `stop()` is not a probe and cancels the runs itself.
**Tests:** New `gate/__tests__/supervisor-busy-probe.test.mjs` (stub adapter, fake child, nothing spawned): a live run stays `busy` across `check(id)` and `start(id)` with `probe.version` refreshed, then settles to `ready`; an adapter that goes missing mid-run turns the state to `not_installed` (the guard against over-merging); a probe with no live run writes what it found. Pre-fix: 2 pass, 5 fail.
**Review:** Failed round 1 on WIDGET-6 only; the reviewer confirmed this is a real fix, that every probe site goes through the merge and the three non-merge sites are the right ones to leave alone, and that letting `incompatible`/`degraded` win over `busy` is correct.
**Residual:**
- The `widgetSnapshot` wiring guard in the same file is a regex over `server.mjs` source rather than a call — fragile, and it exists only because the snapshot provider is a closure with no seam to call. The reviewer agreed it is harmless.

### R2-WIDGET-8
**Status:** Fixed (commit 2ff377e)
**Diagnosis:** CONFIRMED, with the verifier's correction to the trigger noted: three concurrent runs on one environment need `maxConcurrentRuns > 1` (reachable from `POST /v1/environments/:id/runs` by any token holder), but the unit mismatch is real. `server.mjs`'s snapshot closure counted `environmentState` entries whose state was `busy`, and that Map is keyed by environment, while `widgetSnapshot` words the number "N runs in flight" and the app's own fold counts runs.
**Fix:**
- `supervisor.mjs` gained `liveRunCount()`, summing the sizes of the `liveRuns` index across environments (the index an earlier package landed) — it counts tracked run ids rather than filtering `this.runs`, so a Gate with weeks of history answers without a walk.
- `server.mjs`'s snapshot closure now calls `environmentService.liveRunCount()` for `busyRuns`; `widgetSnapshot`'s wording is untouched. Other readers of `environmentState` (`rpc.mjs`, `backend-manager.mjs`, `server.mjs`) are unaffected.
**Tests:** In `supervisor-busy-probe.test.mjs`: three runs on one environment read "3 runs in flight", dropping to "2" then "No runs in flight" as they settle; one run on each of two environments reads "2 runs in flight"; no live run reads "No runs in flight". Pre-fix these fail with `service.liveRunCount is not a function`.
**Review:** Failed round 1 on WIDGET-6 only; the reviewer confirmed the fix, that `liveRunCount()` reads the same index `activeRuns()` does and `finish()` untracks before any later read, and that a service lacking the method degrades inside `resolveSnapshot`'s try/catch rather than throwing out of a push.
**Residual:**
- `liveRunCount()` counts tracked run ids rather than summing `activeRuns()` per environment; they agree only because `finish()` untracks and nothing else deletes from `liveRuns`. The code states that invariant rather than re-deriving it.
- `server.mjs` calls the method directly with no `typeof` guard, so a non-`CliEnvironmentService` in-process service has no answer; it is constructed at `server.mjs:664` and the call sits inside the try/catch.

### R2-NW-V1
**Status:** Not fixed (product decision)
The pushed widget `approvalsPending` is the host-global count while the app's own widget write counts per gateway. The Gate cannot scope to what this phone started; the push-merge package keeps using the pushed number.

### R2-NW-V2
**Status:** Fixed (commit 0280cf2)
**Diagnosis:** CONFIRMED. `void writeWidgetSnapshot(snapshot)` in the `gateway-provider.tsx` write effect was fire-and-forget and each call independently awaited the dynamic `import()` in `loadAndroidWidgetModule` and the native `setPayload`, with no queue, generation counter or cancellation - two fact changes inside one import window were two overlapping native hops with no order between them, and the audit notes completion order is non-guaranteed rather than provably reversed. Independent of R2-WIDGET-1.
**Fix:**
- `widget-device.ts`: every write goes through one promise queue (`enqueueWidgetJob` / `pumpWidgetJobs`) with LATEST-WINS coalescing - while a write is in flight only the newest further snapshot is kept, and an older pending one is resolved `false` (superseded) without being written.
- A `clear` job is never coalesced away: dropping it would leave the card it was called to retire on the home screen.
- `pumpWidgetJobs` treats a throw as `false` and a `finally` releases the pump, so a rejection cannot wedge the queue.
- `writeWidgetSnapshot` and `clearWidgetSnapshot` are now thin `Promise<boolean>` / `Promise<void>` wrappers over that queue.
**Tests:** `__tests__/widget-device-write-test.ts`: "two writes inside one import window reach the card in call order" (the older write is parked inside `setPayload`; `seen` is `[NOW, NOW+1000]` with peak concurrency 1, which pre-fix code cannot produce) and "a snapshot superseded before it starts is refused without being written" (the middle snapshot resolves `false`; the card only sees `NOW` and `NOW+2000`).
**Review:** passed review first time
**Residual:** none

### R2-NW-V3
**Status:** Fixed (commit 4f9d1cf)
**Diagnosis:** CONFIRMED. The audit's reading holds: the only `WidgetRefreshPolicy.enqueue(context)` call sat in `VersutusWidgetModule.setPayload` after both refusal guards, and no other file enqueues it, so a refused first write left the six-hourly redraw unscheduled. The author corrected where the code lives — `WidgetRefreshPolicy` is not its own file but the object at the bottom of `WidgetRefreshWorker.kt`, which needed no change. Also confirmed by reading: `enqueue` is idempotent (`enqueueUniquePeriodicWork` with one name + `ExistingPeriodicWorkPolicy.KEEP`), so scheduling unconditionally is safe, and an empty store draws the honest "Open Versutus to connect" card without throwing.
**Fix:** `VersutusWidgetModule.kt` only.
- New top-level `internal fun storePayloadIfDrawable(json, scheduleRefresh, write)` calls `scheduleRefresh()` first, then parses, and writes only on `WidgetPayload.Parsed.Ok`; free of Android/Expo types so the ordering is JVM-testable.
- `setPayload` calls it with `WidgetRefreshPolicy.enqueue(context)` as the schedule and `WidgetPayloadStore.write(context, json)` as the write, so a refused payload now schedules the redraw and still answers `false` without touching the stored payload.
- Accepted writes behave exactly as before: store, `updateAll` via `scope.launch`, answer `true`. `clearPayload` untouched.
- Verified by reading that the worker's redraw tolerates "nothing stored yet": `WidgetPayloadStore.read` returns null → `parse` gives `Parsed.Invalid` → the card draws the connect prompt and `stamp`/`stale` degrade to `""`/`false`.
**Tests:** New `VersutusWidgetModuleTest.kt` (4 pure JUnit4 tests) records call order: an accepted payload yields `["schedule", "write <json>"]`; a refused one yields `["schedule"]` with no store (the regression test — it fails against the old code); a `NeedsUpdate` payload is refused yet still schedules; two calls produce exactly two schedules and one write. Extended `WidgetRefreshPolicyTest.kt` with a case that repeated `uniqueName()` collapses to one distinct name; the two existing assertions are unchanged.
**Review:** passed review first time
**Residual:**
- Kotlin was never compiled or run here (no Android toolchain); the new code is verified by reading only. `tsc --noEmit` and the three Jest suites (contract 21, widget-push/widget-target 42) pass; Gradle was not run.
- `__tests__/versutus-widget-module-contract-test.ts:139-146` is now a stale proxy: it reads the `.kt` as text and asserts the enqueue literal appears after the store literal. That still holds (the named arguments are ordered `write` then `scheduleRefresh`), but the runtime order is now the opposite — the assertion no longer describes the behaviour. Left alone: the file is outside the package's allowed set.
- The no-`reactContext` case remains the one gap (nothing to enqueue or store); documented in a comment at `VersutusWidgetModule.kt:37-38`. `clearPayload` still does not enqueue.

### R2-NOTIF-01
**Status:** Fixed in part (commit 2ff377e) — the reply side is fixed; the approval half of the audit finding was re-scoped by the verifier and is deliberately not implemented (see Diagnosis).
**Diagnosis:** Partly confirmed, re-scoped. The audit's approval framing (a relayed approval shows no Approve/Deny) is downgraded by the verifier and the author agrees: only a run this app initiated can be approved, and only while connected (`src/lib/notifications/approval-action.ts:48-53`), so a relayed approval's buttons would land on the fail-closed branch — no category was added there. The confirmed mechanism: `gate/core/push-notifier.mjs`'s `messageFor()` built every notice from `{to,title,body,data,channelId,sound[,priority]}`, with no `categoryId` anywhere in `gate/`; Android attaches an action row only when the content carries a category, and for a push that comes from the FCM data key `categoryId`.
**Fix:**
- `push-notifier.mjs`: added `BOT_MESSAGE_CATEGORY_ID = 'botmessage'` as a module constant (the phone's value is TS, not importable), with a comment naming `src/lib/notifications/categories.ts` and the Expo `Message request format` row that documents the field.
- Same file, the `kind: 'reply'` branch of `messageFor()`: `categoryId` set only when `classified.data.botId` is non-empty — the review found the unconditional version put a live Reply button on a bot-less reply, whose tap sends nothing (`botReplyFromResponse` needs `botId`+`sessionId`). This narrows the brief, and the notes say so.
- Run, approval and routine builders untouched (no category); `push-rpc.mjs`'s test notice is `kind: 'test'`, not reply-shaped, so it stays plain. `push-send.mjs` POSTs each message verbatim, so the field reaches Expo unfiltered.
**Tests:** New `gate/__tests__/push-notifier-category.test.mjs` (8 tests): the Gate's string is read out of `src/lib/notifications/categories.ts` so the duplicated constant cannot drift; a Bot-named reply carries `categoryId === 'botmessage'` with `data` unchanged; a whole-message deep-equal; a bot-less reply carries none; four tests pin that run/approval/routine (including a cron reply that classifies to `routine`) carry none. Against the pre-package notifier the two push/widget files ran 12 tests, 6 failing; against the first attempt 11 pass / 1 fail (the new bot-less test). `gate/__tests__/backend-routes.test.mjs`'s end-to-end line was changed to the honest expectation: that test's turn names no Bot, so it now asserts `'categoryId' in batch[0] === false`.
**Review:** Failed round 1. The blocking complaint (the companion disables the widget, see R2-WIDGET-6) was not a code defect and was settled by the harness owner. The review's secondary item — a dead Reply button on a bot-less reply — was fixed with the `botId` condition, its new test, and the changed `backend-routes.test.mjs` line; the review's "the tests assert the absence of a required key" point was half acted on: the key assertion stays (owner decision), and a "no connection *word*" guard was added in both test files. The reviewer cleared NOTIF-01's mechanism end to end, confirming `categoryId` in the installed `expo-notifications` package and `BOT_MESSAGE_CATEGORY_ID = 'botmessage'` in `categories.ts:68`.
**Residual:**
- Not run on a device or APK: Android runtime behaviour of the new field (category/channel matching after a Gate restart) rests on the installed package source and the Expo docs.
- A reply that names no Bot gets no Reply button; if such a turn ever should be answerable, the fix is to name the Bot, not to widen the category.

### R2-NOTIF-02
**Status:** Fixed (commit 94407e4)
**Diagnosis:** CONFIRMED. The seed effect in `notifications-section.tsx` depended on the identity of `prefs.quietHours`, and `normalize()` in `use-notification-preferences.ts` builds a fresh `quietHours` on every read and every write, so any other preference write on that card re-seeded the From/To text and the typed window was gone before "Save quiet hours" could send it.
**Fix:**
- `notifications-section.tsx` derives `storedStart`/`storedEnd` from `formatMinutes(...)`, and the seed effect now depends on `[quietDirty, storedStart, storedEnd]` instead of the row identity.
- New `quietDirty` state, set by both `onChangeText` handlers; the seed effect returns early while it is set, so a stored window arriving from anywhere cannot land on the typing.
- `setPatch` now answers `Promise<boolean>`; `saveQuietHours` clears `quietDirty` only on `saved`, so a refused save keeps the draft and the card's Retry re-read does not overwrite it.
**Tests:** new `__tests__/notifications-section-state-test.tsx` - types 23:30, flips the widget switch (its reply is a fresh row), the field still reads 23:30 and Save sends `quietHours {startMinutes: 1410}`; a save the Gate took hands the fields back (a later server-side change re-seeds 21:00); a refused save keeps the typed window. All three fail on the pre-fix section and hook (16 of the 17 new tests fail pre-fix, verified by restoring both files from HEAD).
**Review:** the harness gate failed the first attempt - `quietDirty`/`setQuietDirty` were used but never declared and `setPatch(...).then(...)` was called on a `void` return (tsc TS2304/TS1345); this pass declares the state and makes `setPatch` answer `Promise<boolean>`.
**Residual:** none.

### R2-NOTIF-03
**Status:** Fixed (commit afc3b82)
**Diagnosis:** CONFIRMED, and the audit's own correction is adopted: S3, not S2. `routine-sync.ts` kept a private `permissionGranted` flag and an `ensurePermission()` that called `Notifications.requestPermissionsAsync()` (rather than reading), and `rearmRoutineNotifications` fanned out with `Promise.all` over every unpaused job, so N requests were issued in one tick. The audit's "routines whose cron is beyond the two repeating shapes never get scheduled" sentence is withdrawn (`routine-schedule.ts`).
**Fix:**
- Deleted the private gate; `routine-sync.ts` now calls the shared `ensureNotificationPermission()` exported from `local.ts`.
- `local.ts` `ensureNotificationPermission()` splits into `readPermission()`, keeping read-first: grant cached, denial remembered for `PERMISSION_DENIAL_TTL_MS`, dialog asked only from undetermined while foregrounded.
- Added `permissionCheckInFlight`, published before the first `await` and cleared in a `finally`, so N callers in one tick produce at most one native read and one request.
**Tests:** new `__tests__/routine-rearm-atomicity-test.ts` - three routines re-armed at once with the app pocketed ask zero times; foregrounded, one request and three schedules; a remembered refusal makes the next full `rearmRoutineNotifications` neither read nor ask. `notification-permission-test.ts` gained "three callers folded in the same tick share ONE evaluation of the gate". All fail on pre-fix `routine-sync.ts` / `local.ts` (13 failures across the three routine suites, verified by restoring each file from HEAD).
**Review:** failed the harness gate first time; see NOTIF-11 (the throttle's module state leaked between cases in the run-progress suite) and V-2 (a pinned assertion that asserted the defect). The permission-gate work itself was not sent back.
**Residual:**
- The in-flight promise is per module instance, so it does not survive `jest.resetModules()`; the two new suites re-establish the module per case.

### R2-NOTIF-04
**Status:** Fixed (commit afc3b82)
**Diagnosis:** CONFIRMED. `syncRoutineNotification` ran schedule -> `cancelKnownNotice` (read id, cancel, delete key) -> `setItem(new id)` with no lock, so the provider's 1.5 s connected re-arm and the Bot Chat read in `chat-screen.tsx` each scheduled, each retired the old id and each wrote a new one, orphaning one notice in the OS queue per collision.
**Fix:**
- `routine-sync.ts` `serialiseSync(jobId, work)` holds a promise tail per job id; the tail settles either way (`run.then(noop, noop)`) and its map entry is deleted when it is the current tail, so a throwing scheduler cannot poison the chain. `syncRoutineNotification` is now a thin wrapper running `armRoutineNotice` behind that chain.
- Inside `armRoutineNotice` the order is read old id -> schedule -> `setItem` -> cancel the old id (`cancelNotice`), so a crash between the last two steps leaves one extra notice, never none.
- New `reconcileRoutineNotices(liveJobIds)` reads `getAllScheduledNotificationsAsync()`, identifies routine notices by the `kind`/`jobId` payload `routineNoticeData` stamps (`routineNoticeJobId`), and cancels any that is not the persisted id of a named job. `rearmRoutineNotifications` calls it once at the end.
- `cancelKnownNotice` was split into `readKnownNotice` + `cancelNotice` so the id can be read before the mapping is overwritten.
**Tests:** new `__tests__/routine-rearm-atomicity-test.ts` uses a notifications fake that answers a macrotask later and keeps the phone's queue as a map: two overlapping re-arms leave the phone holding exactly one notice; the second waits for the first (`schedule, schedule, cancel`); a failed arm leaves the held notice untouched; four reconcile cases (orphan retired, live kept, another Bot's notice untouched, unreadable queue retires nothing). `routine-notice-rearm-test.ts` re-points its source-shape test at `armRoutineNotice` (the serialisation lives in the exported wrapper) and pins the record-before-retire order.
**Review:** passed review first time; the serialisation, the reorder and the reconcile were not sent back.
**Residual:**
- A paused job still goes through `cancelRoutineNotification` on the unserialised path - a pause removes rather than adds.
- An unreadable OS queue makes the reconcile a silent no-op (best-effort, documented in the code).

### R2-NOTIF-05
**Status:** Fixed (commit afc3b82)
**Diagnosis:** CONFIRMED. Retirement went only through `runProgressNoticeIdsRef` in `gateway-provider.tsx`, an in-process `Set` that starts empty, so a `run-progress:<runId>` notice posted by a process Android then killed was never named; the restored row reconciled to complete and `present()` refuses while foregrounded, so the tray kept claiming a finished run was running. Only `dismissGatewayDown` ever scanned the tray.
**Fix:**
- New `dismissStaleRunProgress(liveRunIds)` in `local.ts` reads `Notifications.getPresentedNotificationsAsync()`, maps each expo `Notification` to its `.request`, and dismisses every request whose identifier starts with `RUN_PROGRESS_NOTICE_PREFIX` and is not a live run's identifier. Android only, whole body in a `try`.
- `run-progress.ts` exports `RUN_PROGRESS_NOTICE_PREFIX` (used by `runProgressNoticeIdentifier`) and `inFlightRunIds(runs)`, which reuses the same `IN_FLIGHT_RUN_STATUSES` pair the fold uses, so the sweep cannot disagree with the poster.
- `gateway-provider.tsx` calls the sweep at three sites: mount after `setActivityRuns(restoredRuns)`, the connect-time settle of restored unresolved runs, and the shared reconcile used by the reconnect and foreground paths.
**Tests:** new `dismissStaleRunProgress` suite in `__tests__/notifications-run-progress-test.ts` - a notice for a run no longer running is dismissed, a live run's notice is kept while unrelated gateway-down and approval notices are untouched, an unreadable tray dismisses nothing and does not throw, iOS and web sweep nothing. A source-shape test pins the three call sites and their arguments. Both fail on the pre-fix `local.ts`/`run-progress.ts` and the pre-fix provider.
**Review:** passed review first time; the three call sites and the prefix-based identification were not challenged.
**Residual:**
- Android-only, matching the poster; iOS has no run-progress tray notice in this slice.
- A point-in-time sweep, not a subscription: a run that dies without being reconciled is retired at the next mount, connect or reconcile.

### R2-NOTIF-06
**Status:** Not fixed (design needed)
Approve/Deny on a posted approval notice is dropped when Android killed the process before the tap, because expo-notifications only runs the JS response listener in a live runtime. A fix needs a headless TaskManager handler that can decide an approval fail-closed with no UI - a design of its own. It is masked for pushed approvals by the (re-scoped) NOTIF-01, since those carry no buttons.

### R2-NOTIF-07
**Status:** Fixed (commit afc3b82)
**Diagnosis:** CONFIRMED. `obtainGrantedExpoPushToken` awaited `secureKeyValueStorage.setItem(STORE_KEY, token)` inside the same `try` whose `catch` returned `null`, so a Keystore hiccup (the store retries once, then throws) read as "no token", `registerWithGate` never ran, and push stayed off for the session with nothing logged.
**Fix:**
- `push-registration.ts` splits the persist out into `persistExpoPushToken(token)`, which does its own read-compare-write and `console.warn`s on failure.
- `obtainGrantedExpoPushToken` returns the token whether or not the write landed; only a failure to obtain it returns `null`, so `runPushRegistration` still reaches `registerWithGate`.
**Tests:** new file `__tests__/push-registration-once-test.ts` - "a token whose cache write failed is still handed to the Gate": `setItem` rejects, yet `notifications.register` is called once with `expoPushToken: 'ExponentPushToken[new]'`. Fails on the pre-fix module (verified).
**Review:** passed review first time.
**Residual:**
- A failed write loses the rotation notice for that process; the next successful write puts it right, and the warning says so.

### R2-NOTIF-08
**Status:** Fixed (commit afc3b82)
**Diagnosis:** CONFIRMED on both halves. (a) `gateway-provider.tsx` called `void syncPushRegistration(client)` on every `connected` for a custom gateway, outside the `noteConnectedFanOut` silent-recovery guard. (b) `syncPushRegistration` had no unchanged-token short-circuit, so each flap re-ran `registerWidgetPushTask`, `getPermissionsAsync`, `getExpoPushTokenAsync` and an authenticated `notifications.register`.
**Fix:**
- `gateway-provider.tsx` now reads `connectedFanOutDueRef.current` right after `noteConnectedFanOut` and registers only when the fan-out is genuinely due, so a monitor-earned `connected` registers nothing.
- `push-registration.ts` splits into `syncPushRegistration` (dedupe via `registrationInFlight`, so overlapping connects share one pass) and `runPushRegistration` (the work).
- `widgetPushTaskReady` asks Android for the widget push task once per process; a refusal is not remembered, so the next connect retries.
- `registrationIsFresh()` short-circuits the whole sequence while a registration this process completed is under `REGISTRATION_FRESH_MS` (6 h) AND the stored token still equals it; `lastRegistration` is written only after `registerWithGate` resolves, and `deregisterWithGate` clears it before its RPC, so a refused register is retried and a gateway change always re-registers. Rotation needs no separate hook: the stored token is the last registered token.
**Tests:** new `push-registration-once-test.ts` (failed-write case plus not repeated on the next connect, widget task asked once, written down again after 6 h on fake timers, registers again on rotation, registers again for a gateway just left, retried after a refused register, one pass for two overlapping connects, web registers nothing). `gateway-provider-connected-reads-test.tsx` gained "the monitor's own recovery registers nothing again" and "a real reconnect of a new client registers again". `push-registration-test.ts` CHANGED ASSERTION: "an unchanged token is registered without a redundant write" expected the RPC on the unchanged token - the defect itself - and is now "an unchanged token is neither rewritten nor re-registered".
**Review:** passed review first time; the changed assertion is the only existing assertion this package touched here.
**Residual:**
- The 6 h window is module state, so a fresh process always registers once on its first connect (intended).
- `registrationIsFresh` also compares the stored token, so a `setItem` that keeps failing makes every connect register rather than skip - the NOTIF-07 trade-off in the safe direction.

### R2-NOTIF-09
**Status:** Fixed (commit 94407e4)
**Diagnosis:** CONFIRMED. `permission` was seeded by a mount-only effect with `[]` deps and nothing else read the phone, and this screen is a Stack child, so a trip to Android Settings and back does not remount it: after a revoke the card still showed the relay toggle on, no denial caption, and every write still succeeded.
**Fix:**
- New `readPermission` callback in `use-notification-preferences.ts` calls `Notifications.getPermissionsAsync()` - a read, never the request, so no system dialog is spent off the operator's tap.
- It is called from the mount/foreground effect, from `flush` after every write that lands, and by `setEnabled` before it decides whether to ask.
- The effect subscribes to `AppState` `'change'` and re-reads on `'active'`, unsubscribes on unmount; `liveRef` and `readSeqRef` drop an answer that arrives after a newer read or after the screen is gone.
**Tests:** new `__tests__/notification-preferences-permission-test.tsx` - a DENIED read on the second foreground flips `permission`; a stale GRANTED answer to an older read is ignored; after unmount the AppState listener asks nothing and the in-flight read sets nothing (the file wraps `useState` to observe every setter). `notification-preferences-writes-test.tsx` counts exactly two reads, mount + write. Section-level `notifications-section-state-test.tsx` "a revoke in OS Settings is what the card then says" flips the caption on a foreground. All fail pre-fix.
**Review:** the previous session was killed with the hook work (this finding included) never written - the harness guard only saw the half-landed section edit; the permission read, the AppState effect and the re-read after a write are new here and were not sent back.
**Residual:**
- The read rides the foreground edge, mount and a landing write; an in-app tab return that never leaves `AppState` `active` triggers no read.

### R2-NOTIF-10
**Status:** Fixed in part (commit 94407e4) - optimistic, one-at-a-time ordered writes and a counted `saving`; `load()`'s own `preferences.get` reply still paints unconditionally, and the withdrawn two-Bot-switch scenario was not addressed because the verifier withdrew it as unreachable.
**Diagnosis:** CONFIRMED on the corrected symptoms, with the audit's own correction adopted: S4, not S3, and the "two Bot-filter switches drop an allowlist update" scenario is WITHDRAWN (`disabled={saving || !synced}` blocks the second tap). Live as described: `setPatch` painted nothing until the reply (up to the 30 s timeout at `http-transport.ts:6`), each call did `setPrefs(normalize(raw))` from whatever row its own reply returned, `saving` was cleared by the first caller to finish, and `load` (deps `[connected, gatewayRequest]`) can repaint the card with a pre-write row.
**Fix:**
- `setPatch` applies the patch to local `prefs` at once and returns `Promise<boolean>`.
- Writes go onto `queueRef`; `flush` keeps exactly one `notifications.preferences.set` in the air and coalesces everything queued behind it into the next write (the Gate merges each patch onto its own row, so this is lossless).
- `flush` keeps `confirmedRef` - the last row the Gate itself confirmed - and paints a reply only when its `seq === seqRef.current`, so an older row never repaints over a newer tap; a refusal rolls back to `confirmedRef`, not to a stale reply.
- `beginSave`/`endSave` count writes through `saveCountRef`, so `saving` stays true while any write is queued or in flight.
**Tests:** new `__tests__/notification-preferences-writes-test.tsx` (deferred-reply fake gateway) - the row moves inside `act` before the Gate answers; two flips produce two ordered writes with only one in the air, and the first reply claiming `richBody: true` does not repaint, `saving` still true after it lands; a refused write rolls back to `confirmedRef`, sets `synced` false, and `reload()` restores `synced`/`error`. Fails on pre-fix (part of the 16 pre-fix failures).
**Review:** the interrupted attempt had no hook work at all, so this was never reviewed before; it is new in this pass and was not sent back.
**Residual:**
- Coalescing merges queued patches key-by-key, so two taps on the same key inside one window collapse to the last value - the row the Gate would have ended with anyway.
- `load()` still does an unconditional `setPrefs(row)`, so a `preferences.get` already in flight when a write starts can still repaint the card with the pre-write row; `newest()` guards only `notifications.preferences.set` replies.

### R2-NOTIF-11
**Status:** Fixed in part (commit afc3b82) - the tray post is throttled; the Live Activity update in the same effect is not
**Diagnosis:** CONFIRMED. `gateway-provider.tsx` calls `notifyRunProgress` on every pass of the run-rows effect, which `patchActivityRuns` re-runs per event, so a long run asked the phone to draw, rebuild and notify once per event. The audit's point that the re-post is idempotent in the tray (cost, not duplication) is what the brief scoped the fix to.
**Fix:**
- The throttle lives on the poster in `local.ts`, not at the call site, so every caller meets it: `RUN_PROGRESS_THROTTLE_MS = 5_000` and `throttleRunProgress`, which draws immediately outside the window and otherwise holds the newest state for the open window's one-shot timer, trailing.
- The map is keyed by notice identifier, so two in-flight runs are throttled apart and the first post of a run is never delayed. Terminal notices (`notifyRunComplete`) never pass through here.
- `dismissRunProgress` clears the window with the notice, so a run settling mid-window is not handed one last update. New `clearRunProgressThrottles()` is called by the provider on unmount (mount/unmount-only effect); `resetRunProgressThrottleForTests` is kept as an alias.
- `syncRunActivities` in the same effect was read and deliberately left alone: it is edge-driven per held run in `run-activity-device.ts`, and splitting it would change the Lock Screen's state machine.
**Tests:** new fake-timer suite in `notifications-run-progress-test.ts`: 20 events in 2 s reach the phone once inside the window and twice with it opened; the trailing post carries the newest state; two runs are throttled apart; a settled run is retired at once and its held post never fires; a source assertion pins the window to the poster, not the effect; a window open at unmount never fires. CHANGED: the pre-existing "an update re-posts the run's own identifier" case now uses fake timers and steps over the window so it still exercises replace-in-place. 21 failures in the suite on the pre-fix `local.ts`.
**Review:** failed the harness gate first time - 3 suites, 6 tests. `notifications-run-progress-test.ts` threw `Cannot read properties of undefined (reading '0')` on `mockSchedule.mock.calls[0]` in three pre-existing cases because the new window swallowed a post the case expected. Repair: `resetRunProgressThrottleForTests()` in each suite's `beforeEach`, `jest.useRealTimers()` in `afterEach`, and fake timers on the re-post case so it steps over the window. The notes also record a second correction from that round: the throttle's timers were cleared on run end but not on provider unmount, which the brief requires.
**Residual:**
- The Live Activity update is still per-event; a coalesced tray line can sit up to 5 s behind the Lock Screen until the trailing post closes the gap.

### R2-NN-V1
**Status:** Fixed in part (commit 2ff377e) — the Gate/relay producer now sets the category (this part); the local-notice producer half is out of this package's allowed files and remains open.
**Diagnosis:** CONFIRMED, and it is NOTIF-01 read from the phone side. `src/lib/notifications/categories.ts:68` defines `BOT_MESSAGE_CATEGORY_ID = 'botmessage'`, the action with `textInput` is defined at `:77-95` and registered at `:109`, yet the only `categoryIdentifier` producer anywhere was the local poster (`local.ts:161`, `APPROVAL_CATEGORY_ID`). So `botReplyFromResponse`, `src/app/_layout.tsx:345-355`, and `deliverBotReply` could never fire — even for notices posted locally, not only relayed ones.
**Fix:** The one field added in `messageFor()`'s reply branch of `push-notifier.mjs` (with its `botId` condition) is the whole Gate-side fix. No phone file is in the allowed set and none was needed here, since the relay payload already satisfied `{botId, sessionId}`.
**Tests:** The V-1-specific test is `the category the Gate sends is the one the phone registers`, which reads the phone's `BOT_MESSAGE_CATEGORY_ID` out of `categories.ts` and asserts the Gate's constant equals it — the only assertion that can keep the two ends in agreement. The payload tests are NOTIF-01's, as above.
**Review:** Failed round 1 on WIDGET-6 only; the reviewer listed NOTIF-01/V-1's mechanism as verified correct end to end, with no action.
**Residual:**
- A future *local* bot-message notice is still button-less (`local.ts` is not in this package's allowed files); the category is wired only on the relay path.
- No device verification, as for NOTIF-01.

### R2-NN-V2
**Status:** Fixed (commit afc3b82)
**Diagnosis:** CONFIRMED. `notifyBotReplyNotSent` and `notifySessionOpenFailed` both went through `present(title, body)` with no `allowForeground`, and the refusal for `AppState.currentState === 'active'` is unconditional. The Reply action that reaches the first foregrounds the app to open the Bot Chat, and the tap that reaches the second is the tap that foregrounded it, so the two fail-closed notices could never be seen.
**Fix:**
- Both now pass `allowForeground: true` in `local.ts` (`notifyBotReplyNotSent`, `notifySessionOpenFailed`); `present()` already had the parameter, so no signature change.
- No other notice changed: `notifyRunComplete` still passes `undefined` and is still suppressed while foregrounded.
**Tests:** `__tests__/bot-reply-route-test.ts` CHANGED ASSERTION: "a follow-up posted while the app is foregrounded is suppressed, like every local notice" asserted the defect and is now "both follow-ups are drawn for the tap that foregrounded the app" (two schedules, correct titles), with a new case "an ordinary notice is still suppressed while the app is foregrounded" (`notifyRunComplete` draws nothing) so the shipped rule stays pinned. A new `notifySessionOpenFailed` suite covers the backgrounded and foregrounded shapes. Both foreground cases fail on the pre-fix `local.ts`.
**Review:** the gate caught the suite still asserting the old suppression - the repair was the changed assertion above plus the new case pinning the rule that must stay.
**Residual:** none.

### R2-NN-V3
**Status:** Fixed (commit 94407e4)
**Diagnosis:** CONFIRMED. `permission` was `result.granted ? 'granted' : 'denied'`, so expo's `undetermined` - what Android 13+ and every first iOS launch answer when nobody has been asked - printed "The OS currently reports notifications as denied" two lines under "Permission is asked here", and `setEnabled` reported "Notifications are off for Versutus in the system settings" for a permission never asked. Checked against expo-notifications 57: `getPermissionsAsync()` answers `{status, granted, canAskAgain}`; there is no fourth status, `unknown` being the app's own word for a phone that could not answer.
**Fix:**
- New exported `NotificationPermission = 'unknown' | 'granted' | 'denied' | 'undetermined'` and `permissionFrom()`, which maps `undetermined` with `canAskAgain === false` to `denied` (the same final refusal, the rule `local.ts` `readPermission` already uses) and anything unrecognised to `unknown`.
- The section's caption was already gated on `permission === 'denied'`, so `undetermined` and `unknown` print nothing and no section edit was needed.
- `setEnabled` reads the phone first: `denied` reports "off in the system settings" without asking again, `granted` goes straight to the write, and only the undetermined/unknown case spends the dialog.
**Tests:** new `notification-preferences-permission-test.tsx` - a phone nobody has asked is `'undetermined'`; a refused phone is asked for nothing and `prefs.enabled` stays false; an unasked phone is asked exactly once by the toggle, the write carries `{enabled: true, deviceId}`, no error; a rejecting read is `'unknown'`. `notifications-section-state-test.tsx` - a fresh install still says "Permission is asked here" and no longer prints the denial line. All fail pre-fix except the `unknown` case, which the old `catch` already got right.
**Review:** the interrupted attempt's hook work was absent, so there was no earlier review of it; new in this pass and not sent back.
**Residual:** none.

### R2-NN-V4
**Status:** Fixed (commit 94407e4)
**Diagnosis:** CONFIRMED. A failed write set `error` and left `synced` at its previous `true` (set only on a successful read in `load` and a successful write), so every switch, gated on `disabled={saving || !synced}`, stayed live while the error card directly above them promised they "stay locked until the Gate's own settings are read" - and the operator's next tap re-issued the same failing write.
**Fix:**
- `flush`'s catch in `use-notification-preferences.ts` now calls `setSynced(false)`, exactly the state a failed initial read leaves, so the switches lock.
- The rollback goes to `confirmedRef` (the last row the Gate confirmed), not to whatever the card last painted, so a refused write cannot leave a half-applied row on screen.
- `load` still sets `synced` true on a successful re-read, which is what the card's Retry calls; the error card's copy is unchanged because it is now true.
**Tests:** `notification-preferences-writes-test.tsx` "a refused write rolls back to the row the Gate confirmed and locks the card" - `synced === false` after the refusal, then `reload()` gives `synced === true`, `error === null` and the Gate's row. `notifications-section-state-test.tsx` "a refused write locks the switches the error card says are locked" - `disabled` on the rich-body, widget and relay switches, then Retry unlocks them and clears the card. Both fail on pre-fix.
**Review:** the interrupted attempt had no hook work, so this was never reviewed before; it landed with NOTIF-10's `flush` and was not sent back.
**Residual:** none.

### R2-ACT-1
**Status:** Fixed (commit bc44045)
**Diagnosis:** CONFIRMED, at the audit's post-verification S3 severity. `submitTogglePause` (`src/components/activity/cron-job-sheet.tsx:115`) reads `paused` from state *before* the toggle, calls `botJobs.pause(jobId, !paused)`, then branched on that same pre-toggle value (`if (!paused) syncRoutineNotification(...) else cancelRoutineNotification(jobId)`), and the object passed carried no `paused` field, so `routine-sync.ts`'s own pause branch was unreachable and the call fell through to the schedule path. The author CONFIRMED the audit's correction that only a Bot-owned routine shows a wrong notice (it needs the `[bot:<id>]` prefix `parseRoutineName` looks for); for a gateway-level job the sync hit the `!botId` withhold branch. Bot Chat's own pane (`chat-screen.tsx`) was already right.
**Fix:**
- `cron-job-sheet.tsx` `submitTogglePause` branches on the pre-toggle `paused` with the two arms swapped: a resume (`paused === true`) calls `syncRoutineNotification({ id, name, schedule, nextRunAt, paused: false })` and a pause calls `cancelRoutineNotification(jobId)`.
- The `paused: false` field is what makes the sync take the schedule path in `routine-sync.ts` instead of its retire path.
- Both calls stay fire-and-forget (`void`); the RPC argument (`!paused`), `setPausedOverride(!paused)` and the branch comment are otherwise unchanged, so the label only moves on a confirmed call.
**Tests:** new `__tests__/cron-job-sheet-pause-notice-test.tsx` renders the sheet with a `[bot:scout]`-prefixed job and mocked `botJobs`/routine-sync: Pause calls `cancelRoutineNotification('job-1')` and never syncs; Resume syncs exactly `{ id, name, schedule, nextRunAt, paused: false }` and never cancels; a refused pause changes no notice at all. Red pre-fix 2 of 3 (the refusal case passed). No existing assertion pinned the inverted branches - `cron-job-sheet-controls-test.ts` still asserts `botJobs.pause(jobId, !paused)` and `setPausedOverride(!paused)` and is unchanged and green.
**Review:** passed review first time (no review feedback file); the only round-2 repair was a harness lint rejection - two `eslint-disable-next-line no-require-imports` lines in the new tests replaced by `jest.requireActual('react')` inside the `jest.mock('expo-router')` factory, no behaviour change.
**Residual:**
- none - a gateway-level (Bot-less) job's sync still withholds by design; that is `routine-sync`'s honesty rule, not this call site's business.

### R2-ACT-2
**Status:** Fixed (commit e82654f)
**Diagnosis:** CONFIRMED. `normalizeRestoredRuns` (`src/lib/gateway/session-persistence.ts:216`) stamped `finishedAt: run.finishedAt ?? Date.now()` on every restored in-flight run - the load time - while `local-` provisionals did genuinely end. `buildHomeBriefing` (`briefing.ts:76`) read that stamp as settled news and `terminalFate` folded `cancelled` into `failed`; `glanceFigures` counted only `status === 'running'`, so Activity and Home disagreed about one run. The author CORRECTED the brief: `settleUnresolvedRuns` is not the only writer - `gateway-provider.tsx:3536-3540` also patches `status` and `finishedAt` together and was not editable, so the rule keys off the presence of a finish, not the status.
**Fix:**
- `session-persistence.ts` `normalizeRestoredRuns` branches first on `isLocalProvisionalRunId`: a `local-` row restores `cancelled` with `finishedAt: run.finishedAt ?? Date.now()` (kept), every other restored `running`/`waiting-approval` row restores `unresolved` with the "Interrupted when the app closed" summary and whatever finish it already had - none invented. Doc comment rewritten: a load time is not an end.
- `briefing.ts` new `isUnwatchedStillGoing` (`unresolved`, no numeric `finishedAt`) joins `LIVE_RUN_STATUSES` in `carriedOver`, so such a run reports "1 run still going" instead of failed news.
- `glance.ts` new `inFlightAfterRestore` (same shape) OR-ed into the `working` count and the `dayRibbon` bead state, so Activity draws the run live.
- Consumers audited and unchanged because already safe: `activity/run-card.tsx` `watchedRunSpanMs` returns null for `unresolved`, `fleet/scorecard.ts:239` guards `typeof`, `widget/snapshot.ts:177` uses `run.finishedAt ?? run.startedAt`, `runs.ts` `settleUnresolvedRuns` sets a finish only on a learned fate; persistence and glance ordering use `startedAt`/insertion order, so no NaN and no reordering.
**Tests:** `__tests__/home-briefing-test.ts` 4 new cases (restored row is `live` with "1 run still going"; a `local-` provisional still reads as ended; live before `settleUnresolvedRuns` and ordinary `finished.complete` news after; an `unresolved` row with a real finish stays "1 run ended without a result"). `__tests__/activity-glance-test.ts` 2 new cases (working:1 plus a `working` bead; only the unfinished row counts beside one the settle finished). `__tests__/session-persistence-test.ts:32` *changed* - it pinned the fabrication (`expect.any(Number)`) and now asserts both restored gateway rows carry no `finishedAt`; `:38` extended to keep asserting the `local-` rows do. Pre-fix (sources reverted with the edit tool, no `git stash`): 5 failed / 21 passed, the five failures being the new assertions; the other two new cases are guards that pass both ways.
**Review:** no independent review file for this package; the only feedback is `feedback-SC5-resume.md`, a harness notice that the driving process was killed and the work resumed from the working tree. Nothing was sent back for repair.
**Residual:**
- `src/components/activity/run-card.tsx:60-67` carries a comment whose premise ("the load stamps one at read time") is now wrong; the behaviour it guards is unaffected (`watchedRunSpanMs` returns null for `unresolved`) and the file is outside the allowed list, so it was left alone.
- `src/lib/widget/snapshot.ts:172` still skips `unresolved` rows, so the widget's in-flight count does not include a restored run; it makes no claim about one, and the file is not editable here.
- A restored run whose gateway never returns stays "still going" for as long as it is persisted - the header rule's own trade-off; the settle re-poll is what clears it.

### R2-ACT-3
**Status:** Fixed (commit bc44045)
**Diagnosis:** CONFIRMED (S2). `recordApprovalDecision` (`src/lib/gateway/approval-policy.ts`) was a read-modify-write of one JSON array with no queue - `loadApprovalAudit()` then `keyValueStorage.setItem` - unlike the two sibling writers the repo already serialises (`storage.ts` `enqueueStoreMutation`, `session-persistence.ts`). The author CONFIRMED the audit's mechanism: two rows are decidable at once by design, because the inbox disables a row's buttons only against `approvalBusy === row.approvalId`, so both calls read the same snapshot and one operator answer vanished from the durable audit.
**Fix:**
- `approval-policy.ts` adds one module-level promise chain (`auditWriteTail` + `enqueueAuditWrite`, the `enqueueStoreMutation` pattern), with the tail always settling resolved so a failed write rejects only its own caller and cannot poison the queue.
- The whole read -> append -> write moved inside the queued task, so each decision reads what the previous one wrote; the lenient read inside the task is covered under R2-SH-V1.
- Reads elsewhere stay off the queue deliberately (a load may observe pre-write state, which is acceptable, and staying off the queue avoids delaying the UI's refresh on a write's account).
**Tests:** `__tests__/approval-audit-write-queue-test.ts` (new) over an in-memory `keyValueStorage`: two concurrent `recordApprovalDecision` calls persist both rows (newest first) and `loadApprovalAuditStrict` reads two back; a burst of eight concurrent calls persists eight. Red pre-fix: both cases persisted one row.
**Review:** passed review first time (no review feedback file); round-2 harness lint repair only, as in ACT-1.
**Residual:**
- The queue is per-process and in-memory, so two processes could still interleave (no Gateway-side writer of this key exists); the same limit as the repo's two existing queues.

### R2-ACT-4
**Status:** Fixed in part (commit bc44045) - the N per-row `approvals.pending` re-reads, the N skeleton blanks and the abort-on-first-refusal are gone; the N Gate RPCs are still issued one at a time.
**Diagnosis:** CONFIRMED at the audit's post-verification S3 severity. `decideAll` (`src/components/activity/approval-inbox.tsx:85`) was `for (const id of ids) await decideApproval(id, decision)`, and each `decideApproval` (`gateway-provider.tsx:3390`) did RPC -> audit write -> `await refreshPendingApprovals()`, which set `pendingApprovalsState` to `'loading'` (`refreshPendingApprovals`, `:3376`) - the state the inbox paints as a skeleton - so one tap on 8 rows blanked the list 8 times with no progress, and a refusal at row 5 hit the single `catch`, leaving 6-8 undecided behind one generic card.
**Fix:**
- `gateway-provider.tsx` `refreshPendingApprovals(options?: { silent?: boolean })` skips the `'loading'` flip when silent; `decideApproval(approvalId, decision, options?: { refresh?: boolean })` skips the trailing re-read when `refresh: false`. Defaults are unchanged for every existing caller and the single-row path now refreshes silently. Only these two functions and the context typing were touched.
- `approval-inbox.tsx` `decideAll` decides each row with `{ refresh: false }`, collects failures instead of aborting, drives a `batchProgress` line ("Deciding 3 of 8...") while running, then makes ONE silent `refreshPendingApprovals({ silent: true })` at the end.
- Failures get their own dismissible `ErrorCard`: `cause` = the first refusal's own message, `affected` = "7 decided, 1 failed", `next` says the rows below are still waiting; a clean batch clears any stale notice.
**Tests:** `__tests__/approval-inbox-batch-test.tsx` (new, 7 cases): 8 rows decided against one re-read with every call carrying `{ refresh: false }` and the list never entering `loading`; the progress text; row 5 refusing still decides 6-8 and reports 7/1; two refusals report 6/2 and name the first; a clean batch shows no card; the single-row path takes no options. `__tests__/gateway-provider-connected-reads-test.tsx` (extended) pins that while the post-decision read is outstanding the state stays `ready`, never `loading` - the assertion the old provider fails. One existing *bound* moved: `approval-audit-context-test.ts` slices the provider between the RPC and `await refreshPendingApprovals();`, now `{ silent: true }`; its three assertions are unchanged.
**Review:** passed review first time (no review feedback file); round-2 harness lint repair only.
**Residual:**
- The batch is still serial - one RPC per row - so a batch over many rows still takes N round trips, each bounded by the transport's 30 s ceiling; the brief asked for one refresh, not parallel RPCs.

### R2-ACT-5
**Status:** Fixed (commit e82654f)
**Diagnosis:** CONFIRMED. `HomeBriefingCard`'s focus effect only read the stamp; the write happened only on leaving (`src/app/(tabs)/home.tsx:37-45`, unmount and app background), so while Home stayed focused the window was still the previous leave's and the same lines re-printed on every return. The author ADDED that the card passed no `now` to `buildHomeBriefing`, so the module's "a finish past `now` is a placeholder" rule used a clock that moved under the card. The author CORRECTED the brief: the arrival write cannot be an unconditional stamp at focus time (the card may be showing nothing - no stamp yet, or a gateway switch mid-read), so the write hangs off the successful read.
**Fix:**
- `home-briefing-card.tsx` state is a `VisitWindow` union (`never` | `ok {lastSeenAt, visitStartedAt}` | `error`), so the window cannot move while the card is showing.
- `adopt` (`:52`) on an `ok` read records `visitStartedAt = Date.now()` and only then calls `stampLastSeen(gatewayId, visitStartedAt)` (`:67`) - one write per arrival, after this visit's digest has been read, so the next arrival's window opens here.
- The summary memo passes `visit.visitStartedAt` as `now`. **Chosen option: filter, not relabel** - a run finishing during the visit is excluded from the "While you were away" lines (its `finishedAt` is past `now`) and is reported on the next arrival.
- `home.tsx` untouched: the leave-time writes (unmount, app background) stay as they were. The `cancelled` flag and pending retry timer live in one ref so a focus loss cancels a paint and clears a timer, shared with tap retry.
**Tests:** `__tests__/home-briefing-card-visit-test.tsx` (new, 5 cases) renders the real card over a Map-backed AsyncStorage with a controllable focus edge: arriving stamps the window (`setItem` called exactly once, with the arrival time, while the digest shows "1 run finished"); lines from visit 1 are absent on visit 2 with nothing new finished; a run finishing during the visit never prints "2 runs finished"/"While you were away" and the next arrival does report it. Pre-fix (card reverted with the edit tool): 3 of 5 failed, including the in-visit completion labelled "While you were away"; `a never-stamped gateway still renders nothing` and the neighbouring arrival assertions pass both ways.
**Review:** no independent review file for this package; the only feedback is the harness resume notice (`feedback-SC5-resume.md`) after the driving process was killed. Nothing was sent back for repair.
**Residual:**
- `loadLastSeen` has no caller left in `src/` - the card now uses `readLastSeen` - but it is the wrapper the brief requires, still exercised by `__tests__/home-last-seen-test.ts`, not dead code.
- Only the active gateway is stamped on arrival; the leave-time writes still cover every saved gateway, so a gateway never focused in a session keeps the older, broader window (pre-existing behaviour).

### R2-ACT-6
**Status:** Fixed (commit e82654f)
**Diagnosis:** CONFIRMED. `loadLastSeen` returned `null` for both "never stamped" and "could not be read" (the `catch` returned `null`), `buildHomeBriefing` returned `null` on a null stamp and the card rendered `null` - a rejected AsyncStorage read was pixel-identical to "nothing happened", the claim the module header forbids. The read also ran once per focus with no retry.
**Fix:**
- `src/lib/home/last-seen.ts` new `LastSeenRead` type (`:49`) and `readLastSeen` (`:59`) returning `{state:'never'} | {state:'ok', at} | {state:'error'}`; the `catch` now says `error`. A corrupt or zero value still answers `never` (unknown is not epoch).
- `loadLastSeen` (`:74`) is kept as a thin wrapper over `readLastSeen`, returning `null` for a refused read exactly as before, so existing callers and tests keep their shape.
- `home-briefing-card.tsx` retries a refused read once, silently, after `READ_RETRY_MS = 1000` (`:26`, `:87`); the focus effect re-runs `readWindow` on the next focus, which is the other retry. Still `error` after that renders a one-line `PressableScale`: "Couldn't check what changed while you were away - tap to retry" with an accessibility label, whose `onPress` (`:136`) retries immediately. `never` still renders nothing.
**Tests:** `__tests__/home-last-seen-test.ts` 5 new cases around `readLastSeen`: names the stamp, `never` for a missing key, `never` for a corrupt value, `error` for a rejecting `getItem`, and `loadLastSeen` still answering `null` over that same refusal. `__tests__/home-briefing-card-visit-test.tsx:230` - two rejecting reads, so after the 1 s retry the card shows the retry row and pressing it with a healthy store shows the digest; `:257` a `never` read renders nothing and stamps nothing. Pre-fix (`readLastSeen` removed: `home-last-seen-test.ts` 9 failed / 5 passed; card reverted: the retry-row test failed with an empty render).
**Review:** no independent review file for this package; the only feedback is the harness resume notice (`feedback-SC5-resume.md`). Nothing was sent back for repair.
**Residual:** none.

### R2-ACT-7
**Status:** Fixed (commit bc44045)
**Diagnosis:** CONFIRMED, with the audit's correction: `refreshGateways()` and `readAudit()` are local key-value reads, not Gate traffic, and `refreshCapabilities()` is itself several requests. The real defect was the shape - `Promise.all([refreshCapabilities(), refreshGateways(), refreshPendingApprovals()])` in `onRefresh` (`src/app/(tabs)/activity.tsx`) fanned three entry points at a host the repo documents as serving one request at a time, so the spinner waited on a concurrent pile - plus `setCronReloadSignal` adding a `cron.list()` on top of the read `CronSection`'s focus effect had already issued.
**Fix:**
- `activity.tsx` `onRefresh` awaits the reads sequentially in priority order: `refreshPendingApprovals()` (what the tab is opened for) -> `refreshCapabilities()` -> `refreshGateways()`, then the local `readAudit()` and the signal bump exactly as before.
- `refreshPendingApprovals` cannot reject (it catches internally) and `refreshCapabilities` ends in `catch { /* ignore */ }`, so the only possible refusal comes from `refreshGateways`, which is last - no read the old fan-out performed is lost.
- The stale comment above `cronReloadSignal` ("CronSection loads once per connection") was corrected to say the signal does re-list and the section coalesces it; spinner semantics (ends with the work, same 400 ms hold) are untouched.
**Tests:** `__tests__/activity-pull-sequential-reads-test.tsx` (new) renders the real `ActivityScreen` with a real `CronSection` behind mocked seams and drives `RefreshControl.onRefresh`: the trace must read `approvals:start, approvals:end, capabilities:start, capabilities:end, gateways:start, gateways:end` (a fan-out interleaves these); one `cron.list()` is added by the pull on top of the focus read, one `approvals.pending`, and `refreshing` is false afterwards. Red pre-fix: the ordering case failed; with `cron-section.tsx` also reverted the read-count case failed too (2 reads on mount, 3 after a pull).
**Review:** passed review first time (no review feedback file); the round-2 harness lint repair removed one suppression from this test and the red proof was re-run (1 of 3 red, the ordering case).
**Residual:**
- `refreshCapabilities` still fans out internally (health check, capabilities read, manifest fetch); ordering the three entry points is what this screen controls, and the inner fan is provider-side and outside this package's file list.

### R2-ACT-8
**Status:** Fixed (commit bc44045)
**Diagnosis:** CONFIRMED (S3). `src/components/activity/cron-section.tsx` issued two `cron.list()` in the same tick on mount - the `useEffect(..., [load, cronReloadSignal])` read and the `useFocusEffect` read, which itself fires on the first focus - and every later focus re-ran `load()`, a plain `useCallback` that wrote `setJobs(await cron.list())` unconditionally, with no in-flight guard and no request generation, so an older slow read could resolve last and overwrite a newer list.
**Fix:**
- `cron-section.tsx` `load` now carries a coalescing in-flight guard (`inFlight` ref): a caller arriving while a read is out gets the running promise instead of a second `cron.list()`. The ticket has a `settled` flag so a caller arriving in the same turn a read answers in takes a FRESH read, and the slot is released in a `finally` so a refused read cannot wedge the section.
- `load` also carries a `requestId` generation counter; only the newest read paints jobs/error/loaded.
- The redundant mount effect now fires only for a `cronReloadSignal` that changed after mount (`mountedSignal` ref), leaving the focus effect as the single trigger; `useFocusEffect` still covers the first focus, so no initial read is lost.
**Tests:** `__tests__/cron-section-single-read-test.tsx` (new, 9 cases) with a parked/resolvable `cron.list`: mount issues exactly one read; each refocus exactly one more; a signal bump with nothing in flight issues one read; a signal bump and a refocus arriving mid-read both join it (one call, its list paints); a caller after the answer gets a fresh read; a refused read releases the slot so the next focus reads again; the newest read replaces the previous list. Red pre-fix: all 9 failed (two reads on mount; a joined caller still issued its own).
**Review:** passed review first time (no review feedback file); the round-2 harness lint repair removed one suppression from this test and the red proof was re-run (`cron-section.tsx` reverted -> 9 of 9 red).
**Residual:**
- With coalescing in place two cron reads can no longer overlap, so the "older resolves last" interleaving is structurally unreachable; the tests pin the outcome that removes it (the joined read paints) rather than a literal race, and the generation counter guards the paint.
- A `cron.list()` that hangs forever is joined forever (pre-fix behaviour minus the duplicate requests); the transport's 30 s ceiling bounds it.

### R2-ACT-9
**Status:** Fixed (commit bc44045)
**Diagnosis:** CONFIRMED (S3). `src/components/activity/cron-run-sheet.tsx` armed `setInterval(() => { void poll(); }, 3000)` for as long as the sheet was open - no in-flight guard, no backoff, no signal - and each poll is an RPC with the transport's 30 s ceiling, so up to ten reads could be outstanding at once against a Gate that serves one request at a time; closing cleared the timer but left the reads in flight. The author CORRECTED the brief's optional clause: the sheet cannot know the run is terminal (`cron.transcript` returns `CronTurn[]`, and a `CronTurn` carries no run status), so there is no terminal condition to stop at and polling still runs while the sheet is open.
**Fix:**
- `cron-run-sheet.tsx` drops the interval: the next read is armed by the read that just settled (`scheduleNext`, a closure inside the effect), so exactly one read is outstanding; the first read is still deferred a tick, as before.
- New `POLL_BACKOFF_MS = [3000, 6000, 12000, 30000]` indexed by a `refusals` ref: 3 s while healthy, then 6 -> 12 -> 30 (repeating cap) as refusals accumulate, reset to 0 by a healthy read. The last error keeps rendering inline and the last good transcript still stands.
- `cancelled` is still set on cleanup and now also short-circuits a read issued after close and blocks rescheduling; an in-flight read's result is still dropped.
**Tests:** `__tests__/cron-run-sheet-poll-loop-test.tsx` (new, fake timers, 8 cases): a read held open across 10 s of cadence leaves ONE outstanding call and a peak of 1 (ten before); the next read is armed only after the previous settles; 2.999 s vs 3 s on the healthy cadence; the ladder 6 -> 12 -> 30 -> 30 with the peak still 1; the refusal shown inline with the last good turn; a healthy read resets to 3 s; unmount reads nothing more; a read in flight at close is ignored and arms nothing. Red pre-fix 3 of 8. One existing assertion pinned the defect: `cron-run-sheet-loading-test.ts` required the literal `setInterval(() => { void poll(); }, POLL_MS)`; it now requires the 3 s cadence and the deferred first read, asserts `setInterval(` is gone and `void poll().then(scheduleNext, scheduleNext);` is present - nothing weakened, `POLL_MS = 3000` is still required.
**Review:** passed review first time (no review feedback file); round-2 harness lint repair only.
**Residual:**
- A close cannot abort the request itself (`rpcRequest`/`HttpTransport.request` take no `AbortSignal`), so a read already on the wire still completes on the Gate; what changed is that it can no longer be followed by nine more, and its result is dropped.

### R2-SH-V1
**Status:** Fixed (commit bc44045) for the writer; the `settings.tsx` lenient read the audit's evidence also mentions is not covered - that file is outside this package's allowed list.
**Diagnosis:** CONFIRMED (S2). `recordApprovalDecision` read through the lenient `loadApprovalAudit` wrapper, which folds both a storage refusal and a `JSON.parse` failure into `[]`, then wrote the whole array back, so one bad read replaced the operator's entire on-device decision history with the single new entry. `loadApprovalAuditStrict`, which keeps "failed" apart from "genuinely empty", existed and was used by both read surfaces but not by the only writer.
**Fix:**
- `approval-policy.ts` `recordApprovalDecision` now reads the raw value itself inside the queued task and treats the two failures apart, as `loadApprovalAuditStrict` does: a storage refusal leaves the stored value UNTOUCHED, drops just this row (best-effort never blocks the caller), and `console.warn`s `[approval-policy] Could not read the approval audit; decision "<id>" was not recorded: <reason>` - the `console.warn` + `[module]` + `errorText` shape `storage.ts`/`session-persistence.ts` use.
- An unparsable value is first copied to the new single-slot rescue key `APPROVAL_AUDIT_CORRUPT_STORAGE_KEY` (`versutus:approval-audit:corrupt`) by `preserveCorruptApprovalAudit` (best-effort, mirroring `storage.ts`'s `preserveCorruptGateways`), and only then is a fresh log started and the new entry recorded.
- A write refusal is caught and named the same way, so the task never rejects. Valid JSON that is not an audit log still reads as a genuinely fresh log and is NOT rescued - `approvalAuditFromUnknown` answers `[]` for it, which is the strict loader's own rule.
**Tests:** `__tests__/approval-audit-write-queue-test.ts` (new, 9 cases): a seeded two-entry log plus a rejecting `getItem` leaves the stored bytes byte-identical and warns; the next decision records normally once the store answers; a corrupt value lands in `:corrupt` with the new entry recorded; the rescue slot is a single key (newest copy wins); an unstoreable rescue copy still lets the decision record; valid-JSON-not-a-log is a fresh log with no rescue. Red pre-fix 7 of 9 - both corruption cases and all three refusal cases; the two that passed pre-fix are guard-rails that must keep passing.
**Review:** passed review first time (no review feedback file); round-2 harness lint repair only.
**Residual:**
- The rescue slot is deliberately one key (key-value storage cannot be listed, so the newest copy overwrites the older), and nothing reads `:corrupt` in-app - it is a recovery artefact, not a UI surface.
- `src/app/gateway/settings.tsx` still reads the audit leniently, so a storage failure there prints `approvalAuditSummaryCopy(0)` as if the log were empty; the file is outside the allowed list, so it was left alone.

### R2-SH-V2
**Status:** Fixed (commit bc44045)
**Diagnosis:** CONFIRMED (S3). `cron-section.tsx` `submitCreate` called `syncRoutineNotification({ id, name: created?.name, schedule })` under the comment "the create landed: schedule the phone-side notice under the id the gateway returned". The name is this form's raw draft title, unprefixed on purpose so the Gate files a gateway-level job (`cron-create.ts`), so `parseRoutineName` yields no `botId` and `routine-sync.ts` takes the withhold-and-retire branch - the notice was never scheduled for any job created on this screen, and no connected re-arm builds one either (`gateway-provider.tsx` -> `rearmRoutineNotifications`, same guard).
**Fix:**
- `cron-section.tsx` `submitCreate`: the dead call and its `syncRoutineNotification` import are gone; the comment now says why no phone-side notice exists (routine notices are Bot-bound by design - they open that Bot's chat - and this form files a gateway-level job whose unprefixed title names no Bot, so the sync would withhold the notice and retire any held one).
- The create flow is otherwise identical: same `applyRoutineCreate` draft clearing, same `void load()` re-read, same refusal path; the `.then` callback no longer needs its argument.
**Tests:** `__tests__/cron-section-single-read-test.tsx` "creating a gateway-level job schedules no routine notice and still re-lists": Add calls `botJobs.create` once, calls NEITHER routine-sync function, still re-reads the roster (`listCalls === [0, 1]`) and clears the draft. Red pre-fix: the sync assertion failed (the object had been passed). One existing suite pinned the dead call and was corrected, not deleted: `routine-notification-sync-hooks-test.ts`'s "the Activity gateway-level create syncs the new job's scheduled notice" asserted `syncIdx > createIdx` and now asserts no sync in `submitCreate` with `void load()` still there; its companion fire-and-forget test iterated `chatScreen, sheet, cronSection` and `cronSection` left that list, with a comment saying why, while the other two keep the assertion.
**Review:** passed review first time (no review feedback file); round-2 harness lint repair only.
**Residual:**
- Gateway-level jobs genuinely have no phone-side notice; that is the documented honesty rule, and a notice for them would have to be one that does not name a Bot's chat - out of scope here.

### R2-HAPTIC-1
**Status:** Fixed (commit f0fbdd1) — both sites the audit names (Runs `startRun`, Onboarding `handleContinue`) and, because this package's brief was the whole class, the other 63 raw call sites too (this part).
**Diagnosis:** CONFIRMED, with the verifier's severity correction adopted: on Runs the rejection came *after* `setStarting(true)`, so `finally { setStarting(false) }` never ran and the card wedged on a disabled "Starting…" until remount — worse than a dead button. `PressableScale` and `Button` pass `onPress` to `Pressable` with no rejection handling, so the rejected promise became an unhandled rejection and the action after the await never ran. The scan's "three screens / two files" scope was an undercount: 65 raw `Haptics.*Async` sites in 22 files, none with `.catch` or `try`, while `src/lib/haptics.ts` already existed carrying that exact contract.
**Fix:**
- All 65 sites now call `haptics` (`light`/`medium`/`success`/`warning`/`error`/`selection`), `await`/`void` kept exactly as each site had it; `import * as Haptics` removed from every one, so `expo-haptics` names only `src/lib/haptics.ts`. No new wrapper entry was needed — every style in use already existed.
- `src/lib/haptics.ts` gained `safeHaptic(call)` (`try { Promise.resolve(call()).catch(() => undefined) } catch { … }`), because the old entries only covered a *rejected* promise and a native call throwing before it returns one would still escape into the `void haptics.x()` sites. Exported shape and `Promise<void | undefined>` return type unchanged.
- `src/app/runs.tsx` `startRun`: `await haptics.medium()` moved *inside* the `try`, after `setStarting(true)`, so nothing between the flag and `sendChatInput` can skip the `finally`.
- `src/components/onboarding/onboarding-screen.tsx` `handleContinue`: the three raw calls are now `haptics.medium()`, `haptics.success()`, `haptics.error()` at the same three positions.
**Tests:** `__tests__/haptics-wrapper-guard-test.ts` (new) scans every `.ts/.tsx` under `src/` and fails, naming offenders, if anything but the wrapper imports `expo-haptics` or matches `/\bHaptics\s*\./`; two unit cases pin the detector. `__tests__/haptics-safe-test.ts` (new): all six entries resolve to `undefined` when the module rejects *and* when it throws synchronously, and with a working mock each makes the one native call with the style it names. `__tests__/haptics-never-fail-an-action-test.tsx` (new) renders Runs and Onboarding with a hostile mock: `startRun` still sends and settles, Connect still runs and the `ErrorCard` names the real cause. Eight pre-existing suites asserted the raw call text and had their haptic token changed (`base-sheet-language-test.ts:104`, `confirm-sheet-busy-state-test.ts:54`, `composer-touch-target-test.ts:74`, `terminal-shell-copy-test.ts:41,63`, …); `future-items-cites-test.ts` shifted one line because dropping the import shortened `chat-composer.tsx`. Reverting `haptics.ts`, `runs.tsx` and `onboarding-screen.tsx` failed 15 of 26.
**Review:** passed review first time
**Residual:**
- The guard is a source scan: it proves no raw call returns, not that each handler survives.
- `haptics.ts` still swallows every failure silently (the requested contract), so a device with no vibrator gives no diagnostic.
- The unguarded `retryAutoConnect()` promise is unfixed at `gateway-provider.tsx:4320`, `spend.tsx:160/238`, `gateway-home-dashboard.tsx:291` — outside ALLOWED, so ONB-1's real mechanism stands.

### R2-RUNS-1
**Status:** Fixed (commit 7ae5899)
**Diagnosis:** CONFIRMED, with the audit's "partly confirmed (corrected)" arithmetic kept: the doubling was mount-specific (`useFocusEffect` plus a `runsReloadSignal` effect whose signal starts at 0), and nothing aborted or coalesced an in-flight read. `loadRoutineJobs` and `loadBotSpend` are now single functions in `src/app/runs.tsx` (`:294`, `:373`) with one trigger each.
**Fix:**
- `loadRoutineJobs` (`:294`) returns a `Promise<void>` behind a coalescing ticket (`settled` flag) plus `jobsGeneration`; `useFocusEffect` is its only trigger, and the reload effect now calls it instead of re-triggering.
- `loadBotSpend(force?)` (`:373`) returns before creating any wave while `status !== 'connected'`, drops the 60 s `ledger.completedAt` claim when `canReadBotSessions` flips or the gateway id changes, and stamps `completedAt` only on a wave that finished a read and was not aborted.
- A newer wave and `stopSpendWave` (`:365`, the focus effect's cleanup) abort the older one; the `AbortSignal` is passed to `readBotSpend`, so it reaches each lane's retry ladder.
- A throwing read no longer writes `setSpendRows([])`; rows already on screen stay.
- The third independent `listBots()` effect is gone: names come from the wave's `BotSpendRow.label`, and on a gateway without the scoped read (where `readBotSpend` degrades without asking the roster) the fold asks for the roster itself under the same window/generation.
**Tests:** `__tests__/runs-fold-once-test.tsx` (13 tests, rendered screen, fake gateway/timers) — one `cron.list()` and one spend wave per open, a pull adding exactly one of each, an in-flight caller joining, an older wave landing last not painting, unmount ending the wave, and `connecting → connected` earning exactly one read. Two assertions were rewritten because they pinned the defect: one asserted `listBots` was never called on the degraded path (the names regression), one pinned the freshness gate in front of a wave that read nothing.
**Review:** failed review r1 caught two blockers — a wave that returned at `status !== 'connected'` stamped `completedAt` anyway, so the connect that landed next hit the freshness gate and read nothing (0 reads after the flip); and the unconditional removal of the roster read regressed `botNames` to raw Bot ids. Repaired by the early return before wave creation, the read-gated stamp, the `canReadBotSessions` reset, and the guarded roster read; the sticky refresh notice was repaired too (see R2-RUNS-3).
**Residual:**
- The routine-jobs read has no blur abort; an in-flight `cron.list()` may paint after a blur (not after a superseding read). Matches the brief, which asked for the abort on the spend wave only.
- The roster read for names rides inside the spend fold, so a skipped wave skips it; names go stale with the rows, per gateway.

### R2-RUNS-2
**Status:** Fixed (commit 7ae5899)
**Diagnosis:** CONFIRMED on the corrected claim: `'error'` and `'cancelled'` keep the draft by design and are test-locked (`__tests__/activity-refused-run-keeps-prompt-test.ts`, `activity-refused-run-settles-test.ts`), so the only invisible outcome was `'queued'` — `queueOfflineInput` parks the text and clears `lastError` on purpose. `startRun` (`src/app/runs.tsx:188`) now handles that case and leaves the other two exactly as they were.
**Fix:**
- `startRun` writes `setStartNote(outcome === 'queued' ? RUN_QUEUED_COPY : null)` after the send; `'complete'` still clears the draft.
- The Start card renders that line under the button, and the prompt's `onChangeText` clears it, so it cannot outlive the words it is about; the next attempt clears it too.
- `'error'` / `'cancelled'` are untouched: draft kept, no new text — the provider's `lastError` stays their surface.
**Tests:** `__tests__/runs-outcome-test.tsx` — a `'queued'` outcome shows the note and keeps the draft, `'complete'` clears the draft with no note, the note is retired by the next edit, and a refused run still keeps the draft and says nothing here (unchanged behaviour, pinned). Its fixture was changed from `canReadBotSessions: false` to `true`, because the roster now comes from the spend wave's rows.
**Review:** passed review first time (verified correct in r1, unchanged in round 2).
**Residual:** none.

### R2-RUNS-3
**Status:** Fixed (commit 7ae5899)
**Diagnosis:** CONFIRMED. `refreshCapabilities` swallowed every gateway-side read, so `onRefresh`'s `Promise.all` could not reject and `setRefreshError(null)` ran unconditionally. It is now `useCallback(async (): Promise<boolean>)` at `src/context/gateway-provider.tsx:4635` and still never throws.
**Fix:**
- The provider tracks a local `landed` that any refusal sets false and returns it; `true` with no active gateway (nothing to refresh), `false` when `/health`, the capability catalog, the manifest or the outer `catch` refused. Every currency guard's `return;` became `return landed;`.
- A `null` manifest counts as a failed read; the last known manifest is still kept.
- The context type is `refreshCapabilities: () => Promise<boolean> | undefined` (`:508`); `demo-gateway-provider`'s `idle` returns `undefined`, which is not a refusal.
- `onRefresh` (`runs.tsx:261`) reads the value and sets `REFRESH_UNREAD_COPY` on `false`, clearing the notice only on success. The reconnect action's `void connectGateway(...)` (item 5 of the brief) gained a `.catch` routing the rethrown auth refusal into the same `refreshError` line.
- A connection that comes back sets a one-shot flag and the next read that lands on it clears the notice — deliberately tied to a landed read, not the status flip alone.
**Tests:** `__tests__/runs-refresh-reports-test.tsx` drives the real provider against a fake client: all reads land → `true`; dead `/health` → `false` with the last manifest kept; refused capability catalog → `false` and still swallowed; unanswered manifest → `false` with the served one kept; no active gateway → `true`. `runs-outcome-test.tsx` covers the screen: a refresh that read nothing is named with the rows intact, a success clears it, a storage rejection still names itself, and a recovered gateway retires the notice without a pull.
**Review:** failed r1 on the sibling defect — the notice was sticky across a recovery because `refreshError` was cleared only inside `onRefresh`. Repaired at `runs.tsx:436-441` plus the one-shot `recoveringFrom` flag, with a new test.
**Residual:**
- `REFRESH_UNREAD_COPY` can fire on a gateway that legitimately serves no manifest, since `fetchGatewayManifestRaw` returns `null` for any non-2xx as well as a network failure. Flagged by the reviewer as a new operator-visible false alarm; left as is.
- Home's `onRefresh` still ignores the value (outside the allowed files); the fix is in the provider so that screen can adopt it in one line.

### R2-SR-V1
**Status:** Fixed (commit 7ae5899)
**Diagnosis:** CONFIRMED. `retryRun` was `useCallback((run) => { ...; void sendChatInput(\`/run ${prompt}\`) })` — the `SendChatInputOutcome` discarded, no pending flag, no error surface, and the button (`run-card.tsx`) had no busy/disabled prop, so repeat taps fired repeated `/run` sends.
**Fix:**
- `retryRun` (`runs.tsx:228`) sets `retryingRef` before the await, so two taps in one turn are one send, plus `retryingRunId`; it deletes any previous verdict for that card.
- Outcome handling: `'complete'` writes nothing, `'queued'` writes `RUN_QUEUED_COPY`, `'error'`/`'cancelled'`/`busy'` and a rejected send write `RETRY_REFUSED_COPY`. A `.finally` releases both the ref and the pending state on every outcome, including a throw.
- The finished-card branch withdraws `onRetry` while that card's retry is in flight, so the affordance is absent rather than live behind a guard, and draws the pending/result line under the card.
**Tests:** `__tests__/runs-outcome-test.tsx` — two taps in one turn send once and the affordance is gone while it flies, `'queued'` shows the parked note on the tapped card, `'error'`/`'cancelled'`/`'busy'` show the did-not-start line (`test.each`), the next attempt retires the previous verdict, and a send that rejects outright still releases the card. `run-card-retry-test.ts` and `agentic-run-transcript-test.ts` are source-text pins loosened only where the branch grew the conditional `onRetry` prop and the pending/result line.
**Review:** passed review first time (verified correct in r1, unchanged in round 2).
**Residual:** the pending guard is screen-wide (`retryingRef` holds one run id), so a different card's retry tapped while another is in flight is ignored rather than queued — stricter than per-run, and the brief's "a second tap is ignored" reading.

### R2-SR-V2
**Status:** Fixed (commit f0fbdd1) — for every site the finding names (this part).
**Diagnosis:** CONFIRMED by line. All six raw sites in `gateway-home-dashboard.tsx` sat in front of an action with no `try` — Retry connection, "Open fleet map" → `/fleet`, "Compare Bots" → `/council`, the Channels row → `/chat`, Activity → `/activity`, and Refresh capabilities — and `PressableScale` forwards `onPress` straight to `Pressable` while `Button` passes it through, so a rejected haptic made each a no-op with only an unhandled rejection in the log, on the only route into Fleet and Council. The finding's "~25 call sites" was an undercount: 65 sites in 22 files.
**Fix:**
- Those six dashboard sites, plus every file the finding lists (`chat-composer.tsx`'s four attach/menu handlers, `message-bubble.tsx`'s long-press menu and toggles, `confirmation-sheet.tsx`'s Cancel, `pairing-panel.tsx`, `provider-card.tsx`, `environment-card.tsx`, `gateway/settings.tsx`), now call the wrapper with their `await`/`void` intact.
- The confirm ternary collapsed to `await (preview.risk === 'high' ? haptics.warning() : haptics.success())` — same two styles, no raw call.
- No raw call and no `expo-haptics` import survives outside `src/lib/haptics.ts`.
**Tests:** the guard scan covers the whole class by failing and naming every offender. `__tests__/home-dashboard-derivations-test.ts` — the repo's existing source-contract harness for this component — now asserts `await haptics.light();` and `void retryAutoConnect();` in the retry block, and `haptics.light()` in the fleet/council row where the assertion previously read `Haptics.impactAsync`; reverting just that retry body gave `1 failed, 6 passed` (`Expected substring: "await haptics.light();"`).
**Review:** passed review first time
**Residual:**
- No render test for `GatewayHomeDashboard` (press "Compare Bots" → assert `router.push('/council')`): the component is rendered by no test in this repo and standing it up needs ~15 new component/hook mocks — declined by choice, not impossibility.
- The `void retryAutoConnect()` the dashboard now reliably reaches is still unguarded, so a provider-side failure still lands in the void; the fix belongs in `gateway-provider.tsx`, outside ALLOWED.

### R2-SR-V3
**Status:** Fixed (commit 55c99a2)
**Diagnosis:** CONFIRMED by the verifier and still true of the pre-fix code. `rosterState` started at `'loading'`
(`src/app/council.tsx:37`) and the only writer, `loadRoster`, was reached solely through the effect that returns early when
`status !== 'connected'`, so a screen opened while disconnected rendered three `Skeleton` chips with
`accessibilityLabel="Loading bots"` forever - no error, no retry, no offline wording.
**Fix:**
- The offline case is its own branch in the chip slot (`council.tsx:342-349`): `status !== 'connected'` with no roster held renders an `EmptyState` "Not connected to a gateway" / `COUNCIL_OFFLINE_COPY` ("Connect to a gateway to compare Bots").
- The skeleton branch is now reachable only for a real in-flight read with nothing behind it (`council.tsx:350-355`).
- The read effect is unchanged in shape, so a return to `connected` reads again; `rosterGenerationRef` makes the out-of-order case harmless.
**Tests:** `__tests__/council-screen-test.tsx` "a screen opened while disconnected says so instead of showing skeletons" (no `Skeleton`, one `EmptyState`, no `ErrorCard`, `listBots` never called; pre-fix 3 skeletons) and "a connection that drops mid-read stops claiming to load a list it never asked for" (skeletons during a live read, offline state on the drop, chips after reconnect with `listBots` called twice).
**Review:** passed review first time
**Residual:** The offline state has no Reconnect action - the provider's `connectGateway` is not exposed on this screen.

### R2-LOCK-1
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED, with the scan's line slip corrected: at the base commit the gate's only device read was the `[]`-deps effect in `app-lock-gate.tsx` and the verdict assignment was at `:102`, not `:101`. The `AppState` listener read `lockableRef.current` and never re-asked, and `app-lock.ts` had no `subscribe*` at all - so the switch wrote a flag nobody observed for the rest of the process, inert in both directions.
**Fix:**
- `src/lib/settings/app-lock.ts:109-121` - a module `listeners` set and `subscribeAppLock(listener): () => void`, mirroring `subscribeWidgetPrivacy`; `saveAppLock` (`:129-137`) notifies in its `finally`, so subscribers wake whether the write landed or was swallowed.
- `app-lock-gate.tsx:102-111` - one `readLockable()`: assigns `lockableRef.current` only on success, returns the previous verdict on a throw, so a failed read never reads as "not locked" and never seals a device out.
- `:113-133` - the mount effect subscribes and unsubscribes; a notification refreshes the verdict but deliberately does not settle the phase (the operator who just turned the lock on is in Settings with work in hand).
- `:143-152` - the `AppState` listener keeps the `'background'` edge exactly as it was and additionally re-reads on `'active'`. A cover already drawn is never lifted there; only the operator's unlock is. Phase/route-dismissal machinery (`:166-`) untouched.
**Tests:** `__tests__/app-lock-gate-live-switch-test.tsx` (new, 5 cases) drives the real gate, real `saveAppLock` and real `deviceAppLockState` over in-memory `keyValueStorage`, with `AppState.addEventListener` spied and the switch flipped after mount. Three fail pre-fix (ON then background covers; OFF then background stays open; the gate re-asks the device). Two pass pre-fix: the unsubscribed gate is not re-read (a leak guard for the new channel) and a throwing read keeps the previous verdict. `__tests__/app-lock-test.ts` unchanged and green both ways - it pins `state === 'background'` and `not.toMatch(/state !== 'active'/)`.
**Review:** the first review passed LOCK-1 with no problems and independently confirmed the three pre-fix failures by construction.
**Residual:**
- The `'active'` refresh costs one storage read plus the biometric probe per foreground (the brief's "cheap", not free); `deviceAppLockState` does not prompt, so it cannot nag.
- `handleAppLock` (`settings.tsx:171-174`) still claims the lock optimistically - `saveAppLock` swallows a failed write, so the Switch can show a lock the store does not hold until the next mount. Reviewer named it, author left it: `app-lock.ts` returns no outcome by contract ("never a lockout"), and the gate self-heals on the next foreground while the Switch does not.

### R2-IMPORT-1
**Status:** Fixed (commit 1d89c50)
**Diagnosis:** CONFIRMED, verified against the installed `expo-file-system@57` sources. `src/app/gateway/import.tsx` did `await import('expo-file-system')` then `FileSystem.readAsStringAsync(asset.uri)`, which the SDK 57 root module re-exports from `legacyWarnings` where it unconditionally throws - yet it is still declared in `build/legacyWarnings.d.ts`, so `tsc` stayed green. The author ADDED the second half of the failure: the catch turned the throw into `content: ''` and `pickFile` called `setText(picked.content)` *before* reading `picked.error`, so a refused read wiped the pasted packet and then said "The picked file could not be read."
**Fix:**
- `src/app/gateway/import.tsx` static `import { File } from 'expo-file-system'` and `await new File(asset.uri).text()` in `pickHandoffFile`, the same style as `src/lib/gateway/handoff-share.ts`; no `/legacy` import. The try/catch that turns a read failure into the card's refusal is kept.
- `pickFile` now inspects `picked.error` first and returns early, so a refused read leaves the pasted text exactly as it was; a successful read does `setText(picked.content); clearFailure(); setFileNote(...)`.
- `pickHandoffFile` is exported so its behaviour can be asserted directly instead of through the screen's source text.
**Tests:** `__tests__/handoff-import-pick-file-test.tsx` (new, 4 cases) mocks `expo-file-system` as the REAL SDK 57 root surface - a `File` class with `text()`/`textSync()`/`uri` plus `Directory` and `Paths`, and deliberately no `readAsStringAsync` - so anything left on the legacy name fails as it does on device: a mocked `File` returns `{ name, content }`, its text reaches the packet field with the "Read scout.json" note, a throwing `File` leaves the pasted packet in the field with the ErrorCard cause, and a cancelled picker builds no `File` at all. Pre-fix (`import.tsx` reverted to `HEAD`): `Tests: 3 failed, 17 passed, 20 total` across both suites; two failures are the defect itself (the field came back `""`), the third is `pickHandoffFile is not a function`. `__tests__/handoff-import-test.ts` needed no change - its source-text assertions still hold against the fixed source.
**Review:** passed review first time for this finding - the only feedback for the package is the harness resume notice, and the gate failure and the broken `capabilities-secret-ref-order-test.ts` assertions it reports are both RUN-1/CAPS-1 work.
**Residual:**
- `text()` still reads the whole file into memory, unchanged; the picker is still restricted to `application/json` and nothing here widens it.
- `expo-file-system` is now a static dependency of this route's module graph instead of a dynamic one - the same import `handoff-share.ts` already makes, and covered by the jest mock.

### R2-SRUN-1
**Status:** Fixed (commit 1d89c50)
**Diagnosis:** CONFIRMED. `environments-section.tsx` renders ONE `EnvironmentRunLauncher` for every environment (`visible={runTarget !== null}`, `onClose={() => setRunTarget(null)}`), so `onClose` only nulls the target and the component holding `events`, `running` and `abortRef` stays mounted; Close only ever reached `BaseSheet` and the Close button, `start()` overwrote `abortRef.current`, and `follow`'s `onEvent` appended uncapped. The author ADDED that the real `running` leak is that `follow`'s `finally` fires *after* the run is retired and then sets `running = false` and calls `refreshRuns()` for whatever environment is on screen - not the microtask timing the brief described.
**Fix:**
- `environment-run-launcher.tsx` new `runTokenRef` counter plus `retire()` (abort the controller, null `abortRef`, advance the token); `follow()` takes the token and every callback and its `finally` return early unless `runTokenRef.current === token`, so a stale run cannot `setEvents`, clear `running` or `refreshRuns()`.
- New `dismiss()` retires first, clears `events`/`approval`/`activeRunId`/`detached`/`running`, then calls `onClose`; wired to both the Close button and `BaseSheet`'s `onClose`, which also covers hardware back, swipe-to-dismiss and backdrop press.
- Target change or `visible` going false: an effect on `[environment?.id, visible]` calls `retire()` (the external half); the state half is derived during render from a `sheetKey` of `` `${environment?.id ?? ''}|${visible}` ``, the repo's adjustment-key pattern, because `react-hooks/set-state-in-effect` is an error in this repo's lint config.
- `start()` claims a fresh token via `retire()` before anything else, so a second start aborts the first stream instead of orphaning it; `cancel()` retires and stays the only caller of `client.cancelRun`.
- `MAX_RUN_EVENTS = 2000` and exported `capRunEvents()` keep the newest 2000 frames and re-prepend the `run.started` marker if the tail dropped it; wired into `follow`'s `onEvent`. `environments-section.tsx` is unchanged.
**Tests:** `__tests__/environment-run-close-ends-run-test.tsx` (new, 11 cases, fake client whose `streamRun` promise is settled by hand) pins: Close mid-stream leaves `calls[0].signal.aborted === true`; an event pushed into the retired stream afterwards never reaches the bubble; a retired run's `finally` leaves `listRuns` at 1; reopening for another environment shows `Start run` and not `Cancel run`; `capRunEvents` keeps 2000 with `run.started` first. Pre-fix (launcher reverted to `HEAD`, new exports stubbed so the module loads): `Tests: 9 failed, 8 passed, 17 total`. `__tests__/environment-run-detached-reopen-test.ts` *changed* - it pinned the defect (`onPress={onClose}`); now asserts `onPress={dismiss}` plus a new `<BaseSheet visible={visible} onClose={dismiss}>`, and its other six source assertions are untouched.
**Review:** sent back for repair (harness resume notice): the last gate failed on this finding - `pointing the sheet at another environment retires the run it was following` read `signal.aborted === false` because the first attempt deferred the abort a microtask; the repair derives the reset during render and aborts in the effect, which is synchronous and lint-clean.
**Residual:**
- Close detaches rather than cancels, chosen from the existing UI (a "Cancel run" button, "Recent runs", a Reopen row per run, a detached banner). The Gate-side run keeps going and is replayed by `attach()` on reopen; `cancel()` is the only Gate cancel. The commit subject's "run sheet cancels on close" overstates this.
- `prompt` and `operation` are deliberately not reset by a target change, so reopening keeps the typed prompt and verb - not required by the brief.
- The cap is lossy by construction: a run whose whole output sits in the dropped frames replays from the Gate on reopen rather than from the truncated bubble.

### R2-REACH-1
**Status:** Fixed (commit 329962d)
**Diagnosis:** CONFIRMED as the audit states, and the repair pass made no further edit to it. The author kept the audit's alternative (stamp up front, roll back on cancel) rather than stamping only on completion, and ADDED an unwind path plus a stuck-state rule the audit did not ask for: `reachability-wave.ts`'s `startProbeWave` returns `{ settled, release }`, and `use-gateway-reachability.ts:115`'s cleanup calls `wave.release()`.
**Fix:**
- `reachability-wave.ts` `startProbeWave` stamps `lastProbeAt` **and** `checkingSince` for the whole `due` list in one pass (one extra render, no double-probe) and tracks an `outstanding` id set.
- `release()` deletes both stamps for every claim no probe answered and hands those gateways to `onReleased`; the new `withoutWaveChecking` returns only `checking` rows to `unknown` and leaves any live verdict alone. Both `settled` handlers call it, so a throwing probe unwinds too.
- `planProbeWave` gained `checkingSince` + `stuckAfterMs`; the hook passes `PROBE_STUCK_AFTER_MS = PROBE_TIMEOUT_MS + 5000` (`use-gateway-reachability.ts:86`), so a gateway checked longer than its own deadline is due whatever the debounce says. This is the brief's safety net.
**Tests:** new `__tests__/reachability-wave-cancelled-test.ts` (22 tests) drives the real hook through `react-test-renderer` with a real dependency change mid-probe and asserts the replacement wave re-probes the stranded gateway to a real verdict; also pins the 8 s debounce and both stuck-window planner edges. Pre-existing `__tests__/reachability-wave-test.ts` (19 tests) untouched.
**Review:** failed r1 and was repaired, but the review cleared REACH-1 itself: it traced the stamp/release ordering, the `isCancelled()` guards around both stamp deletes, double-`release()`, and the `settled` handlers by hand and recorded "REACH-1 really is fixed", no action.
**Residual:**
- `probeGatewayUrl` still gets no `AbortSignal` (`src/lib/gateway/probe.ts` is outside the allowed files), so an in-flight probe is disowned, not cancelled.
- The 11 s stuck window only fires when an effect dependency changes; the effect still has no interval.

### R2-CAPS-1
**Status:** Fixed (commit 1d89c50)
**Diagnosis:** CONFIRMED. `capabilities-section.tsx` `saveDraft` awaited `registry.instances.create` before `registry.secrets.set` and pre-checked only the ref's shape with `looksLikeCredential` (`credential-shape.ts`, which passes anything containing `/`, `-`, `_`, `.`), while the Gate refuses the whole `provider/` namespace (`gate/core/capabilities/registry-methods.mjs`); so `provider/my-provider/api-key` created the instance, had the secret refused, and every retry hit `instance "x" already exists`. The author CORRECTED the brief: the first attempt extracted a `writeDraft` helper, which is what broke five source-text assertions in `capabilities-secret-ref-order-test.ts`; the final state keeps the logic inline in `saveDraft`, so that suite passes with all 7 assertions unedited.
**Fix:**
- `credential-shape.ts` new exported `isProviderCredentialRef()` (mirrors the Gate's `/^provider\//`); `saveDraft` refuses such a ref before any RPC with a message naming the field and pointing at `providers.auth.setApiKey` on the Providers screen, alongside the untouched `looksLikeCredential` check.
- Order: `registry.secrets.set` now runs before `registry.instances.create`/`.update`, so a refused secret creates nothing and a refused instance leaves at most a secret the retry overwrites.
- `setDraft(null)` moved before the refresh and the refresh given its own try/catch, so a landed save whose refresh fails closes the draft and shows "Saved, but the capability list could not be refreshed: ..." instead of leaving a create-mode draft.
- Create mode wraps the create: an `already exists` refusal falls through to `registry.instances.update` (the smaller of the two options the brief offered, keeping the operator in the form they are filling in); any other refusal is re-thrown with the draft open. `errorText()` normalizes the caught value.
**Tests:** `__tests__/capability-save-atomic-test.tsx` (new, 8 cases, fake `gatewayRequest` through a mocked gateway provider): a `provider/...` save makes zero save RPCs (only the two list calls); a Gate-refused secret does exactly one `secrets.set` and zero `instances.create`, then a corrected retry completes; index of `secrets.set` < index of `instances.create`; an `already exists` refusal finishes as one `instances.update` with the draft closed; a refresh rejection closes the draft and says "could not be refreshed". Pre-fix (`capabilities-section.tsx` reverted to `HEAD`, new export kept): `Tests: 6 failed, 2 passed, 8 total`; the two passes are guards (the pure helper case and the delete-affordance guard).
**Review:** sent back for repair (harness resume notice): the first attempt's `saveDraft` -> `writeDraft` extraction broke five source-text assertions in the existing `capabilities-secret-ref-order-test.ts`; the repair put the logic back inline rather than editing that suite.
**Residual:**
- The already-exists fallback keys on the Gate's message text (`/already exists/`) because the RPC returns no error code; if that wording changes the save degrades to today's behaviour (error shown, draft open), not to a wrong write.
- A create refused for any other reason still leaves the secret written but unreferenced - the brief's instruction and the safe direction, but a real orphan if the operator abandons the draft. Deleting an abandoned draft does not remove that secret; out of scope.

### R2-SETTINGS-1
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED. `app-settings.ts:46-51` was `loadAppSettings()` -> merge -> `setItem` with nothing serialising the pair, and the read went through an unguarded `getItem`. Two writers share the key - the Settings screen (voice engine) and the provider's connect ladder (`lastSuccessfulUrl`, the onboarding patch, `autoConnect`, seven call sites) - so whichever `setItem` landed last won with the base it had read.
**Fix:**
- `app-settings.ts:39-50` - a module-level `mutationQueueTail` and `enqueueSettingsMutation`, structurally `enqueueStoreMutation` in `src/lib/gateway/storage.ts:28-40`: the tail is always re-settled resolved, so a failed write rejects its own caller and never poisons the queue.
- `:53-66` `readAppSettings()` is the raw reader and throws when the store cannot answer; `:73-79` `loadAppSettings()` wraps it and returns the defaults, so a screen that only needs settings never has to catch a read.
- `:81-91` `saveAppSettings` runs the read-merge-write inside the queue, so each call merges onto what its predecessor stored. Return value and `normalizeVoiceEngine` unchanged. It reads through the throwing reader on purpose: an unreadable blob refuses the write rather than being overwritten with defaults nobody chose.
**Tests:** `__tests__/app-settings-serialised-test.ts` (new, 5 cases). Two fail pre-fix: two overlapping `saveAppSettings` calls with different fields against a `getItem` that yields the event loop lose `voiceEngine` (it comes back `'auto'`, the `lastSuccessfulUrl` write wins with the pre-patch base); and a throwing `getItem` makes `loadAppSettings` reject instead of resolving with defaults. Three pass pre-fix as guards: a refused write rejects only its own caller and the next write lands, sequential writers, and the returned merged blob.
**Review:** the first review passed SETTINGS-1, calling the queue structurally `enqueueStoreMutation` and noting the added `getItem`-refusal source is the same exposure as the pre-existing `setItem` one.
**Residual:**
- `saveAppSettings` can still reject (`setItem` and now also `getItem`), and the seven provider call sites `await` it uncatchingly; the provider is outside the allowed file set. Not a new class of failure.
- The queue is per module instance, which a single JS runtime makes equivalent to one writer chain.

### R2-SVOICE-1
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED. At the base commit `handleVoiceInstall` (`settings.tsx:214-245`) owned no `AbortController`, no cancelled flag and registered no cleanup: the 900-iteration loop slept a fixed 2 s, issued an RPC and an `await pushDeviceParams()` per iteration, and the only `setInstalling(false)` sat after the loop - 30 minutes of phone work that survives the route. The first attempt's replacement reintroduced a smaller version of the class: a bare `let params = await pushDeviceParams()` inside a `try/finally` with no `catch`, and `pushDeviceParams` rethrows `DeviceIdentityError` (`push-registration.ts:108-116`).
**Fix:**
- `settings.tsx:66-70` - `INSTALL_POLL_FIRST_DELAY_MS` 2 s, `INSTALL_POLL_MAX_DELAY_MS` 10 s, `INSTALL_POLL_BUDGET_MS` 10 min.
- `:121` `installCancelRef` + `:275-282` an unmount-only cleanup that aborts it and releases the pending wait. The screen tracks no focus, so unmount is the edge the brief allowed.
- `:125` `installWaitRef` + `:322-329` a `wait(ms)` that publishes its own canceller, released by the unmount cleanup, by the next press (`:311-315`) and dropped in the `finally` (`:414`) - the timer was the one thing that outlived the screen.
- `:310-416` `handleVoiceInstall` - fresh `AbortController`, device params read once before the loop, a `while (true)` loop that awaits `wait(delay)` with a `cancelled()` guard after every await, the delay doubling to the 10 s cap, and a 10-minute budget that sets "Still installing on the PC - this phone stopped watching, check back later." and stops asking. `try/catch/finally` clears `installing` on every exit and releases the refs.
- `:341-354` the params read has its own `catch` and distinguishes the two failures with `isDeviceIdentityError` (identity text) from the Gate refusal sentence, then returns, so the row cannot keep claiming a download the PC never began. `:402-408` a `catch` in front of the `finally` as the structural backstop, since the handler's promise is what `onPress` calls. On an auth-style rejection the params are re-read once, then the watch ends.
**Tests:** `settings-screen-voice-and-preferences-test.tsx`, describe "the voice install watch cannot outlive the screen (VOICE-1)", 9 cases on fake timers. Six fail pre-fix: unmounting mid-poll stops every further RPC; two minutes of fake time produce at most 15 polls (a fixed 2 s poll is 60); the 10-minute budget shows the "still installing" note and ten more minutes add no polls; the device params are read once, not once per poll; a rejecting `pushDeviceParams` (`DeviceIdentityError`) throws out of the press when awaited, and the row names the identity failure; the parked timer is the one released on unmount. Three pass pre-fix as the "must keep working" side: a finished install clears the row and republishes capabilities, a refused poll clears it, an install the Gate will not start says so.
**Review:** first review FAILED on the unhandled rejection from the bare `await pushDeviceParams()` in the new watch (the exact PRIV-1/V-1 class, reintroduced one line above the work), and on V-3 undelivered. Repaired: the params read moved out of the hot loop behind its own `catch` with an identity-vs-Gate note and a `return`, a `catch` was added in front of the `finally`, and a new test makes `pushDeviceParams` reject. Also repaired at the reviewer's instruction: the `wait()` timer is now cleared on unmount, and `handleAppLock` was left alone and named as residual.
**Residual:**
- Cancelled on unmount only, so a backgrounded app with the route still mounted keeps watching to the budget; the brief said not to add focus/app-state plumbing the screen does not have.
- The budget check sits after the wait, so the last poll can land up to 10 s past the 10-minute mark.
- The outer `catch` is a backstop no current path reaches; a second press would clear the first watch's timer without resolving its promise, which is unreachable through the rendered UI (the Install row is replaced as soon as `installing` is true) and unobservable from outside, so it is named rather than changed.

### R2-SPEND-1
**Status:** Fixed (commit 958a455)
**Diagnosis:** CONFIRMED. At the base commit `src/app/gateway/spend.tsx`'s fan-out effect was keyed `[status, canReadBotSessions, listBots, readBotSessions]` and its cleanup only set a boolean, so every transition re-ran `readBotSpend` and an abandoned lane kept retrying. ADDED by the author after review: the first attempt had put the abort guards in `readRosterByConcurrency` and `get-sessions-retry.ts` but never handed the signal down the call chain, so the ladder's `options.signal` had no production caller.
**Fix:**
- `spend.tsx:198-260` a `botWave` ref ledger (`controller`, `running`, `completedAt`, `gatewayId`) inside `runBotSpendWave`; the effect's deps are `[connected, gatewayId, runBotSpendWave]`, never `status`. `running` refuses overlap; a reconnect earns a wave only when the last non-aborted one is older than `BOT_SPEND_WAVE_MIN_INTERVAL_MS` (60 s, `:48`); a gateway change resets freshness; `.then`/`.catch`/`.finally` all bail on `signal.aborted` so an abandoned wave writes nothing and cannot free the newer wave's slot (`:262-265`); `:272` aborts on unmount.
- `spend-report.ts:253-300` the pool's `read` and `BotSpendSource.readBotSessions` take a third optional `signal`, `read(bot.id, SESSION_SPEND_LIST_LIMIT, signal)` (`:267`), and `throwIfAborted` guards before the read, after it, and in the catch (`:262,270,278`) so a cancelled lane is never folded as a Bot that failed.
- `gateway-provider.tsx:4814-4833` `readBotSessions(botId, limit, signal?)` forwards to `client.listBotSessionCatalogue(botId, limit, { signal })` via a local widened cast; `manifest-client.ts:910-934` `listBotSessionCatalogue(botId, limit, { signal } = {})` passes `{ limit, signal }` into `withGetSessionsRetry`.
- `get-sessions-retry.ts:33-105` `options.signal`, a `throw` before every attempt (`:89`), and `waitMs(ms, signal)` (`:35-49`) which clears its timer and rejects `SESSIONS_RETRY_ABORTED_MESSAGE` mid-backoff. No-signal callers are unchanged.
- The doc comment claiming the per-Bot read is "a second, additional read" now states one fan-out per visit.
**Tests:** new `__tests__/spend-bot-wave-test.tsx` (11 tests) - a flap inside 60 s starts no second wave, an in-flight wave is not restarted, a reconnect past the window does earn one, a different gateway starts its own, the lanes get the screen's own signal (aborted by unmount), unmount issues no further read, a superseded wave never writes state. `bot-spend-read-test.ts` and `gateway-get-sessions-retry-test.ts` gain 503-Gate abort cases proving attempts stay at 1 (3 pre-fix, control case proves the fixture is retriable); `read-bot-spend-concurrency-test.ts` gains an abort describe; `gateway-provider-connected-reads-test.tsx` pins the signal the provider hands the client. Two source-text assertions changed as the brief allows: `spend-per-bot-section-test.ts` expects the 3-arg reader and the `{ signal }` forwarding.
**Review:** failed twice before it landed, not passed. r1 and the resume both failed the jest gate on `spend-bot-wave-test.tsx` "a status flap inside the freshness window starts no second wave" (20 s timeout - fake timers awaited outside `act`); repaired by advancing timers and flushing microtasks inside `act`, still failing pre-fix. r2 then failed on substance: the deciding defect was that the retry ladder kept growing attempts behind a caller that had walked away (up to 4 extra large reads), and the notes had claimed otherwise; the repair threaded the signal through spend-report -> provider -> manifest-client -> ladder and added the attempt-count test.
**Residual:**
- A request already on the wire is not recalled - `HttpTransport.request` owns its own controller and `http-transport.ts` is outside the allowed list; stated in the code at `spend-report.ts:240-252` and `spend.tsx:267-271` rather than claimed as a stop.
- `client.ts` deliberately untouched: `HermesGatewayClient` implements no `listBotSessionCatalogue`, so `hasBotSessionScoping` fails and the fan-out never starts against it; the brief's instruction to widen that signature would have had no caller.
- No manual refresh control exists on the screen (`retrySpendRead` re-runs only the total read), so "manual refresh forces a run" is N/A; returning within 60 s of a complete wave shows that wave's rows, as intended.

### R2-DIAG-1
**Status:** Fixed (commit 958a455)
**Diagnosis:** CONFIRMED. `probeStreamingFetch` in `src/lib/runtime-environment.ts` awaited the headers and then the first `reader.read()` with no deadline and passed no `init.signal` to `streamingFetch`, so on a half-open path `diagnostics.tsx`'s `finally setRunning(false)` never ran and the button stayed disabled for the session - the class NET-1 closed for `http-transport.ts`, which this call site never got.
**Fix:**
- `runtime-environment.ts:107-108` exports `PROBE_HEADER_TIMEOUT_MS` / `PROBE_FIRST_CHUNK_TIMEOUT_MS` (8 s each), injectable through `ProbeStreamingFetchOptions`; `withDeadline(ms, work, controller)` (`:129`) aborts the one controller and rejects with `timeoutDetail(ms)`, clearing its timer on both settle paths.
- `probeStreamingFetch(healthUrl, options)` (`:162`) passes `init.signal` into `streamingFetch`, bounds the header await and the first-chunk await separately, and in `catch` maps `controller.signal.aborted` back to the deadline message (the chunk deadline when a reader existed) rather than surfacing a raw `AbortError`; `finally` best-effort releases the reader (`cancel()` with a `.catch`, sync throws swallowed). `src/lib/net/streaming-fetch.ts` is untouched, so every other caller keeps its default behaviour.
- `diagnostics.tsx:63-82` keeps the running/disabled logic and adds `inFlight` (a second tap is ignored) and `mounted` (no state write after unmount) refs; the same button is the retry, which now always re-enables.
**Tests:** `__tests__/runtime-environment-test.ts` gains the describe "probeStreamingFetch is bounded on both awaits" - headers that never arrive, an abort-honouring engine still reporting the deadline rather than the `AbortError`, silence after headers, injectable deadlines, and a normal answer unchanged; each asserts `jest.getTimerCount() === 0`. New `__tests__/diagnostics-live-check-bounded-test.tsx` covers the button coming back, a second tap starting no second probe, and an answer landing after unmount.
**Review:** r2 cleared DIAG-1 with no defect - bounded awaits, timer clearing on every path, both guards traced in `diagnostics.tsx:64-70,78,82`, worst-case hold 8 s + 8 s - and recorded one minor point (below).
**Residual:**
- Reviewer minor, author declined: if the header deadline fires and a transport that ignores the signal resolves later, `reader` is still `undefined` in `finally` (`runtime-environment.ts:174,214-223`), so that body is dropped unreleased; harmless on RN's fetch, and closing it needs a decision about whether to await a late response.
- `withHostLookupRetry` may try another IPv4 candidate after the deadline; the controller is already aborted so it fails fast rather than hanging.
- The probe cannot distinguish "half-open" from "slow" - it names the deadline instead.

### R2-SVOICE-2
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED. The voice-capability read was an effect with deps `[readVoiceCapabilities, applyVoiceRead]`, both `useCallback`s over `gatewayRequest`, which is `useCallback([])` in the provider for its lifetime - so nothing in the chain observed `status` and the mount read was the only read that would ever run. The author ADDED that the same staleness runs both ways: a read that succeeds and then loses the Gate keeps printing "ready".
**Fix:**
- `settings.tsx:227` `const connected = status === 'connected'`; the effect's deps become `[connected, readVoiceCapabilities, applyVoiceRead]`, so the read is keyed on the connected/not-connected **edge** rather than every `status` value - a monitor self-heal walks the intermediate statuses without the Gate's voice readiness changing.
- The effect sets `checking` and clears the previous error on entry and re-reads on both edges: a stale failure clears on the way up, and on the way down a read issued while the Gate is away is refused by `gatewayRequest` before it reaches the network, so the rows name that refusal instead of keeping the last "ready".
- `voiceReadRef` (`:128`) is the request counter, and both the effect and `retryVoiceCapabilities` (`:207-218`) take a ticket from it, so a slow older answer cannot land on a newer one.
**Tests:** describe "the voice rows follow the connection (VOICE-2)", 3 cases, all failing pre-fix. Mounting disconnected prints the refusal and an ErrorCard, then the same `gatewayRequest` identity with `status: 'connected'` clears both with nothing saying "Checking this PC...". A read that succeeds then loses the connection replaces "Ready." with the refusal. A first read parked across the status change and answering after the second (7 min vs 42 min usage) leaves the newer answer on screen. `a connection edge mid-write leaves the row on the engine being stored` passes pre-fix by construction - the base commit never re-reads on an edge - and the author does not claim it as a repro.
**Review:** the first review passed VOICE-2, confirming the edge-keyed effect, the shared ticket counter and the three pre-fix failures.
**Residual:** a `connected` edge costs one `voice.capabilities` RPC, and a flapping connection re-reads once per edge, which is the intent. The same effect carries V-1's pending-write guard, which only ever suppresses the `setVoiceEngine` re-assertion.

### R2-LINK-1
**Status:** Fixed (commit 329962d)
**Diagnosis:** CONFIRMED. The audit's mechanism holds — four `void`/`await` call sites with no handler, `attachClient` rethrows an auth refusal, and `confirmDelete` cleared the candidate before the write. CORRECTED by the repair round: the first attempt's own fix introduced a stale-error card that the review rejected, and its double-submit guard read state from the render closure.
**Fix:**
- `gateway-home-dashboard.tsx` `handleSelect` catches `connectGateway` into `connectFailure`; `handleAddDiscovered` catches and returns before `router.push('/chat')`, so navigation only ever happens over a connection that answered.
- `use-gateway-settings-screen.ts` exports `connectThenOpenChat(gateway, connectGateway, openChat)` returning `{ ok: false, error }` instead of navigating; `handleConnect` and `handleAddDiscovered` both use it and set `connectFailure`.
- Stale-error rule on both refusal cards: `shownConnectFailure = connectionErrorShown(status, refusal.message)` (`gateway-home-dashboard.tsx:220-228`, `gateway-management-section.tsx:39-47`), fed the raw refusal text so the `humanizeGatewayError` ErrorCard still reads a refused token. A render-phase `failureStatus` state clears `connectFailure` when `status` turns `connected` — a `useEffect` would be a `react-hooks/set-state-in-effect` lint error.
- Remove now awaits: `executeDelete`/`confirmDelete` keep the sheet and set `deleteFailure` ("<name> is still saved. <message>") on rejection and dismiss only on success; `cancelDelete` clears the failure.
- Double-submit is `deletePendingRef`, set synchronously before the first `await` and cleared in the same `finally` as the state (`gateway-home-dashboard.tsx:66-69`, `use-gateway-settings-screen.ts:58-61`); `deletePending` survives only to render `ConfirmSheet busy`.
**Tests:** `__tests__/gateway-connect-remove-handled-test.tsx` 18 tests (was 13): a connect that answers clears the refusal with no tap, a refusal survives a flip to `reconnecting`, two presses out of one rendered closure produce one `deleteGateway` call, plus source-shape pins for both gates and the ref guard. Changed: the existing "the Home dashboard awaits its delete and keeps the sheet on a refusal" pinned the literal `if (!target || deletePending) return;` — the defective guard — and now pins `deletePendingRef.current` while still pinning the awaited delete and the catch. `home-dashboard-derivations-test.ts` had its frozen `react` import list widened to `useMemo`; `home-failure-error-card-test.ts`'s no-`describeGatewayError` invariant was left untouched by feeding `connectionErrorShown` a message.
**Review:** failed r1, repaired. It caught three real defects — the refusal card outlived the failure it named (contradicting `stale-error.ts`, and the only gateway error on the settings screen, so it never went away), the delete guard read `deletePending` from the render closure so two presses in one frame both fired, and `openTeammateChat`'s `onOpened` sat inside its `try`; plus two test gaps. All repaired as above; the notes record 5 of 18 failing with the fix reverted.
**Residual:**
- The refusal is cleared when `status` turns `connected`, not when a connect is made from elsewhere. A switch that stays `connected` throughout leaves the old refusal in state — hidden by the render gate, shown again if the status later leaves `connected`; not reachable from a refused connect, since a refusal leaves the status off `connected`.

### R2-PRIV-1
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED. `widget-privacy.ts:40-48` was `try { await setItem } finally { notify }` with no `catch`, and the only caller `void`-ed it, so a rejecting AsyncStorage escaped after notifying while the Switch already showed the new value. Every sibling writer in this area (`app-lock.ts`, `budgets.ts`, `approval-policy.ts`) catches and swallows.
**Fix:**
- `src/lib/settings/widget-privacy.ts:48-60` - `saveWidgetResultHidden` returns `Promise<boolean>`: `true` stored, `false` not stored, never throwing, and still notifying in the `finally` because the widget fold re-reads whatever the store holds.
- `src/app/gateway/settings.tsx:419-434` - `handleWidgetPrivacy` `await`s the write and on `false` puts the Switch back to the render-captured `hideWidgetResult` and sets `widgetPrivacyError`; `:539` renders it on the row's own `detail` (`widgetPrivacyError ?? WIDGET_PRIVACY_SUMMARY`), the same surface the other Settings rows use. No `void`-ed rejecting promise remains; the writer cannot reject at all now.
**Tests:** `__tests__/widget-privacy-test.ts` gains 3 cases in an existing describe, no existing assertion changed: a stored write settles `true` without the caller catching; a refused write settles `false`; a refused write still wakes the subscribers. All three fail pre-fix (the promise rejected with "The database is full"). `settings-screen-voice-and-preferences-test.tsx` presses the real Switch with the store refusing `versutus:widget-result-hidden` through the real `keyValueStorage` and asserts the Switch is back to `false` and the row names the refusal - fails pre-fix (the Switch stayed on, nothing shown).
**Review:** the first review passed PRIV-1, confirming the boolean writer, the revert to the render-captured value and the refusal named on the row's `detail`.
**Residual:** the previous value is captured from the render's `hideWidgetResult`, so two toggles inside one tick can revert to a value older than the last one the operator saw. The author left it rather than adding a generation counter for a case the store cannot produce; the window is a single `setItem` round trip.

### R2-BUDGET-1
**Status:** Fixed (commit 958a455). Note the audit's corrected severity is S4 (code hygiene), not the S3 its header carries; the whole finding was in this brief, so nothing is deferred to another package.
**Diagnosis:** CONFIRMED, taking the audit's correction: `spend.tsx:114-118`'s `setBudgets((previous) => { ...; void saveBudgets(next); return next; })` performed the AsyncStorage write inside a React state updater - a contract violation, since React may replay or discard an updater - but not a reachable loss, because `saveBudgets` is an idempotent full-map write that swallows its own errors. The review chased the notes' residual race (`loadBudgets` vs an edit) and found it unreachable: the cap editor only mounts inside `botReport ? <SpendPerBotSection ...>`, long after the fan-out.
**Fix:**
- `spend.tsx:135-138` `handleSetBudget` is now a pure functional update - `setBudgets((previous) => setBotBudget(previous, gatewayId, botId, cap))` - with no I/O in any updater.
- `spend.tsx:146-149` the single `[budgets, budgetsLoaded]` effect is the only writer, so a write is tied to state that committed; a `loadedBudgets` ref plus the `budgetsLoaded` flag (`:119,127`) makes the identity check `loadedBudgets.current === budgets` skip the just-read value.
**Tests:** `__tests__/spend-bot-wave-test.tsx` new describe: "the value read back from storage is not written straight back", "setting a cap persists it exactly once", "two caps set in one tick persist the final map, once". Two existing source-text assertions pinned the buggy shape and were inverted rather than weakened - `__tests__/budgets-test.ts` and `__tests__/spend-read-state-test.ts` now assert `toContain('void saveBudgets(budgets)')` and `not.toContain('saveBudgets(next)')`.
**Review:** r2 cleared BUDGET-1 with no defect, tracing the updater, the effect writer and the identity check by hand and confirming the notes' residual race is unreachable.
**Residual:** setting a cap to exactly the stored value issues a redundant idempotent write (new object, same value), not a lost one.

### R2-DRAWER-1
**Status:** Fixed (commit 329962d)
**Diagnosis:** CONFIRMED — the drawer's own `/v1/bots` read keyed on `[listBots, status]` with a bare `.catch`, re-run on every status flip, and `openTeammate` pushing `/chat` before `openBot` answered. ADDED after review: the shared cache paint the first attempt added was unguarded and could overwrite a fresher live answer, the exact race `chat-screen.tsx:241-251` already guards with `rosterAnsweredRef`.
**Fix:**
- New exported `drawerRosterReadDue(...)` in `side-drawer-content.tsx` with `DRAWER_ROSTER_OFFLINE_REVALIDATE_MS = 10_000` and `DRAWER_ROSTER_STALE_MS = 20_000`: read only on a new gateway, no read yet, an outage of ≥10 s, or a cached copy older than 20 s. `offlineSinceAtRef` is stamped by an earlier effect and consumed by the read effect, so a monitor self-heal is not mistaken for an outage.
- The cache effect reads `readCached('roster', gatewayId, 'bots')`; the live effect calls `listBots()` and then `writeCached('roster', gatewayId, 'bots', bots)` — the same copy the Chat roster writes. A refused read keeps the rows and sets `teamNote` "Couldn't refresh your team · tap to retry", with `retryTeam` clearing the ledger and bumping `retryTick`.
- `liveAnsweredRef` holds the gateway id a live read answered for and makes the cache effect return early on a match, so a late cached copy cannot paint over a live one. An empty-but-ok live read counts; a refused one does not.
- New exported `openTeammateChat` awaits `openBot` first, calls `onOpened` outside the `try`, and returns `{ ok, reason }`; `openTeammate` closes the drawer and pushes `/chat` only on `ok`, otherwise keeps the drawer open and shows the reason line.
**Tests:** `__tests__/drawer-roster-shared-read-test.tsx` 23 tests (was 19). The `readCached`/`writeCached` mock now keys on the namespace too (`${ns}:${gatewayId}:${key}`), so the shared copy is pinned rather than assumed; new cases assert the exact key, that a parked cache read landing after the live answer loses, that a failed live read still lets the cached roster paint, and that a throwing `onOpened` is not reported as a failed open. Reverting the guard fails 1 of 23; a flipped namespace fails 4.
**Review:** failed r1, repaired. It caught the unguarded cache paint (unseen because the test's `readCached` mock resolved immediately) and `onOpened` inside the `try`, which would report "Couldn't open X." for a Bot that had in fact opened and switched session; it also found the shared-cache-key claim unpinned by any test. All three repaired; the notes record the reverting experiments behind the counts above.
**Residual:**
- The drawer keeps its own `rosterReadAtRef` ledger, so it and the Chat roster can each fire one read near a cold start; unifying them means editing `chat-screen.tsx`, which is not in the allowed files.
- `openBot` answering `false` ("the Gate does not expose bots") now shows a generic "Couldn't open X." where it was silent — a message, not the reason; the reason stays on the provider's status line.
- With the `try` narrowed, a throw from `onOpened` now rejects `openTeammateChat`. `requestSurface` is a React state setter and cannot throw today, and the trade is pinned by a test.

### R2-SG-V1
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED. `saveAppSettings` had no `try/catch` around its `setItem` (base-commit `app-settings.ts:50`) and the voice-engine row did `setVoiceEngine(next)` then `void saveAppSettings({ voiceEngine: next })` with no handler, so a failed write became an unhandled rejection while the radio row stayed selected and reverted on the next launch. The author ADDED a second, narrower shape of the same defect that the first attempt introduced by widening the effect for VOICE-2: `setVoiceEngine(stored.voiceEngine)` re-asserted the stored blob on every connection edge, so an edge landing while a write was in flight snapped the row back and the success path never re-asserted.
**Fix:**
- `settings.tsx:284-303` - `handleVoiceEngine` is `async`, `await`s the write, and in the `catch` puts the row back to `previous` (the engine captured before the optimistic set) and sets `voiceEngineError`. The optimistic set stays, so the row still moves under the finger. `:620-623` renders the sentence in the Voice card under the engine rows as a `Text variant="caption" color="tertiary"`, the register the card's other micro-copy uses. No `void`-ed rejecting promise is left in the handler.
- `:133` `voiceEngineWritesRef` is incremented before the write and decremented in a `finally`; the effect's re-assertion at `:239` is conditional on that counter being zero, so a write in flight leaves the row on the value it is storing.
**Tests:** describe "a preference the phone could not store is never claimed (PRIV-1, V-1)". `the voice-engine row goes back to the stored engine when the write is refused` fails pre-fix - the row stays selected and the rejection escapes - while the write is still what was asked for (`{ voiceEngine: 'local' }`). `a stored engine choice stays selected` and `a stored widget preference stays selected` pass pre-fix as the success sides. `a connection edge mid-write leaves the row on the engine being stored` parks the write across `connected -> reconnecting -> connected` and passes pre-fix (see R2-SVOICE-2).
**Review:** the first review listed the edge re-assertion as a minor defect, not verdict-changing on its own, and instructed the repair: guard the re-assertion with a pending-write ref. Done as described. The privacy half of PRIV-1 was verified in the same review.
**Residual:**
- `saveAppSettings` remains capable of rejecting, so the handler's `catch` is load-bearing; the seven provider call sites still `await` it unguarded (out of scope, see R2-SETTINGS-1).
- The guard covers writes in flight when the effect's read settles; a read issued *before* a write and settling *after* it can still assert a blob the write has moved past. Closing that needs a generation counter on the settings blob itself, beyond this package's allowed change, and the window is one `getItem` round trip.

### R2-SG-V2
**Status:** Fixed (commit f696847)
**Diagnosis:** CONFIRMED. The Settings voice effect awaited `loadAppSettings()` with no `try/catch` before the `readVoiceCapabilities()` call, and `loadAppSettings` read through an unguarded `getItem` whose own `try/catch` wrapped only `JSON.parse`. A throwing read rejected the `void`-ed async IIFE, the Gate read never ran, `voiceCheckState` stayed `'checking'`, and the ErrorCard that offers the Retry never rendered - the one wedge VOICE-2's re-read would not have closed.
**Fix:**
- `settings.tsx:231-254` - the whole async body is wrapped in `try/catch`, and every exit, including a throw from either awaited read, lands on `applyVoiceRead({ ok: false, error })`, which is terminal and renders the ErrorCard with its Retry. The `cancelled`/ticket guards are repeated on the catch path so a superseded read cannot settle the state either.
- `app-settings.ts:73-79` - `loadAppSettings` no longer rejects at all (defaults on an unreadable store), so this screen's read is the belt to that suspenders.
**Tests:** describe "the voice check always reaches a terminal state (V-2)", 2 cases. `a storage read that throws settles failed, not checking forever` - `loadAppSettings` rejects once; the screen must show "Couldn't check this PC: AsyncStorage is unavailable", must not show "Checking this PC...", and must render the ErrorCard. Fails pre-fix: it stays on "Checking this PC..." with no ErrorCard. `the check settles on a refusal too, and Retry re-issues the read` passes pre-fix; it is the recovery half that had to keep working.
**Review:** the first review verified VOICE-2 and V-2 together as correct - every exit lands on `applyVoiceRead({ok:false})`, no terminal wedge, no out-of-order landing - and confirmed all three of that group's tests fail pre-fix.
**Residual:** the catch reports a storage failure in the Gate's voice-read slot, the only surface this screen has, so an AsyncStorage refusal reads as a failed check rather than a device-storage failure. Honest (the check genuinely did not complete) and Retry recovers it.

### R2-SG-V3
**Status:** Fixed (commit e9a7a8b)
**Diagnosis:** CONFIRMED, with the audit's line cites corrected (the old effect was at `notifications-section.tsx:50-65` with the `[]` clear at `:60`, not 47-60) and with the premise "the app's other roster reads use the `swr-store` cache" corrected: `readCached`/`writeCached` in `src/context/gateway-provider.tsx` are used for `history`, `models` and `sessions` only, and the sole `'roster'` namespace consumer is `src/components/chat/chat-screen.tsx`; the drawer and Home are plain uncached `listBots()` effects too. The duplicate-read failure is as audited — `listBots` off the provider is an uncached `client.listBots()`, so every `connected` transition spent a fourth roster read, and a refusal cleared the Bot filter to `[]`.
**Fix:**
- `src/components/gateway/notifications-section.tsx` only: added module state (`RosterBot`, `ROSTER_REVALIDATE_MS = 30_000`, `rosterCache: Map<gatewayId, {bots, readAt}>`, `rosterReads: Map<gatewayId, Promise>`, `NO_BOTS`) and a new `readRoster(gatewayId, listBots)` that hands a caller arriving mid-read the same promise, so two instances share one `/v1/bots`.
- The component effect now reads through `readRoster` with deps `[connected, gatewayId, listBots]` and returns without reading when the remembered list is under 30 s old, so a blip, resume or remount costs nothing.
- The `.catch` no longer clears anything: only a landed read replaces the list, so a refusal keeps the rows the operator is looking at; an empty-but-ok answer is still believed.
- The list is derived during render (`rosterBots` from `answered`/`remembered`) rather than `setState` in the effect, which paints the cache before the revalidation answers and satisfies the repo's `react-hooks/set-state-in-effect` rule (an earlier draft that called `setRoster` in the effect body failed eslint).
- Both the cache and the live answer carry the gateway id, so a gateway switch cannot show one Gate's Bots as another's.
- `botFilterRows`, the toggles, `saveBotFilter`/`toggleBotFilter` allowlist writes, quiet hours and NT2's optimistic-write path are untouched (71 insertions, 11 deletions, all in the roster seam).
**Tests:** New `__tests__/notifications-section-roster-cache-test.tsx` (5 tests, harness copied from `notifications-section-state-test.tsx`, one fresh gateway id per test to isolate the module cache): two connects inside 30 s spend one read, a refused re-read keeps the `Alpha` row, a failed first read shows the empty filter with no unhandled rejection, the remembered roster paints before the read lands, and two cards in one tree share one read. Four of the five fail on the pre-fix component (recorded by reverting the file with the edit tool, no stash: 4 failed / 1 passed); post-fix 5 passed. No existing assertion pinned the old behaviour, so no existing test was changed.
**Review:** passed review first time
**Residual:**
- The share is module-level inside this file, so it de-duplicates between copies of this card only — not with Chat, the drawer, Home, Fleet or the widget, which still read the roster uncached; the real fix is a cached `listBots`/roster field on the provider, not an allowed file here. Documented in-source as a fallback.
- The cache is memory-only, so a cold start paints nothing until the read lands (Chat's copy persists to AsyncStorage).
- `gatewayId` falls back to `''` when `activeGateway?.id` is absent, so a mock without an id still gets one bucket rather than silently never reading.

### R2-FLEET-1
**Status:** Fixed (commit e93099f). The same unguarded tap at `src/app/(tabs)/activity.tsx:286` is outside this package's allowed files and is untouched.
**Diagnosis:** CONFIRMED. `handlePressNode` in `src/app/fleet.tsx` ended the gateway branch with a bare `void connectGateway(gateway);` while `connectGateway` (`src/context/gateway-provider.tsx`) awaits `attachClient`, which rethrows on an auth refusal. The provider's `onStatus` already records `lastError`, but no Fleet surface rendered it. The screen had no error surface at all, so one was added.
**Fix:**
- `fleet.tsx` handlePressNode: `void connectGateway(gateway).catch((error: unknown) => setConnectFailure(error))`, clearing both notices first so the next attempt starts clean. Success path is the same call as before.
- New `connectFailure` / `removedNotice` state and a render-time drop (`fleet.tsx:124-149`), shaped like `gateway-home-dashboard.tsx`'s own handling of the same problem, including the `status !== failureStatus` "drop it on the way up" block.
- Visible text comes from `connectionErrorShown(status, ...)` (`src/lib/connection/stale-error.ts`), so a gateway that is answering proves the refusal gone. Provider `lastError` leads; the rejection's own message is the fallback.
- One inline `Text` line between the heading and the map (`fleet.tsx:355-359`) renders it.
**Tests:** new `__tests__/fleet-tap-honesty-test.tsx` `describe('FLEET-1 …')`, 5 tests: a rejecting `connectGateway` leaves `process.on('unhandledRejection')` empty and the notice names the refusal; the provider's words win; an empty rejection message falls back to `lastError`; the line drops when status flips to `connected` with no tap; the next attempt clears it and still calls `connectGateway(away)`. All 5 fail on the pre-fix code.
**Review:** passed review first time (the reviewer verified the `.catch`, the stale-error drop at render and on `connected`, and the precedence).
**Residual:**
- The provider's `probeMessage` still carries the scan theater's own copy; Fleet's line is the route's own, deliberately.
- Fleet's line has no auto-dismiss; it clears on the next tap or on `connected`.

### R2-ONB-1
**Status:** Fixed (commit e93099f). Shared finding: H1 owns the haptics half of this button (this part); SC10 owns the rejection handling, the busy state and the verdict (this part).
**Diagnosis:** CONFIRMED, both halves. `retryAutoConnect` was `await runAutoConnectCycle();` with no handler, and `runAutoConnectCycle` awaits `runAutoConnect`, whose body is `try { … } finally { … }` with no `catch`, so a refusal or any throw rejected the whole cycle. Every internal caller already ends in `.catch(reportAutoConnectFailure)`; the exported one is what buttons call. The screen's press was `onPress={() => void retryAutoConnect()}` with no busy state, and `probeMessage` kept the pre-tap text. Corrected later by the review: the first pass left the block's render condition on `!busy`, which the ladder's own `'searching'` commit makes true, so the busy label was unreachable.
**Fix:**
- `src/context/gateway-provider.tsx` `retryAutoConnect` now ends in `await runAutoConnectCycle().catch(reportAutoConnectFailure);` (dep added). This is the only change in the provider - one statement plus its dep and comment.
- `onboarding-screen.tsx` `handleRetry()`: guarded by a `retryingRef` (a ref, so a second tap in one frame cannot start a second ladder), `setError(null)` so the last retry's card does not sit over this one, and `try/catch/finally` so a rejection is named rather than dropped by the `void` on the press.
- `mountedRef` gates every `setState` after the await, so nothing is written to a dead tree.
- The verdict is judged in an effect (`awaitingRetryPhase` + `connectionPhase === 'failed'`), not where the await returns: the render the tap triggers still carries the pre-ladder phase.
- Button: `label={retrying ? 'Retrying…' : 'Retry'}`, `disabled={retrying}`, `onPress={() => void handleRetry()}`, inside `probeMessage && (retrying || (!busy && connectionPhase === 'failed'))` - `retrying` outranks `busy` so the button survives the whole ladder; every other hiding case is byte-identical.
**Tests:** `__tests__/provider-lifecycle-test.tsx` +1 - `retryAutoConnect()` resolves (not rejects) when the cycle throws and `lastError` is the reported message. `__tests__/onboarding-connect-honesty-test.tsx` `describe('ONB-1 …')`, 5 tests; the fixture drives the mocked phase to `'searching'` and rerenders like the real provider, then to `failed`/`connected`: busy button mounted + disabled + labelled through `searching`, a second tap in that window does not re-call `retryAutoConnect`, an enabled `Retry` is back on `failed`, no card or button after `connected`, and a thrown cycle is named in the `ErrorCard` with nothing claiming to be retrying. Pre-fix on the third pass's revert: 2 of 5 fail, both at `button('Retrying…')` being `undefined` because the block unmounted. Three existing assertions pinned the defect and were replaced with equal-or-stronger ones: `providers-disconnected-retry-test.ts` asserted `toContain('await runAutoConnectCycle();')` (the unguarded form), `onboarding-failed-retry-test.ts` asserted the literal `onPress={() => void retryAutoConnect()}` and later the literal `probeMessage && !busy && connectionPhase === 'failed'`, `onboarding-stage-test.ts` asserted the old button literal.
**Review:** failed review once. The reviewer caught that the busy state was unreachable in production - `busy` is true from the ladder's first phase commit, so the block unmounted and `Retrying…`/`disabled` were dead code - and that the test proving it used a static `'failed'` fixture that hid exactly that. Repair: the render condition now lets `retrying` outrank `busy`, and the test's mocked `retryAutoConnect` drives `connectionPhase` to `'searching'` before resolving. Everything else the reviewer checked (FLEET-1..4, ONB-2, the changed assertions) was verified correct and untouched.
**Residual:**
- A cycle that *throws* leaves the phase in `'searching'` (the provider sets `failed` only on its own non-throwing paths), so after such a retry the operator gets the named `ErrorCard` but no Retry until some later cycle commits `failed`. Provider phase bookkeeping, outside this package's allowed diff.
- The verdict effect can only judge the phase it is given; a cycle that returns early on `connected` shows no card, which is correct.

### R2-ONB-2
**Status:** Fixed (commit e93099f). `buildGatewayCandidates` was not given a diagnostic channel (see Residual).
**Diagnosis:** CONFIRMED, and the brief is precise about the chain. `validatePcAddress` was `trimmed.replace(/:(\d{2,5})$/, '')` - it stripped up to five port digits and validated only the host, never the range - so `100.95.137.83:99999` read ready, was saved as `tailscaleHost`, then `push`'s empty `catch` swallowed `new URL`'s throw and every later wave dropped it. ADDED by the author: the old `\d{2,5}` also meant a one-digit port was never stripped, so `host:1` was rejected outright; the brief requires `:1` to stay valid, so the width had to widen in both places.
**Fix:**
- `src/lib/onboarding/validate-pc-address.ts:9-23` - the port is captured with `/:(\d+)$/`, range-checked against 1-65535 and refused with "Ports go from 1 to 65535." before being stripped. Everything downstream (dotted-decimal-first ordering, `isCanonicalIpv4`, the hostname fallback) is untouched, so every currently valid form behaves as before.
- `src/lib/gateway/candidates.ts:145-156` - `splitHostPort` widened from `\d{2,5}` to `\d{1,5}` so an address the validator calls ready can always form a candidate. A 6-digit port still falls through as before.
- The comment on `splitHostPort` records why an out-of-range port arriving from an already-saved setting is still dropped by `push` while the rest of the wave answers.
**Tests:** `__tests__/validate-pc-address-test.ts` +3 `test.each` blocks - `:1` and `:65535` valid (IPv4 and MagicDNS), `:0`/`:65536`/`:99999`/`:70000` invalid with "Ports go from 1 to 65535.", a no-port address still reads "Looks good - ready to connect.". `__tests__/candidates-test.ts` +2 - `100.95.137.83:1` forms exactly `['http://100.95.137.83:1']`, and an unprobeable `tailscaleHost` is dropped while the rest of the wave answers. `__tests__/onboarding-connect-honesty-test.tsx` `describe('ONB-2 …')` - 6 rendered tests: typing `:99999`/`:65536`/`:0` shows the message, leaves `Connect gateway` disabled and never calls `setupFromPcAddress`; `:1`, `:65535` and a bare IP stay usable. Pre-fix: 7 validator/candidate tests and 4 of the 6 rendered tests fail (the 2 that pass are the "stays valid" cases).
**Review:** passed review first time (the reviewer confirmed the range check happens before stripping, that `:1`/`:65535` stay valid, and that the `\d{1,5}` widening changes no previously-handled form).
**Residual:**
- `buildGatewayCandidates` still surfaces no reason: its only callers are in `gateway-provider.tsx`, and the rules keep this package's provider diff to `retryAutoConnect`, so no caller can pass a diagnostic and no unused parameter was added. The brief's escape hatch was taken - validation refuses the address before it is saved, so a typed address can no longer be the one `push` drops.
- A `tailscaleHost` saved before this fix still degrades exactly as before (empty wave, fallbacks answer).

### R2-CNCL-1
**Status:** Fixed (commit 55c99a2)
**Diagnosis:** CONFIRMED. The pre-fix `finally` in `handleCompare` (`src/app/council.tsx:130-133`) awaited
`botGroups.deleteGroup(roomId).catch(...)` before `setSending(false)`, with `setColumns(result)` already run at `:127`.
The delete is a normal `gatewayRequest` on the 30 s `DEFAULT_TIMEOUT_MS` (`http-transport.ts:6`).
**Fix:**
- `handleCompare`'s `finally` (`council.tsx`) now clears `setSending(false)` + `inFlightRef.current` before any delete starts.
- The delete moved into `dropRoom` (`council.tsx:144-157`): fire-and-forget, no UI state touched.
- It is wrapped in `boundedOperation(..., ROOM_DELETE_TIMEOUT_MS = 8_000)` (`council.ts`, `boundedOperation`), so a lost Gate costs 8 s of a coroutine instead of 30 s of a locked button.
- A delete refused for a reason other than "already gone" keeps its ledger record (`clearPendingRoom` only on success or `councilRoomGone`) so the sweep retries it.
**Tests:** `__tests__/council-screen-test.tsx` "the button returns to Compare without waiting for the room delete" (a `deleteGroup` that never resolves; the label is `Compare`, not disabled, and the ledger still holds the room) and "a refused delete keeps its ledger record for the next sweep and never blocks". Pre-fix the first failed with label `["Asking…"]`.
**Review:** passed review first time
**Residual:**
- The delete is bounded and ignored, not cancelled (the provider may not be edited).
- A room can survive 2 min past the next connected mount if the delete keeps failing.

### R2-CNCL-2
**Status:** Fixed (commit 55c99a2)
**Diagnosis:** CONFIRMED. The guard was `if (!text || targets.length < 2 || sending) return;` read from the same
render closure by two taps, with `disabled={!canCompare}` only applying after a re-render - the same shape the provider
avoids with `autoConnectInFlightRef`.
**Fix:**
- `inFlightRef` (`src/app/council.tsx:80`) is set synchronously at the top of `handleCompare`, before the first `await`; the old `sending` conjunct of the guard was dropped.
- A second tap while the ref is set returns immediately.
- The ref is released in `finally` only when the round is still the current one (`roundRef === token`), so Stop and the 120 s bound also free it.
- The stale closure still holds `prompt`/`targets`, which is correct: a round answers the prompt the operator saw when they pressed.
**Tests:** `__tests__/council-screen-test.tsx` "two taps inside one render make one room and one send" captures one render's `onPress` and calls it twice in one `act`, asserting `botGroups.create` once, `send` once, one delete; pre-fix `create` was called 2x. "a stopped round can be started again immediately" pins the ref is genuinely released.
**Review:** passed review first time
**Residual:** none.

### R2-ONB-3
**Status:** Fixed (commit f0fbdd1). The second-pass list carries no `R2-ONB-3` heading — this site is listed inside R2-HAPTIC-1's *Where* (`onboarding-screen.tsx:50`), so this block is that finding's Onboarding half under the brief's id.
**Diagnosis:** CONFIRMED exactly as scanned, both halves real. In `handleContinue` the raw `await Haptics.impactAsync(Medium)` sat before `setError(null)` and before the `try` opened, so a rejection meant `setWorking(true)` never ran, no navigation, no error card — a silently dead Connect. And inside `catch`, `setError` was the statement *after* `await Haptics.notificationAsync(Error)`, so a failing error haptic swallowed the genuine connect error the operator needed to see.
**Fix:**
- The three raw calls are now `await haptics.medium()` (ahead of `setWorking(true)`), `await haptics.success()` on `result.kind === 'connected'` (ahead of `router.replace`), and `await haptics.error()` in `catch` ahead of `setError`.
- The wrapper cannot reject, so the connect handler always runs, `setError` is reached, and `finally { setWorking(false) }` re-enables the CTA.
- The ErrorCard Try-again path that re-enters `handleContinue` is untouched and still reaches the connect.
**Tests:** four cases in `__tests__/haptics-never-fail-an-action-test.tsx` with `expo-haptics` mocked hostile — connect runs and the failure is named on rejection; a thrown connect still shows the real cause (`keychain`) and returns the CTA; a successful connect still calls `router.replace('/(tabs)/chat')` on a synchronous throw; Try-again still reaches `setupFromPcAddress`. All four were in the pre-fix-failing set (15 of 26 failed with the three files reverted).
**Review:** passed review first time
**Residual:** none

### R2-CNCL-3
**Status:** Fixed (commit 55c99a2)
**Diagnosis:** CONFIRMED, and the same shape the chat screen already fixed as UI-1. The pre-fix `loadRoster` catch did
`setRoster([]); setRosterError(...); setRosterState('failed')` and the effect re-armed on every `status` transition, so
each blip emptied the chips (selected Bots included) and `targets` collapsed to 0.
**Fix:**
- `loadRoster` (`council.tsx:95-125`) keeps `rosterState` at `ready` across a re-read; the `loading` flip happens only when no roster is behind it.
- The catch calls `setRosterState('failed')` only when `rosterRef.current` is empty; the `setRoster([])` is gone.
- `rosterRef` mirrors the roster so the catch can read it without `loadRoster` depending on the state it writes.
- A good read prunes `selected` to the ids it returned, so a Bot still on the roster stays selected.
- When a roster is held and the refresh failed, the chips stay and an inline line (`ROSTER_REFRESH_FAILED_COPY`, "Couldn't refresh the Bot list") with a `Retry` renders beside them (`council.tsx:374-383`).
**Tests:** `__tests__/council-screen-test.tsx` "a failed re-read keeps the chips, the selection, and says the refresh failed" (chips still `Scout/Night/ada`, `Scout` and `Night` still selected, no `EmptyState`, Retry present; pre-fix the chips array came back empty) and "a read that lands after a newer one cannot repaint over it" for `rosterGenerationRef`.
**Review:** passed review first time
**Residual:** No cached-roster-first read - a cold start with no successful read still shows the `ErrorCard`, which the author calls the honest state.

### R2-CNCL-4
**Status:** Fixed (commit 55c99a2)
**Diagnosis:** CONFIRMED. `canCompare` (closed by `sending`) was the only gate, the awaited chain had no timer, and
`runCouncil` (`src/lib/gateway/council.ts:49-66`) isolates a per-target *rejection* only - a member that never answers is a
wait. One wedged Bot held the screen inert with no indication.
**Fix:**
- The Compare button becomes the round's Stop while `sending` (`label={sending ? 'Stop' : 'Compare'}`, `variant` `destructive`); the asking state moved to a caption, "Asking the selected Bots…".
- `handleStop` (`council.tsx:288-297`) takes the next `roundRef` token, clears `inFlightRef`, returns to idle with whatever columns are on screen, sets `COUNCIL_STOPPED_NOTE` ("Round stopped."), and best-effort deletes the room it knows via `liveRoomRef`. A room that only lands after Stop is dropped inside the round and never sent.
- A 120 s wall-clock bound (`COUNCIL_ROUND_TIMEOUT_MS` in `council.ts`) races the round; on expiry it is treated as cancelled - arrived columns keep their answer, the rest become `councilNoAnswerColumns` `failed` / "No answer", with `COUNCIL_TIMEOUT_NOTE`.
- Every `setColumns`/`setError` is guarded by `mine()`, so a late result or failure from an abandoned round cannot repaint.
**Tests:** `__tests__/council-screen-test.tsx` "Stop unlocks the screen at once and the abandoned answer never paints" (immediate `Compare`, note shown, no columns, `deleteGroup` called; the wedged send later resolving plus 120 s more fake time changes nothing), "a stopped round can be started again immediately", "the 120s bound unlocks a wedged Bot and says what is missing"; `__tests__/council-room-leak-test.ts` covers the merge. Pre-fix all three failed - there was no `Stop` button (`["Asking…"]`).
**Review:** passed review first time
**Residual:** The bound settles the screen, not the Gate - a stopped round's POST keeps running server-side while its room is deleted. With today's one-request fan-out there are never partially filled columns, so the "keep what arrived" branch is only exercised by unit test.

### R2-CNCL-5
**Status:** Fixed (commit 55c99a2)
**Diagnosis:** CONFIRMED. `councilRoomName(text)` took the first ~34 chars of the operator's prompt, and create/delete were
paired inside one async function with no persisted intent, so a round the OS killed left the room on the Gate with the
prompt in its name and nothing swept it.
**Fix:**
- `councilRoomName()` (`src/lib/gateway/council.ts`) now takes no argument and returns `COUNCIL_ROOM_PREFIX` + a 4-hex random token; nothing the operator typed can appear, and the prefix still identifies a council room in a Gate-side list.
- A pending-room ledger (`COUNCIL_PENDING_ROOMS_KEY = 'versutus:council-pending-rooms'`, `{ roomId, createdAt }` records, capped at 8) is written by `notePendingRoom` right after `botGroups.create` returns and before the send, and dropped by `clearPendingRoom` once the delete lands or is `councilRoomGone`.
- `sweepPendingRooms` deletes records older than `COUNCIL_ROOM_LEAK_MS` (2 min), keeps any whose delete failed for a non-"not found" reason, and treats a 404 / "Room not found" as success. It runs on mount when connected and after every round.
- All of it is best-effort: storage refusals are swallowed and the network deletes stay outside the ledger's mutation queue. The storage seam (`CouncilRoomLedger`) is an argument, not an import, so the module keeps no native handle.
**Tests:** `__tests__/council-room-leak-test.ts` (new, fake key-value store): a record younger than the bound is left, a failed delete is retried next sweep, a forgotten room settles like a success, a storage refusal never throws, corrupt JSON reads as empty, the ledger caps at 8 and never double-records. `__tests__/council-screen-test.tsx` asserts the created name does not contain the prompt and that the record is written then dropped. `__tests__/council-view-test.ts`: two assertions pinned the old prompt-derived name (`councilRoomName('Compare notes.') === 'Council · Compare notes.'`, and the blank-prompt `comparison` fallback) and were rewritten as "prefix and a 4-hex token"; the `<= 50` cap assertion was kept, reworded.
**Review:** passed review first time
**Residual:**
- Leaked rooms are only collected when the Council screen is next opened; a room survives 2 min past that visit, and only if the app is not killed again first.
- The ledger key is device-wide, so a record written against gateway A is deleted through whichever gateway is connected at sweep time (worst case: one wasted DELETE).

### R2-FLEET-2
**Status:** Fixed (commit e93099f)
**Diagnosis:** CONFIRMED. `constellation-canvas.native.tsx`'s mount effect started `withRepeat(withTiming(1, { duration: 2600 }), -1, true)` unconditionally with `[pulse]` as the only dependency, and `edgeOpacity` wraps every host edge, so a fleet with nothing running paid a 60 Hz UI-thread animation and Skia redraws for the life of the screen. The brief's escape hatch (`shouldPulse` as a pure exported function) was still used, but only as the pure decision - the native canvas renders in jest with Skia and Reanimated mocked, so the animation assertions are on real code.
**Fix:**
- `constellation-canvas.native.tsx:70` - new `QUIET_PULSE = 0.5`, the middle of the breath's own range, so a quiet map looks as it did mid-breath and costs nothing to hold.
- `constellation-canvas.native.tsx:79-81` - new exported `shouldPulse(model)`, reading `model.summary.running` rather than taking a node array, so the animation cannot drift from the summary the HUD line reads (a `routine behind` badge is accent-toned too, but the fleet is not busy).
- The effect (`:112-120`) is keyed on `running`: it starts the repeat only when something runs, and `cancelAnimation` + `pulse.value = QUIET_PULSE` when nothing does. `edgeOpacity` and `runningGlow` still read the shared value, so a quiet fleet's edge opacity is one static number.
- `constellation-canvas-fallback.tsx` and the web canvas never animated and needed no change; `constellation-view.tsx` was allowed and untouched.
**Tests:** new `__tests__/constellation-pulse-test.tsx`, 6 tests. `shouldPulse` directly: false for a quiet fleet, true with a running run, and false for a fleet whose only accent-toned badge is `routine behind` (proves it reads the summary, not the badges). Rendered: a quiet fleet starts no `withTiming`/`withRepeat` at all, a quiet fleet calls `cancelAnimation` and holds `pulse === 0.5`, a running fleet starts the 2600 ms repeat, and running to quiet cancels it with no new repeat. Pre-fix: 3 of 6 fail - the three animation tests; the two `shouldPulse` tests cannot fail against code without the export, which is itself part of the fix (the notes say so rather than claiming otherwise). Re-verified in a later pass by putting the effect body back with the edit tool: 3 failed, 3 passed, by name.
**Review:** passed review first time (the reviewer confirmed `shouldPulse` reads `model.summary.running`, the effect cancels and holds `QUIET_PULSE`, and the canvas really does render in jest). Minor fidelity note from the reviewer: the test's `useSharedValue` mock returns a fresh object per render, so the effect's `pulse` dep is unstable there unlike real Reanimated; the assertions still hold.
**Residual:** none

### R2-FLEET-3
**Status:** Fixed (commit e93099f), by the brief's floor ("at minimum coalesce"); the shared stale-while-revalidate read was not added (see Residual).
**Diagnosis:** CONFIRMED, with the trigger named: the roster effect flipped only a `cancelled` boolean and called `listBots()` with no way to stop it (`listBots` -> `client.listBots()` takes no abort), and `rosterRequest` changes identity on every `status`/`activeGateway` change, so a connection blip mints a second request while the first enumeration is still on the wire. The concrete duplicate is connected -> reconnecting -> connected on the same gateway, not the A/B switch.
**Fix:**
- `fleet.tsx:21-41` - a module-level `Map<string, Promise<PublicBot[]>>` plus `readFleetRoster(gatewayId, listBots)`: a read already in flight for a gateway is joined.
- The entry is released the moment it settles, identity-checked, so a later read cannot be dropped by an earlier one's cleanup and the next wave is a fresh read rather than a replayed answer.
- The existing `cancelled` generation guard is kept, and both callers attach a `.catch`, so the shared rejected promise cannot become unhandled. A superseded request's effect is never started at all, which is the effect lifecycle's own behaviour.
**Tests:** `__tests__/fleet-tap-honesty-test.tsx` `describe('FLEET-3 …')`, 4 tests: a blip while the first read is in flight issues one `listBots` call and the joined answer still paints; a settled read is not replayed (the next wave is a fresh one, 2 calls); switching A -> B reads once each and A's late answer never paints B; coming back to A joins A rather than opening a second enumeration. Pre-fix: tests 1 and 4 fail; 2 and 3 pass pre-fix and are the must-keep-working guards.
**Review:** passed review first time (the reviewer confirmed the per-id coalescing, the identity-checked release, the generation guard, and the `.catch` on both callers; noted the sync-throw parity with the old `void listBots()` is unchanged).
**Residual:**
- The shared `readCached`/`writeCached('roster', ...)` stale-while-revalidate read (what `chat-screen.tsx` and `side-drawer-content.tsx` use) was not added: it is a feature rather than a fix for the duplicate, and not reachable without growing the provider, which the rules forbid here. The brief's own floor was coalescing, which is what landed.
- The per-gateway revalidate window the drawer and chat screen have (so a flapping connection still re-reads periodically) is not implemented; `fleet-roster-state-test.ts` pins the current re-read-on-every-return-to-`connected` behaviour.

### R2-FLEET-4
**Status:** Fixed (commit e93099f)
**Diagnosis:** CONFIRMED. `handlePressNode` in `fleet.tsx` was `if (!gateway || !handshake.canConnect) return;`, so a star naming a profile no longer in `gateways` returned silently on a screen whose own comment promises "never a silent no-op". The Bot branch already answered a missing roster row honestly (`bot ?? { id: botId }`); the gateway branch did not.
**Fix:**
- `handlePressNode` (`fleet.tsx:267-277`) splits the missing-profile case out ahead of the handshake decision: it clears the connect notice, sets `'That gateway was removed'`, bumps the model revision and returns. The handshake gate and the connect call are unchanged for a profile the device still holds.
- `modelRevision` is the "refresh the model" half: the graph is memoized, so without it the dead star would survive on the map with nothing behind it. The memo body reads it explicitly (`void modelRevision;`) so `react-hooks/exhaustive-deps` sees a real dependency.
- The notice renders on the same inline line FLEET-1 uses (`noticeMessage`, rendered at `fleet.tsx:355-359`); the connect failure wins when both are set, and the next gateway tap clears it.
**Tests:** `__tests__/fleet-tap-honesty-test.tsx` `describe('FLEET-4 …')`, 2 tests: capture the `home` star, remove `home` from `gateways`, re-render, press the captured stale node - the notice says "That gateway was removed", `connectGateway` is not called and no rejection escapes; and the next gateway tap clears the notice and connects to the profile still there. Pre-fix: both fail (the tap returned silently).
**Review:** passed review first time (the reviewer confirmed the missing-profile case is split out ahead of the handshake gate and that the notice is set; called the `modelRevision` bump redundant because the memo already depends on `gateways`, but harmless).
**Residual:**
- The notice has no auto-dismiss timer: it clears on the next gateway tap and, for a connect refusal, on `connected`. A removed-gateway notice left alone persists until another star is tapped. A timer would be new behaviour with no prompt behind it.

