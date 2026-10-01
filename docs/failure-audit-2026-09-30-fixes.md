# Failure audit 2026-09-30 - fix log (diagnosis and fix per finding)

Companion to [failure-audit-2026-09-30.md](failure-audit-2026-09-30.md), which lists each failure with where/what/why.

Written after the fixes landed on branch `claude/app-failure-audit-fc957c` (one commit per work package). Each work package was authored by a free `opencode` model (space-bunny-free; longcat-2.5-preview-free stopped answering mid-run), gated by a harness the author cannot edit (typecheck, ESLint, related jest or the Gate suite, no suppressions, no deleted/skipped tests, allowed-files only) and then reviewed by a separate model session that traced the real code path and re-ran the new tests against the pre-fix source. Most packages needed one to four repair rounds after review; the defects those reviews caught are folded into the entries below (look for "CORRECTED"). Nothing here is deployed: the live Gate and the main checkout were not touched.

Status at a glance

| Finding | Status | Package(s) | Commit(s) |
|---|---|---|---|
| BG-1 | Fixed | G4, P1, P2b | `203821b`, `19de6a2`, `4a9e3cc` |
| LIFE-1 | Fixed | P2a | `a59aeb2` |
| LIFE-2 | Fixed | P1, P2a | `19de6a2`, `a59aeb2` |
| GATE-1 | Fixed | G1, G2 | `3399f6e`, `8063ac7` |
| VOICE-1 | Fixed | K1 | `4466fd9` |
| NET-2 | Fixed | A1, G4 | `e21db1c`, `203821b` |
| NET-3 | Fixed | P1 | `19de6a2` |
| LIFE-3 | Fixed | P1, W1 | `19de6a2`, `5d2d9c0` |
| SPD-1 | Fixed | S1a | `511b310` |
| SPD-2 | Fixed | A1, A2 | `e21db1c`, `790a799` |
| SPD-3 | Fixed | S1b | `6dca43c` |
| SPD-4 | Fixed | S1a | `511b310` |
| SPD-5 | Fixed | S1b | `6dca43c` |
| SPD-7 | Fixed | G2 | `8063ac7` |
| GATE-2 | Fixed | G2 | `8063ac7` |
| GATE-6 | Fixed | G3 | `97f25f0` |
| GATE-7 | Fixed | G3 | `97f25f0` |
| SEND-2 | Fixed | G4, P1, P2b | `203821b`, `19de6a2`, `4a9e3cc` |
| SEND-7 | Fixed | M1 | `143d3f7` |
| STORE-1 | Fixed | ST1 | `79b7305` |
| UI-1 | Fixed | S1b | `6dca43c` |
| UI-2 | Fixed | U1 | `3de607a` |
| VOICE-2 | Fixed | K1 | `4466fd9` |
| VOICE-3 | Fixed | K1 | `4466fd9` |
| ENV-1 | Not fixed (needs your action, nothing touched) | - | - |
| NET-1 | Fixed | A1 | `e21db1c` |
| NET-4 | Fixed | A1 | `e21db1c` |
| NET-5 | Fixed | A1 | `e21db1c` |
| NET-6 | Fixed | A1 | `e21db1c` |
| NET-7 | Fixed | A1, A2 | `e21db1c`, `790a799` |
| LIFE-5 | Fixed | P1 | `19de6a2` |
| LIFE-6 | Fixed | P2a | `a59aeb2` |
| LIFE-7 | Not fixed (decision needed) | - | - |
| LIFE-8 | Fixed | P2a | `a59aeb2` |
| SPD-6 | Fixed | S1b | `6dca43c` |
| SPD-8 | Fixed | S1a | `511b310` |
| SEND-3 | Fixed | P2b | `4a9e3cc` |
| SEND-4 | Fixed | P2b | `4a9e3cc` |
| SEND-5 | Fixed | U1 | `3de607a` |
| SEND-6 | Fixed | P2b | `4a9e3cc` |
| STORE-2 | Partly fixed | ST1, ST2 | `79b7305`, `49b7026` |
| STORE-3 | Fixed | ST1 | `79b7305` |
| UI-3 | Fixed | U1 | `3de607a` |
| UI-4 | Fixed | U2 | `6017230` |
| UI-5 | Fixed | U1 | `3de607a` |
| NOTIF-1 | Fixed | M1 | `143d3f7` |
| PUSH-1 | Fixed | G3 | `97f25f0` |
| GATE-8 | Fixed | G4 | `203821b` |
| GATE-9 | Fixed | G4 | `203821b` |
| GATE-10 | Fixed | G4 | `203821b` |
| GATE-11 | Not fixed (decision needed) | - | - |
| GATE-12 | Fixed | G1 | `3399f6e` |
| VOICE-4 | Fixed | K1 | `4466fd9` |
| VOICE-5 | Fixed | K1 | `4466fd9` |
| VOICE-6 | Known / open (unchanged) | - | - |
| TEST-1 | Fixed | M1 | `143d3f7` |
| LINT-1 | Fixed | M1, manual | `143d3f7`, `a699ddd` |
| COV-1 | Not fixed (decision needed) | - | - |
| CFG-1 | Not fixed (low value, your call) | - | - |
| DEAD-1 | Not fixed (refactor, out of scope) | - | - |

### BG-1
*Package G4*
**Status:** Fixed (commit 203821b) — Gate side only; the phone's turn id, cancel call and background handling are P1/P2b's part.
**Diagnosis:** CONFIRMED: `streamBackendTurn` did `res.on('close', () => controller.abort())` on every turn and returned `clientDisconnected || !collected ? null : collected`, with the completion push gated on `if (streamed)`, so a phone that locked mid-reply lost the reply and the notification. ADDED by the author: (1) since the phone's Stop is now `/v1/chat/cancel` with the socket deliberately still open, an abort is no longer "the client walked away" — the runner answers an abort with `ABORTED_OUTCOME = { hasContent: false, aborted: true }` (`gate/core/voice/turn-runner.mjs:294`), so the Gate wrote `empty_turn` to a caller that had just pressed Stop, and `assertChatStreamComplete` throws that before it checks its own signal. (2) Reusing a turn id overwrote the in-flight map entry and the older turn's `finally` then deleted the newer one, leaving the second turn unstoppable, invisible to `close()` (a hang on restart) and uncounted against the cap.
**Fix:**
- `inFlightTurns` `Map` (inside `createGate`, passed into `streamBackendTurn`) keyed `${callerId}:${turnId}` → `{ controller, startedAt, detached, finished, timer }`; `readTurnId()` accepts only `^[A-Za-z0-9_-]{8,64}$`, so any other id means "unnamed" and keeps the old close-aborts behaviour.
- A close on a named, unfinished, un-aborted turn marks it `detached` and arms the age timer instead of aborting; the bounds are `DETACHED_TURN_LIMIT` 8 (a newly closed 9th turn aborts as before), `detachedTurnMaxMs` (default 10 min, env `VERSUTUS_GATE_DETACHED_TURN_MAX_MS`, `createGate` option), and `close()`, which aborts all. `turn.finished` is set in the turn's `finally` and checked first in the close handler, so Node's close-after-`finish` on a completed turn no longer arms a reaper nothing can clear.
- An id already in use is refused before any stream header with `409` `{ error: { code: 'turn_id_in_use' } }` as `application/json`; the entry is released only by the turn that owns it (`inFlightTurns.get(key) === turn`), so a replaced or post-`close()` turn cannot evict the entry its Stop is found through.
- The runner outcome is read as `{ hasContent, report, aborted }`; `stopped = aborted === true || controller.signal.aborted` suppresses both the `empty_turn` frame and the catch arm's error frame, while `finally` still writes `data: [DONE]`. The return is `controller.signal.aborted || !collected ? null : collected`, so a stopped turn stays silent and a detached turn that ran to its end still pushes `final-response`.
- `POST /v1/chat/cancel` (caller-scoped, `{ turnId }` → `{ cancelled }`) is in `isKnownAuthenticatedRoute` and in the manifest as `chatCancel`.
**Tests:** `backend-routes.test.mjs` — a named turn survives a destroyed socket and pushes exactly one `final-response`; no/ill-formed id still aborts the backend; cancel scoping (other caller's id, unknown id, owner, repeat, unauthenticated 401); the 9th detached turn aborts while the first 8 do not, read back from the backend; the age cap at `detachedTurnMaxMs: 40`; `close()` ends a held turn. This pass adds "a stopped turn ends quietly, and is not reported as one that came back empty" (exact body `delta('Partial reply') + 'data: [DONE]\n\n'`; red on the previous commit with the reviewer's `empty_turn` frame) and "a turn id already in use is refused, and the turn that owns it stays stoppable" (409 json, no `x-versutus-session-id`, no second backend send, Stop still reaches turn 1; red on a probe against the old `server.mjs`, where the test's own teardown then hangs in `close()` — the defect). Two `trackLongTimers` tests pin the timer leak: a completed turn arms none (over `http.request` with `agent:false`, since `fetch` pools the socket and the leak cannot happen) and a detached turn does arm one. Pre-existing assertions changed: the manifest drift test's `postOnly` set gained `chatCancel` (the 401 test now carries that coverage); fixture `parkedTurnRegistry(turns, { delta })` gained an optional delta.
**Residual:**
- Suppression is keyed on any abort, so a turn the Gate reaps itself while its client is still connected (the 9th detach, the age cap) now ends in a bare `[DONE]` with no error frame; a named code for the reaped case is one the app does not know.
- The 409 is raised inside `streamBackendTurn`, after the route has resolved the session id, so a refused turn that named no session leaves an empty session behind; moving the check to the route would duplicate the ownership rule.
- `callerId` is the paired device id or `'bootstrap-token'`, so two phones sharing the bootstrap token share a turn-id namespace; and `VERSUTUS_GATE_DETACHED_TURN_MAX_MS` is absent from the `VERSUTUS_GATE_*` list `gate/cli.mjs:848` prints (that file is outside this package's allowed files).

*Package P1*
**Status:** Fixed in part (commit 19de6a2) — the client half: a turn can now be named and stopped server-side, and the aborting socket is no longer the only cancel. Making a turn outlive the socket (Gate-side detach-and-push, provider-side reconciliation) is other packages (this part).
**Diagnosis:** CONFIRMED for the client half: neither client had any `cancelTurn`, and `ManifestClient.streamChat` sent no turn id, so aborting the phone's stream was the only "cancel" and the host kept working. The audit's other two causes — the Gate treating any response close as a stop, and pushing only a turn that completed while connected — are in `gate/`, not this package.
**Fix:**
- `ManifestClient.cancelTurn(turnId)` POSTs `{ turnId }` to the manifest's `endpoints.chatCancel` through the root transport with `CANCEL_TURN_TIMEOUT_MS = 5_000`, returns without any request when the manifest advertises no such route, and swallows failures.
- `HermesGatewayClient.cancelTurn` is a deliberate no-op — a direct Hermes hosts no cancel route — so the provider can call cancel without first asking what kind of gateway it holds.
- The id `streamChat` now sends is what makes the cancel nameable: `createTurnId()` in client.ts, `X-Versutus-Turn-Id` on the manifest POST, announced through `options.onTurnId` before the request.
- `cancelTurn?(turnId)` was added to `PortalClient` as an optional member, so `src/lib/portal/openclaw-adapter.ts` needed no edit.
**Tests:** 4 of the 8 tests in `__tests__/chat-turn-id-cancel-test.ts`: `cancelTurn` POSTs `{turnId: 'turn-123'}` to the advertised `/v1/chat/cancel` and resolves even when the Gate answers 500; it issues no request at all when the manifest advertises no `chatCancel`; the cancel request is bounded by `CANCEL_TURN_TIMEOUT_MS` (5 s) so it cannot hold a sheet open; the Hermes `cancelTurn` makes no request. Additions only.
**Residual:**
- Against a Gate that has not yet shipped `chatCancel` the cancel is silently dropped (the brief's stated behaviour), so on those hosts a user cancel still only stops the local stream.
- Nothing calls `cancelTurn` yet; wiring it into the provider's Stop path is the provider package's job.

*Package P2b*
**Status:** Fixed (commit 4a9e3cc) — phone half only (this part); the Gate half is another package.
**Diagnosis:** CONFIRMED. In `sendMessage`'s `isConnectionError(error)` branch (`src/context/gateway-provider.tsx`) the bubble was marked with `markInterrupted` and nothing else, so with detachable turns a reply that finished while the phone was away stayed invisible until a full reconnect re-read history. The author ADDED that `stopStreaming` aborted only the local fetch, so with detachable turns Stop no longer stopped the work on the Gate.
**Fix:**
- New `turnIdRef` plus `onTurnId` in `sendMessage`; cleared in that send's `finally` only when the slot still holds this send's id, so a second send in the same tick keeps a cancellable id.
- `stopStreaming` calls `clientRef.current?.cancelTurn?.(turnId)` — optional-chained, fire-and-forget, never throwing — before aborting, so the turn actually stops; an older Gate without the route cannot make Stop an error.
- `reconcileInterrupted(gateway)` is now the single settle step (freeze the run id, `reloadHistoryFor`, `preserveInterruptedAfterReload`, settle interrupted runs), shared by `onHealthCheck`, the ladder and the AppState `active` arm instead of duplicated; it and the AppState arm return early while `isSendingRef.current || abortControllerRef.current`, because `reloadHistoryFor` replaces the whole list and a live turn's deltas are matched by id (without that guard, added in round 4, every foreground return repainted the thread and deleted the streaming bubble).
- `scheduleInterruptedRecovery(gateway)` arms 2 s / 8 s / 20 s windows; each re-checks `connected`, no send in flight and an interrupted bubble still present, and stops once none remains. Timers are cleared on unmount, gateway/session/backend change and a new send.
- AppState: a non-`active` state calls `flushTranscripts()` (errors swallowed) so write-behind transcript writes survive a process kill; the `active` arm runs one `reconcileInterrupted` after a successful health check when an interrupted bubble exists (locked-phone return).
**Tests:** New `__tests__/provider-detachable-turn-test.tsx` (28 cases, fake timers): Stop names the `onTurnId` turn before the local abort; a Gate with no cancel route is not an error; two sends in one tick still cancel the running turn; the ladder finds and settles a finished reply inside the windows and keeps looking while interrupted; a thread switch or Bot open drops the ladder; backgrounding flushes transcripts; a foreground return leaves the turn streaming right then alone (red on the round-3 code — its text was gone).
**Residual:**
- Fixed offsets, not the Gate's turn state: a reply landing after +20 s waits for the next reconnect or a manual reload.
- A new send drops the ladder unconditionally, so an earlier interrupted bubble is missed if the operator sends again inside the window.
- The round-4 guard also leaves an interrupted bubble alone for the duration of the next turn, so a send that never ends starves recovery.

### LIFE-1
**Status:** Fixed (commit a59aeb2)
**Diagnosis:** CONFIRMED. `connectGateway` in `src/context/gateway-provider.tsx` cleared `activeHello`, `messages`, `lastError`, `isSending`, `activeRunIdRef` and overwrote `sessionIdRef` before `attachClient`, whose first guard returned at once for the already-connected client of the same gateway — so no `onHello`/`onHealthCheck`/`reloadHistoryFor` ran and nothing refilled the chat.
**Fix:**
- `connectGateway` now returns early when a live client for the same gateway id is `connected`/`connecting`/`reconnecting`: it only persists the active id and re-applies a changed profile object, with no reset.
- The old reset path is untouched for every other case (cold start, real switch, dead client).
- The AppState handler gained `healLiveClient`: on a missed health check it calls `client.forceReconnect?.()`, else `client.resumeReconnect()`, instead of `reconnectLastKnownGateway()`.
- `reconnectLastKnownGateway()` is kept for the no-client case and for a client still `disconnected` after the re-verify; a thrown `healthCheck` is now a miss rather than an unhandled rejection.
**Tests:** `__tests__/provider-lifecycle-test.tsx` (LIFE-1, 2 tests) render the real `GatewayProvider`: a connected client backgrounded then foregrounded with `healthCheck` → null keeps `['ping','pong']`, a non-null `activeHello` and session `live-session`, calls `forceReconnect` once on the same client and never builds a second one (pre-fix: 0 `forceReconnect` calls). The second test — no live client, so `reconnectLastKnownGateway()` still builds one — passed before and after and guards the regression.
**Residual:**
- The early return also covers a deliberate re-connect to the gateway already on screen; that already returned inside `attachClient`, so behaviour is unchanged apart from no longer blanking.
- An `upgrade: true` attach (manifest-arrived rebuild) is unaffected.

### LIFE-2
*Package P1*
**Status:** Fixed in part (commit 19de6a2) — the clients announce and expose the rejection; nothing consumes the signal yet, so the provider-side "no automatic retry after an auth rejection" is another package (this part).
**Diagnosis:** CONFIRMED, and the ordering the audit depends on is exactly as written: both clients call `monitor.suspend()` then `setStatus('disconnected', message)` inside `attemptConnect` before throwing, and `setStatus` fires `onStatus`, so at callback time a wrong key and a dead gateway are the same event with detail text and nothing else.
**Fix:**
- `GatewayClientCallbacks.onStatus` (client.ts) and `PortalClientCallbacks.onStatus` (src/lib/portal/adapters.ts) take an optional third argument `info?: { authRejected?: boolean }`; both private `setStatus` methods take and forward it.
- Only the auth-rejection `setStatus('disconnected', message)` passes `{ authRejected: true }`; no other status call changed.
- Both clients gain a `readonly authRejected` getter over a private flag set on rejection and cleared on the line before `setStatus('connected')`.
- `PortalClient` gains optional `authRejected?: boolean`; every new interface member is optional, so `OpenClawAdapterClient` still satisfies it unchanged.
**Tests:** 6 tests in the same new file, "an auth rejection says so in the status it announces" (both clients × 3): a 401 on capabilities/models yields `onStatus('disconnected', …, { authRejected: true })` and `authRejected === true`; a later good key clears the getter and the flag; a plain connect/disconnect never reports `authRejected`. Additions only.
**Residual:**
- The provider still retries a rejected key until the other package lands; the flag is advisory for now.
- The flag clears only on a successful `connect()`, not on the monitor's self-heal back to `connected`.

*Package P2a*
**Status:** Fixed (commit a59aeb2) — provider side only (this part); the clients' `authRejected` signal is P1's.
**Diagnosis:** CONFIRMED, and the author ADDED a second defect. `onStatus` reached the `decision.scheduleAutoRetry` check while `authFailureRef.current` was still false (set only in the catch after the throw, cleared at the top of every `attachClient`), so the ladder armed on a refused key and each cycle repainted `probeMessage`/`lastError` and threw unhandled. The provider's local `isGatewayAuthFailure` also matched neither client's own refusal, so the required `.catch` behaviour was unreachable.
**Fix:**
- `onStatus` takes `(nextStatus, detail, info)` and raises `authFailureRef` on `info?.authRejected` before the retry decision, then remembers `gateway.token` in a new `authRejectedTokenRef`, sets `lastError` to the detail, sets `probeMessage` to 'Gateway rejected the API key. Update it from the gateway settings.' and clears the pending retry timer.
- `attachClient` clears the flag only when `gateway.token !== authRejectedTokenRef.current`; `retryAutoConnect` always clears both.
- `runAutoConnectCycle` returns while the flag is set, `scheduleAutoRetry` refuses to arm, and `runAutoConnect` no longer repaints while it is set.
- New `reportAutoConnectFailure` records the failure; every fire-and-forget automatic entry point (`deleteGateway`, the retry timer, `resumeAfterRetiredTeardown`, `reconnectLastKnownGateway`, both AppState sites) now ends in it.
- `isGatewayAuthFailure` delegates to the status-aware `isAuthRejection` and additionally matches `rejected the api key`.
**Tests:** 3 tests in `__tests__/provider-lifecycle-test.tsx` (LIFE-2): a refusal announcing `authRejected` then throwing builds one client across 15 s and 5 min of fake time with `lastError` and the auth `probeMessage` intact and no unhandled rejection (pre-fix: 8 clients, message overwritten to 'Auto-connect failed…', rejection reported against the test); a newly saved token gets one attempt; `retryAutoConnect` forces exactly one. `__tests__/session-labels-test.ts` pinned the old bare `void runAutoConnect(...)` text at both call sites and was extended to the `.catch(reportAutoConnectFailure)` form.
**Residual:**
- `connectGateway` still rejects on an auth refusal, so an awaiting UI caller must handle that rejection (pre-existing; the test asserts it explicitly).
- While the flag is set the ladder also stays shut for a gateway that has since become reachable; the retry button or a new token is the way back.

### GATE-1
**Status:** Fixed in part (commit 3399f6e) — this part. Fixed here: the stdin/child `'error'` sites in `jsonrpc-stdio.mjs`, `terminal.mjs`, `local-engine.mjs`, plus new process-level guards. Not here: `gate/core/credentials/windows-dpapi.mjs:71` still does an unlistened `child.stdin.end(...)` (outside the allowed file list); the two other no-listener spawn sites the audit names (`native-server.mjs`, `stdio-server.mjs`) were fixed in a different package (8063ac7).
**Diagnosis:** CONFIRMED, with one addition. Node turns an unlistened `'error'` into an uncaught exception and nothing in `gate/` installed a handler, so the Gate died. ADDED: a spawn failure emits `'error'` then `'close'` and **never** `'exit'` (probed with `node -e` on `local-engine`), so the pre-existing `closed`/`exitCode` guards could not help — `createStdioJsonRpc`'s `write()` called `child.stdin.write(...)` with only an `exit`-driven `closed` flag, `createTerminalSessions`'s `session.write()` did `child.stdin?.write(...)`, and `LocalEngine._ensureWorker()` only had `child.on('exit')`.
**Fix:**
- `gate/core/cli-environments/jsonrpc-stdio.mjs`: one `fail(reason)` closure (`:41`) now owns every death — marks closed, reports via `onDiagnostic`, rejects all pending requests naming the cause. Wired to `child 'exit'` (`app-server exited with code N`), `child 'error'` (`:50`, `app-server failed to start: …`), `child.stdin 'error'` (`:52`, `app-server stdin failed: …`).
- `write()` (`:75`) now also refuses with the existing `app-server is not running` error when stdin is missing/destroyed/not writable, so a post-death request fails synchronously instead of raising another async `'error'`.
- `gate/core/cli-environments/terminal.mjs`: `closeWithError(message)` (`:111`) deletes the session and calls `onError` once (the `sessions.delete` returning false is what makes "once" true); it serves both `child 'error'` (`:116`) and the new `child.stdin 'error'` (`:121`). `session.write()` throws `terminal session has exited` when stdin is missing, destroyed or not writable. `owner`, output chunking and `killTree` untouched.
- `gate/core/voice/engines/local-engine.mjs`: `_ensureWorker()` (`:97`) adds `child.on('error')` (`:117`) that logs `voice worker failed: …` on the engine's `'log'` event and funnels through a one-shot `onDeath` (`:111`) into `_onExit(null)`, so a missing python spends one restart from the backoff budget instead of killing the Gate.
- New `gate/core/process-guards.mjs`: `installProcessGuards({ log, exit, proc })` survives `EPIPE`/`ECONNRESET`/`ERR_STREAM_DESTROYED`/`ERR_STREAM_WRITE_AFTER_END`, logs an isolated rejection and exits 1 when more than 20 land in a rolling 60 s window, exits 1 on any other exception; returns `uninstall()`, idempotent per `proc` via a module `WeakMap`. Called once in `gate/cli.mjs:405`, after the lock/shutdown handlers and before `createGate`.
**Tests:** 14 new tests in `__tests__/jsonrpc-stdio.test.mjs`, `terminal.test.mjs`, `voice-local-engine.test.mjs` (extended) and `process-guards.test.mjs` (new). They drive an `EPIPE` `stdin` `'error'` next-tick and assert nothing throws uncaught, the in-flight request rejects naming EPIPE, `onDiagnostic`/`onError` sees the cause, the next write is refused with the not-running/exited error, a `null` stdin is refused not written, and a spawn `ENOENT` restarts the voice worker once (one `schedule`, `voice.open` re-run) then ends the call with one fatal `worker-exhausted`. `process-guards.test.mjs` uses a fake `EventEmitter` proc: all four survivable codes, unknown error exits 1, 20 rejections survive / the 21st exits, double install registers one handler. No pre-existing assertion pinned the defect and none was changed; the three extended files only had their fake children made realistic (`stdin` became an `EventEmitter`, terminal fake gained `writable`). All 14 fail on the pre-fix sources (author-verified).
**Residual:**
- `windows-dpapi.mjs:71` — same defect shape, unlistened `stdin.end`; the new guard keeps it from taking the Gate down but the stream still has no local handler.
- A stdin `'error'` in `terminal.mjs` tears the session down without `killTree` (as the brief specified); if such an error ever arrived with the child alive, `closeAll` could no longer reach it.
- The rejection window uses the real clock (no injected `now`), so "rejections spread over more than 60 s do not exit" is reasoned, not tested.
- Suite state after the commit: gate tests 1179/1179, `scripts/` tests 20/20, tsc and eslint clean.

### VOICE-1
**Status:** Fixed (commit 4466fd9)
**Diagnosis:** CONFIRMED as briefed. The playback body was an inline `Thread { while (running) { … Thread.sleep(5) … } }` in `HandsfreeGateMedia.startPlayback`, and `stop()` set `running = false` then `playbackThread?.interrupt()`; with an empty buffer (most of a call) the thread sits in the sleep, the interrupt escapes the lambda and reaches Android's default handler, killing the process. The author ADDED that the capture thread body had no guard at all, so it had the same exposure.
**Fix:**
- New `PlaybackLoop.kt`: pure class with injected `isRunning`/`drain`/`write`/`sleepMs`; `run()` wraps the whole loop, `catch (_: InterruptedException)` restores the flag via `Thread.currentThread().interrupt()` and returns, `catch (_: Throwable)` ends the loop, nothing propagates.
- `HandsfreeGateMedia.startPlayback` (:279-285) now only constructs and runs `PlaybackLoop`, so the interrupt can no longer reach the default handler.
- The capture thread body is wrapped the same way inline (`InterruptedException` → restore flag, `Throwable` → end), HandsfreeGateMedia.kt:237-241; correctness now rests on `running`, not on the interrupt.
- `stop()` behaviour is unchanged (flag first, interrupt only as a wake-up); a comment at :100 says so.
**Tests:** new `PlaybackLoopTest.kt` (5 tests): an interrupting `sleepMs` returns normally and leaves the interrupt flag set; a throwing `write` ends the loop after exactly one write; the loop exits when `isRunning` goes false; drained audio reaches `write`; an empty buffer sleeps rather than spins. Compiled against a copy of the old unguarded loop the first two fail with `InterruptedException`/track error escaping `run()`. No pre-existing assertion pinned the defect; none changed.
**Residual:**
- Capture/VAD loop bodies are guarded inline, not extracted, because their `AudioRecord` dependency is not unit-testable here — only `PlaybackLoop` has JVM coverage.

### NET-2
*Package A1*
**Status:** Fixed (commit e21db1c) — this part: the phone-side idle watchdog only. The Gate-side `X-Versutus-Keepalive-Ms` header and `: keepalive` frames are another package's job, so a server that does not send the header still gets no watchdog.
**Diagnosis:** CONFIRMED, plus a BLOCKING defect the author found in his own pass-1 code. `streamSSE` had no idle bound, so a half-open socket left `isSending` true until Stop. Worse, the first stall path called `reader.cancel()` *before* `failStalled(error)`; on a spec-compliant `ReadableStream` `cancel()` synchronously settles the pending `read()` with `{ done: true }`, that resolution is enqueued as a microtask ahead of the rejection, and `Promise.race([reader.read(), abortSeen, stalled])` won with `{ done: true }` — `streamSSE` resolved `false` and `StreamStalledError` was dead code on any real stream (expo/fetch builds `response.body` as a plain WHATWG stream).
**Fix:**
- New `StreamStalledError` (`src/lib/gateway/errors.ts`, message `The gateway stopped responding mid-stream.`); `isConnectionError` returns true for it, so chat marks the bubble interrupted.
- `idleTimeoutFrom()` (`http-transport.ts:38-42`) defaults the bound to 3× `X-Versutus-Keepalive-Ms`, and returns no watchdog for a missing, malformed or non-positive value — or for a non-positive `options.idleTimeoutMs`, which would otherwise mean "stall instantly".
- The idle timer rejects first and lets the existing `finally` do the reader release, so the socket is still released and the caller gets the stall error instead of a clean `false`.
- `HttpTransport` gained an optional `onNetworkTrouble?(reason)` constructor option (called via a `try/catch` wrapper that never throws) fired on timeout, connection error and stall; no caller wires it yet.
**Tests:** `__tests__/http-transport-test.ts`, all rewritten onto a real `new ReadableStream({ start() {} })` (the old fixtures wrongly replaced it) — `silence past the keepalive watchdog rejects with StreamStalledError`; `the stall releases the real stream but still rejects with the stall error` (asserts the source's `cancel()` ran *and* the promise rejected); `onNetworkTrouble fires when a stream stalls`; `a server without the keepalive header gets no watchdog`; `comment-only keepalive frames reset the watchdog` (`: keepalive` every 15 s for 75 s then clean EOF); `an idleTimeoutMs of zero arms no watchdog`; `isConnectionError recognizes a stream stall`. Author-verified: reverting `failStalled` after `reader.cancel()` fails the first three, reverting the `idleTimeoutMs` guard fails the sixth.
**Residual:**
- `streamRunEvents` (`client.ts:664`, `manifest-client.ts:1022`) now rejects with the stall error instead of ending silently as if the turn completed — the required behaviour, but how each caller's surface renders it is outside this package's allowed files.

*Package G4*
**Status:** Fixed (commit 203821b) — Gate side only; the phone's stall watchdog is A1's part.
**Diagnosis:** CONFIRMED (this part): none of `streamBackendTurn`, the `/v1/runs/:id/events` relay, `/v1/environments/:id/runs/:run/events` or `/v1/terminal/stream` wrote a heartbeat, and each wrote the `text/event-stream` triple by hand. ADDED: a heartbeat cannot simply be added to the run relay — it is the only raw-byte writer (`res.write(chunk)` at arbitrary boundaries), so a comment between two chunks terminates a half-written line and both app consumers swallow the resulting `JSON.parse` failure (`src/lib/gateway/client.ts:666`, `manifest-client.ts:1000`), losing possibly the terminal event with no error. The author also found two provider-path responses advertising a cadence they never sent, and the two archive branches advertising one they cannot.
**Fix:**
- New `gate/core/sse.mjs`: `KEEPALIVE_MS` (15000), `sseHeaders(extra, { keepalive })`, `startSseKeepalive(res, { intervalMs, canWrite })` (unref'd timer, stops on `close`/`finish` and on an ended/destroyed `res`, idempotent `stop()`), `createSseFrameTracker()`.
- All four SSE routes use `sseHeaders()` + `startSseKeepalive`; headers are still written before slow work. `createGate({ keepaliveIntervalMs })` injects the cadence.
- The run relay pushes every chunk it writes into the tracker and passes `canWrite: () => frames.atBoundary` (4-byte latin1 tail, so a split multi-byte character cannot shift the answer); the archive still gets raw upstream bytes, so a replay is byte-identical.
- `relayNormalizedSse` and the local-interface iterator branch of `chatViaProviderService` now send the heartbeat the headers promise; `keepaliveIntervalMs` is threaded from `createGate` through `proxyChat` → `relayNormalizedSse`.
- Both archive branches of `/v1/runs/:id/events` pass `{ keepalive: false }`, so a complete replay does not promise a heartbeat.
**Tests:** new `gate/__tests__/sse-keepalive.test.mjs` (9) — `sseHeaders` contents/cadence; comment frames on a fake response, nothing after `end()`, idempotent `stop()`, nothing written to a destroyed one; three route-level tests (chat turn, run relay, terminal) on a real Gate with a silent stub backend assert `x-versutus-keepalive-ms: 15000` and a frame actually received; one proves the heartbeat is a comment by reading only `data:` lines. Plus "a relayed run stream is relayed byte for byte, heartbeats only at frame boundaries" (red without `canWrite`: `a keepalive was injected at byte 92, which is not an SSE frame boundary`) and "a run replayed from the archive does not advertise a heartbeat it never sends" (red on the previous commit: `'15000' !== null`). `provider-chat-abort.test.mjs` adds a silent reasoning vendor that gets `: keepalive` and still completes, and the same for the iterator branch.
**Residual:**
- A run whose current upstream line never ends gets no heartbeat until it does; inherent to a byte-for-byte relay.
- One trap in the fixture worth keeping: Node does not flush a `writeHead` until the first `write`, so the fake vendor calls `res.flushHeaders()`.

### NET-3
**Status:** Fixed (commit 19de6a2)
**Diagnosis:** CONFIRMED. `withGetSessionsRetry` (src/lib/gateway/get-sessions-retry.ts) hard-coded `GET_SESSIONS_ATTEMPT_TIMEOUT_MS = 8_000` per attempt and retried twice on anything `isConnectionError` matched — that predicate's regex in src/lib/gateway/errors.ts includes `timed out|timeout`, so a per-attempt timeout got the full 3-attempt ladder. Author ADDED: the Gate's own ceiling is real (`readTimeoutMs = 30_000` in gate/core/cli-environments/backends/hermes.mjs) and the client simply never used it, and a timeout needs its own budget precisely because the abandoned attempt keeps running on the Gate.
**Fix:**
- `withGetSessionsRetry(getOnce, options?: { limit?: number })` uses `GET_SESSIONS_LARGE_ATTEMPT_TIMEOUT_MS = 30_000` when `limit > GET_SESSIONS_LARGE_LIMIT = 50`, and keeps 8 s for `limit <= 50` and for an unknown limit.
- `isAttemptTimeout` (matching the transport's own `Request timed out: …` text) caps retries at 0 for a large read and 1 for a small one; 5xx and genuine network errors keep the full `GET_SESSIONS_MAX_RETRIES = 2` ladder; 404 is still never retried.
- `ManifestClient.getSessions` and `listBotSessionCatalogue` pass `{ limit }`; `HermesGatewayClient.getSessionsFromPath(path, limit)` passes it through with the `/v1` → `/api` 404 fallback left single-shot.
- The existing exported constant names are unchanged; the new large constant is re-exported from client.ts.
**Tests:** 6 tests appended to `__tests__/gateway-get-sessions-retry-test.ts` ("a session-list read is budgeted by how much it asks for"), using a fetch that only ever ends by its own abort signal: the 50 → 8 s / 51 → 30 s / unknown → 8 s boundary; `limit=20` throws on the second timeout and never makes a third attempt; `limit=200` is still unsettled at 24 s (where the old policy had already thrown) and ends on one attempt at 30 s; a 503 on a large read still retries and succeeds; `ManifestClient.getSessions(200)` gets 30 s single-shot, `(20)` keeps 8 s + one retry. The pre-existing 404-fallback and 503 tests were left untouched and still pass.
**Residual:**
- Worst case for a large read on a 5xx-ing host is now ~3 × 30 s + 2 s backoff ≈ 92 s, inherent in matching the Gate's ceiling; the pre-existing 26 s arithmetic for the small read still holds.
- `listBotSessionCatalogue` was threaded although the brief named only `getSessions` — same helper and same read, and its default limit is small so nothing changes for the per-Bot spend read.

### LIFE-3
*Package P1*
**Status:** Fixed in part (commit 19de6a2) — the fast verdict path and the client surface are in, but nothing calls `nudge` automatically: `HttpTransport` in this tree has no `onNetworkTrouble` option, which belongs to the transport package (this part).
**Diagnosis:** CONFIRMED. `ConnectionMonitor` (src/lib/gateway/connection-monitor.ts) had one sampling path, the `HEALTH_INTERVAL_MS = 30_000` tick with `HEALTH_FAILURE_THRESHOLD = 2`, so 42–72 s, and no public method asked for a verdict sooner. Author ADDED: a nudge verdict passes through the same `recentlyServedUs` masking as a tick, so a gateway that answered anything recently is excused by policy, not by accident.
**Fix:**
- `ConnectionMonitor.nudge(reason)` with exported `NUDGE_REPROBE_DELAY_MS = 2000` and `NUDGE_COOLDOWN_MS = 5000`; it refuses when suspended, when no `probe` is wired, while a probe is in flight, inside the 5 s cooldown, or when `timer` is null so a never-started monitor is never woken into polling.
- `tick()`'s body was split into `runProbe()` and `recordProbe(healthy): boolean` so a nudge folds into the failure streak exactly as a tick does.
- A lone nudge failure schedules one re-probe 2 s later (two quick failures reach `reconnecting` at ~2 s); once the second failure declares the path down the re-probe chain stops and the existing reconnect ladder owns recovery. `stop()` clears the pending re-probe and resets the cooldown; `noteConnected()` clears the pending re-probe.
- Both clients expose `nudge(reason)` and `forceReconnect()` (`setStatus('reconnecting', 'Checking the connection')`, then the single-flight `connect()` with no teardown); `PortalClient` gained both as optional members.
**Tests:** 7 tests appended to `__tests__/connection-monitor-test.ts` ("ConnectionMonitor nudge"): healthy nudge probes once and moves nothing; a dead gateway is not `reconnecting` at 1.99 s and is at 2.0 s with 2 probes, then hands over to the ladder; two nudges inside the cooldown probe once; a suspended nudge is inert; a never-started monitor gains no interval; a probe-less monitor cannot be nudged; the recent-answer excuse matches the interval's. Client wiring: 4 more tests in the cancel-safe file (`reconnecting` in ~2.5 s via nudge; `forceReconnect` announces "Checking the connection" first, then one attempt on the same client). All additions — no existing assertion changed.
**Residual:**
- `nudge` has no automatic caller yet; each client carries only the `// onNetworkTrouble: (reason) => this.nudge(reason) — wired when HttpTransport grows onNetworkTrouble` note beside its transport construction.
- A nudge failure is still forgiven when the gateway answered anything in the last 30 s — same policy as the interval, left deliberately.
- `nudge`'s `reason` is accepted but not interpolated into status text, so the announced detail is unchanged from the interval's.

*Package W1*
**Status:** Fixed (commit 5d2d9c0) — this part. The transport→monitor wiring only; the audit's other LIFE-3 observations (no NetInfo/expo-network dependency, 30 s `HEALTH_INTERVAL_MS` × `HEALTH_FAILURE_THRESHOLD = 2`, 30 s request timeout, no stream watchdog) are unchanged by design.
**Diagnosis:** CONFIRMED as briefed, with one correction of emphasis. `HttpTransport` already took and called `onNetworkTrouble` (`http-transport.ts:18`, fired at `:114` from the timeout branch `:169`, the connection-error branch `:173` and the SSE idle watchdog `:217`), and `ConnectionMonitor.nudge` already existed (`connection-monitor.ts:147`) behind `HermesGatewayClient.nudge` (`client.ts:288`) and `ManifestClient.nudge` (`manifest-client.ts:287`); both clients carried only the TODO placeholder (`client.ts:126`, `manifest-client.ts:88`), and `ManifestClient`'s second transport `rootTransport` had no placeholder at all — that is the transport every real answer lands on. ADDED: the `update()` trap is worse than one site, `HttpTransport.update` replaces `this.options` wholesale (`http-transport.ts:80`) and all four call sites pass a full option set, so a constructor-only hook would be silently dropped by the first profile change. CORRECTED: the brief's "~2 s" wording — `recordProbe` forgives a failure while `recentlyServedUs` is true (`connection-monitor.ts:216-219`), so a transport trouble can never be the first counted failure on a live client; in practice the trouble's probe is the second counted sample and `reconnecting` lands at the trouble. The feedback guard was already correct, so nothing had to be built there.
**Fix:**
- `HermesGatewayClient`: `onNetworkTrouble: (reason) => this.nudge(reason)` passed to the constructor `HttpTransport` (`client.ts:126`) and restated in `updateProfile`'s `transport.update(...)` (`client.ts:173`); TODO replaced by a comment on why.
- `ManifestClient`: the same hook on both constructed transports — `transport` (`manifest-client.ts:88`) and `rootTransport` (`:93`) — and on both `update(...)` calls in `updateProfile` (`:157`, `:163`).
- No interval, threshold, delay or reconnect-ladder constant changed; `connection-monitor.ts` untouched, so the existing `suspended` / `probing` / `!timer` guards and `monitor.stop()` in `disconnect()` are what make a late timeout on a discarded client a no-op.
**Tests:** new `__tests__/gateway-network-trouble-test.ts` (10 tests — each case runs against both clients via a path-routed fetch mock that counts `/health` hits) covers: a `getSessions()` read held past `GET_SESSIONS_ATTEMPT_TIMEOUT_MS` → exactly one probe after the timeout and `reconnecting` without waiting for the 30 s tick; a real `ReadableStream` that never yields a byte plus `X-Versutus-Keepalive-Ms` → one probe, status still `connected`, nothing queued 10 s later; ten troubles in 5 s → one probe; trouble after `disconnect()` → no probe, no status move, `jest.getTimerCount() === 0` (that test first proves the same trouble *does* probe on the live client, so the silence is the guard and not a mock that never fires); `updateProfile` keeps the hook (fails without the `update(...)` sites). `__tests__/connection-monitor-test.ts` gains *trouble reported by the monitor's own probe does not chain more probes* — the probe takes 6 s, longer than `NUDGE_COOLDOWN_MS`, and nudges from inside itself, so the cooldown is not what stops the recursion; asserts 2 probes and `reconnecting`. Red/green: with all four hook lines removed the new suite fails 8 of 10; deleting the `probing` guards makes the monitor test report 5 probes instead of 2. No pre-existing assertion pinned the defect and none was changed; the existing two-failures-in-~2 s case (`connection-monitor-test.ts:325`) still pins the monitor-level behaviour.
**Residual:**
- `connection-monitor.ts` left unchanged deliberately: a nudge whose probe fails while `recentlyServedUs` is still true is excused and `probeNow` re-arms the re-probe (`:165-170`), so a gateway that streams frames but refuses `/health` is probed every 2 s until contact goes stale. Pre-existing and reachable from the public `nudge`; capping it would move monitor behaviour the brief froze. Flagged, not fixed.
- A trouble raised while a `connect()`/`reconnect()` is already in flight costs one extra `/health` probe (monitor already started, cooldown does not block the first nudge) — bounded at one per 5 s on an already-failing path.
- Reviewer-declined: no `netinfo`/`expo-network` event source was added; the detector stays transport-driven. Suite state after the commit: 651 suites / 6471 tests pass, tsc and eslint clean (1 pre-existing eslint warning at `connection-monitor-test.ts:248`).

### SPD-1
**Status:** Fixed (commit 511b310)
**Diagnosis:** CONFIRMED. `ManifestClient.attemptConnect` (`src/lib/gateway/manifest-client.ts`) proved the token with `await this.getModels()` and threw the catalogue away; `attachClient` in `src/context/gateway-provider.tsx` then fetched the manifest again after a `live` attach, and awaited `client.getModels()` again for the default-model pin before returning.
**Fix:**
- `probeAuth()` (`manifest-client.ts:349`) replaces the catalogue proof: an authenticated GET on the cheapest advertised route (`endpoints.environments`, then `providers`, then `models`) over `rootTransport` with `AUTH_PROBE_TIMEOUT_MS = 10_000`; result discarded, `getModels()` unchanged for the picker, and the existing `isAuthRejection`/non-blocking branches in `attemptConnect` are untouched.
- The post-connect manifest fetch is now gated on `if (attachSource !== 'none') return;` (`:2128`), so a `live` attach does not re-read the document `manifestForAttach` just served; `adoptLiveManifest(manifest, source)` (`:1813`) carries the publish for the `none` upgrade path and for the cached path's `onLive`.
- The default-model pin moved to `scheduleConnectedRead(CONNECT_DEFAULT_MODEL_DELAY_MS, …)` (1000 ms) as a fire-and-forget `void (async () => …)` with an added `isCurrent()` check, so `connectGateway` resolves while the read is in flight. Pin logic unchanged.
- `refreshedManifest` holds the background answer so the attach's `setActiveManifest(refreshedManifest ?? manifest)` cannot overwrite a fresher document; the refresh keeps DNS-fallback retry coverage via `manifestRetryIps()`.
**Tests:** `__tests__/manifest-client-test.ts` — `the auth proof takes the cheapest advertised route, not the catalogue`, `a manifest without environments falls back to providers, then to models`, `a refusal from the cheapest route still surfaces as an auth failure`, `a probe that fails for any other reason does not block connect`. `__tests__/gateway-provider-connected-reads-test.tsx` — `a live-served manifest is not fetched again after connect` (one fetch), `a cached manifest refreshes in the background and is published when it lands`, `the connect does not wait on a model catalogue read for its default pin` (a never-settling `getModels`). Existing source-pinned assertions in `gate-attach-manifest-miss-test.ts` followed the moved code (`if (lateManifestUpgradesClient(source, manifest))`, the `loadCached` line, the new `attachSource !== 'none'` guard); none weakened.
**Residual:**
- The default-model pin now lands ~1 s after connect instead of before `connectGateway` returns; nothing downstream reads it at return time, and a superseding attach cancels the timer.
- A third-party manifest advertising an *unauthenticated* `environments` route would stop `probeAuth` catching a bad token. Reviewer-raised, matches the brief as written, deliberately not `withScope()`-scoped.

### SPD-2
*Package A1*
**Status:** Fixed (commit e21db1c)
**Diagnosis:** CONFIRMED. `probeHighPriorityCandidates` in `src/lib/gateway/probe.ts` used `Promise.allSettled` over the wave, so one black-holed candidate held the whole wave for `GATEWAY_PROBE_PARALLEL_TIMEOUT_MS = 10 s` even when another answered in tens of milliseconds. The author's pass-1 replacement then had a new problem: `preferManifest` asked the remaining successes about their manifest one after another, i.e. up to 4 × 10 s inside the connect path.
**Fix:**
- The wave launches every probe concurrently and resolves as soon as a success arrives for the highest-priority candidate still running; a lower-priority success waits at most `PROBE_PRIORITY_GRACE_MS = 400` for higher-priority ones, then the best success on hand is taken (`probe.ts:127-198`).
- Unsettled probes are aborted through a new optional `signal` parameter on `probeGatewayUrl`, which reports such an abort as `code: 'closed'`, not `timeout`. Signature and result shape unchanged.
- A `.catch` around the manifest step so a throw there can neither leave the wave pending nor raise an unhandled rejection.
- `preferManifest` still asks the chosen success first, but the remainder is now raced with `Promise.any` (`probe.ts:223-235`): first manifest hit wins, else the chosen success with `hasManifest: false`. Worst case is one chosen budget plus one fallback budget.
**Tests:** `__tests__/probe-fallback-parallel-test.ts` — `a fast success returns before a black-holed candidate settles` (fake timers; the black-holed probe's signal is asserted `aborted === true`); `a higher-priority success within the grace wins over an earlier lower one`; `a lower-priority success stands when a higher-priority probe stays black-holed`; `races the fallback manifest checks instead of asking one at a time` (four successes, three gated: all four manifest reads asserted in flight at once, then `b:8642` is released; fails against the serial loop). `checks the chosen success's manifest first, then falls back to another success` was rewritten in pass 1 because it pinned the old parallel fan-out SPD-2 replaces; its outcome assertions are unchanged.
**Residual:** none.

*Package A2*
**Status:** Fixed (commit 790a799)
**Diagnosis:** CONFIRMED, mechanism added by the author (this part; the first-success wave and the 400 ms grace landed in A1/e21db1c). `src/lib/gateway/probe.ts` had `PROBE_PRIORITY_GRACE_MS = 400`; `evaluate()` (probe.ts:169) starts that grace as soon as any success lands, and `finish()` (probe.ts:146) then takes the best success and aborts the rest. Against a path measured at 0.9–1.7 s RTT with loss — the reason the probe timeouts are 12 s / 10 s parallel (probe.ts:12-13) — a healthy priority-0 Versutus Gate was aborted at 400 ms before its manifest check, and a priority-1 bare Hermes `/health` answering in 50 ms locally won.
**Fix:**
- probe.ts:24 — `PROBE_PRIORITY_GRACE_MS` raised 400 → 2500, still exported.
- probe.ts:16-23 — the comment now states the relay measurement and why the wait must outlast one hop without becoming a second copy of the 10 s parallel timeout; probe.ts:164-168 — stale "short grace" wording in `evaluate()` names the constant.
- Nothing else changed: immediate resolve when the highest-priority still-pending candidate succeeds, abort of unsettled probes in `finish()` (probe.ts:153-155), the raced `preferManifest`, the `ProbeResult` shape and `hasManifest` are untouched. A black-holed higher-priority candidate now costs at most 2.5 s instead of the full 10 s.
**Tests:** `__tests__/probe-fallback-parallel-test.ts` — added `a priority-0 gate on a slow relay outranks a priority-1 /health that answers first` (priority-0 at 1500 ms, priority-1 at 50 ms, 10 s budget: priority-0 wins, `/.well-known/gateway.json` fetched for `slow-gate` first, `hasManifest === true`); red under the 400 ms grace. Changed `a lower-priority success stands when a higher-priority probe stays black-holed`: the `advanceTimersByTimeAsync(500)` budget assertion became unresolved at 1000 ms, resolved by `1000 + PROBE_PRIORITY_GRACE_MS - 900`, with the black-holed probe still aborted. One stale comment in `a higher-priority success within the grace wins over an earlier lower one` was reworded only; that test drives timers by hand, so its timing is unchanged.
**Residual:** none.

### SPD-3
**Status:** Fixed (commit 6dca43c)
**Diagnosis:** CONFIRMED. `threadSpendRefreshKey` folded `sending` into the key, so the open-thread glance re-read `sessions.list` at `limit: 200` (~141 KB, ~11 s on the operator's host per the Gate's own comments) when a turn *started* and again when it *ended*, the first concurrent with the turn on a single-threaded, `state.db`-bound Gate, and each read went through `gatewayRequest` with no abort.
**Fix:**
- `threadSpendRefreshKey` (`session-analytics.ts:233`) now returns `<surfaceKey>:<sessionId>`; `sending` stays in the input type and is still passed, but no longer moves the key.
- New exported pure helpers: `THREAD_SPEND_GLANCE_LIMIT = 50` (`:248`), `THREAD_SPEND_MIN_READ_MS = 10_000` (`:251`), `threadSpendNeedsWideRead` (`:257`) and `threadSpendFinishedRead` (`:273`).
- `chat-screen.tsx:1573` adds a `spendFinishTick` to the effect key, and a `useEffect` on `[isSending, spendSurfaceKey]` turns the true→false edge into exactly one bump via `threadSpendFinishedRead`; two finishes inside 10 s read once (the second is dropped, not queued).
- The read asks for 50 (`chat-screen.tsx:1872`) and widens to ONE `SESSION_SPEND_LIST_LIMIT` (200) read only when `threadSpendNeedsWideRead` says the open thread is missing; a failed wide read keeps the narrow one and marks it stale. `spendGlanceRef` (`:1854`) holds the last good read per surface, painted synchronously before the request so a revisit cannot blank.
**Tests:** `__tests__/thread-spend-glance-cost-test.ts` (16) — `the refresh key is the same before and after a send starts`, `chat-screen spends nothing on the sending flag but still names it`, `a turn STARTING is never a read, and neither is staying idle`, `a turn that ends is a read — once`, `two turns that end within the minimum gap read once, not twice`, `the floor is ten seconds`, `the thread is in the newest 50 — no wide read` / `is not … one wide read is owed` / `a failed or threadless read owes no wide read`, `the last glance answer is held per surface in memory`. One existing behaviour assertion in `__tests__/session-analytics-test.ts` pinned the defect and was inverted with a comment saying why: `expect(live).not.toBe(done)` → `toBe(done)`. No other existing assertion was weakened; two source-pinned ones followed moved code (the new `isCurrent` expression in `sheet-open-before-read-test.ts:65`, and the `FUTURE-ITEMS.md:285` cite in `future-items-cites-test.ts`).
**Residual:**
- The 10 s floor *drops* a finishing turn, it does not defer it: a finish inside the floor schedules nothing, so the common flow keeps a pre-turn total until something else re-reads. Deferring needs a timer, which the brief's "never closer than 10 s" does not ask for. Reviewer-flagged, declined.
- Narrowing to 50 rows narrows what `SessionAnalytics` draws — the week sparkline loses sessions, and `spendWindowCopy`'s bound line degrades from "newest 200 sessions" to "recent sessions" (corrected in round 3: it returns a string either way, so the regression is honesty, not a disappearing label). Prescribed by the brief.
- `currentSessionId` is set *during* a send and is part of the effect deps, so a sessionless thread still spends a 50-row read concurrently with the turn — much cheaper than the 200-row read, not eliminated.

### SPD-4
**Status:** Fixed (commit 511b310)
**Diagnosis:** CONFIRMED. Every transition to `connected` in `attachClient`/`gateway-provider.tsx` started approvals, `cron.list`, `listBots`, `botJobs.list()` (re-arm), `loadWorkflows`, push registration and the history read together, and the two routine reads went through different routes to the same facts. The author also found two defects in his own first pass: the self-heal stamp was written on the `connected` announcement (a connection that dropped inside the 1.8 s window suppressed its own recovery's reads), and the workflows effect was keyed on the profile object, so a default-model pin or TLS write re-scheduled the read.
**Fix:**
- New provider-local seam: `connectedReadTimersRef`, `cancelConnectedReads()` (`:1647`) and `scheduleConnectedRead(delayMs, read)` (`:1653`). Called from the start of `attachClient` and on unmount, so a superseded attach drops pending reads.
- Stagger from the `connected` announcement: history unchanged/immediate → approvals 600 ms → `cron.list` 900 ms → `listBots` 1200 ms → routine re-arm 1500 ms → workflows 1800 ms. Each effect returns its disposer from cleanup, so leaving `connected` or changing gateway cancels the pending read.
- De-duplication: `routineReadRef` (`:4662`) mirrors `routineRead`; `rearmRoutineNotices` (`:4672`) reuses `read.jobs` when the cron read landed for this gateway and falls back to `botJobs.list()` only if it did not.
- Self-heal guard: `noteConnectedFanOut(gatewayId, generation)` (`:1685`) classifies a transition from `connectedFanOutRef` (gateway + client generation + timestamp) against `CONNECTED_FAN_OUT_REPEAT_MS = 60_000`; the cron/bots/re-arm/workflows reads skip when the transition is a silent recovery. Approvals and history stay outside the guard. `markConnectedFanOutRan()` (`:1700`) writes the stamp as the last read runs, not on announcement.
- The workflows effect depends on `activeGateway?.id`, so a profile write no longer re-schedules it.
**Tests:** New `__tests__/gateway-provider-connected-reads-test.tsx` — `the fan-out is staggered behind the transcript, not fired with it` (sampled at 0/300/700/1000/1400 ms), `approvals land before the routine list, and neither lands first`, `the routine re-arm reuses the cron read instead of asking the jobs route again` (`listCronJobs` 1, `listJobs` 0) and its cron-unavailable counterpart, `the monitor's own recovery inside the window repeats no fan-out`, `a flap inside the stagger window does not earn the self-heal stamp`, `a profile written while connected does not push the workflow read out`, `a real reconnect of a new client still fans out`. Existing source-pinned tests in `routine-notice-rearm-test.ts`, `widget-target-test.ts` and `fleet-route-test.ts` asserted the defective immediate/double-read shape (the `botJobs.list()` read, the effect dep lists, `if (live) setRoutineRead(…)`) and were updated to the new shape; the outcomes they pinned are unchanged.
**Residual:**
- `syncPushRegistration` in `onStatus` is still immediate — not in the brief's stagger list, and `push-connect-hooks-test` pins it on `nextStatus === 'connected'`.
- The fan-out stamp is written by the workflows read, the last of the set; if that read never runs the next transition fans out again (a redundant read, never a suppressed one).
- A gateway with no cron seam skips the 900 ms read, so its "complete" moment is the 1.8 s read either way.

### SPD-5
**Status:** Fixed (commit 6dca43c)
**Diagnosis:** CONFIRMED. `attach-manifest.ts` was the only data cache; the roster, session page, model catalog and thread history each went to the network on every visit and their UI showed the empty/loading state offline or on a slow Gate even though the device had answered the same read minutes ago. The author ADDED a class the audit did not name: a cached paint can land *after* the live read, and the read sequence and client generation do not move when a read lands, so a remembered copy could overwrite a fresh answer.
**Fix:**
- New `src/lib/cache/swr-store.ts`: `readCached`/`writeCached`/`clearCachedForGateway` (`:120`, `:159`, `:203`) on `keyValueStorage`, keys `versutus:swr:<namespace>:<gatewayId>:<key>`, envelopes `{v:1, savedAt, value}`, a 150 KB cap (`SWR_MAX_BYTES`) that refuses and *deletes* the old copy, a 20-entry in-memory LRU in front, per-key promise-chained writes, nothing throws, `stripSecretFields` (per-word match, so `listenKey`/`api_key` go and `monkey` stays) on every write.
- Painted at four sites keyed by gateway: roster `chat-screen.tsx:1506`, sessions `gateway-provider.tsx:4088`, models `:4012`, history `reloadHistoryFor` `:1426` (last 40 turns, `HISTORY_CACHE_TURNS`), each `writeCached` only on a successful read (`chat-screen.tsx:1541,1943,2170`; provider `:1464,4030,4108`).
- Round 3 closed the two late-paint races: per-open `readSettled` booleans in `openModelPicker` (`:3998`) and `openSessionSelector` (`:4080`), set synchronously the tick the read settles either way, guard the cached paint (`:4014`, `:4090`) — the same shape as round 2's `liveHistoryPainted` (`:1318`).
- The session fold also refuses a failed read (`previous.loaded || previous.failed ? previous : …`, `:4092`), because `applySessionListRead` leaves a failed first read at `loaded:false, failed:true` on purpose.
- The cached session read moved ahead of `if (!client) return;` (`:4070` `isCurrent` gained the `client === null` clause), so a selector opened while `clientRef` is null still lists what the device remembers.
- `clearCachedForGateway` is called from `clearRetiredGatewayStores` (`:863`) and `deleteGateway` (`:2909`).
**Tests:** `__tests__/swr-store-test.ts` (19) — key shape and round trip, gateway isolation, four wrong-envelope shapes and a throwing `getItem` → `null`, the cap including old-copy removal, per-key write ordering under a blocked and a rejected predecessor, `isSecretFieldName` word matching, `stripSecretFields` through nested objects/arrays, clear-by-gateway over all four namespaces, the LRU. `__tests__/provider-swr-cache-test.tsx` (16) over the real provider: cached paint before the read settles then replaced by it, a refused read keeps the paint and still names the failure, another scope's/thread's copy never shows, a late cached paint never paints over the read or over a refusal, delete clears all four namespaces.
**Residual:**
- `SessionListState` has no `fromCache` field and `session-list.ts` is outside the allowed files, so a remembered page carries no "not yet re-read" flag; `thread-config-sheet.tsx` renders a loaded list with no spinner, so a remembered page looks fresh until a read fails.
- `clearCachedForGateway` does not cancel an in-flight `writeCached`, so a delete racing a roster write can be followed by one DTO's resurrection; `deleteSessionById` leaves `history:<gw>:<sessionId>` on disk and the history namespace has no eviction.
- The cached history paint still cannot fire on a deliberate `selectSession` (it does not clear `messages`, so `messagesRef.current.length > 0` blocks it) — brief-conformant wording, declined by the author as needing provider-state work.

### SPD-7
**Status:** Fixed (commit 8063ac7)
**Diagnosis:** CONFIRMED. Every walk the audit named asked `backendManager.get()` — which ends in `server.ensureRunning()` — for the live backend before asking whether it implements the method: `resolveBackendFor` and the gateway-methods walk in `gate/core/server.mjs`, both Bot walks plus the `startRun` walk in `resolveRunBackend`/`resolveConversationBackend`, the `botGroups` `listBotIds` walk and the `/v1/models` aggregate; a failed start was never remembered, so each request re-paid the 30 s timeout. ADDED: the audit suggested reading the static capability list `describe()` exposes, but `describe()` returns `adapter.capabilities` (manifest flags), not method names, so the author derived the key set from `adapter.createBackend()` over inert transports instead.
**Fix:**
- `backend-manager.mjs` gains exported `methodsOf(environmentId)`: builds the backend over inert transports (`inertOptions`, `refusingRpc`) and caches its function keys per environment; `null` (unknown) is returned for no record/adapter/factory, a throwing factory or a non-object, and is deliberately not cached so one failed probe cannot disable the shortcut; `stopAll()` clears it. All four shipped adapters were read first and construct without spawn, socket or write.
- `server.mjs` `backendCanServe(entry, method)` (`methods === null || methods.has(method)`) gates six walks — `listBotIds` (`:644`), `getBackend` (`:834`), `resolveConversationBackend` (`:1325`), `resolveRunBackend` (`:1412`, `:1440`, `:1466`). Ordering, `?backendId=` precedence, the `failures` bookkeeping into `unresolvedBackendResponse` and every status/body are unchanged, and each site still re-checks `typeof backend[method] === 'function'` after `get()`.
- `backend-manager.mjs` `get()`/`markUnavailable`: a rejected `ensureRunning()` records `{ error, attempts, retryAt }` (5 s, 15 s, 60 s, 300 s cap; injectable `now`) and rethrows that remembered error immediately inside the window; a success clears it, so `DEFAULT_START_TIMEOUT_MS = 30 s` is now paid once per window.
- `resolveBackend` and the `/v1/models` aggregate are deliberately unchanged (not a capability walk; every backend owns a model list) — the aggregate's failures are made cheap by the backoff instead (this part).
**Tests:** new `gate/__tests__/backend-capability-probe.test.mjs` — `methodsOf` returns the fake adapter's keys without starting anything and is cached, returns `null` for a throwing factory/non-object/unknown environment, hands each transport an inert stand-in, and five requests cost one `ensureRunning` with each backoff boundary costing exactly one more. Three route tests added to `gate/__tests__/backend-routes.test.mjs` (`makeGate` gained an optional `backendServerFactory`; no existing assertion changed): a backend that cannot serve `GET /v1/bots` is never started, an explicit `?backendId=` still starts the environment it names (pinned deliberately; passes before and after), and an unreadable capability still starts and is asked. 7/8 probe tests and the two discriminating route tests fail against pre-fix sources.
**Residual:**
- `methodsOf` costs one extra `store.get` (JSON read) per environment examined, because the required signature takes an environment id; the store is not cached in-process.
- `voice-backend.mjs` `runVoiceTurn` still walks `list()` + `get()` and can cold-start a backend that turns out not to answer — file outside this package's allowed set.
- An adapter whose `createBackend` cannot be built over inert transports gets no speedup (none today); the `null` verdict degrades to the old behaviour.

### GATE-2
**Status:** Fixed (commit 8063ac7)
**Diagnosis:** CONFIRMED for the stdio half. `stdio-server.mjs` returned its cached `handle` forever (`if (handle) return handle;`) with no `exit` hook, and `backend-manager.mjs` keyed its cached backend on `handle.baseUrl ?? 'stdio'` — the constant `'stdio'` for a pipe — so after the Codex app-server died `ensureRunning()` handed back the dead handle, `get()` returned the backend still bound to the dead rpc, and every request rejected with "app-server is not running" until the Gate restarted; `native-server.mjs` re-validated health precisely because a cached handle is a moment, not a lease, and stdio had no equivalent. CORRECTED: the brief's "neither file attaches `child.on('error')`" is true of `stdio-server.mjs`'s own code but not of the process — `createStdioJsonRpc` already attached one at `jsonrpc-stdio.mjs:51`, which is why the handshake case already refused promptly; `native-server.mjs` genuinely had none, so a missing executable was an uncaught exception there.
**Fix:**
- `stdio-server.mjs` `start()` attaches `child.on('error')` right after spawn, recording a named `Error` (`<adapter> app-server could not start <command>: <code>`), and races the handshake against it so the refusal wins; `child.on('exit')` clears `child` and `handle` (identity-guarded, so a clean `stop()` cannot clear a later spawn) and bumps the `generation` counter carried on the handle.
- `native-server.mjs` `spawnServer` attaches `child.on('error')`; the poll loop checks it at the top and races the poll interval against it, so a missing executable rejects immediately (and `stop()`s, as the timeout path does) instead of polling for 30 s.
- `backend-manager.mjs` `get()` cache key becomes `handle.baseUrl ?? \`stdio:${handle.generation ?? 0}\``, so a respawned app-server yields a new backend bound to the new rpc; the HTTP lifecycle is unchanged.
- An adapter with no handshake gets one `setImmediate` turn in place of the handshake await, so the spawn error is observed instead of nothing rejecting (this part; the other files of the same spawn-error class belong to another package).
**Tests:** four tests in `backend-capability-probe.test.mjs` — a dead fake child makes the next `get()` respawn and return a different backend bound to the new rpc (a third `get()` reuses it without respawning), a stdio ENOENT refuses at once, a no-handshake stdio server refuses at once too, and the native server refuses at once naming the executable; each asserts the rejection carries the executable and OS code and a temporary `uncaughtException` listener proves nothing escaped. The respawn, no-handshake and native tests fail on the pre-fix tree; the with-handshake stdio one already passed (`jsonrpc-stdio.mjs`, fixed earlier) and is kept as a promptness/regression guard.
**Residual:** none known. `isOwned()` for stdio now reports `false` once the child has exited, which is the honest answer; nothing in `gate/` reads it.

### GATE-6
**Status:** Fixed (commit 97f25f0)
**Diagnosis:** CONFIRMED. `device-tokens.mjs` `#readAll()` swallowed every error to `{devices:[]}` while `#writeAll` used truncating `writeFile`, and `verify()` still re-reads the file per request (deliberate, so an out-of-process `cli.mjs pair revoke` lands) — so a read inside another write's window parsed nothing, 401'd the phone, and a following `issue()` wrote `{devices:[newOne]}`, dropping the rest. `tokens.mjs` `#read()` swallowed to null (a crash-truncated `.tokens.json` made `ensureToken()` mint a new bootstrap token), `pairing.mjs` did unlocked read-modify-write, `push-tokens.mjs` serialized mutations but its free-running reads could catch the truncation.
**Fix:**
- New `gate/core/atomic-file.mjs`: `writeFileAtomic` (sibling tmp file + `rename`, up to 25 EPERM/EBUSY retries with 10–40 ms jitter, tmp removed on failure) and `readJsonFile` returning `{state:'missing'|'ok'|'corrupt'}` so a caller can tell an absent file from an unreadable one.
- `device-tokens.mjs`: `issue`/`revoke` run through `#serialize` and `writeFileAtomic` (0o600 kept); `#readAll` retries a corrupt read once after 25 ms; `#quarantineCorrupt` copies a corrupt file to `<path>.corrupt-<ts>` and logs a loud `console.error` before the mutation proceeds from an empty list, so the corrupt bytes survive as the recovery path.
- `tokens.mjs`: `rotate()` writes atomically; `#read` mints only for `missing`, and a `corrupt` file is copied aside with a loud log before a new token is minted; timing-safe compare and in-memory cache unchanged.
- `pairing.mjs`: atomic `#write`, `#serialize` on `openWindow`/`addPending`/`takePending`, and `MAX_PENDING = 50` with the oldest entries spliced off in `addPending`.
- `push-tokens.mjs`: `#writeAll` uses `writeFileAtomic` (0o600 and the existing serialize queue kept); `#readAll` retries once on `corrupt`.
**Tests:** new `atomic-file.test.mjs` — no tmp file left, missing/ok/corrupt told apart, and a real race (4 writers × 64 KiB payloads vs a tight reader for ~300 ms where every read must be a complete payload or `missing`); the author reports it fails against a plain `writeFile` scratch copy. `device-tokens.test.mjs` adds corrupt-file backup with original bytes preserved and a loud log, `issue` for B keeping A, three concurrent `issue` calls keeping all three, and revoke across two store instances. `tokens.test.mjs` adds token-survives-restart and corrupt-moved-aside; `pairing.test.mjs` adds the 50 cap, 30 concurrent `addPending`, and read-only calls on a corrupt file producing 0 backups/0 logs while a mutation quarantines exactly once (this was the reviewer's finding 5 — the first revision quarantined inside the shared `#read`, so the unauthenticated `isWindowOpen()` flooded backups; `#readForMutation` now owns it). No pre-existing assertion pinned the old behaviour.
**Residual:**
- Pairing mutations are serialized in-process only, so a concurrent `cli.mjs pair approve` (separate process) and a request can still lose updates — the audit listed this independently and the fix does not reach it.

### GATE-7
**Status:** Fixed (commit 97f25f0)
**Diagnosis:** CONFIRMED. `server.mjs` `readJsonBody`, defined inside the request handler, collected the whole stream with no size limit for every route; `replayCache = new Set()` grew once per verified request and was never pruned; `pairing.addPending` rewrote the whole file per request with no cap — all three reachable by anything that can hit the port. CORRECTED from the first attempt: quarantining a corrupt pairing file inside the shared `#read` meant the read-only `isWindowOpen()` on this same unauthenticated route wrote unbounded `.corrupt-*` copies and log lines; `#read` is now side-effect-free (see GATE-6).
**Fix:**
- `readJsonBody(req, { maxBytes })` counts bytes as chunks arrive, stops reading past the limit and throws; the handler's error path answers 413 `{error:{code:'body_too_large'}}` and destroys `req` only in the `res.end` callback — destroying first takes the socket and the client sees a reset instead of the verdict (the author verified this on this Windows host).
- Limits are `ACCESS_MAX_BODY_BYTES` 16 KiB on `/.well-known/gateway/access` and `AUTH_MAX_BODY_BYTES` 64 MiB on every authenticated route; the "Request body must be valid JSON" 400 path and all other status codes are unchanged.
- `signature.mjs` gains `ReplayCache` (Map signature → expiry, `has`/`add`), pruned on every `add` and capped at 10 000 with oldest evicted; entries expire after `maxSkewMs` (300 000 default). `server.mjs` uses it in place of the `Set`, and `verifySignedAccessRequest` still works with a plain `Set`.
- The pending-list cap of 50 in `pairing.mjs` bounds the third vector.
**Tests:** four new tests in `server.test.mjs` — a 100 KiB access body gets 413 `body_too_large` (posted over a raw socket, because the server destroys the oversized request, so the request-side error is expected), a body of exactly 16 KiB is not a 413 and reaches the 400, `/v1/capabilities/rpc` still accepts a 1 MB authenticated body, and a fresh device is granted a token with the window open. The existing access tests still pin 202 (pending) and 403 (bad signature). `signature.test.mjs` adds duplicate-within-window rejection, expiry-then-accept-again, oldest-evicted cap and prune-on-`add`; the plain-`Set` replay test is unchanged.
**Residual:**
- Under a flood the 10 000-entry cap evicts still-unexpired signatures, so an old one could be accepted a second time; the skew window bounds how old.
- An authenticated caller can still buffer up to 64 MiB per request — sized for base64 images in chat turns.

### SEND-2
*Package G4*
**Status:** Fixed (commit 203821b) — Gate side only; reading the header on the phone is P1's part.
**Diagnosis:** CONFIRMED: the handler resolved `body.sessionId ?? (await backend.createSession(...)).id` and only the non-stream JSON body carried `session_id`; the streamed response headers carried nothing, so a phone with no session opened a new one every turn and lost the thread. ADDED: a client-supplied id can carry a newline, and Node throws `ERR_INVALID_CHAR` from inside `writeHead`, so the value needs a guard.
**Fix:**
- `streamBackendTurn`'s `writeHead` carries `X-Versutus-Session-Id` whenever `safeHeaderValue(sessionId)` passes — created or supplied — and it is still the first thing written.
- New `safeHeaderValue(value)` (`server.mjs`) accepts only a header-safe string, so a hostile session id cannot throw in the middle of opening a stream.
- `gate/core/cors.mjs` sets `Access-Control-Expose-Headers: X-Versutus-Session-Id, X-Versutus-Keepalive-Ms` for a listed origin, so the web build can read the streaming contract; the preflight already echoed the requested headers, which is what admits `X-Versutus-Turn-Id` without pinning a list.
**Tests:** "a streamed turn tells the phone which session it belongs to" in `backend-routes.test.mjs` — no `sessionId` → the header equals the created session's id and exactly one session was created; a supplied id → the header echoes it and none is opened. `gate-cors.test.mjs` adds "a listed origin may read the streaming contract, and may send the turn id" (both headers exposed; a preflight asking for `x-versutus-turn-id` gets 204 with it allowed); the existing "no config changes nothing" and "unlisted origin stays blind" tests still pass. No pre-existing assertion pinned the old behaviour.
**Residual:** none.

*Package P1*
**Status:** Fixed in part (commit 19de6a2) — the client half: the turn id is minted and sent and the Gate's adopted session is reported. The Gate side (honouring `X-Versutus-Turn-Id`, emitting `X-Versutus-Session-Id`) is another package (this part).
**Diagnosis:** CONFIRMED. `ManifestClient.streamChat` sent `this.transport.headers` unchanged — no turn id, so the Gate had nothing to correlate — and never read a response header, so a session the Gate opened for the turn was invisible to the app; `HermesGatewayClient.streamChat` likewise sent no turn id.
**Fix:**
- `createTurnId()` (client.ts) wraps `createMessageId('turn')` and strips anything outside `[A-Za-z0-9_-]`; `createMessageId` (src/lib/gateway/messages.ts) yields `turn-<ms>-<6 base36>`, already inside the protocol's 8–64 char shape.
- `ManifestClient.streamChat` calls `options.onTurnId?.(turnId)` before the POST and sends `X-Versutus-Turn-Id: <turnId>` alongside the transport headers.
- After the `response.ok` guard both clients read `response.headers.get('x-versutus-session-id')` and call `options.onSession?.(id)` when present and different from the session the request already named; `HermesGatewayClient.streamChat` mints and announces the id but sends no Versutus request header (a stock Hermes has never heard of the turn protocol).
- `onTurnId` / `onSession` were added to both `streamChat` option types and to `PortalClient`'s.
**Tests:** New `__tests__/chat-turn-id-cancel-test.ts` (8 tests, 4 of them for this half): the manifest chat request carries `X-Versutus-Turn-Id` matching `/^[A-Za-z0-9_-]{8,64}$/` and `onTurnId` received that exact value; two sends get two different ids; a Gate-adopted `X-Versutus-Session-Id` is reported through `onSession` while a header repeating the session we sent is not; the Hermes client announces a turn id, sends no Versutus header and does read the response header. Pure additions.
**Residual:**
- `onSession` is deliberately not called for a non-2xx chat response, so an erroring turn still leaves the app on its old session id.

*Package P2b*
**Status:** Fixed (commit 4a9e3cc)
**Diagnosis:** CONFIRMED. A turn sent with no `sessionIdRef.current` made the Gate create a session and `sendMessage` ignored the id now reported on the stream, so every later turn created another. The author ADDED that pinning on the client is not enough: connect copies the stored profile onto the live one, so the adopted id must also be persisted.
**Fix:**
- `onSession` in `sendMessage` returns immediately when `sessionIdRef.current` is set; otherwise it adopts the id, calls `setCurrentSessionId`, pins it with `pinLiveSession`, and writes the returned profile through `persistGateway`, updating `activeGatewayRef.current`/`setActiveGateway` first.
**Tests:** Two new cases in `__tests__/provider-detachable-turn-test.tsx`: "the announced session is adopted, pinned on the client and persisted" (a Gate with no session catalogue, so the thread is genuinely empty) and "a session already held is never replaced by one the Gate names".
**Residual:** none.

### SEND-7
**Status:** Fixed (commit 143d3f7)
**Diagnosis:** CONFIRMED, and one site added: not three `getRunStatus` call sites but four — the notes count the closing `getRunStatus(...).catch(() => null)` in `executeRun` (`src/lib/gateway/runs.ts`) alongside the initial, post-approval and post-stream reads, plus the swallowed `.catch(() => undefined)` on the event stream. All four now retry.
**Fix:**
- `src/lib/gateway/runs.ts`: added module constants/helpers `STATUS_RETRY_DELAYS_MS = [500, 1500]`, `isRetryableStatusError()` (HTTP >= 500 via `GatewayHttpError`, else `isConnectionError` from `@/lib/gateway/errors`) and internal `readStatusWithRetry(client, runId, sleep)` — up to 3 attempts, waiting `jitteredPollDelay(backoff)` through the injected `sleep`.
- A 4xx, or any non-connection non-5xx, is rethrown on the first attempt, so `executeRun` still returns today's `{ status: 'unknown', unresolved: true, error }`.
- The stream's `.catch(() => undefined)` became `try/catch` setting `streamFailed`; when set, the loop waits the first 500 ms backoff before polling, placed after the abort check so a stopped run is not delayed.
- `readStatusWithRetry` now backs all four call sites, including the final read at `runs.ts:416`. `MAX_STATUS_POLLS`, approval flow, `requestStop`, `settleUnresolvedRuns` untouched.
**Tests:** `__tests__/runs-test.ts` gains `describe('executeRun rides out a transient status failure')` with a `countedStatusClient` that scripts attempts and records injected waits: a lost read recovers, the post-approval read retries, a dropped stream waits ~500 ms first, a 404 is not retried, three connection failures give up after 3 reads with the same unresolved outcome, and an abort inside a backoff still cancels. `__tests__/run-orchestration-test.ts` — the existing case `intermediate getRunStatus failure during polling returns unresolved with the run id` had a fixture (`callCount === 2`) that pinned the defect, since one retryable error now recovers; changed to `callCount >= 2` so it pins a sustained failure instead, plus `expect(callCount).toBe(4)`. Assertions unchanged.
**Residual:**
- `isConnectionError` is message-regex based, so a transport failure with an unrecognised message is still treated as final (unchanged shipped behaviour).
- Red-check recorded: 5 of the 6 new cases fail against pre-fix `runs.ts`.

### STORE-1
**Status:** Fixed (commit 79b7305)
**Diagnosis:** CONFIRMED. `src/lib/gateway/transcript.ts` did `appendTranscript`/`updateTranscript` as bare `loadTranscripts` → build → `saveTranscripts` read-modify-write over one AsyncStorage key with nothing between concurrent calls, while `gateway-provider.tsx` `updateLocalMessage` calls `updateTranscript` once per streamed `/agent` delta. The author's `mutateEntries`, `enqueueTranscriptMutation` and `entriesByKey` now exist in that file.
**Fix:**
- `transcript.ts`: per-key promise chain (`mutationTails`, `enqueueTranscriptMutation`) whose tail always settles resolved, so a failed task rejects only its own caller and never poisons the queue.
- `mutateEntries` — now the shared body of `appendTranscript` and `updateTranscript` — reads the held copy, loads once on first touch, applies the change, stores the `slice(-200)` result and arms a 250 ms trailing debounce instead of writing per delta.
- `entriesByKey` is the in-memory copy; `loadTranscripts` answers from it, so a read sees an update that is still queued.
- `saveTranscripts` (whole-list, not a delta) still writes through, but now goes through the queue and updates the held copy so the two paths cannot disagree.
- `clearTranscriptsForGateway` drops cache and armed timers by key prefix; the author's first version filtered by `getAllKeys`, which misses a transcript that exists only in the held copy.
- New `flushTranscripts()` forces every armed timer, joins the writes they enqueue (including writes those writes queue), and rethrows the first failure after the rest have had their turn.
**Tests:** `__tests__/transcript-write-behind-test.ts` (new, 9 cases, `key-value` mocked over a real Map to count `setItem`); 7 of 9 were red pre-fix — 50 concurrent field updates to one entry all survive and equal the stored value after `flushTranscripts`, a 100-update burst does 0 writes until forced and 1 after (pre-fix 101 `setItem`), a read sees a queued update, a refused write is reported by `flushTranscripts` while a later update still lands, the clear drops cache/timer/value, a fresh module load reads the flushed value. The 2 already-green cases (write-through save, 200-entry bound) are regression guards, not red tests.
**Residual:**
- `entriesByKey` holds one bounded list per key for the process lifetime with no eviction; only a gateway delete drops it.
- `flushTranscripts` is not wired to an AppState background handler (`gateway-provider.tsx` outside the allowed files), so a delta in the last 250 ms before a process kill is still lost.
- A debounced write failure is held until the next `flushTranscripts()`, so `void updateTranscript(...)` callers never see it; a pre-existing clear-vs-mutate race can still land after a clear.

### UI-1
**Status:** Fixed (commit 6dca43c)
**Diagnosis:** CONFIRMED, and the asymmetry the audit described was exact: `refreshRoster` → `applyRosterRead` already kept the last good rows on a failed re-read, while the mount path's `.catch` ran `setRosterRows([{ kind: 'configurable' }])` — one blip replaced a real roster with a navigation row plus an error, and the effect re-read on every visit and reconnect.
**Fix:**
- The mount `.catch` folds through `rosterRowsAfterRead` (`:1548`) and only sets `rosterError`; `setRosterRows([{ kind: 'configurable' }])` no longer appears in the file. The navigation row survives only where it is true: a first read that produced no rows at all, or a switch to another gateway.
- `rosterRowsAfterRead` (`:258`) is `applyRosterRead` composed with `rosterRowsForGateway`, so a refusal keeps this gateway's rows and never leaves the previous gateway's Bots under the new name.
- Because the failure path now keeps rows, the remembered copy beside the error is the point (SPD-5) — so the cached paint fills a blank or other-gateway roster and yields to a live answer (`rosterRowsFromCache`, `:241`).
- Success clears the error and writes the copy that the next mount paints from (`:1537`).
**Tests:** `__tests__/chat-roster-swr-test.ts` (21, shared with SPD-6) — `the last good rows survive a refused read after a good one`, `a refused read on the SAME gateway still keeps its rows`, `a refused read on the new gateway never shows the old one's Bots`, `a first read that produced no rows at all still falls back to the navigation row`, and the source-pinned `the mount read never collapses a good roster to the navigation row`.
**Residual:**
- The 20 s throttle still stamps `rosterReadAtRef` *before* the read and does not re-arm, so a failed roster read followed by a reconnect inside 20 s is not re-read until the operator leaves and re-enters. Brief-conformant; the rows and the error stay on screen, so it is staleness rather than a blank surface. Not fixed.

### UI-2
**Status:** Fixed (commit 3de607a)
**Diagnosis:** CONFIRMED, with one ADDED detail. `handleRoutineTogglePause` (`src/components/chat/chat-screen.tsx`) chained `botJobs.pause` → `botJobs.list()` → a first `.then` that returned nothing on **both** paths (not just the `if (paused) return;` one) → a second `.then` folding `routineJobsFromList(jobs)`. So the second `.then` always received `undefined`; `routineJobsFromList(undefined)` returns `[]` (`src/lib/gateway/routines.ts:121`, "a non-array is empty, not a guess") and `applyRoutineRead` (`routines.ts:190`) believes `{ ok: true, jobs: [] }` — every pause and resume replaced the roster with zero jobs and **no error**, which is why the symptom was silent. `handleRoutineCreate` above it and `routines-pane.tsx`'s `onTogglePause` were already correct; the defect was purely the promise handoff.
**Fix:**
- The first `.then` now parses the re-read once into `const list = routineJobsFromList(jobs)`, looks the toggled job up in that same `list`, and `return list;` — so `foldRoutineRead(botSurfaceId ?? '', { ok: true, jobs: list })` folds the list that was just read instead of `undefined`.
- Notice handling is byte-for-byte the previous behaviour: a pause still calls `cancelRoutineNotification(jobId)` up front; the re-arm is now written `if (!paused && job) void syncRoutineNotification(job);`, which is the same condition the old `if (paused) return;` + `if (job)` pair expressed across two paths.
- `.catch`, the `useCallback` deps (`[botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList]`) and the fire-and-forget contract are unchanged; the edit is line-count neutral (6 in, 6 out) so the line anchors other tests pin still hold.
**Tests:** `__tests__/routine-run-relist-test.ts` (extended, house source-contract style) now *derives* the handoff rather than pinning a literal — it extracts the first `.then`, asserts no bare `return;`, captures the identifier that is returned, and asserts that identifier is what builds `const … = routineJobsFromList(jobs)` and what `{ ok: true, jobs: … }` folds, plus that the old `routineJobsFromList(jobs)`-at-the-fold shape is gone and that the notice rules hold. `__tests__/routines-test.ts` +2 tests pin the mechanism on the real functions: a 2-job list folds to 2 loaded jobs and `Routines (2)`, while `routineJobsFromList(undefined)` folds to `{ jobs: [], loaded: true, failed: false }` — a *successful* read of zero jobs. The structural test fails on the pre-fix `chat-screen.tsx` (1 failed / 29 passed, author-verified by restoring the HEAD file).
**Residual:**
- The brief's optional extraction of the pure step into `routines.ts` was **declined**. `__tests__/future-items-cites-test.ts:24` pins specific line numbers in `chat-screen.tsx` (`1157`, `2495`) against the citation in `FUTURE-ITEMS.md`, which is outside this package's allowed files; one added named import shifts both anchors. The author took the line-neutral edit instead (anchors verified intact, `routines.ts` byte-identical to HEAD), trading the extraction for a green suite.
- Consequence: no unit test of an extracted pure helper, and no render-level test of the handler — no test in this repo renders `ChatScreen`. The data flow is pinned structurally instead.

### VOICE-2
**Status:** Fixed (commit 4466fd9)
**Diagnosis:** CONFIRMED. `queued`, `totalBytes`, `activeGen`, `primed` were plain fields mutated from the OkHttp reader thread (`push`, `cancel` via `handleTextFrame`), the playback thread (`drain`) and the caller thread (`flush`); `drain()` did `isEmpty()` then `removeFirst()`, so a barge-in `cancel()`/`clear()` in between threw `NoSuchElementException` on the playback thread, and `push`→`trimToCap` had the mirror race on the OkHttp thread.
**Fix:**
- `JitterBuffer.kt`: `@Synchronized` on every public member — `push`, `cancel`, `drain`, `pendingMs`, `flush` — and on the private `clear`/`trimToCap`, all on the same instance monitor.
- The monitor is reentrant, so the existing intra-object calls (`push`→`clear`/`trimToCap`, `drain`/`trimToCap`→`pendingMs`) are unchanged and cannot self-deadlock.
- `drain()` now takes the chunk with `queued.removeFirstOrNull()` and treats `null` exactly as the old empty-queue branch did, so it cannot throw on an emptied queue.
- Priming, generation and cap behaviour untouched; the class doc now records why the lock exists.
**Tests:** new `JitterBufferConcurrencyTest.kt`: five threads (pusher, canceller, two drainers, flusher) with random generations 1..3 hammer the buffer for 500 ms, collecting throwables in a `CopyOnWriteArrayList`; asserts nothing threw, `pendingMs()` never went negative during the race, and no worker outlived the deadline. A second test replays priming/generation/cancel/flush 200 times to show the buffer still works afterwards. Against the pre-fix `JitterBuffer` the same test fails 3/3 runs with `NoSuchElementException: ArrayDeque is empty.`, a negative `pendingMs`, an NPE and an `ArrayIndexOutOfBoundsException`; 5/5 pass after. Existing `JitterBufferTest` untouched and passing.
**Residual:**
- `trimToCap` uses `ArrayDeque.size`, which is O(n) in `kotlin.collections.ArrayDeque` — pre-existing, left alone.

### VOICE-3
**Status:** Fixed (commit 4466fd9)
**Diagnosis:** CONFIRMED. `onFailure` interpolated the throwable's message raw; OkHttp's DNS failure reads `Unable to resolve host "host": No address associated with hostname`, so the frame carried unescaped quotes, `isRetryableSocketFailure` (`src/context/handsfree-voice-provider.tsx:186`) got `false` from its `parseGateFrame` catch, and the Gate's 20 s resume window went unused. The author ADDED that the other two hand-built frames (`media_failed`, `socket_closed`) were literals — safe today, but hand-built, so they now share the builder.
**Fix:**
- New `JsonEscape.kt`: `internal fun escapeJsonString(s: String)` escaping `"`, `\`, `\n`, `\r`, `\t` and every other character below `0x20` as `\u00XX`; no Android or `org.json` type is touched.
- `HandsfreeGateMedia.errorFrame(code, message)` (:163) runs both values through it; `media_failed` (:89), `socket_closed` (:148) and `socket_failed` (:154) all use it.
- The `t`/`code`/`message`/`fatal` shape is byte-identical for the two literal frames; Gate-sent frames are still forwarded verbatim.
**Tests:** new `JsonEscapeTest.kt` (5 tests): quotes and backslashes; the three short escapes; NUL/backspace/form feed/0x1F as `\u00XX`; pass-through of `naïve ✓ 🎤 100% — socket` and the empty string; and a full `socket_failed` frame built from OkHttp's real DNS message plus a newline — no bare quote, no raw control character, the escaped value splits the frame into exactly the two expected halves, then round-trips through an unescape helper written in the test. No pre-existing assertion pinned the defect.
**Residual:**
- `escapeJsonString` is deliberately not a full JSON writer; `GateFrameCodec` still parses inbound frames with `org.json`, as before.
- `errorFrame` itself is not unit-tested (it lives in a class that builds an OkHttp client); the escaping it relies on is pinned by the tests above.

### ENV-1
**Status:** Not fixed (needs your action, nothing touched)
`C:\Projects\Versutus\node_modules` (and `Versutus-ui-audit`) are missing `@babel/code-frame`, `@eslint-community/eslint-utils` and `@expo-google-fonts/instrument-serif`, and the npm cache dir `E:\Data\pkg-caches\npm` does not exist. The fix is `npm ci` in the main checkout after restoring the cache directory (or `npm config set cache` to a real path). It was deliberately not done: the live Gate runs from that checkout and imports from its `node_modules`. All verification for this work ran in worktrees with a complete install (a junction to `Versutus-nocturne\node_modules`).

### NET-1
**Status:** Fixed (commit e21db1c)
**Diagnosis:** CONFIRMED. `HttpTransport.request()` in `src/lib/gateway/http-transport.ts` cleared its abort timer as soon as `await fetch(...)` resolved (headers) and then ran `await response.text()` unguarded; Expo SDK 57's global fetch is `expo/fetch` (headers-first, streaming body), so headers-then-stall hangs forever. The audit's note about `probe.ts:38,50` never consuming a successful `/health` body was also confirmed (`probeGatewayUrl`, `hasGatewayManifest`).
**Fix:**
- `request()`: `clearTimeout(timer)` moved out of the `try`/`catch` into a `finally` after the body read, so the timer stays armed through `response.text()`.
- The catch still keys off `controller.signal.aborted`, so an abort mid-body reports `Request timed out: METHOD path`, not a raw `AbortError`.
- `probeGatewayUrl` cancels `response.body` on success and on refusal; `hasGatewayManifest` cancels it in its `finally`. `GatewayHttpError`, `sanitizeHeaderValue`, `assertChatStreamComplete` untouched.
**Tests:** `__tests__/http-transport-test.ts` — `a body that never completes times out with the request message` (fake timers, abort-aware `text()` that never resolves → `Request timed out: GET /x`); `the request timer is cleared once the body is read` (`jest.getTimerCount()` 0 after a normal JSON request); probe tests `a successful probe cancels the response body` / `a refused probe cancels the response body too`. `__tests__/terminal-client-test.ts` adds the same two assertions for the NET-5 send path. No pre-existing assertion pinned the defect; none changed.
**Residual:**
- A review claim that a stalled error body (`500` headers then hang) reports `GatewayHttpError` instead of the timeout was investigated and does not reproduce: the `GatewayHttpError` is built inside the same `try`, so a body-read rejection lands in a `catch` whose first branch is the aborted-signal check. The author reverted his first fix attempt and re-ran the new test against unmodified pre-pass-3 source to confirm; no source change was made.
- `an aborted error body still reports the request timeout` and `an unreadable error body that is not a timeout still reports the status` therefore pin current behaviour rather than prove a fix (labelled as such in the notes).

### NET-4
**Status:** Fixed (commit e21db1c)
**Diagnosis:** CONFIRMED. `PROBE_TIMEOUT_MS = 1800` in `src/hooks/use-gateway-reachability.ts` sat below the 0.9–1.7 s DERP/Tailscale RTT the rest of the codebase documents (3–3.5 s already produced false negatives), so reachable tailnet gateways showed "unreachable".
**Fix:**
- `PROBE_TIMEOUT_MS` is now `6000`, with the comment above it rewritten to state the measurement and the new rationale.
- The second comment that still said "1.8s x N of lossy hops" updated to "6s x N". No behavioural change to the capped probe wave.
**Tests:** `__tests__/reachability-wave-test.ts` — `the probe timeout leaves room for a lossy Tailscale relay hop`, asserting the hook source contains `const PROBE_TIMEOUT_MS = 6000;`. No pre-existing assertion pinned 1800.
**Residual:** none.

### NET-5
**Status:** Fixed (commit e21db1c)
**Diagnosis:** CONFIRMED. `sendTerminalInput` in `src/lib/terminal/client.ts` was a bare `fetch`: no timeout, no host-lookup fallback, and two quick submits were independent requests that could reorder on the wire.
**Fix:**
- `sendTerminalInput` now queues per session on a module-level `Map` keyed by gateway URL + sid, chaining onto the previous send; the chain catches the prior rejection first, so a failed send does not block later ones, and the entry is deleted once settled.
- The actual request moved into `dispatchTerminalInput`, which runs a 15 s `AbortController` through `withHostLookupRetry` with no extra IPv4s, keeping the `HostLookupError` wording; an aborted controller is reported as `Terminal input timed out: POST /v1/terminal/input`.
- The response body is released in the `finally` (both `ok` and error paths) — the same leak NET-1 closed in `probe.ts`, since the 15 s timer only covers the wait for headers.
**Tests:** `__tests__/terminal-client-test.ts` — `three sends back to back are dispatched in order` (the first send is held in flight; the later two must not have dispatched; fails against the old bare `fetch`, which dispatched all three synchronously); `a rejected send does not block the next`; `a send times out and aborts`; `an accepted send releases the response body`; `a refused send releases the response body too` (both fail with the release removed). No pre-existing assertion pinned the defect.
**Residual:** none.

### NET-6
**Status:** Fixed (commit e21db1c) — this part: only `authorizedFetch` in `manifest-client.ts` was edited, per the brief; the rest of that file is another package's.
**Diagnosis:** CONFIRMED. `authorizedFetch` went to `streamingFetch` with no timer, so a stalled non-stream POST (CLI-environment run submission) never settled. The author additionally found a self-inflicted pass-1 defect: the `finally` removed the caller's abort listener at headers, severing `streamRun`'s ability to abort a body read already in flight.
**Fix:**
- New `AUTHORIZED_FETCH_HEADER_TIMEOUT_MS = 60_000` (`manifest-client.ts:42`) aborts an internal controller if response headers do not arrive.
- The timer clears in a `finally` at headers only; the body is deliberately unbounded because callers stream it.
- The caller's `init.signal` stays wired to the internal controller for the whole life of the response (`{ once: true }`, never removed), so a post-headers abort still reaches the body. An `AbortSignal.any` was avoided deliberately: the listener is safe on Hermes without a capability check.
**Tests:** `__tests__/manifest-client-test.ts` — `aborts when response headers do not arrive within 60 s`; `a caller abort after headers still aborts the response body` (drives a real `ReadableStream`; fails if the listener removal is restored); `the headers timer does not fire once headers arrive`. `propagates the caller's own signal` is a regression guard only — the pre-fix code passed `init.signal` straight through. No pre-existing assertion pinned the defect.
**Residual:**
- "Bounded but real listener growth" — the caller's abort listener is registered once and never removed, because it must outlive headers. A caller reusing one long-lived signal across many `authorizedFetch` calls accumulates listeners for that signal's life. The bound is the number of concurrent authorized requests sharing a signal, which the transport already bounds; kept as an accepted trade-off with no behaviour change.

### NET-7
*Package A1*
**Status:** Fixed (commit e21db1c)
**Diagnosis:** CONFIRMED. `withHostLookupRetry` in `src/lib/gateway/host-lookup.ts` tried the hostname first on every request with no memory, so a broken MagicDNS name paid a failed resolver lookup before reaching the advertised IPv4 — on every request.
**Fix:**
- Module-level `Map<hostname, { failedAt }>` (`host-lookup.ts:78`) with a 2-minute window; while marked, `withHostLookupRetry` builds its candidate list as advertised IPv4s first, hostname last.
- A hostname success deletes the mark; a hostname lookup failure writes it.
- `rememberHostLookupFailure` (`host-lookup.ts:89-100`) sweeps marks older than two minutes before writing, so a host nobody probes any more cannot hold an entry for the life of the process.
- New test-only export `hostLookupFailureCountForTests()` beside the existing `resetHostLookupMemoryForTests()`. `https` is still never rewritten — `rewriteHttpUrlHost` returns null before any ordering is built.
**Tests:** `__tests__/host-lookup-test.ts` — `after a hostname failure the IPv4 is tried first`; `the IPv4-first memory expires after two minutes`; `a hostname success clears the failure memory`; `marking a host prunes the marks that have expired` (two hosts marked, 121 s later a third is marked and only one entry survives; fails when the sweep is replaced by a bare `set`). One existing assertion in `portal-identify-reachability-test.ts` pinned the old hostname-first order after a miss and was changed to the new IPv4-first order; its outcome assertions are unchanged. Four suites sharing a hostname across files (`streaming-fetch`, `portal-identify-reachability`, `manifest-lookup-retry`, `portal-access`) got `beforeEach`/`afterEach` resets for the process-wide module state.
**Residual:** none.

*Package A2*
**Status:** Fixed (commit 790a799)
**Diagnosis:** CONFIRMED, mechanism added by the author (this part; the two-minute memory itself landed in A1/e21db1c). `src/lib/gateway/host-lookup.ts` `withHostLookupRetry` rethrew every non-lookup failure from the candidate loop, so with the memory active — `candidates = [...ipv4Candidates, url]` at host-lookup.ts:138 — an unreachable advertised IPv4 was rethrown and the hostname, the only candidate that can clear the mark, was never reached; every request failed for the full two minutes. Only the reordered pass strands; hostname-first calls were unaffected.
**Fix:**
- host-lookup.ts:148-152 — the catch is split: a lookup miss keeps the old handling (continue, and re-mark when it was the hostname); everything else is now decided separately.
- host-lookup.ts:141 — new `hostnameStillToCome = rememberFailure && ipv4Candidates.length > 0`, true only in the reordered pass where the hostname is untried.
- host-lookup.ts:160 — a non-lookup error is thrown immediately when `candidate === url` (normal order: DNS worked) or when `!hostnameStillToCome`; otherwise it goes into `lastError` and the loop continues to the remaining candidates, hostname included.
- host-lookup.ts:164 — `lastError` is thrown after the loop; an all-lookup-miss run still becomes `HostLookupError` with unchanged wording. A hostname success still deletes the mark (host-lookup.ts:146), so the next request is hostname-first.
- Narrowing: new `isHttpRejection` (host-lookup.ts:108) makes any error carrying a numeric `status` final, because something answered on that address. This keeps the existing `__tests__/http-transport-test.ts` "a refused token is not retried as a DNS miss" (asserts `toHaveBeenCalledTimes(1)` for a 401) passing unedited. Refused, unroutable, timeout and unrecognised platform messages all still fall back, so an allowlist of connection text cannot re-strand them.
**Tests:** four added to `__tests__/host-lookup-test.ts`: an unusable advertised IPv4 falls back to the hostname and the third call is hostname-first with `hostLookupFailureCountForTests() === 0`; the *last* error surfaces after the whole reordered walk; an unmarked hostname's `ECONNREFUSED` is thrown without trying an IPv4; a 401-shaped rejection stops after one call. The first two fail against the old catch, the rest pin the guards. No existing host-lookup assertion changed.
**Residual:** none.

### LIFE-5
**Status:** Fixed (commit 19de6a2)
**Diagnosis:** CONFIRMED. `closed` is set by `HermesGatewayClient.disconnect()` / `ManifestClient.disconnect()` (src/lib/gateway/client.ts, src/lib/gateway/manifest-client.ts) and read only by `resumeReconnect()`, so a `healthCheck()`/`getCapabilities()`/`getModels()` already parked in `attemptConnect` resumed after the cancel and ran `setStatus('connected')`, `onHello`/`onCapabilities` and `monitor.start()` on the discarded client — a 30 s health interval on the old gateway.
**Fix:**
- Both clients keep an integer `connectEpoch`; `disconnect()` increments it as its first statement.
- `attemptConnect` captures the epoch before `setStatus('connecting')` and re-checks it after every await — in each resolve path and at the top of each catch, so a rejection that arrives after a cancel is silent too (`ManifestClient` also checks after `getModels()`).
- A changed epoch returns with no status change, no callback and no `monitor.start()`.
- `connect()` after a `disconnect()` picks up the new epoch and runs normally; the single-flight `connectAttempt` handle is untouched.
**Tests:** New `__tests__/gateway-connect-cancel-safe-test.ts`, "a connect that loses its client goes quiet" — 4 tests (both clients × 2). A `/health` released *after* `disconnect()` never announces `connected`, ends `disconnected`, and `jest.getTimerCount()` is 0 after two further 30 s intervals; the second case reconnects and expects two `connected` announcements. The author reproduced the defect first (`connecting, disconnected, connected` with `connectEpoch += 0`). No existing assertion changed.
**Residual:**
- `closed` is still the flag `resumeReconnect()` reads; the epoch supplements it, does not replace it.

### LIFE-6
**Status:** Fixed (commit a59aeb2)
**Diagnosis:** CONFIRMED. `attachClient` in `src/context/gateway-provider.tsx` disconnected the old client and then awaited the new gateway's manifest (up to ~20 s) before installing the new `clientRef`, so the generation guard made the old callbacks inert while `status` still read `connected` and `clientRef` still pointed at the old client — `sendChatInput`'s guard passed and the message went to the previous gateway under the new one's name.
**Fix:**
- Straight after `clientRef.current?.disconnect()` the attach now sets `clientRef.current = null`, `applyStatus('connecting')`, `applyConnectionPhase('connecting')` and `setStatusDetail('Connecting…')`, so the UI and the send guard tell the truth for the whole window.
- New `abandonAttach` helper applies `disconnected` + phase `failed`; it is called on the TLS-fingerprint-changed early return, the one abort that returns while the window is open.
- The other early returns are `if (!isCurrent()) return`, where a newer attach owns the state, so they are left alone; the generation guard and all later logic are unchanged.
**Tests:** 1 test (`__tests__/provider-lifecycle-test.tsx`, LIFE-6): gateway A connected, switch to B with the manifest fetch held open — `status` is `connecting`, `sendChatInput` returns `'queued'`, A's client never saw `streamChat` and no second client was built yet. Pre-fix it failed with `status` still `'connected'`.
**Residual:**
- An attach that throws after the window opens (e.g. `loadGateways()` for a child profile) leaves `status` at `connecting`; the caller reports it through `reportAutoConnectFailure` and `applyConnectionPhase('failed')`. Converting `status` there is outside this package's regions.

### LIFE-7
**Status:** Not fixed (decision needed)
The guard compares a profile's stored fingerprint with itself (`checkTlsFingerprintTofu(gateway, gateway.tlsFingerprint)`), so `changed` can never fire. A real check needs the observed certificate fingerprint, which React Native / `expo/fetch` cannot read, so the options are native pinning or removing the claim from the UI. Either is a product/native decision rather than a defect fix, so nothing was changed.

### LIFE-8
**Status:** Fixed (commit a59aeb2)
**Diagnosis:** CONFIRMED. `deleteGateway` awaited `deregisterWithGate(leaving)` before `leaving?.disconnect()` and the state reset, so an unreachable Gate held the teardown for the request timeout with the deleted gateway still reading as active; `disconnectGateway` already issued the same call as `void … .catch(…)`.
**Fix:**
- The call is now started rather than awaited and raced against a new `DEREGISTER_TIMEOUT_MS = 3000` clock: `void Promise.race([deregisterWithGate(leaving), timeout]).catch(() => undefined)`.
- Teardown continues immediately, and the call is still issued before `leaving?.disconnect()`, so the RPC goes out over the HTTP transport disconnect does not cancel.
**Tests:** 1 test (`__tests__/provider-lifecycle-test.tsx`, LIFE-8): a `deregisterWithGate` that never settles still settles the teardown under fake timers with no timer advance — active gateway null, status `disconnected`, deregistration attempted. Pre-fix the teardown promise never settled. The source-pinning test in `__tests__/push-connect-hooks-test.ts` asserted `source.indexOf('await deregisterWithGate(leaving)') > -1`, pinning the defect; it now slices the `deleteGateway` body and asserts the call is there, inside a `Promise.race([`, not awaited, and still before `leaving?.disconnect()`.
**Residual:**
- A Gate slower than 3 s misses the deregistration; that is the trade the brief asks for, bounded by a constant instead of the transport's own timeout.

### SPD-6
**Status:** Fixed (commit 6dca43c)
**Diagnosis:** CONFIRMED. The roster effect in `chat-screen.tsx` depended on `[surface.kind, status, listBots]`, so every return to the roster and every reconnect issued `/v1/bots` with no cache. The author ADDED two defects found while fixing it: the effect re-keyed on `activeGateway` going `null` and back to the same id, so a disconnect reset a good roster twice (Bot display name and pinned model fell back to defaults); and the 20 s throttle stamp survived a gateway switch, so A → B → A inside 20 s read nothing.
**Fix:**
- `ROSTER_REVALIDATE_MS = 20_000` with `rosterReadAtRef` keyed by gateway (`:1471`); the effect early-returns inside the window, and pull-to-refresh (`refreshRoster`, `:1943`) always reads and stamps.
- A separate effect paints `readCached('roster', gatewayId, 'bots')` before any network call and clears `rosterLoading` (`:1506`).
- Rows are kept across the re-key: `rosterRowsForGateway` (`:222`) returns the previous rows when `gatewayId === undefined` (a disconnect, not a switch) and resets only on a real switch; the switch also clears `rosterReadAtRef` and `rosterAnsweredRef` (`:1495`).
- `rosterAnsweredRef` (`:1480`) records which gateway a *successful* live read answered for — stamped by all three reads (mount `:1537`, refresh `:1942`, create/edit `:2169`) and read by the cached paint as `liveAnswered` (`:1514`), so a remembered roster cannot restore Bots an empty-but-ok read had just removed. A failed read deliberately does not stamp.
**Tests:** `__tests__/chat-roster-swr-test.ts` (21) — behavioural tests drive the exported helpers: `a status flip inside 20s does not re-read; an explicit refresh always does`, `a disconnect keeps them — the same gateway is coming back`, `a switch resets the rows before anything reads`, `an empty-but-ok read is believed`, `a remembered roster never paints over an answer that already landed` (and the same fold with `liveAnswered: false` paints, which is the SPD-5 promise). Wiring tests pin the effects: `the mount path paints the cached roster before it reads` (extended to assert the `liveAnswered` capture), `every live roster read stamps the gateway it answered for` (a stamp-count test), `the rows are re-keyed when the active gateway changes` (extended to assert the early return and both ref clears).
**Residual:**
- The roster is pinned by source-shape assertions plus tested pure helpers, not by a mounted render — `ChatScreen` needs the whole app tree and the repo has no harness for it. Logic regressions are caught behaviourally, wiring regressions by the source assertions.
- `refreshRoster` and the create/edit path still capture `gatewayId` before their `await` and do not re-check it (pre-existing shape, unchanged).

### SPD-8
**Status:** Fixed (commit 511b310)
**Diagnosis:** CONFIRMED. `manifestForAttach` in `src/lib/portal/attach-manifest.ts` read the cache last: `fetchLive()` (10 s), a `GATE_MANIFEST_RETRY_MS` (900 ms) sleep, `fetchLive()` again, and only then `loadCached()` — so a known Gate that was down or slow could not start `client.connect()` for ~21 s with a usable manifest in storage.
**Fix:**
- `manifestForAttach` (`:58`) now reads the cache first for a `knownGate` profile only: on a hit it returns `{ manifest: cached, source: 'cached' }` immediately and starts `void fetchLive().then(saveCached).then(onLive)` in the background, with every failure swallowed and no retry sleep on that path.
- With no cached manifest the old ladder is byte-for-byte unchanged (live → sleep → live again → save + `source: 'live'`, else `source: 'none'`); a non-`custom` profile never calls `loadCached()` and never starts a refresh. `lateManifestUpgradesClient` and `GATE_MANIFEST_RETRY_MS` unchanged, so `'none'`-sourced connects still upgrade.
- New optional `onLive(manifest)` parameter hands the background refresh's answer to the caller once saved; a refused `saveCached` still delivers it. In `attachClient` the provider's `onLive` calls `adoptLiveManifest(served, 'cached')`, so the `cached` case no longer needs a second post-connect fetch.
**Tests:** `__tests__/gate-attach-manifest-miss-test.ts`, new `describe('a known Gate that already has a manifest')` — `connects on the cached manifest instead of waiting for the live one` (fake timers, `fetchLive` held open, `sleep` asserted uncalled), `the refresh that lands is saved and handed to the caller, never fetched again`, `a refresh that fails or finds nothing changes nothing the connect depends on`, plus the unchanged-behaviour guards `a Gate with nothing cached still pays the retry before giving up` and `a profile not known as a Gate never reads the cache or starts a refresh`. In `gateway-provider-connected-reads-test.tsx`, `a cached manifest refreshes in the background and is published when it lands`. No pre-existing assertion pinned the cache-last order.
**Residual:**
- The background refresh is not cancelled when the attach is superseded; it can still land and write the cache. That write is correct (it is the manifest the Gate is currently serving) and `onLive` is guarded by the attach's `isCurrent()`, so nothing stale reaches provider state.

### SEND-3
**Status:** Fixed (commit 4a9e3cc)
**Diagnosis:** CONFIRMED. `stopStreaming` did `setMessages(prev => prev.filter((m) => !m.streaming))`, deleting the text already on screen, and `sendMessage`'s abort branch then ran `convertStreamError` on a message that no longer existed. The author CORRECTED the marker: the kept bubble must not reuse `interrupted`, because every reader of that flag treats it as outstanding work (the recovery ladder, `preserveInterruptedAfterReload`, the per-run status poll).
**Fix:** (`src/lib/gateway/message-reducer.ts` and the provider)
- New `stopStreamedTurns(messages)` settles every streaming placeholder: text kept and `streaming: false`, running tool cards promoted to `complete`, a placeholder with no text dropped; `stopStreaming` calls it instead of filtering.
- Kept bubbles carry a distinct marker, `StoppedTurnMarker` / `isStoppedTurn`, read through the predicate because `src/lib/gateway/types.ts` is outside this package's allowed files.
- `sendMessage`'s abort branch asks the message itself (`isStoppedTurn`) whether Stop already settled it, so nothing a later send does changes the answer.
- `appendStreamDelta`, `appendReasoningDelta` and `appendToolCallDelta` no longer re-set `streaming: true` on a stopped bubble, so a chunk delivered between Stop and the transport noticing the abort cannot restart the orb.
**Tests:** New `__tests__/message-reducer-stop-test.ts` (13 cases): keep/finalize/mark, stopped is not interrupted, every placeholder settled, tool card promoted, empty and whitespace-only dropped, no mutation, the three late-delta cases (red on the round-2 code: `Expected: false / Received: true`) and a negative control that an ordinary turn still streams. `__tests__/provider-detachable-turn-test.tsx` drives it end to end: partial text survives Stop not streaming, the abort branch and a later send do not delete it, a text-less placeholder is removed, and a delta arriving after Stop leaves the orb stopped. No existing assertion pinned the filter.
**Residual:**
- A stopped bubble is not restored by `preserveInterruptedAfterReload`, so a reload (thread switch, Bot open, reconnect) drops a stopped partial reply the Gate never persisted — deliberate, since restoring it would re-arm the reconcile.
- The kept partial assistant turn is still sent to the gateway as a completed turn in the next turn's context; the conversation filter is shared with ordinary history.
- Nothing renders "Stopped" (`message-bubble.tsx` / `types.ts` out of bounds), and deltas still buffered when Stop lands are dropped by `batcher.cancel()`.

### SEND-4
**Status:** Fixed (commit 4a9e3cc)
**Diagnosis:** CONFIRMED, plus a round-1 defect the author found: with a signal now reaching the stream, Cancel's abort was presented as a failure — `assertChatStreamComplete` throws `Chat stream stopped`, which `sendChatInput`'s catch turned into a `lastError` banner, a Failed command bubble, and a transcript write overwriting the `cancelled` status `cancelCommand` had just recorded.
**Fix:**
- `runAgentCommand` creates an `AbortController`, parks it in `abortControllerRef`, passes `signal` to `streamChat`, and clears `activeRunIdRef.current` only while it still equals its `runId`, so `cancelCommand` reaches the work and a later reconnect no longer freezes an unrelated bubble.
- `asCommandAbort(error)` re-throws the operator's stop as an `AbortError`; `runTask`'s catch marks the Activity row `cancelled` and `sendChatInput`'s catch sets no `lastError` and leaves `Cancelled: <label>`, with a cancelled transcript entry not dressed as a failure on the way back in.
- `finally` consults `liveControllersRef` (a `WeakSet` of controllers whose owner has not unwound): a displaced chat send still in flight gets its controller back, one that already unwound gets `null`, and `sendMessage` drops its own controller from that set in its `finally`. Before this, restoring a dead controller silenced the BG-1 ladder for the rest of the session.
**Tests:** New cases in `__tests__/provider-detachable-turn-test.tsx`: Cancel aborts the signal handed to the stream; a finished command leaves no run id for a reconnect to freeze; a chat turn streaming alongside a command is the one Stop settles; a chat turn finishing alongside a command does not take its Cancel with it; no banner, no Failed badge, cancelled transcript. The BG-1 ladder case ("a command that displaced the failing turn does not silence the ladder") is this code path's regression. The `/run`-through-`cancelCommand` path is covered only by that catch's own `isUserAbort` guard — the fake client has no run surface.
**Residual:**
- `abortControllerRef` is still one slot shared with `sendMessage` and `stopStreaming`, so a chat turn and a command running at once stay mutually unstoppable; asserted by a test rather than ignored.
- `sendMessage`'s `finally` still clears `activeRunIdRef.current` unconditionally, so with two sends in one tick the first drops the second's run id and a later reconcile would not freeze that bubble. The reviewer declined it as a third instance of the pattern the harness named elsewhere; a one-line compare would fix it.

### SEND-5
**Status:** Fixed (commit 3de607a)
**Diagnosis:** CONFIRMED. In the bare branch of `runModelCommand` (`src/lib/gateway/slash-commands.ts`) `const validation = await validateModelId(modelId, context)` was computed and never read (ESLint `no-unused-vars`), so the override was set with no warning at all while `/model set` ~15 lines below warned "Not found in the live catalog" from the same value.
**Fix:**
- Added `modelCatalogValidationCopy(validation)` — `'Not found in the live catalog (you can still force it).'` when `state === 'missing'`, else `` `Catalog: ${validation.label}` `` — and used it in both places so the two surfaces cannot drift.
- The bare branch now appends that line to the success text when `validation.state === 'missing'`, **after** `setModelOverride(modelId)`; the result is still `textResult(...)` under `/model`, still says the session will reopen, and still requires no `--confirm`/`--force`.
- The `/model set` preview's inline ternary was replaced with the same helper; its confirm line and `--force` suffix are unchanged.
**Tests:** `__tests__/slash-model-switch-test.ts` +2 tests in the existing mocking style: `/model unknown-id` against a catalog containing only `grok-4` calls `setModelOverride('unknown-id')`, still returns "session will reopen" **and** now contains "Not found in the live catalog"; `/model grok-4` calls `setModelOverride('grok-4')` and contains no warning — the control that stops the fix warning on a model that is in the catalog. The first was verified failing on the pre-fix `slash-commands.ts`; the second passes on both by design. Existing `/model set … --confirm` and bare-form tests untouched and passing.
**Residual:**
- The warning is a text line appended to a successful result; it does not block the switch. That is the requested behaviour (a bare pick is not destructive, so no `--force` is required).

### SEND-6
**Status:** Fixed (commit 4a9e3cc)
**Diagnosis:** CONFIRMED as written. Fourteen `void upsertGateway(x).then(setGateways)` sites had no `.catch`, so a refused storage/Keystore write left an unhandled rejection and a silent loss, and three of them spread the `gateway` closure captured when the turn started.
**Fix:**
- New `persistGateway(next: GatewayProfile)` writes, applies `setGateways` on success, and names a failure (`Could not save gateway settings: …`) through `setLastError`; every fire-and-forget site now uses it. `upsertGateway` is still awaited only where a caller needs the result: `resolveGatewayForUrl`, the `/model` slash path, `approveTlsFingerprintChange`.
- The three stale bases in `sendMessage` (success path, catch path) and `clearDeviceModelLock` now spread `{ ...(activeGatewayRef.current ?? gateway) }`, so a model or session pin the operator changed during a long turn survives the write-back; those sites also update `activeGatewayRef.current` and `setActiveGateway`.
**Tests:** New `__tests__/provider-profile-write-test.tsx`: a refused write sets `lastError` and raises no `unhandledRejection`, a refused model-lock write is named too, and clearing the lock on completion does not revert a mid-turn model pick. `__tests__/model-lock-wiring-test.ts` carried an assertion that pinned the defect (`const next = { ...gateway, modelLocks: updated }` followed by `upsertGateway(next)`); it now requires the live base plus `persistGateway(next)`.
**Residual:** none.

### STORE-2
*Package ST1*
**Status:** Fixed in part — the audit's other STORE-2 point, one SecureStore item holding every gateway (the ~2 KB iOS limit that grows with saved gateways), is unchanged; it was out of the brief and the audit notes Android is the shipping target. The error-honesty and destroyed-credentials halves are fixed.
**Diagnosis:** CONFIRMED on both halves. In `src/lib/storage/secure-key-value.ts`, one `try/catch` covered the import, the `isAvailableAsync()` probe and the operation, so any throw fell through to `allowInsecureFallback`, which in a release build throws a dev-only "unavailable … refusing" message. In `src/lib/gateway/storage.ts` `loadGateways` returned `[]` for both a parse failure and a non-array, and the next `upsertGateway` overwrote the original.
**Fix:**
- `secure-key-value.ts`: `runSecureStore(operation, key, run)` retries once after 150 ms and then throws `[secure-key-value] SecureStore <read|write|remove> of "<key>" failed: <cause>` — no "unavailable", no production write fallback.
- A `STORE_ABSENT` sentinel keeps the `isAvailableAsync() === false` answer on the dev-only path; `loadStoreOrNull` still treats a package that will not load as absent. `secure-key-value-fallback-test.ts` passes unchanged.
- The probe sits inside the retried operation, so a throwing `isAvailableAsync()` is retried rather than read as an absent store. Legacy AsyncStorage → SecureStore migration on read is unchanged.
- `getItem`/`setItem`/`removeItem` take an optional trailing loader (defaulting to the dynamic import) — the same seam as `widget-device.ts`; without it the retry path is untestable under jest. Existing call sites stay source-compatible.
- `storage.ts`: `preserveCorruptGateways` parks the raw string at `versutus:gateways:corrupt-<timestamp>` through `keyValueStorage` and `console.warn`s before `loadGateways` returns `[]` — both the parse-failure and non-array branches. `pruneCorruptGateways` keeps the 3 newest in numeric order; `nextCorruptStamp` keeps two same-millisecond failures apart.
**Tests:** `__tests__/secure-key-value-retry-test.ts` (new, 9 cases; the 5 "store that throws" cases red pre-fix: one-shot read/write failures retry and succeed, persistent read/write/remove failures name the operation and cause, never "unavailable" or "development-only", and leave AsyncStorage empty with no warning). `__tests__/gateway-storage-corrupt-test.ts` (new, 5 cases; 4 red): corrupt and non-array blobs kept byte-exact under a `versutus:gateways:corrupt-` key with the key named in the warning, the copy survives a following `upsertGateway`, five failures leave exactly the 3 newest, a parsable blob produces no copy. Existing `gateway-storage-test.ts` and `child-sync-test.ts` each gained an AsyncStorage `jest.mock` (they mock SecureStore only); no assertion in either was changed, removed or weakened.
**Residual:**
- The rescue copy is plaintext by construction, so an unparsable blob is also copied to less-protected storage.
- Because `upsertGateway` loads internally, the first overwrite of a corrupt blob writes two copies; `lastCorruptStamp` is per-process, so the 3-copy cap restarts from disk after a restart.

*Package ST2*
**Status:** Fixed (commit 49b7026) — the rescue-copy part of the finding only (this part). The audit's other STORE-2 items (whole array in one SecureStore value, iOS ~2 KB risk) are untouched by this commit.
**Diagnosis:** The audit section (docs/failure-audit-2026-09-30.md:470) does not itself describe the plaintext copy; the author's diagnosis CONFIRMED the brief: `preserveCorruptGateways` in src/lib/gateway/storage.ts wrote the unparsable blob through `keyValueStorage` (plain AsyncStorage) and `pruneCorruptGateways` listed/removed those keys there. ADDED: the blob is exactly what `writeGateways` persists, so it carries every `GatewayProfile.token`/`sessionKey`; the old comment justifying plain storage is self-refuting (a parse failure means SecureStore handed the value over); and prefix-pruning is impossible against the target store because `secureKeyValueStorage` (src/lib/storage/secure-key-value.ts) exposes no `getAllKeys`.
**Fix:**
- src/lib/gateway/storage.ts: dropped the `keyValueStorage` import; the module no longer touches plaintext storage.
- Replaced the timestamp prefix + `CORRUPT_GATEWAYS_KEPT` with a fixed ring: `CORRUPT_GATEWAYS_SLOTS = 3`, `CORRUPT_GATEWAYS_SLOT_PREFIX`, `CORRUPT_GATEWAYS_NEXT_KEY` (`versutus:gateways:corrupt-next`).
- `preserveCorruptGateways` reads the counter from SecureStore, writes the raw bytes to `versutus:gateways:corrupt-<counter % 3>`, writes `counter + 1` back; newest three kept by overwrite, so no key listing and no `removeItem`.
- Deleted `pruneCorruptGateways`, `nextCorruptStamp`, `lastCorruptStamp`; added `corruptGatewaysSlotKey` and `parseCorruptGatewaysCounter` (missing/invalid/negative/non-integer reads as 0, ring restarts).
- Both `console.warn`s kept and now name the slot key; the failure one says the write went to SecureStore. Doc comment rewritten to say the store handed the value over and only its contents are bad.
- `loadGateways` unchanged: still returns `[]`, still preserves first (parse failure and non-array), still never throws from the rescue — the counter read has its own `try`, the slot write and counter write-back share one.
**Tests:**
- `__tests__/gateway-storage-corrupt-test.ts` now asserts against the secure-store mock; no existing assertion deleted or weakened. The count-based "keeps the three newest copies" was changed to "…and overwrites the rest of the ring": per-slot assertions after five loads (`-0 = broken-four`, `-1 = broken-five`, `-2 = broken-three`, exactly 3 slots) instead of sorted values.
- New: "never reaches the plain store, which is where the tokens were audited out of" — no `keyValueStorage.setItem` call carries a `versutus:gateways:corrupt` key, the raw token-bearing string is absent from the plain store and present in a secure slot. New: "a rescue copy the secure store refuses does not break the load" — load still resolves `[]`, nothing stored, failure warning emitted. `beforeEach` re-seeds the secure mock so that override cannot leak.
- `__tests__/gateway-storage-test.ts`: removed the now-unneeded `@react-native-async-storage/async-storage` mock and reworded the comment; no test touched. 14 tests pass across the two suites; with the old code restored 6 of 7 corrupt tests fail (author-verified).
**Residual:**
- Older plaintext `versutus:gateways:corrupt-<timestamp>` copies from previous builds are not migrated or purged; a token-bearing blob stays on disk until the user clears app data. Author flagged rather than did it — no migration hook exists and the brief did not ask.
- If the counter write-back fails after a successful slot write, the next copy reuses that slot (one copy lost) — matches the brief's sequence, better than the old unprunable plaintext copy.

### STORE-3
**Status:** Fixed (commit 79b7305)
**Diagnosis:** CONFIRMED. `loadTranscripts` (now `readStoredEntries`) guarded only `JSON.parse`, and `loadOfflineQueue` / `loadActivityRuns` in `src/lib/gateway/session-persistence.ts` did the same, so a throwing `getItem` propagated into the provider's `bootstrap()` `Promise.all` and into `reloadHistoryFor`'s own `Promise.all`.
**Fix:**
- `transcript.ts` `readStoredEntries` puts `keyValueStorage.getItem` in its own try/catch: a refused read returns `[]` and `console.warn`s the cause. It is also the read-through path the queued mutations use, so a refused read cannot fail a queued update either.
- `session-persistence.ts` `loadOfflineQueue` and `loadActivityRuns` wrap their `getItem` the same way, each returning its empty value with one warning; the new `errorText` helper formats the cause.
**Tests:** `__tests__/session-persistence-read-guard-test.ts` (new, 3 cases; 2 red pre-fix) — a throwing `getItem` yields `[]` and no throw from `loadOfflineQueue` and `loadActivityRuns`, one warning each naming the cause; the unparsable-value case stays a quiet empty list (old behaviour kept). A further red-pre-fix case in `transcript-write-behind-test.ts` gives `loadTranscripts` an empty transcript and one warning when `getItem` throws.
**Residual:**
- The warning is the only record that history did not come back; nothing in the app or test suite reads it.

### UI-3
**Status:** Fixed (commit 3de607a)
**Diagnosis:** CONFIRMED as written. `HandsfreeCallBanner` (`src/components/voice/handsfree-call-banner.tsx`) is mounted unconditionally at the app root (`src/app/_layout.tsx`); its `useSyncExternalStore` subscribe ran `setInterval(onStoreChange, 1000)` against a `Math.floor(Date.now()/1000)` snapshot, and `if (!active) return null` sat **after** all the hooks, so an idle app still ticked a 1 Hz store and re-rendered the banner 60×/minute for the whole process lifetime.
**Fix:**
- Split in two: the outer `HandsfreeCallBanner` now calls `useHandsfreeVoice()`, `return null` when `!active`, and otherwise renders a new `ActiveHandsfreeCallBanner`, which owns the `useSyncExternalStore` elapsed clock and every other hook (`useTokens`, `useSafeAreaInsets`, the label/copy derivations).
- The `setInterval` therefore only exists while a call is active. Hook order stays legal in both components because the early return is now above any hooks in the outer one.
- The active banner's markup, props, styles and copy are unchanged; the only other edit in the file is a stray capital "A" → "a" in a comment on the moved lines.
**Tests:** new `__tests__/handsfree-call-banner-timer-test.tsx` (jest-expo + react-test-renderer, `useHandsfreeVoice` and UI primitives mocked, fake timers). `with active: false the banner schedules no clock` spies on `setInterval` and asserts it is never called, and asserts the pending-timer count matches a baseline measured from a control component that renders `null`. `with active: true the elapsed copy ticks` asserts the 1 s interval is created and that advancing 2 s changes the rendered output. Verified failing on the pre-fix banner (1 failed / 1 passed) by restoring the HEAD file.
**Residual:**
- The brief asked for `jest.getTimerCount()` to "stay 0"; the author found that unreachable — React's own scheduler parks exactly one timer under `jest.useFakeTimers()` even for `() => null` — and declined to fake it, asserting "no interval exists" plus "count does not exceed the measured scheduler baseline" instead. A reviewer expecting a literal `0` should read this as a deliberate substitution.

### UI-4
**Status:** Fixed (commit 6017230)
**Diagnosis:** CONFIRMED, with three additions. `src/app/_layout.tsx` exported no `ErrorBoundary`; Expo Router v57 wraps a route's own component in it (`useScreens.js:141-160`), so for the root layout that component is `RootLayout` — the only place a render error from `GatewayProvider` / `HandsfreeVoiceProvider` / `FontProvider` can be caught. The only boundaries were the four `componentDidCatch` canvas classes (`constellation-canvas.native.tsx`, `spend-chart-plot.native.tsx`, `AmbidentCanvas.native.tsx:35-49`, `handsfree-call-indicator.native.tsx`). ADDED: nothing in `src/` touched `ErrorUtils`, and RN's handler only feeds LogBox in `__DEV__`, so a release-build uncaught error in an event handler ended the app with nothing recorded. ADDED: `polyfillPromise.js:28-35` only enables the rejection tracker under `__DEV__`, so a release build had no tracker at all, and Hermes accepts exactly one — hence the chain to RN's options rather than a replacement. CORRECTED: `ErrorBoundaryProps` is exported from the `expo-router` root (`exports.d.ts`), not `views/ErrorBoundary.d.ts`; `retry` is `() => Promise<void>`.
**Fix:**
- New `src/lib/diagnostics/failure-log.ts` (`recordFailure` / `loadFailures` / `clearFailures` / `installGlobalFailureHandlers`, no React): persists through `keyValueStorage` under `versutus:failure-log:v1`, newest 50, message capped 500 / stack 2000, every read-modify-write serialized so same-tick records both land.
- Consecutive identical records fold into the top row and only `count` moves (identity is kind + message + fatal, not stack), keeping the first timestamp; every storage touch is its own try/catch, so a corrupt value reads as an empty log and one bad row is dropped without emptying the rest.
- `installGlobalFailureHandlers` wraps `ErrorUtils.getGlobalHandler`/`setGlobalHandler`, records kind `js-error`, then calls the previous handler in a `finally` so the log is additive; for rejections it enables `HermesInternal.enablePromiseRejectionTracker` and forwards `onHandled`/`onUnhandled` to RN's own `promiseRejectionTrackingOptions`. Idempotent, returns an uninstall.
- New `src/components/error-fallback.tsx`: `Screen`/`Text`/`Button` on shared tokens, "Something went wrong", "Try again" wired to `retry`, "Copy details" via `expo-clipboard` with a refused clipboard swallowed.
- `src/app/_layout.tsx`: `installGlobalFailureHandlers()` at module scope right after `installStreamingFetch(...)`, plus `export function ErrorBoundary({ error, retry }: ErrorBoundaryProps)` recording kind `render`, `fatal: true` in an effect. Provider tree, navigation and screen options untouched.
- `src/app/gateway/diagnostics.tsx`: `Card variant="inset"` "Recent failures" after the Live check — loads on arrival, `<relative time> · <kind>` with a `×N` badge, empty state "No failures recorded", "Clear" disabled while empty; the Runtime environment card and its live check are unchanged.
**Tests:** four new files, 43 tests: `failure-log-test.ts` (19 — round trip, 60 records keep the newest 50, collapse/count, 500/2000 truncation, rejecting `setItem` does not throw and the log stays readable, three records in one tick all persist, corrupt JSON reads empty, ErrorUtils record-and-forward/uninstall/double-install against fakes, and an unhandled rejection reaching RN's `onUnhandled`), `error-fallback-test.tsx` (4), `root-error-boundary-test.ts` (16, source-pinned, asserts the provider tree above the Stack is byte-for-byte unchanged and streaming fetch still installs first), `diagnostics-failures-section-test.tsx` (4). No existing test was changed, skipped or weakened. One of the author's own new assertions was corrected: it pinned the recorded stack byte-for-byte, which cannot hold under the 2000-char cap, so it now pins the truncated stack.
**Residual:**
- Hermes cannot switch a rejection tracker off: `uninstall()` re-installs RN's options best-effort and, if that module is unresolvable, the tracker stays ours. Documented in the code.
- Deliberate lint warning at `failure-log.ts:236`: `require` through a `specifier` const is the only typed way to reach RN's Flow-only `promiseRejectionTrackingOptions` (static import, `declare module` and dynamic `import()` are all TS errors, and disables are forbidden). The alternative was dropping RN's tracker on Hermes, which the brief forbids.
- Release builds now install a promise-rejection tracker where they previously had none (RN gates it behind `__DEV__`); RN's own options are chained so nothing already reported is silenced. No render test of the exported `ErrorBoundary` (importing `_layout.tsx` into jest pulls in every provider) — it is covered by the source-pinned contract test. A record whose write fails is lost by design; the fallback renders above `ThemeProvider`/`FontProvider`, so its type falls back to the platform font on a cold crash.

### UI-5
**Status:** Fixed (commit 3de607a)
**Diagnosis:** CONFIRMED, both halves. (1) In `src/components/terminal/terminal-screen.tsx` the effect owning the live shell had deps `[gatewayId, status]` and its cleanup calls `sessionRef.current?.close()`, so any status flip (health blip → `reconnecting` → `connected`) closed the SSE stream — which the Gate treats as the shell going away — and the start effect then opened a fresh empty one. (2) `sendToTerminal` called `setInput('')` before awaiting the request, and its catch set the error **and** `setTerminalConnected(false)` for *any* failure, so a transient 500 destroyed what the user typed and made a healthy stream read as disconnected.
**Fix:**
- The cleanup effect's deps are now `[gatewayId]` — the live session closes only on a gateway change or unmount. The start effect is untouched, so a session still starts once connected, and a genuinely dead stream is still reported by the existing `onError` / `onExit` / `onClose` handlers, which all null the ref and clear the flag.
- `sendToTerminal`'s catch derives `message` once, restores the typed text with `setInput(value)`, sets the error, and clears `terminalConnected` only when `message.includes('404')` (the gateway no longer knows this session). Any other failure leaves the session alive and untouched.
**Tests:** new `__tests__/terminal-session-survival-test.tsx` (render-level; `openTerminalSession`, `sendTerminalInput` and `useGateway` mocked, mode switched to Shell through a mocked `TerminalModePicker`): a `connected → reconnecting → connected` blip never calls `session.close`; a gateway change calls it exactly once; a rejected send leaves `'ls -la'` in the text field. 2 of 3 verified failing on the pre-fix screen (the gateway-change one passes on both, by design). `__tests__/terminal-shell-disconnect-flag-test.ts` — which the previous attempt left with a **syntax error** (unterminated regex on the `not.toMatch` line, breaking `tsc` and every importer) — is repaired and its first test now pins the new contract: deps `[gatewayId]`, `}, [gatewayId, status]);` gone, cleanup still closes + nulls the ref + clears the flag.
**Existing assertion that pinned the defect — changed:** `__tests__/terminal-error-banner-mode-test.ts:71` asserted the exact inline text `setTerminalError(error instanceof Error ? error.message : String(error));` inside the send catch. That form is gone by design (the message is now derived once and also inspected for 404), so the assertion now pins `setInput(value);` / `setTerminalError(message);` — same intent, new shape. Nothing deleted, skipped or weakened.
**Residual:**
- A full offline (not a blip) no longer closes the session from the effect; it is closed by the stream's own `onError`/`onClose`, which is what the brief asked for.
- `sendToTerminal` still pushes the value onto the input history before the request, so a failed send leaves the text restored **and** in history. Left as-is: the brief asked only for the restore.

### NOTIF-1
**Status:** Fixed (commit 143d3f7)
**Diagnosis:** CONFIRMED as written. `ensurePermission` in `src/lib/notifications/local.ts` cached only `permissionGranted = settings.granted`, so any non-`true` answer fell through to `Notifications.requestPermissionsAsync()` on every notice; because `present()` returns early while foregrounded, those requests fired from the background.
**Fix:**
- `src/lib/notifications/local.ts`: added `PERMISSION_DENIAL_TTL_MS = 10 * 60 * 1000`, module-level `permissionDeniedUntil`, and `denialRemembered()` / `rememberDenial()`.
- `ensurePermission` returns true if a grant is cached, false if a refusal is still remembered, otherwise reads `Notifications.getPermissionsAsync()` first — `granted` caches true; `status === 'denied'` or `canAskAgain === false` remembers the refusal and returns false without asking.
- `requestPermissionsAsync()` is now called only from an undetermined state with `isForegrounded()` true; a refusal from that dialog is remembered by the same TTL. Whole body stays inside the existing `try`/`catch`, so it never throws. Exported names, `present()` and all copy unchanged.
**Tests:** new `__tests__/notification-permission-test.ts`, 7 cases, each reloading the module via `jest.resetModules()` + `jest.requireActual` because the grant cache and remembered denial are module state. Proves a denial is never re-asked across three notices, `canAskAgain: false` is final, undetermined reads but does not ask in the background, undetermined asks once (and caches) when foregrounded, a grant posts without asking, foreground suppression is unchanged, and a throwing phone resolves instead of throwing. Six existing suites (`gateway-down`, `run-notice-data`, `approval-notice-payload`, `bot-reply-route`, `approval-action-fallback`, `notifications-run-progress`) mocked `expo-notifications` without `getPermissionsAsync`; each mock gained one, no assertion changed.
**Residual:**
- Since `present()` suppresses notices while foregrounded and every poster passes `allowForeground: undefined`, the request branch is reachable only in the race where the app comes forward mid-read; in the shipped flow the Settings toggle raises the dialog. Until permission is settled elsewhere, local notices post nothing rather than asking from the background.

### PUSH-1
**Status:** Fixed (commit 97f25f0)
**Diagnosis:** CONFIRMED. `push-send.mjs` `send()` awaited `collectReceipts` on the ticket ids it had just been handed, a second HTTP round trip for receipts Expo does not produce for ~15 minutes, so the poll returned nothing, receipt-found dead tokens were never pruned, and every notification paid the round trip. CORRECTED from the first attempt: the deferred collection passed ticket ids into `tokens.removeByToken`, which matches stored `expoPushToken` values, so the prune was a silent no-op and the ticket-id→token map had been dropped.
**Fix:**
- `send()` no longer calls `collectReceipts`; it returns `{ok: true, tickets, ticketTokens, receipts: [], deadTokens}`, with `deadTokens` coming only from tickets that themselves say `DeviceNotRegistered`.
- `ticketTokens` is a plain `{ticketId: expoPushToken}` map (first token per ticket), and `collectReceipts(ticketIds, ticketTokens)` translates receipt ids back to push tokens before reporting `deadTokens` (still exported and chunking at 1000 ids).
- `push-notifier.mjs` `scheduleReceiptCollection` starts one `unref`'d timer per successful batch (default 15 min, injectable via `receiptDelayMs`), passes the map through with the ids, and prunes via the existing `tokens.removeByToken`; collection errors are logged, not thrown. `server.mjs` wires `collectReceipts: pushSend.collectReceipts` into the notifier.
**Tests:** three existing `push-send.test.mjs` tests pinned the inline poll and were rewritten — they now assert zero receipts calls, `receipts: []`, and dead tokens still reported from `DeviceNotRegistered` tickets. Added: receipt shape with id→token translation asserted, the 1000-id chunk boundary (1001 ids → two calls), `payload.errors` → `ok: false`, a `MessageTooBig` receipt passing through without being dead, and a `send` → `ticketTokens` → `collectReceipts` round trip. `push-notifier.test.mjs` adds an integration test wiring the real `createPushSend`, `PushTokenStore` and notifier against a fake fetch: nothing is collected inline, the dead row survives the send, one deferred collection runs carrying the map, and only then is the row pruned — plus no collection after a failed send and a swallowed, logged collection failure.
**Residual:**
- The deferred timer is in-process and unref'd, so a Gate that stops or restarts inside the window never collects that batch's receipts; those dead tokens are pruned by a later batch or not at all.

### GATE-8
**Status:** Fixed (commit 203821b)
**Diagnosis:** CONFIRMED: `proxyChat` / `chatViaProviderService` / `relayNormalizedSse` neither aborted the upstream `fetch` nor the reader when the client disconnected, and the `fetch` had no timeout, so Stop or a drop let the vendor stream keep running and billing, and a silent vendor held the request for undici's default. ADDED: the bound must be on response *headers* only — a reasoning model is legitimately silent for 30–120 s before its first token, so bounding the body would cut off slow streams — and a close that already fired has to be read live, since the `close` listener will never fire again.
**Fix:**
- `providerUpstreamCall(res, { headersTimeoutMs })` gives each provider-path chat call a client `AbortController` (`res.once('close')`) and a separate 120 s headers watchdog, combined with `AbortSignal.any`; `clearWatchdog()` runs in the `finally` the moment headers exist, so a slow stream is never cut off while the client's abort stays attached for the whole call. Node v24.14.0 confirmed, so `AbortSignal.any` is available.
- The headers timeout answers `504 { error: { code: 'upstream_timeout' } }`; every other upstream failure keeps the sibling 502 (`upstream_unreachable`, and `upstream_error` for an unreadable non-stream body). A `json()` failure that is only the client leaving is now a silent `return`.
- `relayNormalizedSse` cancels the reader on close, on an oversized line and in its `finally`, and re-reads `clientGone()` = `res.destroyed || res.writableEnded || upstream.clientGone` each pass and after the loop, so a disconnect mid-answer is observed and `[DONE]` is not written to a dead socket.
- The local-interface iterator branch of `chatViaProviderService` checks `clientGone()` between events and passes `upstream.signal` into `providerService.chat`, so the signal actually reaches the vendor adapter; its 504 mapping is the same.
- `createGate({ upstreamHeadersTimeoutMs })` makes the bound injectable for tests.
**Tests:** new `gate/__tests__/provider-chat-abort.test.mjs` (8) — a client that stops mid-stream takes the upstream with it (fake upstream counts a response closed before `writableFinished`); the same for a non-streaming `json()` turn; a never-answering provider is a 504 at the injected 60 ms; "the bound is on the headers: a slow stream is not cut off"; the profile adapter's signal is not aborted during a live turn and does fire when the caller disconnects. Existing assertion changed and disclosed: the adapter test asserted `signals[0].aborted === false` *after* `await response.text()`, by which time the correct abort was already true; replaced with `abortedMidTurn` recorded from inside the turn.
**Residual:**
- `relayNormalizedSse` keeps `res.once('close', release)` cancelling the reader directly as well as through the signal, deliberately, for readers whose `cancel()` ignores an aborted signal; the `finally` awaits it, so no reader is left open.
- The local-interface branch has no reader to cancel, so a generator parked forever holds its handler until the next event or the client goes away.

### GATE-9
**Status:** Fixed (commit 203821b)
**Diagnosis:** CONFIRMED, but the audit's suggested mechanism is the thing that does not work: racing the iterator against `close` and `break`ing calls `subscriber.return()`, which against the real `createEventLog().stream()` is queued behind an in-flight `next()` and never honoured, so the waiter stayed in the log's `waiters` for the life of the run — exactly the finding, unmet. The first pass's fix was wrong and its test could not see it because the fixture was a hand-written iterator whose `return()` is immediate. ADDED: a queued `return()` cannot unsubscribe this generator, so the unsubscribe has to be a signal.
**Fix:**
- `createEventLog`'s `stream(signal)` (`gate/core/cli-environments/run-protocol.mjs`) registers an abort listener that splices its own parked waiter out of `waiters` and resolves it, so the generator's loop re-checks and returns for real; `released` is checked before every yield and before parking, and the `finally` removes the listener.
- `pendingWaiters()` is exposed as the honest witness that a released subscriber is no longer parked.
- `CliEnvironmentService.events(runId, { signal })` (`supervisor.mjs`) passes the signal down; it is optional, so `awaitLastEvent` is unchanged.
- The `/v1/environments/:id/runs/:run/events` route creates an `AbortController` per subscription, aborts it on `res` `close` and in its `finally`, and hands the signal to `events(...)`; it still races `next()` against the close promise (`CLOSED_STREAM`) so the handler returns at once rather than waiting for the log to wake it, and the `run.failed` error frame is written only to a socket still writable.
**Tests:** `gate/__tests__/environment-run-events-release.test.mjs`, rewritten against the real `createEventLog` (4) — "the event log drops the waiter of a subscriber that lets go" parks a subscriber on an empty log, aborts, and asserts the in-flight `next()` resolves `done:true` with `pendingWaiters()===0`, that a later `emit` does not revive it, and that an un-signalled stream still receives events; "a viewer that leaves releases the run event subscription" runs a real Gate, reads `run.started` so the subscription demonstrably opened, destroys the socket, then asserts both `pendingWaiters()===0` and the real generator reaching its end; a run reaching its terminal event ends the response cleanly with every event on the wire and no invented `run.failed`; a throwing iterator still reports `run.failed`. The first pass's version of this file is replaced (disclosed): it asserted a `return()` call count on a hand-written iterator and could not fail for the right reason.
**Residual:**
- The `closed.then(...)` race adds one reaction per event (`server.mjs:2379`); left alone, as reordering does not remove the reactions.
- A `subscriber.next()` that rejected after the close race was won would be left floating; unreachable with the real `createEventLog` (abort only resolves the in-flight `next()`), and the reviewer agrees it is latent hardening.

### GATE-10
**Status:** Fixed (commit 203821b)
**Diagnosis:** CONFIRMED: `await backend.removeJob(jobId)` and `await backend.deleteSession(...)` were unwrapped, so any refusal fell through to the outer catch and became a generic 500 with a logged stack, leaving the app unable to tell "already gone" from "Gate broken". The audit's status/code mapping is adopted as written, modelled on the sibling `sessionReadError`.
**Fix:**
- New `deleteRefusal(error, fallbackCode)` in `server.mjs`: an integer `error.status` in [400, 600) passes through, `code === 'unknown_session'` or a message matching `/not found/i` → 404, otherwise 502; the body is `{ error: { message, code } }` with `error.code` when it is a string, else the fallback.
- `DELETE /v1/jobs/:id` wraps `backend.removeJob` with fallback `job_delete_failed`; `DELETE /v1/sessions/:id` wraps `backend.deleteSession` with `session_delete_failed`.
- Success paths (`{ok:true}` / `{deleted:true}`) and the outer `res.headersSent` guard are untouched.
**Tests:** one table-driven test per route in `backend-routes.test.mjs` over 503-with-code pass-through, a plain `Error` → 502 plus fallback code, `unknown_session` → 404, `status: 200` (an out-of-band status that would otherwise read as a successful delete) → 502, and the success path. Verified red by reverting only the two `try`/`catch` wrappers: both failed `500 !== 503`. No pre-existing assertion pinned the old behaviour.
**Residual:**
- The message passes through without the secret redaction `sessionReadError` applies; matching it would mean reaching into that handler's closure.

### GATE-11
**Status:** Not fixed (decision needed)
`/health` is intentionally an unauthenticated process-liveness probe, and the connection monitor depends on it. Making it report backend readiness changes what `connected` means in the app (and the `/health/detailed` route is authenticated), so it needs a decision on the contract: e.g. a `degraded` flag on `/health` that the monitor surfaces as a warning without leaving `connected`. Not changed.

### GATE-12
**Status:** Fixed (commit 3399f6e)
**Diagnosis:** CONFIRMED — `gate/core/voice/media-socket.mjs:18` imports `ws` statically, `gate/package.json` declares no dependencies, and the root `package.json` carries `ws`. CORRECTED, load-bearing: the brief put the preflight "before creating the Gate" inside `handleStart`, but that code cannot run — `gate/cli.mjs` imported `createGate` from `./core/server.mjs` at the top of the file and a static import graph is linked before any statement in the entry module runs. Reproduced in a sandbox copy: the process died with `Error [ERR_MODULE_NOT_FOUND]`, exit 1, and the author's `handleStart` code never executed. The preflight therefore had to move ahead of the module load, not just ahead of `createGate`.
**Fix:**
- `gate/cli.mjs`: the static `import { createGate } from './core/server.mjs'` became `const { createGate } = await import('./core/server.mjs')` inside the existing lock-releasing `try` in `handleStart`, so the server graph (and therefore `media-socket.mjs`) loads after the preflight. Side effect: non-server commands no longer load the server graph at all.
- The preflight sits in `handleStart` right after port resolution and before the instance lock and port bind: `await import('ws')` in try/catch, and on failure one line naming the command (`the Gate needs the repo's dependencies: run \`npm install\` in the repository root`), then `process.exit(78)`.
- `startFailureExitCode` and the 75 port/lock path untouched; no `package.json` or lockfile edited.
**Tests:** new `__tests__/cli-start-preflight.test.mjs` copies `cli.mjs`, `core/`, `flavors/`, `registry/` to an OS temp dir with its own `node_modules/ws` whose entry point is missing (the repo's `node_modules` is never touched), then runs `node cli.mjs start` and asserts exit **78**, the actionable line on stderr, no `ERR_MODULE_NOT_FOUND`/`at async`/`node:internal` text, and no `Starting` on stdout — proving it refuses before taking the port or the lock. Pre-fix this exits 1 with the raw module-resolution stack (verified).
**Residual:**
- The positive path (an installed checkout sails through the preflight) is not covered — proving it means starting a Gate, which the task forbade; the author verified it by hand (sandbox copy with working `ws` reaches the port/lock step, exit 75).
- The test's copy is ~700 KB / 113 files per run (~0.3 s) and depends on `cli.mjs`'s static import graph staying inside `core/`, `flavors/`, `registry/`; a new statically imported top-level `gate/` directory would need adding to that list.
- The supervisor still only special-cases 75; 78 falls into the generic 1-60 s backoff. Left alone as out of the allowed files, and the author judged it the right treatment for 78.

### VOICE-4
**Status:** Fixed (commit 4466fd9)
**Diagnosis:** CONFIRMED. The client was built with `readTimeout(0, TimeUnit.MILLISECONDS)` and no `pingInterval`, so after a network switch nothing timed out on the phone and reconnect could only start from `onFailure`.
**Fix:**
- `.pingInterval(15, TimeUnit.SECONDS)` on the same `OkHttpClient.Builder` (HandsfreeGateMedia.kt:52), with a comment naming the Wi-Fi→cellular case.
- `readTimeout(0, …)` kept; a missed pong arrives as `onFailure`, which already emits `socket_failed` and feeds the JS reconnect path.
**Tests:** none. No pre-existing assertion pinned the defect.
**Residual:**
- No unit test: the builder is not reachable from a JVM test without instantiating the client, and the behaviour under test is OkHttp's.
- Pings are sent every 15 s for the whole lifetime of a call.

### VOICE-5
**Status:** Fixed (commit 4466fd9)
**Diagnosis:** CONFIRMED in both loops. `HandsfreeGateMedia.startCapture` had `if (read <= 0) continue` inside `while (running)`, and `startBargeIn` in `HandsfreeCallService.kt` the same in `while (vadRunning)`; a record whose mic was taken or that lost audio focus returns an error code at once, so the thread spun at full CPU for the rest of the call. The author ADDED that both loops now sleep, so their bodies had to be guarded too or the new `Thread.sleep` could itself become an uncaught `InterruptedException` on a background thread.
**Fix:**
- Both loops sleep `READ_FAILURE_BACKOFF_MS = 10L` on a non-positive read and count consecutive failures; `MAX_CONSECUTIVE_READ_FAILURES = 100` ends the loop, a successful read resets the counter. Constants live in each class's companion object.
- Capture (HandsfreeGateMedia.kt:218-234) emits the existing fatal `media_failed` frame through `onFrame` at the 100th failure and breaks; the JS reducer turns a fatal error frame into `dispatch({type:'end'})`, so the existing path releases the socket, playback thread and records.
- The VAD loop (`HandsfreeCallService.kt:767-820`) sets `vadRunning = false` at the 100th failure and breaks.
- Both bodies wrapped: capture catches `InterruptedException` + `Throwable`, the VAD catches `InterruptedException` + `Exception`, matching each file's existing style.
- Reviewer note declined: the capture thread deliberately does not call `HandsfreeGateMedia.stop()`, because `start()` re-arms `running` and a late failure run from a previous call could close the new call's socket.
**Tests:** none for the backoff itself — the loops sit beside `AudioRecord` calls a JVM test cannot make. Surrounding behaviour is covered by the existing `JitterBufferTest` (6 tests) and the new `PlaybackLoopTest`/`JitterBufferConcurrencyTest`. No pre-existing assertion pinned the defect.
**Residual:**
- A slow-but-alive record returning `<= 0` 99 times in a row is tolerated; a real 20 ms frame at 16 kHz returns 640 bytes.

### VOICE-6
**Status:** Known / open (unchanged)
Hands-free calls not opening is tracked in `PENDING.md` and handed to another agent. The Kotlin fixes in VOICE-1..5 make the Gate-media path safer to exercise once it opens; they do not address why the session fails to start.

### TEST-1
**Status:** Fixed (commit 143d3f7)
**Diagnosis:** Accepted as stated, not reproducible here — the pair passes together in 3.5 s, so the breach only shows under parallel load. The fix is the one named in the audit.
**Fix:**
- `package.json`: added `"testTimeout": 20000` to the existing `jest` block, directly after `preset`. Nothing else in the file changed (no dependencies, no `collectCoverageFrom`, no thresholds).
**Tests:** none — jest configuration. Full suite run under the new timeout: 641 suites, 6325 tests, 0 failed.
**Residual:**
- A genuine hang over 20 s in one test now takes 20 s to report instead of 5 s; the requested trade.

### LINT-1
**Status:** Fixed in part — the `lint` script was deliberately not widened, because `eslint gate scripts --max-warnings 0` still exits 1 on two pre-existing `import/no-duplicates` warnings in `scripts/__tests__/serve-web-demo-guard.test.mjs` (lines 19-20), a file outside this package's allowed edit set. Widening the script would break `npm run lint` and `npm run verify`.
**Diagnosis:** CONFIRMED exactly. `npm run lint` is `expo lint && eslint gate --max-warnings 0`; the Node-globals block in `eslint.config.js` listed only `gate/**/*.mjs`, `gate/**/*.js`, `scripts/__tests__/**/*.mjs`. Linting `scripts/` reported 10 problems: 7 `'Buffer' is not defined` errors (`register-desktop-agent.mjs`, `smoke-provider-runtime.mjs`, `voice-spikes/s1-codex-realtime.mjs`), the unused `hasFlag` in `scripts/serve-web-demo.mjs:34`, and the 2 duplicate-import warnings. The audit's other items (`modules/`, SEND-5 `validation`, hook deps) are outside this package's edit set.
**Fix:**
- `eslint.config.js`: Node-globals `files` extended to `["gate/**/*.mjs", "gate/**/*.js", "scripts/**/*.mjs", "scripts/**/*.js"]` — the single permitted edit; `scripts/**/*.js` matches nothing today.
- `scripts/serve-web-demo.mjs`: removed the unused `hasFlag`.
- `src/app/fleet.tsx` and `src/app/runs.tsx`: removed the unused `activityRuns` destructure (the bare name in `fleet.tsx` is only an object property key, so the binding was dead).
- `package.json`: `lint` left as `expo lint && eslint gate --max-warnings 0`. Nothing else changed.
**Tests:** none — lint configuration. Evidence is exit codes: `eslint scripts` exits 0 with the Buffer errors and dead variable gone; `eslint gate --max-warnings 0` still exits 0.
**Residual:**
- `scripts/` is lint-clean but not lint-gated by any npm script; closing that needs either permission to edit `scripts/__tests__/serve-web-demo-guard.test.mjs` (one line: use `http.createServer()`) or a second `eslint.config.js` edit, which the author declined to avoid silencing `import/no-duplicates` repo-wide.
- `expo lint` was never run (npm/npx disallowed); the eslint legs were run directly.

### COV-1
**Status:** Not fixed (decision needed)
Coverage is measured for `src/lib/gateway/**` only. Widening `collectCoverageFrom` to the provider/UI or the Gate would drop the measured percentage below the recorded ratchet baseline immediately, so it needs a deliberate baseline reset and a protected-file change. Not done. Note that this work added substantial tests inside the measured area and for the provider and Gate (node:test), but those are not measured.

### CFG-1
**Status:** Not fixed (low value, your call)
`app.json` `extra.gatewayHosts` carries personal tailnet/LAN addresses. It is only a fallback list behind the saved profile and `lastSuccessfulUrl`; moving it to build-time env/EAS would be tidy but changes how builds are configured, so it was left.

### DEAD-1
**Status:** Not fixed (refactor, out of scope)
mDNS discovery is disabled (`isNativeDiscoveryAvailable()` is `false`) but its call sites remain. Deleting them is a refactor with no failure to remove, and `FUTURE-ITEMS`/project rules say refactoring is not a deliverable. Left as is.

