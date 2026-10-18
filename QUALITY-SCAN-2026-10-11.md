# Versutus codebase quality scan - 2026-10-11

Scanned by 33 Claude Haiku 5.5 workers (one per ~4,500-line chunk), read-only, on master @ 51bd074. Covers app source (`src/`), the Gate (`gate/core`, `gate/voice-worker`), native modules, plugins and scripts; test files, docs and generated sweep scripts were excluded.

**432 findings**: 25 HIGH, 190 MED, 217 LOW.

| Category | Count |
|---|---|
| BUG | 172 |
| FAILURE | 73 |
| SECURITY | 29 |
| PERF | 30 |
| QUALITY | 70 |
| FUNC | 58 |

**Trust level:** these are Haiku findings, i.e. drafts. I re-read the code for 8 of the 25 HIGH items (marked below); the other findings have not been independently checked. Expect some false positives, especially in LOW/MED.

## Part 1 - All HIGH findings (25)

### [FUNC] /cron and /artifacts are refused on every connected Gate
- where: src/lib/gateway/dashboard.ts:449-460 (cron), 533-544 (artifacts), 1103-1107 (advertised set), 1147-1150 (methods entry); src/lib/gateway/slash-commands.ts:581-582 (blockUnsupportedCommand), 637-638 (family dispatch)
- what: The commands in group `'System'` (environments, cron, cron-list, env-list, artifacts) are not listed in any `CAPABILITY_GROUP_DEFS[].commandGroups`, so `advertised` never contains `'System'`, and each of their `methods[id]` entries is set to `available: false` ("not offered by this gateway") whenever a capability catalog is present.
- why: On any connected Gate, `/cron ...` and `/artifacts` hit `blockUnsupportedCommand` and return "not available on this gateway" before the family handler at line 638 runs, so the cron slash surface is unreachable.
- fix: Add `'System'` to the `commandGroups` of the cron and artifacts capability defs, or judge each command by its own feature flag instead of by group.
- scan area: src/lib/gateway/council.ts ... src/lib/gateway/groups.ts

### [SECURITY] Re-adding a discovered gateway keeps the trusted TLS flag over a new, untrusted fingerprint
- where: src/lib/gateway/profile-dedupe.ts:153-157 (FILLABLE at :20-31); sources src/hooks/use-gateway-settings-screen.ts:124-129 and src/lib/gateway/storage.ts:164
- what: mergeIntoExistingGateway overwrites a FILLABLE field only when the incoming value is non-empty. A discovery beacon add passes `tlsFingerprint` but no `tlsFingerprintTrusted`, so the saved profile keeps `tlsFingerprintTrusted: true` while its `tlsFingerprint` is replaced by the beacon's never-trusted value.
- why: On the next connect checkTlsFingerprintTofu sees stored === observed and trusted === true and returns 'unchanged', so a new, unverified certificate fingerprint is silently trusted with no prompt for any already-saved gateway.
- fix: When the incoming fingerprint differs from the saved one, take the incoming trust fields (reset trusted and firstSeenAt) instead of inheriting the saved trust.
- scan area: src/lib/gateway/paired-devices.ts ... src/lib/gateway/shortcuts.ts

### [SECURITY] TOFU change detection compares the stored fingerprint with itself, so a changed certificate is never flagged
- verification: CONFIRMED by reading the code
- where: src/context/gateway-provider.tsx:3212 (call `checkTlsFingerprintTofu(gateway, gateway.tlsFingerprint)`); src/lib/gateway/security.ts:62-94
- what: The "observed" argument is the stored fingerprint, not one read from the live connection. No code path obtains a live fingerprint (security.ts:62 says fetch does not expose it), so the 'changed' branch at security.ts:80 can never fire, and an untrusted stored value is marked trusted on first connect (security.ts:90-91).
- why: The "changed fingerprint blocks the connection until approved" guard the comments describe is unreachable; a gateway presenting a different certificate than the one saved or beaconed connects without any prompt.
- fix: Either feed the fingerprint actually presented into the check, or stop claiming TOFU protection at connect time and label the stored value as discovery-only.
- scan area: src/lib/gateway/paired-devices.ts ... src/lib/gateway/shortcuts.ts

### [BUG] A /run stop that the gateway never confirmed is reported as "Run cancelled"
- where: src/lib/gateway/runs.ts:356-370 (requestStop), returns at :414, :431, :486-487; src/lib/gateway/slash-commands.ts:810-812; src/lib/gateway/run-status-verdict.ts:29-34
- what: A failed stop returns `{ status: 'cancelled', cancelled: true, unresolved: true }`. outcomeToActivityStatus (runs.ts:237) makes `unresolved` win and its comment (:231-236) says a plain 'cancelled' is the lie to avoid, but the /run handler checks `outcome.cancelled` first and answers "Run cancelled: Run <id> was cancelled."
- why: The operator is told the run stopped while the gateway may still be running it and spending tokens, and the unresolved state that the reconnect re-poll relies on is hidden from the slash path.
- fix: Check `outcome.unresolved` before `outcome.cancelled` in slash-commands and report that the stop was requested but not confirmed, with the error text.
- scan area: src/lib/gateway/paired-devices.ts ... src/lib/gateway/shortcuts.ts

### [BUG] `/model fallbacks` and `/model set-agent` are swallowed as a model id
- verification: CONFIRMED by reading the code
- where: src/lib/gateway/slash-commands.ts:1055-1067 (bare-model branch), reached from 601-602
- what: The bare `/model <name>` guard excludes only set, auth, routing, policy, agent and agents. It does not exclude `fallbacks` or `set-agent`, so those subcommands fall into the bare branch.
- why: On Hermes and Gate (where `setModelOverride` is wired, see src/context/gateway-provider.tsx:5234), `/model fallbacks a,b --confirm` calls `setModelOverride("fallbacks")` and `/model set-agent main x --confirm` calls `setModelOverride("set-agent")`. The live session is released and the next turn runs on a nonexistent model, while the reply says "Model override set to fallbacks". The real fallbacks and set-agent handlers at 1128 and 1165 are unreachable on these gateways.
- fix: Add `fallbacks` and `set-agent` to the exclusion list, or better, dispatch by an explicit allowlist of subcommands before the bare-model fallthrough.
- scan area: src/lib/gateway/slash-commands.ts

### [BUG] `/approval approve|deny` reports success when the RPC failed
- verification: CONFIRMED by reading the code
- where: src/lib/gateway/slash-commands.ts:1581-1583
- what: The RPC error is caught into `{ error }` and then the reply is built unconditionally as `Approval ${action} for ${id}`, with the error only in `raw`.
- why: A failed approve or deny (unknown id, gateway error) renders as a successful decision. The operator believes a pending agentic run was approved or denied when it was not. The same file's own helpers at 1455-1461 and 1474-1483 say this must not happen.
- fix: Use the `error` check that `directReadResult` / `sessionActionResult` already use, and return a "could not be ..." message when `result.error` is set.
- scan area: src/lib/gateway/slash-commands.ts

### [BUG] Transcript read failure or corrupt blob is overwritten by the next write
- where: src/lib/gateway/transcript.ts:226, 173-179, 186-188, 229-231
- what: `mutateEntries` takes its base list from `readStoredEntries` when the key is not held in memory. That function returns `[]` both when `keyValueStorage.getItem` throws (173-179) and when the stored JSON fails to parse (186-188), and the mutation then writes `[entry]` back over the key (229-231 plus the scheduled flush).
- why: A transient AsyncStorage read refusal, or a truncated/corrupt transcript blob, on the first append/update after a thread switch (or after eviction from the 16-entry ring) erases the whole stored command transcript for that session. The read-error comment ("reads as an empty one and says why") is only safe for display, not for a read-modify-write.
- fix: Have `mutateEntries` treat a failed or unparsable read as a refusal (reject or skip the write) instead of as an empty base, and preserve the raw blob the way `storage.ts` `preserveCorruptGateways` does.
- scan area: src/lib/gateway/slash-palette.ts ... src/lib/gateway/workflows.ts

### [BUG] Attachments silently dropped when a busy send is parked in the outbox
- where: src/context/gateway-provider.tsx:5095-5108 (sendMessage call and busy park), queueOfflineInput at 4024-4061
- what: When `sendMessage` returns 'busy' for a turn that carries photos, `sendChatInput` calls `queueOfflineInput(trimmed, ...)` with text only and returns 'queued'. The attachments are never stored on the outbox row.
- why: The code at 5080-5085 explicitly refuses to park photo turns because "an outbox row carries the words and nothing else" and the images would be lost. The busy branch at 5105-5107 does exactly that, and the composer reads 'queued' so it clears the staged pictures. Images are lost with no message saying so, whenever a photo send lands while another turn is streaming.
- fix: Apply the same `attachments.length > 0` refusal (return 'busy' or 'offline') on the busy branch, or persist attachments on the outbox row.
- scan area: src/context/gateway-provider.tsx

### [BUG] Run-shaped outbox row is re-queued after its run throws, so the run can execute twice
- where: src/context/gateway-provider.tsx:7208-7209 (flush calls sendRunQueued), 7228-7231 (`unsent.delete` skipped on throw), 7234-7236 (catch swallows), 7243-7245 (stranded rows re-queued); sendRunQueued at 7078-7112 rethrows at 7108
- what: `sendRunQueued` rethrows after marking the bubble failed. The throw escapes the `for` loop in the flush, so `unsent.delete(item)` never runs for that row. The `finally` treats it as unsent and puts it back at the head of `offlineQueueRef`, marked `queued: true`.
- why: The docstring at 7073-7076 says the row "has already left the queue, so a lost send is a lost run". The code does the opposite. A run that started on the Gate and then lost its stream (or was refused, e.g. over budget) is re-sent on the next connect, and unlike chat rows the run path has no turn id to dedupe on the Gate.
- fix: Settle the row (unsent.delete and persist) before rethrowing from `sendRunQueued`, or catch inside the flush and treat a thrown run as sent, matching the docstring.
- scan area: src/context/gateway-provider.tsx

### [BUG] Ending a call during Gate start leaves the native session and audio socket running
- where: src/context/handsfree-voice-provider.tsx:657-726 (teardown), 1225-1237 (torn-down-while-starting branch), 1081-1094 (abandonGateStart); src/lib/voice/handsfree-start-attempt.ts:249-294
- what: teardown() during `starting` calls stopGateMedia and stopSession (lines 682, 687) before openGateVoiceSession has run, skips the Gate session stop because gateSessionIdRef is still unset (691), and dispatches `stopped`. openGateVoiceSession then calls startSession and startGateMedia and returns `started`; the branch at 1225 calls refuseGateStart, whose abandonGateStart only clears refs and never stops the media socket or the native session.
- why: When End is tapped (or the notification ends the call) while the call is still Starting, the phone shows idle while the microphone, foreground service and media socket opened after teardown stay live with no owner.
- fix: In the torn-down-while-starting branch, stop the media socket and the native session by their startId as well as the Gate session, or have teardown mark the attempt so the later starts are cancelled.
- scan area: src/context/handsfree-voice-provider.tsx ... src/lib/fleet/constellation-model.ts

### [BUG] Grace-window partials are appended, so resumed speech is sent with repeated words
- where: src/lib/voice/handsfree-session.ts:306-307 (joinSpoken at 202-206); contrast the listening-state partial at 283-285
- what: In `confirming`, every `partial` is folded into `held` with `joinSpoken`. In `listening`, a partial replaces `partial`. Recognizer partials are cumulative hypotheses for the current utterance, so each one re-appends the same words.
- why: When the operator pauses and then keeps talking inside the grace window, the turn sent to the Gate contains duplicates (for example "turn on the light and and the and the fan and the fan"). This is the exact path the grace window exists to serve.
- fix: Keep the in-flight utterance as its own tail that partials replace, and append that tail to `held` only on `final`.
- scan area: src/lib/terminal/ansi.ts ... src/lib/voice/voice-preferences.ts

### [BUG] A transient read failure wipes every Bot voice and speaker toggle on the next write
- where: src/lib/voice/voice-preferences.ts:233-235 (loadVoicePreferences returns `{}` on throw) and 281-283 (updateVoicePreferences writes `fold(await loadVoicePreferences())`)
- what: The read-modify-write path uses the read-tolerant loader. A throw from `keyValueStorage.getItem` becomes "nothing stored", and the fold then writes back a blob containing only the one change being made.
- why: One failed storage read followed by any voice or speaker tap erases all other Bots' voices and every conversation's speaker flag, and the loss persists after relaunch. The "unreadable is nothing stored" rule is right for display but wrong before a write.
- fix: Let the mutation path reject (or skip the write) when the read fails, and only treat a missing key as empty.
- scan area: src/lib/terminal/ansi.ts ... src/lib/voice/voice-preferences.ts

### [SECURITY] App lock fails open when the stored flag cannot be read
- where: src/lib/settings/app-lock.ts:99-107 (catch at 104-105); src/components/app-lock-gate.tsx:102-110, 113-119, 143-146
- what: `loadAppLock()` swallows any storage error and returns `false`, so `readLockable` sets `lockableRef` to false and the cold-start effect sets the phase to `open`. The gate comment at app-lock-gate.tsx:98-101 says an unreadable verdict must never read as "not locked".
- why: A transient AsyncStorage read failure at launch leaves the app unlocked for the session, and the background edge at line 146 only re-locks when `lockableRef` is true, which it is not. The lock is silently not enforced.
- fix: Return a tri-state from the storage read and fail closed (keep the cover up) when the verdict is unknown and the lock was previously enabled, instead of mapping errors to `false`.
- scan area: src/lib/voice/voice-stream-protocol.ts ... src/components/app-lock-gate.tsx

### [BUG] Call link opens the call sheet without the engine read, so the chosen engine and disclosure are skipped
- where: src/components/chat/chat-screen.tsx:1117-1125, 1447-1474 (openCallSheet), 1514, 1524, 3011
- what: The `call=1` effect calls `setCallSheetVisible(true)` directly and never calls `openCallSheet`, so `callCapabilities` stays null and `callPreference` stays `'auto'` instead of the stored `voiceEngine`.
- why: `callEngine` is then null, so `transport` falls to `'phone'` (1514), `voiceEngine` is sent as `'auto'` (1524), `disclosure` is undefined (3011) and `onChangeEngine` is hidden. A call started from the link ignores a stored local/codex engine and shows no statement of where the audio goes. The comment at 1438-1445 records this same failure as already fixed on the button path. The sheet appears only once a thread surface exists, because `composerDraftThread` returns undefined for the roster (src/lib/gateway/composer-draft.ts:35), so it can open later on whichever thread the operator picks.
- fix: Route the link effect through `openCallSheet` (or share its capability read) instead of setting visibility directly.
- scan area: src/components/chat/chat-screen.tsx

### [BUG] Room history load is dropped when the parent re-renders mid-load
- where: src/components/chat/group-room-view.tsx:254-273 (effect, alive guard at 260 and 267-268); src/components/chat/chat-screen.tsx:2788 (`loadHistory={() => botGroups.history(activeGroup.id)}`)
- what: The history effect depends on `loadHistory`, which the parent passes as a new arrow function on every render. The cleanup sets `alive = false` for the first request; the re-run returns early because `historyRequested.current` is already true, so no new request is made and the in-flight result is discarded.
- why: Any parent re-render while the first history read is in flight leaves `historyLoaded` false, so the skeleton stays forever, stored replies are never merged, and the error note is also suppressed (the catch branch checks `alive` too). Opening a room is a common path, so this hits users.
- fix: Memoize `loadHistory` in the parent with useCallback keyed on the group id, or stop tying the `alive` guard to the prop's identity.
- scan area: src/components/chat/command-history-section.tsx ... src/components/chat/skills-pane.tsx

### [BUG] Key-not-ready verdict is erased by the reload that follows it
- where: src/components/gateway/providers-section.tsx:141-146 (also :43-44)
- what: saveKey sets the error to "<label>: not ready" at line 141, then calls `void load()` at line 146. load() runs `setError(null)` at line 44 after its `await client.list()` resolves, so the verdict is cleared moments after it is set.
- why: After a key is saved but the readiness check fails, the sheet closes and no error is shown, so the operator believes the provider is ready. Only the "is ready" notice path survives.
- fix: Do not reload after setting the verdict, or have load() leave the error alone when it is a check result (e.g. set the check verdict after the reload completes).
- scan area: src/components/gateway/environment-registration-form.tsx ... src/components/glass-collapsible.tsx

### [SECURITY] Codex approval requests are answered automatically and the operator reply never lands
- where: gate/core/cli-environments/jsonrpc-stdio.mjs:66-69; gate/core/cli-environments/backend-manager.mjs:182, 236-239; gate/core/cli-environments/backends/codex.mjs:136-138, 313-315; gate/core/server.mjs:3113
- what: With no `onServerRequest`, jsonrpc-stdio answers every server request with `{result: {}}`. backend-manager passes only `onNotification` to the stdio server and no `onApproval` to `createBackend`, so codex `replyApproval` calls an undefined callback. server.mjs:3113 calls `replyApproval(runId, {approved, feedback})`, which does not match codex's `(sessionId, requestId, reply)` signature. `isApprovalRequest` has no production caller.
- why: Every codex approval (execCommandApproval, applyPatchApproval, etc.) is settled by the Gate before the operator sees it, and the empty `{}` reply carries no decision, so the phone's approval card never affects the run.
- fix: Route `onServerRequest` into ApprovalService so the request waits for the operator, pass a real `onApproval` that resolves it, and align the `replyApproval` signature with the server.mjs call site.
- scan area: gate/core/cli-environments/backends/codex.mjs ... gate/core/cli-environments/schema.mjs

### [BUG] Child CLI environments on Windows lose PATH, SystemRoot, WINDIR and ComSpec
- verification: CONFIRMED in code (allow-list is case-sensitive; callers pass process.env)
- where: gate/core/cli-environments/process-environment.mjs:3-18, 31-35; callers gate/core/cli-environments/supervisor.mjs:407 and gate/core/server.mjs:1489
- what: The allow-list is upper-case (`PATH`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`) and is matched with `ALLOWED.has(key)` against the raw keys of `process.env`, which Windows reports in their stored case (`Path`, `SystemRoot`, `windir`, `ComSpec`).
- why: On Windows the child environment silently drops its PATH and system directories, so any tool a CLI shells out to is not found and runs fail. The test at gate/__tests__/process-environment-posix.test.mjs:33 passes upper-case keys, which is why it does not catch this.
- fix: On win32, compare keys case-insensitively (uppercase the key for the lookup while keeping the original name in the child env).
- scan area: gate/core/cli-environments/backends/codex.mjs ... gate/core/cli-environments/schema.mjs

### [SECURITY] Environment id is joined into a file path unvalidated, so RPC callers can read, overwrite or delete arbitrary *.json files
- verification: CONFIRMED (no id validation in schema, rpc or store)
- where: gate/core/cli-environments/store.mjs:80, :96, :106; gate/core/cli-environments/schema.mjs:113; gate/core/cli-environments/rpc.mjs:37-49
- what: `CliEnvironmentStore.get/put/delete` build `join(this.dir, `${id}.json`)` from the raw id, and the schema only checks `requireString(value.id)`. `environments.create`, `environments.update` and `environments.delete` pass the caller's `id` straight through.
- why: An id such as `../../../device-tokens` makes `delete` remove `device-tokens.json` outside `config/environments`, and `create` writes an arbitrary `.json` path with record content. `get` also reads any JSON file. The id is never checked against `validateId`, which exists in cli-helpers.mjs.
- fix: Validate ids at the store boundary (`/^[a-z0-9-]+$/`), and assert that the resolved path stays inside `this.dir`.
- scan area: gate/core/cli-environments/stdio-server.mjs ... gate/core/providers/oauth/attempt-store.mjs

### [BUG] Unreadable push-token file is treated as empty, so the next write erases every device
- where: gate/core/push-tokens.mjs:44-54 (#readAll), 69-93 (upsert, write at 92), 111-120 (remove, write at 117), 122-131 (removeByToken, write at 129)
- what: #readAll returns `{}` when the file is still corrupt after one 25 ms retry, and each mutation then writes that `{}` plus its own row back to disk with #writeAll.
- why: readJsonFile reports every non-ENOENT failure as `corrupt` (gate/core/atomic-file.mjs:86-95), so a Windows sharing violation during a concurrent write makes a single register or preference change overwrite the whole roster, and push silently stops for every other phone. atomic-file.mjs:67-71 says callers must not treat corrupt as empty, and store.mjs:14-16 already has the transient-retry handling this file lacks.
- fix: Reuse the transient-code retry from providers/store.mjs and throw instead of substituting `{}` when the file is still unreadable, so a mutation never writes over an unread roster.
- scan area: gate/core/providers/oauth/device-code.mjs ... gate/core/serial-reload.mjs

### [SECURITY] Provider id is used unvalidated as a file name, allowing path traversal
- verification: CONFIRMED (schema only checks non-empty string)
- where: gate/core/providers/schema.mjs:109; gate/core/providers/store.mjs:105-106, 145-146, 154-157; gate/core/providers/rpc.mjs:66, 68
- what: validateProviderRegistration only requires `id` to be a non-empty string, and ProviderStore builds `join(configDir, \`${id}.json\`)` and `join(stateDir, \`${id}.json\`)` with no character check.
- why: an id such as `..\..\somewhere\name` lets providers.create write a schema-valid registration and state file outside the providers directory, and providers.delete can remove any existing .json file that parses as a provider record. Nothing in the providers tree constrains the id charset.
- fix: Reject ids that do not match a strict pattern such as /^[a-z0-9][a-z0-9-]{0,63}$/ in validateProviderRegistration and again in ProviderStore before any path is joined.
- scan area: gate/core/providers/oauth/device-code.mjs ... gate/core/serial-reload.mjs

### [BUG] Barge-in leaves the abandoned turn running; its reply lands in the next turn
- where: gate/core/voice/voice-session.mjs:188-194 (bargeIn), :277, :314; gate/core/voice/media-socket.mjs:415-435 (turn.run), :570, :578-584 (deliver)
- what: bargeIn() cancels speech and moves to listening but emits no `turn.cancel`, so the backend turn keeps running. turn.run starts a new turn via startTurn() without aborting the still-live `turnAbort`, and deliver() forwards the old turn's events without checking it is still current.
- why: After a barge-in (manual or automatic via userSpeechStart at :277), the old turn's replyDelta/replyDone reach the reducer once the next utterance is in thinking/speaking, so stale text is spoken as the answer to the new question. Its replyDone during a new thinking phase also hits voice-session.mjs:344-351 and speaks "Sorry, that turn could not be completed." over a correct answer.
- fix: Emit `turn.cancel` from bargeIn (or abort the previous turnAbort in the turn.run path) and have deliver() drop events from a controller that is no longer the current turn.
- scan area: gate/core/voice/media-socket.mjs ... gate/core/voice/voice-session.mjs

### [BUG] Audio mode and loudspeaker route left set when audio focus is refused
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:283-286, 298, 309-310, 319-320
- what: `requestAudioFocus()` sets `audioManager.mode = MODE_IN_COMMUNICATION` and calls `routeToLoudspeaker()` before the focus request, and `focused` is only set true if the request is granted. `releaseAudioFocus()` returns early on `if (!focused) return`, so the mode reset and `releaseLoudspeaker()` are skipped when the request was refused.
- why: When focus is refused (e.g. a phone call or another app already holds it) the call still starts with "started", and after teardown the device stays in MODE_IN_COMMUNICATION with the speakerphone or communication device forced on, affecting other apps' audio until something else resets it.
- fix: Only set mode and route after a granted request, or make `releaseAudioFocus` restore mode and loudspeaker unconditionally.
- scan area: gate/voice-worker/run-tests.mjs ... modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/HandsfreeRecognizerErrorsTest.kt

### [FAILURE] HMAC launch key generated without setDigests, so every signed auto-start link is silently rejected
- verification: LIKELY FALSE POSITIVE - Android derives the digest of an HMAC key from the algorithm, so omitting setDigests should not throw; the scanner itself marked it unconfirmed. Test on a device before acting
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeLaunchKey.kt:90-94; modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeVoiceModule.kt:219-227
- what: `KeyGenParameterSpec.Builder(ALIAS, PURPOSE_SIGN).build()` never calls `setDigests(DIGEST_SHA256)`, which the AndroidKeyStore HMAC key generation requires (no `setDigests` anywhere in modules/gate/src). `verifyLaunch` wraps `loadOrCreateKey` in `catch (_: Exception) { return false }`.
- why: On device the key generation is expected to throw, so `verifyLaunch` returns false for every `versutus://call` link and the signed auto-start never opens the call, with no log or error surfaced. Platform behaviour not confirmed on a device; verify on a Keystore-backed device before relying on the finding.
- fix: Add `.setDigests(KeyProperties.DIGEST_SHA256)` to the builder and log the caught exception instead of returning false silently.
- scan area: gate/voice-worker/run-tests.mjs ... modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/HandsfreeRecognizerErrorsTest.kt

### [BUG] Latency harness never records end-of-speech, so reported latency is an epoch timestamp
- verification: CONFIRMED by reading the code
- where: scripts/voice-spikes/latency-harness.mjs:92-93, 119, 126, 44
- what: `endOfSpeechAt` is a local `let` set on the `final` frame (line 126), but the returned `sample` object is `{ endOfSpeechAt: null, firstAudioAt: null }` (line 93) and only `firstAudioAt` is ever written to it (line 119). `summarize()` then computes `sample.firstAudioAt - sample.endOfSpeechAt`.
- why: `firstAudioAt - null` equals the absolute `Date.now()` value (about 1.7e12 ms), so p50/p95, `--save` baselines and the `--check` verdict are all wrong on every run.
- fix: assign `sample.endOfSpeechAt = endOfSpeechAt` (or write it directly to the sample) before resolving.
- scan area: plugins/with-openclaw-discovery.js ... eslint.config.js

## Part 2 - MED and LOW findings by area

### src/lib/gateway/abort.ts ... src/lib/gateway/connection-monitor.ts

#### [MED][BUG] Connection monitor stays suspended after a healthy foreground return
- where: src/lib/gateway/connection-monitor.ts:96-102 (start), :115-122 (suspend/resume), :129-135 (noteConnected); src/lib/gateway/client.ts:282-283 (attemptConnect success path); src/context/gateway-provider.tsx:5915 (suspendReconnect on background), :5931 and :5953 (foreground: resumeReconnect only when not connected, healthy path never resumes)
- what: Background calls `monitor.suspend()`, which sets `suspended = true`. Foreground with a client that still reports 'connected' runs `healthCheck(6000)`; a healthy result does nothing with the monitor. `start()`, `noteConnected()` and the `attemptConnect` success path never clear `suspended`; only `resume()` does, and it is called only from `resumeReconnect()` (status not connected) and `disconnect()`.
- why: While `suspended` is true, `tick()`, `nudge()` and `scheduleReconnect()` all return early, so the interval, the network-trouble nudges and the reconnect ladder are dead. After any background/foreground cycle the client can sit at 'connected' while the gateway is unreachable, with no detection until the app is backgrounded again.
- fix: Call `monitor.resume()` in `attemptConnect`'s success path (or in `noteConnected`/`start`), so a successful connect always re-arms the monitor.

#### [MED][BUG] connect() joins a stale attempt after disconnect and resolves without connecting
- where: src/lib/gateway/client.ts:221-228 (connect joins `connectAttempt`), :245 (epoch check returns silently), :286-297 (disconnect does not clear `connectAttempt`)
- what: `connect()` returns the in-flight `connectAttempt` whenever one exists. `disconnect()` bumps `connectEpoch` but leaves `connectAttempt` set. A connect() made during the old attempt's health probe joins it, and when that attempt resumes it hits the `connectEpoch !== epoch` guard and returns with no status change.
- why: The new caller's promise resolves as if connected, but nothing calls `setStatus` or `monitor.start()`, so the client stays 'disconnected' (set by disconnect) until some other trigger fires. Window is up to the 12s health timeout after a disconnect.
- fix: In `disconnect()` clear `this.connectAttempt = null` (and have `connect()` ignore an attempt whose epoch is stale), so a post-disconnect connect starts a fresh attempt.

#### [MED][FUNC] Bot edit form cannot clear a Bot's description
- where: src/lib/gateway/bots.ts:101-109 (buildBotUpdatePatch); used at src/components/chat/chat-screen.tsx:2411
- what: The loop only copies a string value when `value.trim()` is non-empty; the null branch is reachable only for model fields because `BotEditDraft.description` is typed `string | undefined`. A cleared description therefore is omitted from the patch, and the Gate keeps the old text.
- why: An operator who empties the description field in the edit sheet sees a successful save that changes nothing, and there is no way to express "clear description" through this patch at all.
- fix: Send `description: null` (or `''`) when the trimmed description is empty and the Bot currently has one, matching how `modelId`/`providerId` clear.

#### [MED][FAILURE] Documented run-cancel fallback does not exist; failed server-side stop is swallowed
- where: src/lib/gateway/cancel.ts:21-39 (serverSideCancelForCommand, its `.catch(() => undefined)` and the comment naming a `requestStop` re-ask); src/context/gateway-provider.tsx:4940-4942 and :6021 (sole callers)
- what: The comment says the run's executeRun abort branch re-asks via `requestStop` and surfaces a refusal as an `unresolved` activity row. No `requestStop` or `stopRun` call exists anywhere in src/context/gateway-provider.tsx, and grep finds no `requestStop` in src at all. The only cancel path is the fire-and-forget call, whose error is discarded.
- why: When the Gate refuses or cannot be reached, the run is marked 'cancelled' locally (provider line ~4944) while the server-side run keeps going, and the operator gets no signal. The stated compensation does not exist, so the swallow really hides the failure.
- fix: Either implement the abort-branch re-ask the comment describes, or surface the rejection from `serverSideCancelForCommand` onto the run's activity card instead of discarding it.

#### [MED][BUG] Spend-cap parser strips every comma, so "1,5" becomes 15
- where: src/lib/gateway/budgets.ts:65-68 (parseSpendCapInput; the strip is at :66)
- what: `.replace(/,/g, '')` removes all commas unconditionally. The doc comment (lines 58-64) says a comma that is not a thousands separator must be rejected as undefined.
- why: A cap typed as "2,5" or "1,5" is saved as $25 or $15, and "12,34,56" becomes $123,456, so a Bot's budget can be silently set orders of magnitude off.
- fix: Accept commas only in valid thousands groups (e.g. `/^\d{1,3}(,\d{3})+(\.\d+)?$/` or no commas), and return undefined otherwise.

#### [MED][BUG] Number config field silently saves 0 for empty or non-numeric input
- where: src/lib/gateway/capability-form.ts:45-47 (parseFieldValue, 'number' case)
- what: `Number(trimmed)` returns 0 for an empty string and NaN for junk; the code then returns `Number.isFinite(parsed) ? parsed : 0`.
- why: A user who clears a numeric capability field or types "12a" has 0 written as the value with no error, which can silently disable or change the setting the Gate applies.
- fix: Return a validation failure (or the previous value) for empty or non-finite input rather than coercing it to 0.

#### [LOW][FAILURE] Approval audit silently discards valid-JSON rows that fail validation on the next write
- where: src/lib/gateway/approval-policy.ts:303-318 (recordApprovalDecision; filtering at :306 via approvalAuditFromUnknown, overwrite at :315-318)
- what: Unparsable blobs are parked under `APPROVAL_AUDIT_CORRUPT_STORAGE_KEY` before the log restarts, but a blob that parses and then loses entries to `isAuditEntry` (or is a non-array JSON value) is overwritten with no preservation.
- why: The audit is described as "the only durable record of what the operator answered"; rows that fail the shape check are dropped the next time any decision is recorded, with no copy kept.
- fix: Park the raw blob whenever the parsed log has fewer entries than the stored array, the same way unparsable bytes are parked.

#### [LOW][QUALITY] Stale ordering comment on the audit view contradicts the writer
- where: src/lib/gateway/approval-audit-view.ts:16-18; contradicted by src/lib/gateway/approval-policy.ts:192-197 (appendApprovalAudit prepends)
- what: The comment says the persisted log is "oldest first (entries are appended)", but the writer prepends new entries so the log is newest first.
- why: The sort in `approvalAuditRecent` still gives correct output, but a future change relying on the comment (for example, slicing the persisted log instead of sorting) would show the oldest decisions.
- fix: Correct the comment to say the persisted log is newest first.

#### [LOW][FUNC] Auth-rejection message names a Windows path on every platform
- where: src/lib/gateway/client.ts:264-266
- what: The thrown message says "Enter API_SERVER_KEY from %LOCALAPPDATA%\hermes\.env" regardless of platform.
- why: Phone users (Android/iOS, the app's main targets) are sent to a Windows environment variable path that does not exist on their device, so the instruction is unactionable.
- fix: Vary the hint by platform or drop the path and point to the Gate's key setting.

#### [LOW][FAILURE] getSkills and getToolsets turn every error into an empty list
- where: src/lib/gateway/client.ts:824-831 (getSkills), :836-844 (getToolsets)
- what: Both wrap the request in a bare `catch` and return `[]`, including on 401 auth refusal and unreachable hosts.
- why: The caller cannot distinguish "no skills" from "could not read", which is the empty-versus-failed conflation this module set (see bots.ts rosterEmptyView and botSoulRead) elsewhere refuses to make.
- fix: Return the error (or a failed-read marker) so the surface can say the read failed.

#### [LOW][PERF] Session and message reads re-probe the Gate dialect on every call
- where: src/lib/gateway/client.ts:448-466 (getSessions), :489-523 (createSession), :530-547 (deleteSession), :564-592 (getSessionMessagePage)
- what: Each of these tries `/v1/*` first and falls back to `/api/*` on 404 without remembering which dialect answered. getModels (:371-390) does remember it, and its comment says an unremembered client "pays two requests for every cold model read".
- why: Against a direct Hermes host every session list, message page, create and delete costs an extra round trip that always 404s, and the sessions sheet is delayed by it.
- fix: Store the answering dialect in `modelDialect`-style state and lead with it for all session routes.

#### [LOW][QUALITY] Hermes model mapping duplicated inside one class
- where: src/lib/gateway/client.ts:398-410 (getModels) and :424-436 (readHermesModelOptions)
- what: The same `flattened.map(...)` into `ModelInfo` is written out twice.
- why: The two copies can drift (the fallback already differs in its `if`/`return null` handling), so a field added to one path is missed on the other.
- fix: Extract a single `modelsFromHermesOptions` helper and call it from both sites.

#### [LOW][QUALITY] Routing-verdict precedence repeated in three places
- where: src/lib/gateway/bots.ts:37-43 (botRowSubtitle), :62-67 (botChipRoutingTag); src/lib/gateway/bot-detail.ts:61-73 (botRoutingView)
- what: The same multiplex / default-key / listen-key precedence is hand-written in each, with the same copy strings in two of them.
- why: The comments say the three must agree ("same precedence the roster row uses"); a change to one (new routing issue) will silently leave the others showing a different verdict.
- fix: Route botRowSubtitle and botChipRoutingTag through botRoutingView so the precedence lives in one function.

#### [LOW][QUALITY] child-sync reconciler carries an unused parameter and a field that is always empty
- where: src/lib/gateway/child-sync.ts:22-31 (reconcileChildProfiles: `_providers` at :24, `toUpsert: []` at :30)
- what: The `providers` argument is ignored, and `toUpsert` is hard-coded to an empty array, while the caller only reads `toRemove`.
- why: Dead API surface suggests upserts happen when they never do, and misleads anyone changing the sync behaviour.
- fix: Drop `toUpsert` and the unused parameter, or document why they exist.

### src/lib/gateway/council.ts ... src/lib/gateway/groups.ts

#### [MED][FUNC] Editing an environment silently collapses its additional workspace roots
- where: src/lib/gateway/environment-client.ts:218-222 (patch `workspacePolicy`), contrasted with the intent comment at 188-191
- what: `buildEnvironmentUpdatePatch` spreads `existing.workspacePolicy` but then overwrites `roots` with `[defaultRoot]` from the form.
- why: An environment whose Gate record lists several roots (with `allowAdditionalRoots` still true) loses every root except the default on any edit, such as fixing the executable path. The comment at 188-191 says exactly this must not happen. The form never shows `roots`, so the operator cannot see the loss.
- fix: Preserve `existing.workspacePolicy.roots` (keeping `defaultRoot` included) rather than replacing the list with the single form root.

#### [MED][BUG] Auth heuristic runs before run-failure classification, so a provider 401/403 is blamed on the gateway token
- where: src/lib/gateway/error-humanizer.ts:145-153 (isAuthRejection), versus 176-193 (describeRunFailure, which the comment at 176-179 says must run first)
- what: `isAuthRejection` matches any message containing `401`, `403`, `unauthorized` or `invalid api key`, and returns "Gateway rejected the key / update the token" before `describeRunFailure` is consulted.
- why: A run or Bot-send failure whose forwarded text carries an upstream provider 401 (the unsupported-model 401 case described in run-failures.ts) is sent to replace the working gateway token. This is the same misdiagnosis the comment at 106-112 was added to stop.
- fix: Classify with `describeRunFailure` before `isAuthRejection`, or exclude messages that `describeRunFailure` recognises from the auth branch.

#### [LOW][BUG] Completed run with no finish time displays an ever-growing duration
- where: src/lib/gateway/cron.ts:147-157 (line 150 `run.finishedAt ?? now`); rendered at src/components/activity/cron-job-sheet.tsx:313
- what: For `status === 'completed'` with `finishedAt` null, the end time falls back to `now`, so the elapsed label is "time since start".
- why: A finished run whose host omitted `finishedAt` shows a duration that keeps increasing on each re-render. The file's own rule (lines 7-8) is that absent data must read as unknown, not as a fact.
- fix: Return null when a completed run has no `finishedAt`.

#### [LOW][BUG] Pending-room ledger cap evicts the oldest owed deletes, which are the ones the sweep needs
- where: src/lib/gateway/council.ts:258-265 (`rememberPendingRoom`, slice at line 264)
- what: Once more than `COUNCIL_PENDING_ROOM_CAP` (8) rooms are owed, `slice(-8)` keeps the newest and silently drops the oldest.
- why: The oldest records are the stale leftovers that `sweepPendingRooms` exists to delete, so after nine unswept kills the earliest orphan rooms on the Gate are never deleted and never retried.
- fix: Evict the newest or sweep stale records before adding, so a stale room is never dropped unsettled.

#### [LOW][QUALITY] `councilNoAnswerColumns` `arrived` branch is unreachable, and its failed-column overwrite contradicts its doc
- where: src/lib/gateway/council.ts:148-162; callers src/app/council.tsx:216 (`setColumns([])`), 259 (`setColumns(result)` only on success), 267 (`setColumns((arrived) => councilNoAnswerColumns(targets, arrived))`)
- what: On timeout the caller always receives `arrived === []`, because the screen was reset at line 216 and the round result is never stored on timeout. Any arrived column that is not `answered`, including a `failed` one with a real error, is replaced with "No answer".
- why: The doc comment says arrivals keep their columns and nothing is rewritten, which cannot happen on this path. A real per-Bot error inside an arrived column would be hidden behind "No answer" if the path ever became live.
- fix: Drop the `arrived` parameter and its comment, or keep `answered` and `failed` columns as they are and only fill the missing targets.

#### [LOW][PERF] Run-view fold cache is defeated once the launcher caps the event list
- where: src/lib/gateway/environment-run-view.ts:107-129 (`extendsCache` prefix check); src/components/gateway/environment-run-launcher.tsx:29-36 (`capRunEvents`), 228
- what: The cache relies on the new list starting with the cached events by reference. After 2000 events, `capRunEvents` slices the head off each frame, so the prefix check fails and every frame refolds the full 2000 events.
- why: The cache's stated purpose is to avoid per-frame work on a chatty run. Past the cap it does a full refold per streamed frame, and the per-frame cost stays at the cap size.
- fix: Track the number of folded events by sequence number instead of by array prefix, or fold incrementally on the capped list.

#### [LOW][BUG] Empty `ts` parameter on a call link counts as a valid timestamp
- where: src/lib/gateway/deep-link.ts:125-131
- what: `Number('')` and `Number('  ')` are `0`, which is finite, so a `ts=` with an empty value passes the `Number.isFinite(ts)` check together with `autoStart=1` and any non-empty `sig`, and the link is marked `autoStart: true` with `signature: { ts: 0, sig }`.
- why: The module comment says only a link with a real timestamp and signature may auto-start. The check here is looser than that, and the trust decision then depends on the native side rejecting a `ts` of 0.
- fix: Require `tsRaw` to be a non-empty string matching a digits-only pattern before converting it.

#### [LOW][QUALITY] Group validation messages hardcode the member limits they describe
- where: src/lib/gateway/groups.ts:252-258 (`validateGroup`), against constants at lines 3-4
- what: The error strings "need at least 2 bots" and "at most 6 bots" are literals, while the checks use `MIN_GROUP_MEMBERS` and `MAX_GROUP_MEMBERS`.
- why: If a limit constant changes, the check and its message diverge, and the user is told the wrong limit.
- fix: Build the message strings from the constants.

#### [LOW][FUNC] Command availability ignores the selected backend that the group tiles respect
- where: src/lib/gateway/dashboard.ts:950-956 and 995-1011 (backend-scoped group status), versus 1103-1107 (`advertised` built from Gate-wide readiness) and 1147-1150 (`methods` entries)
- what: Group tiles mark sessions and tools unsupported when the selected backend lacks them, but the per-command `methods` map still uses the Gate-wide `advertised` set, so `/session ...` and `/tools` commands are still offered as available.
- why: The comment at 943-944 says a selected backend must not be offered surfaces it cannot serve. The command palette and the slash block still offer them, so the operator reaches a backend-level failure instead of the honest "not available" line.
- fix: Derive `advertised` from the same `backendOverride` result that the group tiles use.

### src/lib/gateway/handoff-import.ts ... src/lib/gateway/openclaw-types.ts

#### [MED][FAILURE] Imported packet without `excluded` throws during render and breaks the import screen
- where: src/lib/gateway/handoff-import.ts:112, src/lib/gateway/handoff.ts:98-106, src/app/gateway/import.tsx:66-69
- what: `botHandoffFromUnknown` only checks `format`, `version` and `bot.id` and returns the raw object, so `excluded`, `routines`, `skills` and `chrome` are never validated. `botHandoffImportPlan` then runs `[...outcome.packet.excluded]`, and import.tsx calls that plan inside a `useMemo` at render time.
- why: A hand-edited or foreign file with a valid header but no `excluded` array makes `[...undefined]` throw a TypeError during render, so the import screen crashes on user-picked input instead of showing a refusal.
- fix: Validate `excluded` (and the other packet arrays/objects) in `botHandoffFromUnknown`, or default them to `[]`/`{}` before the plan reads them.

#### [MED][BUG] @mentions match email addresses, so an email sends a handoff to a Bot
- where: src/lib/gateway/mentions.ts:7-18 (extractMentions), src/lib/gateway/mentions.ts:35-51 (mentionTokenAtCaret), src/context/gateway-provider.tsx:4448-4453
- what: The regex `/@([a-z0-9][a-z0-9_-]{0,62})/gi` does not check the character before the `@`. Only a second `@` directly after the token is skipped (line 12). The sender loop at gateway-provider.tsx:4448 forwards every match to `handoffMention`.
- why: A message such as "reply to ethan@ledger.com" matches `@ledger`. If a Bot id is `ledger`, the message is handed to that Bot without the user asking for it. The caret picker (line 47-50) also opens for the same email shape.
- fix: Require the `@` to be at the start of the text or preceded by whitespace or punctuation other than a word character, in both extractMentions and mentionTokenAtCaret.

#### [MED][BUG] Reconciling interrupted bubbles can put the same history turn in the list twice
- where: src/lib/gateway/message-reducer.ts:366-386 (match at 369-375, check at 373)
- what: For each interrupted bubble, `history.find` picks the first history assistant turn whose text starts with the bubble text. The "not already shown" check uses `current`, not the `next` array being built, and a matched history turn is never removed from the candidates.
- why: Two interrupted bubbles whose text is a prefix of the same history turn (for example "Sure" and "Sure, here") both get the same history object, so `next` holds two entries with one id. That gives duplicate React keys and a duplicated answer in the transcript.
- fix: Track the ids already placed in `next` (or remove a matched history entry from the candidate pool) and exclude them from later matches.

#### [MED][FAILURE] A request sent while the socket is null is silently dropped and hangs for its full timeout
- where: src/lib/gateway/openclaw-client.ts:283-290 (send on line 284), src/lib/gateway/openclaw-client.ts:330-347 (onclose), src/lib/gateway/connection-monitor.ts:236-238, src/lib/gateway/openclaw-client.ts:192-197 (resumeReconnect)
- what: `request()` calls `this.socket?.send(...)`, and when `socket` is null that is a silent no-op. The pending entry is registered but nothing rejects it until the timer fires. onclose nulls `this.socket` and calls `scheduleReconnect`, but the monitor returns early while suspended (connection-monitor.ts:237) without calling `onStatus`, so status stays 'connected'. `resumeReconnect` then does nothing because it only connects when status is not 'connected'.
- why: With the app backgrounded, a socket drop leaves status 'connected' with no socket. Requests then wait out their full budget (30 s, or 120 s for chat.send) instead of failing, and recovery waits for a later monitor probe to declare the path down.
- fix: Reject immediately when `this.socket` is null (and treat a dropped socket as not connected, so resume reconnects), instead of a silent optional-chained send.

#### [MED][BUG] A connect() issued after disconnect() joins a stale attempt and resolves without connecting
- where: src/lib/gateway/manifest-client.ts:238-245 (connect joins connectAttempt), src/lib/gateway/manifest-client.ts:302-313 (disconnect does not clear it), src/lib/gateway/manifest-client.ts:256, 262, 274, 281, 291 (epoch early returns)
- what: `connect()` returns the in-flight `connectAttempt` when one exists. `disconnect()` bumps `connectEpoch` but does not clear `connectAttempt`. The old attempt then returns early at each epoch check without throwing, status change, or monitor start.
- why: Disconnect during an in-flight connect, followed by connect() on the same client, makes the second call resolve successfully while status stays 'disconnected' and no connection is made. Callers that trust the resolved promise think the gate is connected.
- fix: Clear `connectAttempt` in disconnect(), or have a joined attempt compare its epoch with the caller's epoch and start a fresh attempt when they differ.

#### [MED][BUG] streamChat HTTP refusals lose their status and code, so auth rejections are misclassified
- where: src/lib/gateway/manifest-client.ts:549-557 (streamChat non-ok branch), src/lib/gateway/errors.ts:34-40 (isAuthRejection), compare src/lib/gateway/http-transport.ts:167-173
- what: The non-ok branch throws `new Error(messageFromHttpErrorBody(...))`. `HttpTransport.request` throws `GatewayHttpError` with `status` and `code`, but this path drops both. `isAuthRejection` then falls back to matching "401", "403" or "unauthorized" in the message text.
- why: A chat POST answered 401 or 403 whose body text lacks those words is not recognised as an auth rejection, so the reconnect logic retries a refused token. The Gate's error code is also lost for chat turns.
- fix: Throw `new GatewayHttpError(message, response.status, errorCodeFromHttpBody(errorText))` here, as HttpTransport does.

#### [LOW][BUG] A packet with a bot record but no `format` is reported as having no Bot record
- where: src/lib/gateway/handoff-import.ts:85-91
- what: `classifyHandoff` accepts `raw.format === undefined` (line 85), so the fall-through on line 91 returns NO_BOT_REASON even when `raw.bot.id` is present.
- why: A file that has a bot but no format string gets the message "This packet carries no Bot record to import." That is the wrong reason shown to the operator; the real problem is the missing format.
- fix: Reject a missing format as WRONG_KIND_REASON, or check the bot record before returning NO_BOT_REASON.

#### [LOW][SECURITY] Path template values are not URL-encoded, and unknown placeholders become empty strings
- where: src/lib/gateway/manifest-client.ts:43-48 (interpolatePath), 1059-1060, 1189-1190, 1201-1202, 1262
- what: `interpolatePath` inserts `vars[key]` raw and replaces an unknown placeholder with `''`. The template branches pass ids unencoded, while the fallback branch of getSessionMessagePage (line 1060) uses `encodeURIComponent(sessionId)`.
- why: A session or run id containing `/`, `?` or `#` changes the route, and a template that names a placeholder the caller did not supply silently becomes `//` instead of failing. Ids come from the Gate, so exploitation needs a hostile or buggy gate, but the two branches disagree.
- fix: Encode each substituted value with `encodeURIComponent`, and throw when a template placeholder has no value.

#### [LOW][QUALITY] Empty if-block in getCapabilities
- where: src/lib/gateway/manifest-client.ts:407-409
- what: `if (endpointsRecord.health && !endpointsRecord.health_detailed) { /* comment only */ }` does nothing.
- why: Dead branch that reads as if it sets a capability, which is misleading for anyone checking diagnostics support.
- fix: Delete the block.

#### [LOW][QUALITY] rewriteHttpBaseHost has no production caller and drops the base path
- where: src/lib/gateway/host-lookup.ts:67-71
- what: The function returns `new URL(rewritten).origin`, which discards any path prefix on the base URL. Its only callers are in `__tests__/host-lookup-test.ts`.
- why: Dead exported code that would silently strip a `/gate` style prefix if someone wired it in.
- fix: Remove it, or return the rewritten href with its path kept.

#### [LOW][BUG] providerDisplayName reads inherited Object properties from a plain object
- where: src/lib/gateway/model-selection.ts:371-395 (PROVIDER_NAMES, lookup at line 394)
- what: `PROVIDER_NAMES[trimmed.toLowerCase()]` is a plain object lookup, so a provider id of `constructor`, `toString` or `__proto__` returns an inherited function or object instead of undefined.
- why: The picker section title becomes a non-string value for such an id, which can render wrongly or throw as a React child.
- fix: Use a `Map`, or check `Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, key)`.

#### [LOW][FUNC] Non-JSON error bodies are shown to the user in full
- where: src/lib/gateway/http-error-body.ts:2 and 18; used by src/lib/gateway/manifest-client.ts:556
- what: When the body is not a JSON error envelope, `messageFromHttpErrorBody` returns the whole `errorText` (line 2 and 18) with no length limit or HTML check.
- why: A proxy 502 HTML page becomes the thrown message, which convertStreamError then renders as "Error: <html>..." in the assistant bubble. The manifest-client comment at line 550 says raw wire text must not reach a bubble.
- fix: Return `HTTP <status>` when the body is not JSON, or truncate and strip markup before using it as the message.

#### [LOW][QUALITY] Redundant expression in historyToChatMessages
- where: src/lib/gateway/messages.ts:156
- what: `text: text || (toolCalls.length > 0 ? '' : text)` always equals `text`, since the false branch is `text` itself.
- why: The conditional suggests the author meant something different for tool-only turns, so a reader cannot tell the intended behaviour.
- fix: Write `text` and state the tool-only case in a comment, or fix the intended logic.

#### [LOW][BUG] Concurrent turns that share a turn id remove each other's abort registration
- where: src/lib/gateway/manifest-client.ts:539 (pendingRuns.set), src/lib/gateway/manifest-client.ts:593 (finally delete)
- what: `pendingRuns` is keyed by turnId, and the finally block deletes that key unconditionally. A queued line resent under the same turn id (as the comment at line 519-521 describes) can overwrite the first entry, and the first request's finally then deletes the second's entry.
- why: While the second stream is still running, disconnect() no longer finds its controller and does not abort it, so the stream keeps reading for a discarded thread.
- fix: In finally, delete only when `this.pendingRuns.get(turnId)` is still the controller this call registered.

#### [LOW][PERF] Caller abort listeners accumulate on a long-lived signal
- where: src/lib/gateway/manifest-client.ts:530-534 (streamChat), src/lib/gateway/manifest-client.ts:1151-1154 (authorizedFetch)
- what: Each call adds an abort listener to the caller's signal and never removes it when the turn or fetch finishes. The code comment at line 526-529 says the provider owns that signal and it is reused.
- why: A session-long signal holds one closure and one controller per completed turn, which grows for the life of the session.
- fix: Remove the listener in the finally block, or use `{ once: true }` together with an explicit removeEventListener on completion.

### src/lib/gateway/paired-devices.ts ... src/lib/gateway/shortcuts.ts

#### [MED][FAILURE] The run driver abandons its event stream at the wall-clock deadline and never aborts it
- where: src/lib/gateway/runs.ts:455-483 (stream started at :458-474, deadline break at :483); raceDeadline at :265-279
- what: raceDeadline only stops waiting. The stream is started with the caller's signal only and no driver-owned AbortController, so when the 30-minute bound wins, executeRun returns `unresolved` while the stream request stays open and `onEvent` keeps firing. If the deadline is already spent, the stream is still started before the race.
- why: The comment at :248-250 says a wedged environment keeps the socket alive via keepalives, so each stuck run leaks a connection and keeps writing into the activity transcript after it was reported unresolved.
- fix: Create a per-stream AbortController, abort it when the deadline wins (and on the streamFailed path), and skip starting the stream when no time remains.

#### [MED][BUG] Any failure text containing "expired" is classified as a task-expiry verdict
- where: src/lib/gateway/run-failures.ts:254-255
- what: `/\bexpired\b/i` runs after the environment checks and before `empty_turn`, so an upstream "token expired" or a provider sign-in lapse becomes kind 'expired' with title "Task expired" and the fix "Resubmit it — the host considers this job past its valid window."
- why: A credential problem is shown with the wrong verdict and the wrong fix (it should read as needs sign-in); the raw cause is kept but the headline and next step mislead the operator.
- fix: Anchor the match to the Gate's own job-expiry wording rather than the bare word.

#### [MED][BUG] Provider status falls through to raw readiness strings for disconnected and refreshing auth
- where: src/lib/gateway/provider-state.ts:17-26
- what: The function handles auth missing, authorizing, denied and needs_reauth but not `disconnected` or `refreshing`. With readiness `ready` and auth not `ready`, it returns `snapshot.readiness.state` (lowercase "ready"); with readiness `unavailable` in api_key mode it returns the raw "unavailable".
- why: A disconnected OAuth provider whose readiness still reads ready can show a healthy-looking lowercase "ready" for a provider that cannot authenticate, and other states leak raw enum values into the UI.
- fix: Map `disconnected` to 'Not configured' or 'Needs sign-in', map `refreshing` to a transitional label, and give every readiness state a user-facing label.

#### [MED][PERF] The plain candidate probe waits for every candidate before answering
- where: src/lib/gateway/probe.ts:102-121 (runCapped over all URLs at :114-116); callers src/context/gateway-provider.tsx:3588 and :5726
- what: probeGatewayCandidates awaits runCapped over the whole list and only then returns the first success in input order. Unlike probeHighPriorityCandidates (:131-202), it has no early-win or grace logic.
- why: A healthy first candidate answers in about 100 ms, but reconnect still waits for each black-holed candidate to time out (up to 12 s each, three at a time), so the connect path can stall 12 s or more behind a dead entry.
- fix: Resolve as soon as the highest-priority success is known, using the grace logic from probeHighPriorityCandidates, or abort the remaining probes once a higher-priority candidate wins.

#### [MED][FUNC] A turn that finishes within 10 s of the last spend read never triggers a re-read
- where: src/lib/gateway/session-analytics.ts:296-313 (threadSpendFinishedRead); used in src/components/chat/chat-screen.tsx:1801-1810
- what: When the turn ends within THREAD_SPEND_MIN_READ_MS of the last read, the function returns false, and nothing schedules a later read. The doc comment (:297-300) calls the second edge "dropped, not queued behind a timer".
- why: The glance keeps the pre-turn total until some other trigger (surface or session change), so the newest turn's tokens and cost are missing from the thread's spend line.
- fix: Record a pending flag and schedule one trailing read at lastReadAt + THREAD_SPEND_MIN_READ_MS.

#### [MED][BUG] An HTTP error answer from the gateway is labelled as a connection failure
- where: src/lib/gateway/probe.ts:70-78 (code 'connect-failed' for any non-OK status); categorizeProbeError at :291-303
- what: probeGatewayUrl returns code 'connect-failed' for every non-OK HTTP response, and categorizeProbeError maps that code to "Could not reach the gateway host. Check network/Tailscale."
- why: A gateway that answers HTTP 401, 403, 500 or 503 (for example while still starting, or behind a failing proxy) is reported as unreachable, sending the operator to check Tailscale instead of the gateway's own status.
- fix: Return a distinct code (for example 'http-error') that carries the status, and have categorizeProbeError say the gateway answered with that status.

#### [LOW][QUALITY] Reachability wave comment cites a stale 1.8 s probe timeout
- where: src/lib/gateway/reachability-wave.ts:8-10
- what: The PROBE_WAVE_CONCURRENCY comment says probes have a 1.8 s timeout, but probe.ts sets 10 s and 12 s (probe.ts:12-13).
- why: Anyone tuning the wave cap from this comment underestimates worst-case wave time by roughly 6x.
- fix: Update the comment to point at GATEWAY_PROBE_TIMEOUT_MS and GATEWAY_PROBE_PARALLEL_TIMEOUT_MS.

#### [LOW][BUG] Plain-object method lookups answer Object.prototype members
- where: src/lib/gateway/rpc-routes.ts:132 (METHOD_TO_ROUTE[method]); src/lib/gateway/rpc-methods.ts:67 and :79 (slash map); used at src/lib/gateway/client.ts:860
- what: The route table, guidance table and slash map are plain objects. A method name such as "constructor" or "toString" returns a built-in function instead of undefined, so resolveRoute returns a bogus route with no path, and the slash map skips or returns a function for those names.
- why: Only method names that match Object.prototype members are affected, so the impact is small, but the lookup is wrong for them and the failure is not reported as "unsupported".
- fix: Use Object.hasOwn or a Map for these lookups.

#### [LOW][FAILURE] Unfilled route placeholders are sent to the host as literal text
- where: src/lib/gateway/rpc-routes.ts:139-149
- what: When a required {param} (for example jobId for jobs.run and jobs.remove, or sessionId for session.get) is missing from params, resolveRoute leaves "{jobId}" in the path and returns it as a valid route, which client.ts:860-876 then sends.
- why: A caller that forgets the id sends, for example, DELETE /api/jobs/{jobId} to the host instead of failing locally with a clear error.
- fix: Return null or throw when a route placeholder has no value.

#### [LOW][QUALITY] liveSessionId accepts a `stored` argument it never reads
- where: src/lib/gateway/session-resume.ts:30-37
- what: The input type accepts `stored`, but the body reads only `live`. The comment at :20-29 says stored must not be used as a fallback.
- why: The unused field in the signature invites callers to pass a value that has no effect, and a later edit that adds a fallback would reintroduce the CLI-environment bug the comment describes.
- fix: Drop `stored` from the input type so the signature matches the behavior.

#### [LOW][BUG] Concurrent recent-command writes can lose a usage count
- where: src/lib/gateway/recents.ts:39-48; caller src/context/gateway-provider.tsx:5162
- what: pushRecentCommand reads the stored usage, computes the next value and writes it back with no serialization. The caller fires each push with `void`, so two commands sent back to back both read the same stored list.
- why: The second write overwrites the first, so one command's frequency count is lost.
- fix: Serialize writes per gateway through a promise chain, like the activity-run saves in src/lib/gateway/session-persistence.ts:315-336.

#### [LOW][BUG] recentBotShortcuts returns one shortcut when limit is 0
- where: src/lib/gateway/shortcuts.ts:26-37
- what: The limit check runs after the push, so a limit of 0 still returns the first Bot.
- why: A caller asking for no shortcuts gets one.
- fix: Return [] when limit is zero or less, before the loop.

#### [LOW][QUALITY] executeRun's doc comment sits on requestStop
- where: src/lib/gateway/runs.ts:340-355
- what: The "Start a run and drive it to a terminal state" JSDoc is placed above requestStop's own JSDoc, so executeRun (line 372) has no doc and requestStop's doc is doubled.
- why: Misleading documentation for the two functions that matter most to the run lifecycle.
- fix: Move the executeRun block onto executeRun.

### src/lib/gateway/slash-commands.ts

#### [MED][FUNC] `/device revoke <id>` never forwards the device id
- where: src/lib/gateway/slash-commands.ts:1607-1612; src/lib/gateway/dashboard.ts:389-399 (`device-revoke` has `params: {}`); gate/core/capabilities/gateway-methods.mjs:316-320
- what: The `revoke` branch calls `runRegistryCommand('device-revoke', context)` with no params, so the typed id in `args[1]` is dropped and `device.revoke` is sent with `{}`.
- why: The Gate rejects that call with `deviceId is required`, so `/device revoke <id>` can never revoke anything. The paired-devices pane sends `{ deviceId }` (src/components/gateway/paired-devices-pane.tsx:70), so the chat path is the only broken one.
- fix: Pass `{ deviceId: args[1] }` as `paramsOverride` (and reject a missing id with usage text before the call).

#### [MED][BUG] `/device revoke` is judged by the `/device` info entry's availability
- where: src/lib/gateway/slash-commands.ts:696-710 (`commandIdForInput`), used at 746 (`blockUnsupportedCommand`) and 582-583; compare the doc comment at 691-695
- what: `commandIdForInput` tries the bare command token first and returns the first registry entry in array order. For `/device revoke`, the bare `/device` matches `device-info` (dashboard.ts:385, defined before `device-revoke` at 389) and returns before `/device revoke` is considered. The doc comment claims "the longest slash that is a prefix of the input", which the code does not do.
- why: On Gate, `device.info` is judged undispatched, so `/device revoke` is blocked with "/device is not available on this gateway" even though `device.revoke` is served. The composer's `findConfirmableSlash` (src/lib/gateway/command-match.ts:33-63) does use longest-prefix, so the confirmation sheet and the block disagree.
- fix: Make `commandIdForInput` pick the longest matching slash across the full input (or pass the full `commandName + args` to the longest-match lookup), and fix the doc comment to match.

#### [MED][BUG] Workflows whose names contain spaces cannot be run
- where: src/lib/gateway/slash-commands.ts:864-865 (`trimmed.split(/\s+/)`, then `findWorkflow(workflows, name)`), 447 (suggestion row `/workflow ${workflow.name} `); src/lib/gateway/workflow-model.ts:77 (name is only trimmed), 102-106 (`findWorkflow` compares the whole name)
- what: The run path takes only the first whitespace-delimited token as the workflow name. Names are stored with spaces (only trimmed on create and rename), and the palette offers `/workflow <full name>`.
- why: For a workflow saved as "Morning Brief", selecting the palette row or typing `/workflow Morning Brief` yields "Unknown workflow: Morning", and the workflow can never run. The palette row is advertised as runnable.
- fix: Match the longest stored workflow name that prefixes the argument text (case-insensitive, word-boundary aware), then pass the remainder as input.

#### [MED][BUG] A workflow step that never resolved is counted as a success
- where: src/lib/gateway/slash-commands.ts:879-904, specifically the failure test at 885-889; src/lib/gateway/runs.ts:26-31 (`RunOutcome.unresolved`)
- what: The failure check looks at `cancelled`, `error`, and `/fail/i` on `status`. It ignores `outcome.unresolved`, which the type documents as "callers must not present this as a finished run".
- why: When the client stopped polling before a terminal status, the step is treated as passed, the next steps run anyway, and `recordWorkflowRun` at 903-904 counts the workflow as completed. The user is told the workflow ran through when its fate is unknown.
- fix: Treat `outcome.unresolved === true` as a stop (like a failure) and do not record the run.

#### [MED][BUG] Failed cron runs render as "completed"
- where: src/lib/gateway/slash-commands.ts:2305-2307 (`describeCronRun`); gate/core/cron-view.mjs:48-50
- what: The status is `running` or `completed`, and the Gate's `error` field (set when `end_reason === 'error'`) is never read. The Gate itself emits `status: 'completed'` for errored runs, and the client never looks at `error`.
- why: `/cron history <job>` lists a failed run as "completed" with no error marker, so the operator cannot see that a scheduled job failed.
- fix: Render `error` (or a failed state) when the field is present, instead of defaulting every non-running row to "completed".

#### [MED][SECURITY] Write actions reachable through `/cron` and `/env` and `/config rollback` are classified "safe" and skip confirmation
- where: src/lib/gateway/slash-commands.ts:1253-1258 (`config.rollback`), 1675-1682 (`/cron run|pause|resume|create`, `/env start|stop`); src/lib/gateway/command-match.ts:51-63 (fallthrough to the `/cron` or `/env` safe registry row)
- what: The write handlers call `jobs.run`, `jobs.pause`, `jobs.resume`, `jobs.create`, `environments.lifecycle.start|stop` and `config.rollback` directly. None of these has a registry entry with a write or destructive danger (confirmed: no `jobs.*`, `environments.lifecycle`, or `config.rollback` entries in dashboard.ts). `findConfirmableSlash` then falls back to the `/cron` or `/config` or `/env` prefix, which is `danger: 'safe'`.
- why: Stopping an environment, pausing a job, creating a scheduled job, or rolling back gateway config runs on Enter with no confirmation, while `/config patch` and `/channel stop` do confirm.
- fix: Add registry or local danger rules for these sub-forms (as `LOCAL_DANGER_SLASHES` does for `/workflow`), so the sheet fires.

#### [MED][FAILURE] `/workflow new|rename|delete` reports success even when the save silently failed
- where: src/lib/gateway/slash-commands.ts:933-936 (`commit`), 949; src/lib/gateway/workflows.ts:31-37 (`saveWorkflows` swallows all errors)
- what: `commit` awaits `onWorkflowsChanged` and then returns "Saved ..." / "Renamed ..." / "Removed ...". The provider's save helper catches and drops any storage error.
- why: If storage fails (quota, serialization), the operator is told the workflow was saved, but it disappears on the next load. The reply never reflects the actual write.
- fix: Have `saveWorkflows` return a boolean (or throw) and have `commit` report a failure message when the write did not land.

#### [LOW][FUNC] `/session new <title>` keeps only the first word of the title
- where: src/lib/gateway/slash-commands.ts:1374-1376
- what: `const title = args[1]?.trim()` uses the first tokenized argument only.
- why: `/session new Q3 planning` opens a session titled "Q3" and the reply echoes "Q3", silently dropping the rest.
- fix: Use `args.slice(1).join(' ')` (or the raw argument text) for the title.

#### [LOW][QUALITY] Dead condition after an early return
- where: src/lib/gateway/slash-commands.ts:573-575 and 582-583
- what: `/run` returns at 574 before reaching line 582, so `if (blocked && commandName !== '/run') return blocked;` can never see `/run`.
- why: The exclusion is misleading and suggests `/run` can reach the block check when it cannot.
- fix: Drop the `commandName !== '/run'` clause.

#### [LOW][QUALITY] Unreachable fallback method in `runAdvancedFamilyCommand`
- where: src/lib/gateway/slash-commands.ts:1724
- what: `if (!method) method = commandName.replace('/', '').replace('-', '.') + '.list';` runs only after a switch that covers every caller's command name (`/agents`, `/tools`, `/plugins`, `/cron`, `/env`, `/skills`, `/artifacts`). The branch is dead, and `.replace` only handles the first `-`.
- why: Dead code that looks like a live path hides which methods are actually sent.
- fix: Remove the fallback, or throw for an unknown family.

#### [LOW][QUALITY] Stale comment and duplicated bare-model logic in `/model`
- where: src/lib/gateway/slash-commands.ts:1052-1067, 1197-1209, 1217-1236
- what: The comment at 1197-1202 says the bare `/model <name>` composer path is "unused in favour of the sheet", but the path is live for OpenClaw (no `setModelOverride`). The bare-model override logic appears three times (1055-1067, 1217-1236, and the bottom fallthrough), and 1057 runs `validateModelId` whose result is discarded on the OpenClaw path. Indentation at 1197-1236 is also misleading, since `applyModelIdDirect` is module-level.
- why: The comment and layout make the real dispatch hard to follow, which is how the `fallbacks` bug above went unnoticed.
- fix: Route all bare-model switches through one function and update the comment.

#### [LOW][FAILURE] Error reasons are dropped in two summary reads
- where: src/lib/gateway/slash-commands.ts:1302-1307 (`runHealthChecksCommand`), 1326-1328 (`runSessionSpendCommand`)
- what: The `catch` blocks discard the error and render a generic `ok: false` or "Sessions could not be read." message with no reason.
- why: The operator cannot tell a timeout from an auth failure, and the failure is not logged anywhere.
- fix: Keep the error text in the `raw` field (as the other read helpers do), or log it.

#### [LOW][BUG] Empty or unrecognised health and status payloads render as healthy
- where: src/lib/gateway/slash-commands.ts:1965 (`'OK'` default), 1978 (`'online'` default)
- what: When a response has no `status`, `state` or `ok` field (for example `{}`), the formatter falls back to "Health: OK" or "Status: online".
- why: A malformed or empty reply shows as a green state with no evidence behind it.
- fix: Fall back to "unknown" when no recognised field is present.

#### [LOW][BUG] `/cron create` strips quotes and collapses spacing in the prompt
- where: src/lib/gateway/slash-commands.ts:1679 (`args.slice(1).join(' ')`), with the tokenizer at 3089-3091 (`tokenizeCommand`)
- what: The prompt is rebuilt from tokens, so quoted text loses its quotes and runs of whitespace collapse.
- why: `/cron create T | 0 9 * * * | Say "hi"` schedules the prompt `Say hi`, not what was typed. The same pattern affects `/session new` titles.
- fix: Pass the raw argument text after the command name, as `/run` and `/workflow` already do.

### src/lib/gateway/slash-palette.ts ... src/lib/gateway/workflows.ts

#### [MED][BUG] Failed or unparsable workflow read is saved back as the whole store
- where: src/lib/gateway/workflows.ts:20-28 and 31-37; src/context/gateway-provider.tsx:5186-5194
- what: `loadWorkflows` returns `[]` on any read or JSON error (catch at line 25). The `/workflow` path passes that list into `executeGatewaySlashCommand`, and `onWorkflowsChanged` then calls `saveWorkflows(gateway.id, next)` with a list derived from the empty snapshot. `saveWorkflows` also swallows write errors.
- why: A single failed read of `versutus:workflows:<id>` followed by any `/workflow new`, `rename`, or `delete` overwrites every saved workflow for that gateway with the one new entry, with no warning.
- fix: Distinguish "no workflows stored" from "store unreadable" (throw or return a failed read) and refuse to save over a store that did not load.

#### [MED][FAILURE] Corrupt-gateways rescue ring fills with duplicates of one blob
- where: src/lib/gateway/storage.ts:101-116 (calls at 108 and 112), 77-99 (`preserveCorruptGateways`)
- what: `loadGateways` is a read path that is deliberately off the mutation queue. Every call that sees an unparsable or non-array blob calls `preserveCorruptGateways(raw)`, which writes the same raw string into the next slot and bumps the counter. Nothing in the read path rewrites the blob, so the same corrupt value stays and is re-saved on every load.
- why: After three loads of one corrupt blob, all three rescue slots hold identical copies and any older, different rescued blob is overwritten, so the ring no longer keeps "the newest few" as its comment promises. Each load also costs two SecureStore writes.
- fix: Skip the rescue when the raw value already matches the most recent slot, or run the preserve step inside `enqueueStoreMutation` only on the write path.

#### [MED][BUG] `http://host:80` is silently rewritten to port 8642
- where: src/lib/gateway/url.ts:91
- what: `parsed.port` is `''` for an explicit default port (WHATWG strips `:80` for `http:` and `:443` for `https:`), so the fallback `parsed.protocol === 'https:' ? '443' : '8642'` runs and replaces an explicit `:80` with `:8642`. Verified in Node: `new URL('http://h.example:80').port === ''`.
- why: A gateway the operator typed on port 80 (for example behind a reverse proxy) is saved and probed on 8642, so connection fails with no message about the port change. The same applies to a beacon advertising port 80 (`buildGatewayUrlFromBeacon`, line 118 and 126).
- fix: Read the port from the raw host text, or fall back to the scheme default (`80` for http, `443` for https) only when the port was absent in the input.

#### [MED][BUG] Failed debounced transcript writes are dropped, and the code comment says otherwise
- where: src/lib/gateway/transcript.ts:102-112 (`trackWrite`), 120-129 (`enqueueWrite`), 166-167 (`flushTranscripts` failure report)
- what: The comment at 106-107 says a debounced write's failure "is held here and handed to whoever forces the next flush". `trackWrite` instead removes the write from `pendingWrites` on rejection (`() => pendingWrites.delete(write)`) and keeps no error, so `flushTranscripts` never sees it and `scheduleFlush` has no catch or retry.
- why: When `keyValueStorage.setItem` throws during the 250 ms debounced flush, the transcript the UI already shows is never persisted, and no caller is told, so the loss surfaces only as a missing transcript after reload.
- fix: Store the rejection in a field (or a list) that `flushTranscripts` rethrows, or log and retry, so the comment and behaviour match.

#### [MED][BUG] Deleting a session or gateway can resurrect its transcript from a queued write
- where: src/lib/gateway/transcript.ts:309-316 (`clearTranscriptsForGateway`), 284-289 (`removeTranscriptsForSession`), with 226-231 (`mutateEntries`) and 139 (`scheduleFlush` callback)
- what: Both delete paths clear the held copy and cancel the timer synchronously, but they do not wait on mutations already queued in `mutationTails`. A queued `mutateEntries` task runs after the delete, finds no held copy, re-reads storage (still holding the old data), calls `holdEntries` and `scheduleFlush` again, and its 250 ms timer then writes the entries back with `setItem`.
- why: Deleting a gateway or session while a `/agent` command or delta update is in flight recreates a `versutus:transcript:<gatewayId>:<key>` entry after the profile is gone, which is exactly the leak the comment at 306-308 says to prevent.
- fix: Route the delete through `enqueueTranscriptMutation` (or mark the key as deleted so `scheduleFlush` and `holdEntries` refuse it) so no mutation can re-hold a removed key.

#### [MED][FUNC] Duplicate workflow names are accepted, and the second one can never be run or renamed
- where: src/lib/gateway/workflow-model.ts:72-88 (`createWorkflow`, no uniqueness check), 102-106 (`findWorkflow` returns the first match); src/lib/gateway/slash-commands.ts:945, 956, 966
- what: `/workflow new <name>` appends a workflow without checking whether the name already exists. `findWorkflow` returns the first case-insensitive match, so `/workflow run`, `rename`, and any lookup by name always reach the older entry.
- why: Creating the same name twice leaves a second workflow that the slash surface cannot reach by name, so its steps and run tally are unreachable and it shows up as an unexplained duplicate row.
- fix: Reject a `createWorkflow` whose trimmed case-insensitive name already exists, or give duplicates a unique suffix at creation.

#### [LOW][QUALITY] `readChatFrames` documents a replay filter the code does not apply
- where: src/lib/gateway/turns.ts:266 (doc: "Frames at or below this seq were rendered already and are not reported"), 283-290 (no seq comparison before `callbacks.onDelta`), 319 (only `onSeq` checks `seq > after`); src/lib/gateway/manifest-client.ts:1385 (`?after=` sent to the Gate)
- what: The reader reports every frame's text to `onDelta`/`onReasoning`/`onToolCall` regardless of `after`. Only the seq callback is gated. Duplicate suppression therefore depends entirely on the Gate honouring `?after=`.
- why: A gateway (or proxy) that ignores `after` and replays from the start will append every already-rendered delta a second time into the bubble, and the doc comment misleads anyone who relies on it.
- fix: Either drop frames with `seq <= after` before calling the callbacks (the read has the id via `onId`), or correct the doc comment to say the server does the filtering.

#### [LOW][QUALITY] Orphaned JSDoc above `READ_BOT_SPEND_CONCURRENCY`, and `readBotSpend` has none
- where: src/lib/gateway/spend-report.ts:203-216 (block describing `readBotSpend`), 217-225 (second block for the constant), 289 (`readBotSpend` with no doc)
- what: The block that explains the per-Bot fold and its failure rules sits above a second JSDoc, so it documents nothing; the function it describes (line 289) has no attached doc at all.
- why: Readers and tooling see the concurrency note as the constant's doc and the failure contract (`{ ok: false }` kept as a named failure) as undocumented on the exported function that implements it.
- fix: Move the 203-216 block onto `readBotSpend` and merge the concurrency rationale into the constant's doc.

#### [LOW][BUG] A toolset with an empty `name` is dropped even when it has an `id`
- where: src/lib/gateway/toolsets.ts:47
- what: `stringField(raw, 'name') ?? stringField(raw, 'id')` uses `??`, which only falls back when `name` is missing. An empty-string `name` returns `''`, so `parseToolset` returns `null` and the entry is discarded even though `id` holds a usable name.
- why: A gateway that sends `name: ""` with a valid `id` silently loses that tool from the list, and the count shown in `toolsetsToggleLabel` is wrong with no indication.
- fix: Fall back on the trimmed value, for example `(stringField(raw,'name') || stringField(raw,'id') || '').trim()`.

### src/context/demo-gateway-provider.tsx ... src/lib/gateway/skills.ts

#### [MED][FUNC] Showcase group mutators return the first group for every group
- where: src/context/demo-gateway-provider.tsx:239-240, 242
- what: `rename` returns `{ ...SHOWCASE_GROUPS[0], id: groupId, name }`, so it borrows group 0's members. `leave` and `addMembers` ignore `groupId` and return `SHOWCASE_GROUPS[0]` outright.
- why: chat-screen.tsx:2563, 2587 and 2600 feed the returned room back with `setDetailGroup(room)`. Renaming, removing a member from, or adding members to any group other than the first makes the open sheet show group 0's roster and name.
- fix: look up the group by `groupId` in SHOWCASE_GROUPS (or a mutable copy) and return that group's updated record.

#### [MED][BUG] skillsReadFromUnknown reports an array of unparseable entries as an empty successful read
- where: src/lib/gateway/skills.ts:58-67 (contract stated at lines 52-56; consumer applySkillsRead at 69-75, copy at 86)
- what: when `items` is an array, every entry goes through `parseSkill`, and entries that fail (non-object, or no `name`/`id`) are dropped. The function still returns `{ ok: true, skills: [] }`.
- why: the doc comment says a junk envelope must never be "an empty-ok list". A schema drift such as `[{"description":"x"}]` makes the pane show "No skills." (skills.ts:86), and a later re-read clears the last good list instead of marking it stale.
- fix: return `{ ok: false }` when the array is non-empty and no entry parsed, or count dropped entries and treat a total loss as a failed read.

#### [LOW][FUNC] Showcase gatewayRequest does not answer skills.list
- where: src/context/demo-gateway-provider.tsx:176-183; consumer src/components/chat/chat-screen.tsx:1976
- what: `gatewayRequest` handles only `sessions.list` and `bots.get`. Every other method, including `skills.list`, resolves to `{}`.
- why: `skillsReadFromUnknown({})` returns `ok: false`, so the skills toggle always reads "Skills could not be read." in the showcase. That is despite `features.skills: true` at line 45, so the skills pane cannot be judged there.
- fix: add a `skills.list` branch that returns a canned list from showcase-fleet, or make unhandled methods fail explicitly.

#### [LOW][BUG] Streaming state and the busy lock are global, not per thread
- where: src/context/demo-gateway-provider.tsx:118, 131, 251, 331
- what: `timer`, `beat` and `streamingId` are single values. `isSending` is `streamingId !== null` for whichever thread is open, `sendChatInput` returns 'busy' for any thread while another reply streams, and `stopStreaming` finishes the stream from any thread.
- why: send to bot A, then open bot B within the stream (about 2-3 seconds). B's composer shows busy and its Stop button cuts off A's reply, even though nothing was sent to B.
- fix: key `streamingId` and the timers by `threadKey`, and only report `isSending` and stop for the thread that owns the stream.

#### [LOW][FUNC] Writes return success but the read methods never reflect them
- where: src/context/demo-gateway-provider.tsx:200 (createBot), 223 and 226 (botJobs.create/remove), 236 and 241 (botGroups.create/deleteGroup), 305-306 (createNewSession/deleteSessionById), 285 (selectModel)
- what: these return success-shaped values but never change the static SHOWCASE_* data that list and read calls return. `selectModel` ignores its `modelId` argument and only closes the picker.
- why: a created or deleted bot, group, job or session appears to succeed and then vanishes on the next read, and a picked model never shows as selected. The showcase cannot be used to judge these flows.
- fix: seed mutable state from SHOWCASE_* and apply writes to it, or document these methods as intentional no-ops.

#### [LOW][BUG] Unknown bot ids get a fabricated or unrelated record
- where: src/context/demo-gateway-provider.tsx:201 (updateBot), 179-180 (bots.get)
- what: `updateBot` falls back to `SHOWCASE_BOTS[0]` when the id is not found. `bots.get` returns `{ soul: '' }` with no id when the bot is missing.
- why: updating a missing bot reports bot 0 as the result, and a missing lookup yields a record with no id. Callers that trust the return value show the wrong bot or a broken one.
- fix: throw or return a not-found error for unknown ids, as the real Gate would.

#### [LOW][FUNC] Group reply is hardcoded to bot 'aria' and fixed text
- where: src/context/demo-gateway-provider.tsx:237
- what: `botGroups.send` always returns `{ replies: [{ botId: 'aria', text: 'Noted — I will fold that into the 9:00 note.' }] }`, whatever the group, its members or the message.
- why: the reply is attributed to 'aria' even when she is not a member of the group, and the text ignores what the user sent, so group-chat flows show a misleading result.
- fix: derive the reply from the group's members and the input text, or from a per-group canned reply table.

### src/context/gateway-provider.tsx

#### [MED][FUNC] Confirmation preview shows "(unset)" as the current value when config.get fails
- where: src/context/gateway-provider.tsx:859-868
- what: `buildActionPreview` catches a failed `config.get` and sets `current = null`, then builds every diff row with `before: safeStringify(lookupPath(current, key))`, which yields `(unset)`; the diff is still returned as normal.
- why: On a `/config patch` whose read fails, the operator is told every key is currently unset and asked to confirm the write on that false basis; the sheet never says the before state is unknown.
- fix: Mark the before value as unreadable (distinct from unset) when the read fails, and say so on the sheet.

#### [MED][FAILURE] Re-attach ladder gives up after one failed getTurn read
- where: src/context/gateway-provider.tsx:2521-2551 (reattachTurn), 2404-2414 (scheduleTurnReattach), 2493-2495
- what: `reattachTurn` reads the turn with `.catch(() => null)` and, when the result is null, returns without re-arming `scheduleTurnReattach`; the stream catch arms the ladder only once per dropped stream.
- why: The ladder exists for a dropped connection, and getTurn is the request most likely to fail during that outage, so a single failed read ends the follow. A dropped-stream bubble is not marked interrupted, so it stays streaming with no timer until the next connect, foreground or thread edge.
- fix: Treat a rejected getTurn as unknown and re-arm the next backoff window (with a cap), reserving the stop for a confirmed not-found.

#### [MED][FAILURE] connectGateway switches the displayed profile before a storage write that can throw
- where: src/context/gateway-provider.tsx:3345-3362 (the write is at 3361; the live-branch write at 3342 has the same shape)
- what: `connectGateway` calls `setActiveGateway(gateway)` and `setMessages([])` (3345-3347), then awaits `saveActiveGatewayId` with no catch before `attachClient` (3361-3362). `clientRef` is not cleared on this path.
- why: `src/lib/storage/secure-key-value.ts` throws on a refused write in production builds, so the await rejects before attachClient runs. The header then names the new gateway while `gatewayRequest` and `gatewayFetch` still use the previous connected client in `clientRef`.
- fix: Catch the active-id write and report it through `setLastError`, or write after attachClient settles; either way, tear down the outgoing client on the same path.

#### [LOW][FAILURE] A roster-heal write failure is reported as a settings load failure
- where: src/context/gateway-provider.tsx:3648-3661 and 3701-3707
- what: The bootstrap heal awaits `saveGateways` and `saveActiveGatewayId` before `setGateways(roster)` and `setActiveGateway(active)` run; any throw goes to the outer catch.
- why: A refused write on a roster that was read fine leaves the screen on "Could not load saved gateway settings" with no gateways shown, even though the saved profiles were readable.
- fix: Catch the heal's writes separately, keep the healed roster in memory, and report the write failure through `setLastError`.

#### [LOW][QUALITY] Discovery path is unreachable
- where: src/context/gateway-provider.tsx:766-771, 941-955, 3504-3525; src/lib/discovery/scanner.ts:10-12
- what: `isNativeDiscoveryAvailable()` is hard-coded to `false`, so `discoverForProbe` returns `[]` before touching the shared scanner; `getDiscoveryScanner`, the `discovered` threading and the `wsBeacon` branch can never produce a result.
- why: Dead code that reads as live discovery, and the `discovered` argument threaded through `runAutoConnect` and `resolveGatewayForUrl` never carries anything.
- fix: Remove the discovery plumbing from `runAutoConnect` and the provider, or re-enable it behind a real native check.

#### [LOW][QUALITY] Any https:// gateway is recorded as discoverySource 'tailscale'
- where: src/context/gateway-provider.tsx:3448-3453; the same heuristic at src/app/gateway/add.tsx:116 and src/lib/gateway/storage.ts:220
- what: The source is set to `'tailscale'` for any URL containing `.ts.net` or starting with `https://`, so an HTTPS gateway on a LAN or public host is labelled as tailnet.
- why: `src/components/gateway/compact-gateway-list.tsx:79` keys on that value, so non-tailnet HTTPS gateways are classified wrongly, and the same heuristic is copied into three files and will drift.
- fix: Derive the source from the host in one shared helper and call it from all three sites.

#### [LOW][QUALITY] Public context types the model catalog and session list as any[]
- where: src/context/gateway-provider.tsx:640 (`modelCatalog: any[]`) and 649 (`sessionList: any[]`)
- what: The exported `GatewayContextValue` types these two lists as `any[]` even though the provider holds typed data (`ModelCatalog` rows and `HermesSession`, already imported at line 198).
- why: Every consumer of the context loses type checking on these fields, so a shape change in the catalog or session list compiles and fails at runtime.
- fix: Type both fields with the real row types from their lib modules.

#### [LOW][PERF] AbortController allocated on every provider render
- where: src/context/gateway-provider.tsx:1507
- what: `useRef<AbortController>(new AbortController())` evaluates `new AbortController()` on every render of `GatewayProvider`, and React keeps only the first instance.
- why: The provider re-renders on each streamed chat frame because the message list lives in it, so a throwaway controller is allocated on every frame for nothing.
- fix: Create the controller lazily (for example with a ref initialised to null and a check at first use).

### src/context/gateway-provider.tsx

#### [MED][BUG] Capability refresh stamps "checked just now" even when the reads failed
- where: src/context/gateway-provider.tsx:6139-6140 (`setCapabilityCheckedAt(Date.now())`), with `landed = false` set at 6103, 6137 and 6144. Display: src/components/gateway/gateway-capabilities.tsx:36 and 70-72
- what: `refreshCapabilities` sets `landed = false` when the capability read or the manifest fetch fails, but still runs `setCapabilityCheckedAt(Date.now())` unconditionally at 6140.
- why: `CapabilityFreshness` renders "checked N minutes ago" from that stamp. A refresh that read nothing (MagicDNS blip, refused capability read) makes the card claim fresh data, which is the exact lie the comment at 6062-6064 says this function exists to prevent.
- fix: Only stamp `capabilityCheckedAt` when `landed` is true.

#### [MED][BUG] refreshCapabilities ignores a false health result, so a dead /health still reads as landed
- where: src/context/gateway-provider.tsx:6092-6093
- what: `await raceAbort(client.healthCheck(), abort.signal);` discards the boolean. The AppState handler at 5958-5961 treats a falsy health result as a failed check (`if (!health) healLiveClient()`).
- why: If `/health` resolves false while the capability read still succeeds, `landed` stays true and the pull-to-refresh reports fresh data. The comment at 6062-6064 names exactly this "dead /health" case as one it claims to cover.
- fix: Set `landed = false` when `healthCheck()` resolves falsy.

#### [MED][FAILURE] deleteGateway awaits saveActiveGatewayId without a catch, so a refusal skips the resume path and rejects after teardown
- where: src/context/gateway-provider.tsx:4164 (`await saveActiveGatewayId(null)`), skipped branch at 4165-4171; compare disconnectGateway at 4223-4225, which catches the same write
- what: The active-gateway teardown in deleteGateway has already run (client disconnected, state cleared) when the unguarded write at 4164 throws. The auto-connect resume and the `applyConnectionPhase` call on the lines after it are then never reached.
- why: The operator gets a rejected delete even though the profile was removed at 4096. The connection phase is left stuck instead of 'searching' or 'idle'. The comment at 4107-4112 says a delete must not be reported as failed when teardown succeeded, and this path breaks that.
- fix: Wrap the write in `.catch(...)` as disconnectGateway does, or move the phase and resume logic ahead of the await.

#### [MED][BUG] Outbox flush sends queued lines through a closure captured before the backend and Bot switch
- where: src/context/gateway-provider.tsx:7169-7171 (selectBackend), 7179 (openBot), 7211-7217 (sendChatInput); the stale reads are in sendMessage at 4330, 4345, 4416 and 4437, where `selectedBackendId`, `selectedBotId` and `activeGateway` come from the render-time closure
- what: The flush loop runs inside an async closure created by the effect at 7123, so `sendChatInput` and `sendMessage` are the instances from that render. `selectBackend` and `openBot` update refs and state, but the already-captured `selectedBackendId`, `selectedBotId` and `activeGateway` keep their pre-switch values for every row in the batch.
- why: `resolveSendModel`, `providerId` and the Bot handoff check then use the old environment's model and provider against the new client scope. A new Hermes session is created with that model, and its model pin is immutable. The comment at 7166-7168 says the words must run in the environment they were typed in, and this does not hold for the model or Bot routing.
- fix: Have the flush read the live scope from refs (selectedBackendIdRef, selectedBotIdRef, activeGatewayRef) when it sends, or pass the resolved scope explicitly into sendChatInput.

#### [MED][PERF] Every streamed command delta writes the transcript store and re-renders the whole provider
- where: src/context/gateway-provider.tsx:5224-5230 (onAgentDelta calls updateLocalMessage per delta), 4076-4091 (updateLocalMessage), 4085-4088 (`void updateTranscript(...).then(setTranscripts)`), value memo deps at 7526
- what: Each delta from a command stream calls `updateLocalMessage` with the full text, which in turn calls `updateTranscript` and `setTranscripts`. Nothing is coalesced, unlike the chat path (comment at 4294-4297).
- why: A long streamed command issues one store write and one `setTranscripts` per delta, and `commandTranscripts` is in the `value` memo deps, so every delta re-renders all context consumers. The writes are fire-and-forget, so they can also complete out of order and leave an older partial summary on disk.
- fix: Throttle or batch the transcript write for running commands (write once on completion or per RAF) and keep `setTranscripts` out of the streaming path.

#### [MED][FUNC] Composer stays locked for the whole Bot-handoff phase after the reply has finished
- where: src/context/gateway-provider.tsx:4437-4460 (roster read and serial handoffMention awaits, inside sendMessage's try), with `setIsSending(false)` only in the finally at 4549-4552
- what: After `finalizeStreamingMessage` runs at 4408, sendMessage still awaits `listBots()` and then one `handoffMention` per mention before it returns. `isSending` stays true until the finally runs.
- why: The reply is already on screen, but the composer refuses new sends (`isSending` guard at 4241) until each handoff round-trip settles, up to the transport timeout per call. Multi-mention replies extend that lock serially.
- fix: Release `isSending` (and the send's ownership) before the handoff loop, and run the handoff afterwards as a detached step that reports through system notes.

### src/context/handsfree-voice-provider.tsx ... src/lib/fleet/constellation-model.ts

#### [MED][BUG] Cached sessions lose every token count because the secret sweep matches "tokens"
- where: src/lib/cache/swr-store.ts:64 (SECRET_WORDS), 94-103 (stripSecretFields); written at src/context/gateway-provider.tsx:5569 and read at 5518
- what: isSecretFieldName drops any field whose words include "tokens" or "keys". HermesSession fields such as input_tokens, output_tokens, cache_read_tokens, cache_write_tokens and reasoning_tokens (shape visible at src/lib/demo/showcase-fleet.ts:212-216) all match and are removed before the session page is cached.
- why: The cached paint of the session list shows sessions with no token usage, then the live read fills the numbers in, so the list changes on every visit and the first paint is wrong.
- fix: Match credential-shaped names only (token, access_token, api_key, and similar), or exempt count and usage fields such as *_tokens.

#### [MED][FUNC] The running run's name is never populated, so the Bot's running name is always empty
- where: src/lib/fleet/constellation-model.ts:150-153 and 237; src/lib/fleet/constellation-input.ts:63-66; src/lib/fleet/bot-sheet.ts:58
- what: runningRuns is seeded with '' (line 152) and never assigned a name; line 237 reads it back with `|| undefined`, so runningRunName is always undefined. The input projection keeps only id, botId and status, so no prompt or name can reach the model.
- why: The map's "one live run name" and the bot sheet's `running` field (bot-sheet.ts:58) are always null, so the sheet never shows what a Bot is running.
- fix: Carry the run's prompt or title through FleetRunInput and record it for the first running run per Bot, or drop the field and the copy that promises it.

#### [MED][BUG] Bot rows are drawn outside the 640 design square when the live gateway sits at the bottom of the ring
- where: src/lib/fleet/constellation-model.ts:177-178 (gateway y), 216-219 (botsPerRow), 231-232 (botX/botY)
- what: Gateways sit on a radius-210 ring. The second of two gateways (or the third of four) lands at y=530; its Bot rows start at y=602 and each further row adds 64. With six Bots per row, the seventh Bot is at y=666, outside the 640 box. Nothing clamps node positions, and constellationLayout (lines 525-529) only scales them.
- why: On a two-gateway fleet with the live gateway at the bottom, any Bot beyond the sixth is drawn off the map and cannot be tapped, which contradicts the layout's claim that "a node never leaves the box".
- fix: Stack Bot rows upward when the gateway is in the lower half of the ring, or compress the row gap so every row stays inside CONSTELLATION_HEIGHT.

#### [MED][BUG] Run and failure counts ignore the gateway, so another gateway's runs mark a live Bot
- where: src/lib/fleet/constellation-model.ts:146-153 and 163-167; src/lib/fleet/constellation-input.ts:63-66
- what: Running and failed runs are keyed by botId alone. The input projection drops gatewayId from each run (lines 63-66), although ActivityRun carries gatewayId (src/lib/demo/showcase-fleet.ts:249). The model itself treats a Bot as gateway-scoped (node id `bot:${profile.id}:${bot.id}`, line 261).
- why: A run from a Bot with the same profile id on a different saved gateway shows "Running" or "N failed" on the live gateway's Bot, so the map reports work that is not happening on the connected gateway.
- fix: Pass gatewayId through the run projection and count only runs whose gatewayId matches the live gateway.

#### [MED][FUNC] Pending approvals for Bots missing from the roster vanish from the map and the HUD count
- where: src/lib/fleet/constellation-model.ts:163-167, 250-251, 324
- what: approvalsByBot is only read inside the per-Bot roster loop, so an approval whose botId is not on the roster (roster stale or unavailable, or the Bot removed) adds nothing to approvalsTotal or to any node.
- why: The HUD and the map report zero approvals while the approval inbox and the glance "needs you" figure still count them, so an operator waiting on an approval sees nothing on the map.
- fix: Count every pending approval into summary.approvals and show unattributed ones on the gateway node.

#### [MED][BUG] Restored "unresolved" runs count as working in the glance but as finished in the partition and presence
- where: src/lib/activity/glance.ts:25-27 and 38; src/lib/activity/presence.ts:14-17; src/lib/activity/run-partition.ts:14-16
- what: glanceFigures and dayRibbon treat an unresolved run with no finishedAt as in flight (inFlightAfterRestore). teamPresence only marks `running` runs as working, and runIsInFlight only counts `running` and `waiting-approval`, so the same run is finished in the list and not working on the Bot's presence.
- why: The screen disagrees with itself about one run, the exact problem inFlightAfterRestore was written to prevent; the header figure and the Activity list give different answers.
- fix: Move inFlightAfterRestore into one shared predicate and use it in runIsInFlight and teamPresence.

#### [MED][FUNC] The rejection tracker is replaced even when the React Native options cannot be loaded
- where: src/lib/diagnostics/failure-log.ts:265-277 (require at 268), 286-308
- what: `require(specifier)` takes a variable, so the bundler cannot include the module. At runtime the require throws, the catch returns null, and chainRejectionTracking still overwrites Hermes' single rejection tracker while forwarding to a null rnOptions.
- why: React Native's own unhandled-rejection reporting, which the comment says must not be silenced, is disabled in every build with no sign that the chain failed.
- fix: Use a string-literal require with a typed declaration so the module is bundled, or leave the existing tracker in place when rnOptions is null.

#### [MED][PERF] The hands-free context value is rebuilt on every render, so every consumer re-renders on each chat update
- where: src/context/handsfree-voice-provider.tsx:265 (useChatSurface messages), 1434-1467 (value literal, no useMemo)
- what: The provider reads `messages` from useChatSurface, so it re-renders on every streamed chat update. The value object is a fresh literal on each render with no memoisation, so every useHandsfreeVoice consumer re-renders with it.
- why: During a streamed reply each token re-renders the call banner and every subscribed component, although almost none of the fields changed.
- fix: Memoise `value` on its inputs, and split the fast-changing transcript fields from the stable call controls.

#### [LOW][BUG] The ribbon drops runs older than a day while the glance still counts them as working
- where: src/lib/activity/glance.ts:38 versus 82
- what: glanceFigures counts every running run regardless of age, but dayRibbon keeps only runs with startedAt inside the span.
- why: A run still in flight after 24 hours is in the "working" figure but has no bead on the ribbon, so the glance and its picture disagree.
- fix: Keep in-flight runs on the ribbon regardless of age, or bound the glance figures to the same window.

#### [LOW][BUG] readCached writes the disk copy over a newer memory copy after its await
- where: src/lib/cache/swr-store.ts:126-133 (memory check, then await getItem), 150 (remember after await)
- what: readCached only consults memory before awaiting keyValueStorage.getItem, then calls remember() with the disk envelope without rechecking memory.
- why: If writeCached stores a newer value while that read is in flight, the older disk value replaces it in memory, and paints show stale data until the next write.
- fix: After the await, keep an existing memory entry if one appeared meanwhile instead of overwriting it.

#### [LOW][BUG] The size cap counts UTF-16 units, not bytes
- where: src/lib/cache/swr-store.ts:27-28 (doc), 174 (raw.length check)
- what: The check `raw.length > SWR_MAX_BYTES` measures UTF-16 code units, while the constant and the file header describe bytes.
- why: Multi-byte content (non-ASCII names or chat text) can be well over 150 KB on disk and still pass the check, against the store's own rule.
- fix: Measure the encoded byte length (for example utf8Encode(raw).length from src/lib/encoding.ts) before writing.

#### [LOW][FAILURE] A look that fails to persist is dropped silently
- where: src/lib/avatar/look-store.ts:89-90
- what: registerCrestLooks applies the choice at once, and the setItem failure is swallowed by `.catch(() => undefined)`.
- why: A look that never reached storage shows as saved for the session and quietly reverts on the next launch, with nothing recorded.
- fix: Report the failure through recordFailure (src/lib/diagnostics/failure-log.ts) or retry the write.

#### [LOW][FUNC] The discovery scanner does not remember its state, so late subscribers never see 'unavailable'
- where: src/lib/discovery/scanner.ts:17-21 (subscribe), 23-31 (start), 37-43 (snapshot)
- what: start() emits status 'unavailable' with the explanatory error but stores nothing, and subscribe() replays snapshot(), which is always 'idle' with no error.
- why: A screen that subscribes after start() shows 'idle' and never explains that discovery is off and that gateways must be added by URL.
- fix: Keep the last emitted DiscoveryState in a field and replay it from subscribe().

### src/lib/fleet/gateway-handshake.ts ... src/lib/notifications/run-progress.ts

#### [MED][BUG] Operator-cancelled runs counted as "failed" on Home
- where: src/lib/home/briefing.ts:36-43, src/lib/home/briefing.ts:131
- what: `terminalFate` maps only `complete` and `unresolved` to their own groups; `cancelled` falls through to `'failed'`, and the summary then prints `N failed`.
- why: A run the operator stopped is reported as a failure on Home. The scorecard module (src/lib/fleet/scorecard.ts:148-151, header lines 7-10) explicitly rules that a cancelled run is not a failure, so the two surfaces disagree.
- fix: Give `cancelled` its own group (or leave it out of the failed count) and keep the Home copy consistent with the scorecard rule.

#### [MED][FUNC] Routine notices for routines paused or deleted elsewhere keep firing
- where: src/lib/notifications/routine-sync.ts:264-268 (also :204-225), callers src/context/gateway-provider.tsx:6454 and src/components/chat/chat-screen.tsx:1939
- what: `rearmRoutineNotifications` filters paused jobs out with `!job.paused` and never cancels their held notice. The reconcile sweep only touches job ids present in the read, so a job that disappeared from the read is never cancelled either. `cancelRoutineNotification` only runs for actions taken on this device (cron-job-sheet.tsx:136, :163; chat-screen.tsx:1903).
- why: A DAILY or WEEKLY expo trigger repeats indefinitely. A routine paused or deleted from the desktop or TUI keeps posting "Routine X is due" on this phone, which contradicts the module's own stated rule that a stale notice for a paused routine is the lie it exists to avoid.
- fix: In the re-arm, cancel the held notice for every paused job, and track the last-known job set so that jobs that vanish from the read are retired.

#### [MED][FAILURE] sheetMaxHeight floor lets a sheet exceed the space actually available
- where: src/lib/motion/sheet-height.ts:100, documented at :66-67
- what: The function returns `Math.max(minimum, available)` with `minimum` defaulting to 240, while its doc says it "never returns more than the space actually available".
- why: When the IME is up and `available` falls below 240, the ceiling is 240 regardless of the space left. The sheet then extends above the visible area and pushes its header and title off the top, which is the overflow failure this module was written to prevent.
- fix: Clamp to `available` when the window is measured, and apply the floor only to the "not measured yet" case, or change the doc to match the floor.

#### [LOW][BUG] Palette chrome constants are below their own size estimate
- where: src/lib/motion/slash-palette-height.ts:14-17, src/lib/motion/thread-config-list-height.ts:15-19
- what: The comment estimates the palette chrome at about 122 and the thread-config chrome at about 130, but the code subtracts 116 and 120 and calls them "conservative".
- why: Subtracting less chrome than the sheet actually uses lets the list run 6-10px past the sheet budget, so the last row clips under the sheet edge when the keyboard is open.
- fix: Use the upper end of the estimate, or measure the chrome instead of hard-coding it.

#### [LOW][BUG] Token counts just under a million print wrong
- where: src/lib/format.ts:4-5
- what: `formatTokenCount` rounds before choosing the unit. Counts from 999.5 to 999.99 hit `Math.round` and print "1000", and counts from 999,500 to 999,999 hit `toFixed(0)` and print "1000k".
- why: Values in these ranges print as "1000" or "1000k" instead of "1.0k" or "1.0M".
- fix: Round first, then promote to the next unit when the rounded value reaches 1000.

#### [LOW][BUG] Last-seen stamp is written under a trimmed key but read and cleared under the raw key
- where: src/lib/home/last-seen.ts:23-26 (stamp trims), :61 (read), :82 (clear)
- what: `stampLastSeen` writes `lastSeenKey(gatewayId.trim())`, while `readLastSeen` and `clearLastSeen` use the untrimmed `gatewayId`.
- why: An id with surrounding whitespace is stamped but never read back, so the digest sees "never" and `clearLastSeen` never removes the key. This only matters if such ids can exist.
- fix: Normalize the id in one shared key helper used by all three functions.

#### [LOW][BUG] Rival-attempt line names the tapped gateway when the active gateway's name is missing
- where: src/lib/fleet/gateway-handshake.ts:64; caller src/app/fleet.tsx:165
- what: `activeGatewayName ?? gatewayName` falls back to the tapped gateway's own name. The caller passes the raw `activeGateway?.name`, not the normalized `gateway.name?.trim() || gateway.id` used at fleet.tsx:161.
- why: When the name is undefined, the status line says "Connecting to <tapped gateway>" while a different gateway holds the attempt. When it is an empty string, the line reads "Connecting to ..." with no name.
- fix: Fall back to the active gateway's id, normalized the same way as the tapped gateway's name.

#### [LOW][FAILURE] streamingFetch throws synchronously despite its Promise-returning type
- where: src/lib/net/streaming-fetch.ts:90-95 (throw in `resolveFetch`), :104-110 (`streamingFetch` calls it outside any promise)
- what: The misconfiguration error is thrown synchronously from `streamingFetch`, which is typed as `typeof fetch` and returns a Promise.
- why: A caller that chains `.catch` on the call, rather than awaiting inside a try, will not catch it, and the exception escapes the call site.
- fix: Return `Promise.reject(new Error(...))` from `streamingFetch` instead of throwing.

#### [LOW][FAILURE] Lock Screen activity is orphaned when end() rejects
- where: src/lib/notifications/run-activity-device.ts:146-148, :164-171
- what: `held.delete(runId)` runs before `await entry.instance.end(...)`, so the entry is dropped even if `end` rejects. The rejection is swallowed.
- why: The activity stays on the Lock Screen with no entry tracking it, and `swept` is already true (line 95), so the once-per-process sweep at :88 never ends it again in this process.
- fix: Delete the entry only after `end` resolves, or keep it so the next pass retries the end.

#### [LOW][FUNC] Bot-message reply action has no producer
- where: src/lib/notifications/categories.ts:68-95, src/lib/notifications/bot-reply.ts:11-13, src/app/_layout.tsx:345
- what: `registerNotificationCategories` registers the `botmessage` category and the layout handles its reply action, but no code path posts a notice with `categoryIdentifier: BOT_MESSAGE_CATEGORY_ID`. The only category passed to `present` is the approval one.
- why: The reply path cannot be reached in a shipped build. The header comment at bot-reply.ts:11-13 acknowledges this, so the gap is known, but the wiring is still dead.
- fix: Wire the producer, or hold the registration and the response branch until one exists.

#### [LOW][QUALITY] Doc for registerWithGate is stacked onto the wrong function
- where: src/lib/notifications/push-registration.ts:120-121, :133-143
- what: The comment "Hand one token to the Gate under the paired device's own grant." sits directly above the `pushDeviceParams` doc block, so `registerWithGate` at :143 has no doc.
- why: The comment describes the wrong function and misleads a reader of both.
- fix: Move it to sit above `registerWithGate`.

#### [LOW][QUALITY] Exported helper returns an empty array and is referenced only by tests
- where: src/lib/home/home-hero-actions.ts:12-14
- what: `homeHeroPrimaryActions()` always returns `[]`. Its only callers are home-empty-state-test.ts:52, and a dashboard test asserts the dashboard does not call it.
- why: The module is dead code kept alive by its own test.
- fix: Delete the module and the test that pins its empty result.

#### [LOW][QUALITY] Test-only copy of the keyboard-lift formula
- where: src/lib/motion/composer-dock-insets.ts:24-28; compare src/lib/motion/keyboard-lift.ts:14-19
- what: `composerKeyboardLiftForTest` duplicates the worklet `composerKeyboardLift` line for line, and only composer-dock-insets-test.ts:11 uses it.
- why: Two copies of one formula can drift, and the test exercises the copy rather than the function production calls.
- fix: Test the real `composerKeyboardLift` export and delete the copy.

#### [LOW][QUALITY] Screen-edges comment describes behavior the code does not have
- where: src/lib/motion/screen-edges.ts:6-8 versus :21
- what: The header says screens without a dock "also take the bottom edge now", but line 21 returns `['top']` for `hasDock: false` on iOS and Android. Every production caller passes `hasDock: true`, so the `false` branch is unreached.
- why: The comment documents a behavior nothing ships, and the unused branch invites a wrong assumption.
- fix: Correct the comment, or remove the unused branch.

#### [LOW][QUALITY] Two list-height functions are identical apart from their constants
- where: src/lib/motion/slash-palette-height.ts:19-36, src/lib/motion/thread-config-list-height.ts:21-37
- what: `paletteListMaxHeight` and `threadConfigListMaxHeight` have the same body, differing only in the chrome and max constants.
- why: A fix to one clamping rule has to be copied by hand, and the two can drift.
- fix: Extract one helper parameterised by chrome and max height.

#### [LOW][QUALITY] Stale cross-reference to the home briefing's clock rule
- where: src/lib/fleet/scorecard.ts:225-226
- what: The comment cites `briefing.ts:47-49` for the rule that a finish past its clock is ignored. That check is at src/lib/home/briefing.ts:76, and lines 47-49 are an unrelated comment.
- why: A maintainer following the reference lands on the wrong code when checking the shared rule.
- fix: Point the reference at briefing.ts:76, or name the function instead of a line range.

### src/lib/notifications/tap-route.ts ... src/lib/storage/secure-key-value.ts

#### [MED][BUG] Dotted three-part address "1.2.3" accepted as a hostname
- where: src/lib/onboarding/validate-pc-address.ts:24, 36, 43-44
- what: `lanIpPattern` needs exactly four octets, so "1.2.3" skips the canonical-IPv4 check and falls through to `hostnamePattern`, which accepts any dot-separated labels, returning `valid: true`. The comment at lines 33-34 says this exact form is refused.
- why: The WHATWG URL parser reads "1.2.3" as the IPv4 address 1.2.0.3, so `completion-from-add.ts` (`new URL(url).hostname`) saves and probes a different machine than the one typed, with no error shown.
- fix: Run the dotted-decimal check on any all-numeric dotted string (for example `/^\d+(\.\d+)*$/`), not only on four-octet forms.

#### [MED][BUG] Guard band steering lands a lamp hue inside another status band
- where: src/lib/stage/lamp.ts:129-137 (test pinning it: __tests__/stage-lamp-test.ts:99)
- what: `guardLampHue` returns on the first status hue within 45 degrees and steers to that band's edge without re-checking the other bands. The status hues are 66 and 75 degrees apart, which is less than the 90-degree combined band width, so the bands overlap.
- why: Amber 88.1 is steered to 43.1, which is 21.2 degrees from red 21.9 and so still inside the failure guard. Any crest near amber (or a hue around 60 degrees, steered to 66.9) lights a room in a status-coloured hue, the exact case the guard exists to prevent. The test at line 99 asserts the buggy value, so it passes.
- fix: After steering, check the result against all status hues and pick the nearest candidate that clears every band, or fail to a neutral lamp.

#### [MED][BUG] Notice stays scheduled while the opt-in reads OFF
- where: src/lib/notifications/weekly-report.ts:207-211 (mapping stored), 220-228 (flag write failure returns `storedOptInState()`)
- what: If the flag write at line 221 throws, the notice has already been scheduled and its identifier stored at line 207, yet the function returns `storedOptInState()`, which reads the old flag (off). The comment at 224-226 says "no refusal to name", but the state returned is off.
- why: The module's own rule (lines 161-171) says a notice the operator did not opt into must not outlive the opt-out and the state must match what the device holds. Here a Monday notice fires while the toggle reads off, and the operator is not told.
- fix: Either roll back the scheduled notice when the flag write fails, or return `{ state: 'on' }` because the notice is held, and name the storage failure.

#### [MED][BUG] App lock write failure is swallowed and the switch shows ON
- where: src/lib/settings/app-lock.ts:129-137; caller src/app/gateway/settings.tsx:171-174
- what: `saveAppLock` returns `void` and catches the write error, so the caller cannot learn that nothing was stored. `handleAppLock` sets the switch to `next` before and regardless of the write.
- why: If the write fails when the user turns the lock on, the switch shows Face ID/fingerprint lock as enabled while the stored flag is still off, so the app opens unlocked. Compare `saveWidgetResultHidden` in widget-privacy.ts, which returns the outcome so the switch can be put back.
- fix: Return the outcome from `saveAppLock` (as `saveWidgetResultHidden` does) and revert the switch on failure.

#### [MED][FAILURE] Access-request body read has no timeout
- where: src/lib/portal/access.ts:314-323 (timer cleared in `finally` as soon as headers arrive), 329 (`response.json()`)
- what: The per-request abort timer is cleared in the `finally` of the fetch callback, which runs once headers arrive. The body is read afterwards at line 329 with no deadline.
- why: A gateway that sends headers and then stalls the body leaves `requestGatewayAccess` pending forever, so the add/pair sheet stays in its saving state until the user leaves the screen. The comment at 312-313 says the timer covers the request, which is not what happens.
- fix: Keep the timer armed through `response.json()` (clear it after the body is read), or race the body read against the same deadline.

#### [LOW][BUG] Corrupt settings blob is silently overwritten with defaults
- where: src/lib/settings/app-settings.ts:55-65, 83-88 (contradicting the doc at 52 and comment at 83-84)
- what: `readAppSettings` catches a JSON parse error and returns `DEFAULT_SETTINGS`. `saveAppSettings` reads through that same function, so the write proceeds and replaces the unparseable blob with defaults merged with the patch.
- why: The comment at 83-84 says an unreadable blob "must refuse the write, never be overwritten with defaults". Only storage read failures refuse; a corrupt blob is overwritten and fields such as `tailscaleHost` and `onboardingComplete` are reset with no signal.
- fix: Make the parse failure throw inside `readAppSettings` so `saveAppSettings` refuses it, and keep the catch only in `loadAppSettings`.

#### [LOW][BUG] A thrown biometric query reads as "unsupported" and fails open
- where: src/lib/settings/app-lock-device.ts:37-46; copy in src/lib/settings/app-lock.ts:70-74
- what: Any exception from `hasHardwareAsync`/`isEnrolledAsync` returns `'unsupported'`, which the settings line shows as "This device cannot ask for Face ID or a fingerprint", and `reason !== null` means the stored lock does not engage.
- why: On a native device that does have the sensor and an enrollment, a transient native error (not a platform without the module) turns the lock off for that launch and displays a false hardware claim.
- fix: Return a distinct "unknown" reason for a thrown query, and keep the lock engaged (or retry) when the device was previously able to answer.

#### [LOW][QUALITY] JSDoc for createClientForKind sits above a different function
- where: src/lib/portal/adapters.ts:263-270 (doc), 271 (`profileWithAlternateIpv4`), 284 (`createClientForKind`)
- what: The doc block describing the factory's routing is directly above `profileWithAlternateIpv4`, so `createClientForKind` has no doc and the helper carries the wrong one.
- why: Misleading docs for the one routing function that decides which client a Gate gets.
- fix: Move the block to just above `createClientForKind` and give the helper its own one-line doc.

#### [LOW][QUALITY] Chat acknowledgement timeout duplicates CHAT_SEND_ACK_MS as a literal
- where: src/lib/portal/openclaw-adapter.ts:34 (constant), 356 (`timeoutMs: 120000` in the `chat.send` params), 358 (`CHAT_SEND_ACK_MS`)
- what: The wire budget is written twice, once as the exported constant used for the client timeout and once as a hardcoded literal in the params. The comment at 30-33 claims they are the same value.
- why: Changing one without the other makes the gateway's budget and the client's budget disagree, which reintroduces the lost-run problem the constant was added to fix.
- fix: Use `CHAT_SEND_ACK_MS` in the params as well, or derive both from one value.

#### [LOW][BUG] Lossy SecureStore key mapping lets distinct keys alias
- where: src/lib/storage/secure-key-value.ts:39-42
- what: `toSecureStoreKey` replaces every character outside `[A-Za-z0-9._-]` with `_`, so "a:b" and "a_b" map to the same SecureStore item. Every read and write goes through this mapping.
- why: Two different logical keys that both exist (for example a gateway token and a device-identity key with the same sanitized form) overwrite or read each other's secret. The mapping is not injective, and nothing checks for it.
- fix: Use an injective encoding (for example percent-encoding or a short hash suffix) and migrate existing keys, or assert that no two keys in use collide.

### src/lib/terminal/ansi.ts ... src/lib/voice/voice-preferences.ts

#### [MED][BUG] Recovered speech is cleared even when the draft write silently failed, and a failed draft read overwrites the typed draft
- where: src/lib/voice/handsfree-recovery.ts:80-86; src/lib/gateway/composer-draft.ts:133-141 (loadComposerDraft returns '' on throw) and 144-155 (saveComposerDraft swallows errors)
- what: `promoteHandsfreeRecovery` loads the recovery, loads the typed draft, saves the merge, then unconditionally clears the recovery. Both draft helpers swallow their errors.
- why: The recovery is documented as the only surviving copy of the spoken words. If the draft save fails, the words are removed from both places. If the draft read fails, the typed draft is treated as empty and replaced by the recovered words alone.
- fix: Have the draft helpers report failure, clear the recovery only after a confirmed save, and refuse to merge when the typed draft could not be read.

#### [MED][FUNC] Any assistant reply that starts with "Error:" is treated as a failed turn and never spoken
- where: src/lib/voice/handsfree-reply.ts:54-57 (isFailedReply); used at src/context/handsfree-voice-provider.tsx:971-973; src/lib/voice/speech-reply.ts:37-40 speaks the same bubble
- what: Failure is inferred from `text.trimStart().startsWith('Error:')`, a content prefix, not from a failure flag on the message. A model answer that begins with that text is dispatched as `reply-failed`.
- why: A legitimate reply such as "Error: the file is missing, here is how to fix it" is silently dropped from speech, and the call moves on without saying it. The speaker toggle reads the same bubble aloud, so the two readers disagree about whether it is a failure.
- fix: Carry an explicit failure marker on the message (set by the stream error path) and drop the text-prefix test.

#### [MED][BUG] A queued reply is read in the voice, rate and pitch of the reply that started the run
- where: src/lib/voice/speech.ts:79-87 (advance captures `voice` from its first call) and 145-157 (speakReply appends to `pending` and returns `advance(engine, run, voice)` only when idle)
- what: `voice` is bound once per run. A second reply that arrives while the first is still being read has its chunks pushed onto the same `pending` queue, and those chunks are spoken with the first reply's voice options.
- why: With per-Bot voices, a reply from Bot B that finishes while Bot A is still speaking is read in Bot A's voice. Rate and pitch are wrong for the same reason.
- fix: Store the voice options alongside each chunk in `pending` and pass them when each chunk is handed to the engine.

#### [MED][BUG] Reconnect schedule sleeps 72 seconds before its last attempt when the Gate advertises its 90 s window
- where: src/lib/voice/gate-reconnect.ts:44 (BACKOFF_MS), 55-58 (the single final delay), called with `windowMs` from src/context/handsfree-voice-provider.tsx:611
- what: The five backoff steps sum to 15.5 s. The final "last moment" delay is `windowMs - 2500 - 15500`, which is 72 000 ms for a 90 s window.
- why: With the current Gate, attempts happen at about 0.5, 1.5, 3.5, 7.5, 15.5 and then 87.5 s. A link that comes back at 30 s is not retried until 87.5 s, so the call stays silent for about a minute. The backoff was meant to be capped, and the sleep was not.
- fix: Cap the backoff sleeps and distribute remaining attempts across the window instead of appending one long sleep.

#### [MED][BUG] Any shell group status other than "ready" is reported as "No shell on this gateway"
- where: src/lib/terminal/shell-support.ts:22-23; status union at src/lib/gateway/types.ts:417
- what: With a `fresh` or `stale` snapshot, any terminal group status except `ready` returns `unsupported`. The union includes `missing-scope`, `warming`, `partial`, `unknown` and `unavailable`.
- why: The terminal group requires `operator.write`, so a token lacking that scope (`missing-scope`) is told the gateway has no shell. A group still warming or partially probed is reported as definitively unsupported, which the file's own doc says must be `unknown`.
- fix: Return `unsupported` only for `unavailable`/`unsupported`, and map every other non-ready status to `unknown`.

#### [MED][BUG] OSC and most two-byte escape sequences are not consumed, so their text leaks into the terminal pane
- where: src/lib/terminal/ansi.ts:61-62 (OTHER_CSI, OTHER_ESC), 148-153 (escape handling in parseAnsiText); compare src/lib/terminal/output.ts:11 (stripAnsi handles `ESC ]`)
- what: The parser handles SGR, CSI and `ESC ( x` only. OSC sequences (`ESC ] ... BEL`, used by shell prompts for window titles and markers) and `ESC =`/`ESC >` fall through, so the ESC byte and the payload are emitted as visible text.
- why: Prompts such as bash or zsh configured to emit OSC titles show `0;user@host:~` text in the pane. `ansiPlainText` is also used for prompt detection and copy, so those inherit the leak. The two parsers in this chunk disagree about what a control sequence is.
- fix: Consume `ESC ]` through BEL or ST, and all `ESC` plus one intermediate or final byte, in parseAnsiText.

#### [MED][BUG] An empty JSON string is displayed as null
- where: src/lib/terminal/json-tree.ts:16-17
- what: `jsonTreeNode` maps `value === ''` to the `null` primitive, the same as a real null.
- why: A command result such as `{"stderr": ""}` renders as `"stderr": null`, which misstates the output the operator is reading. Empty strings are common in command results.
- fix: Remove the `value === ''` case so empty strings render as `""`.

#### [MED][BUG] Row ids and expansion paths collide when keys contain dots or brackets
- where: src/lib/terminal/json-tree.ts:122-146 (paths built as `${path}.${entry.key}` and `${path}[${index}]`; ids `c:`, `k:`, `p:` derived from them)
- what: The path is built by string concatenation with no escaping. Keys such as `"a.b"` and a nested `a` → `b` produce the same path, id and expanded-set key.
- why: Expanding one container also expands its sibling, and two rows get the same React key, which causes duplicate-key warnings and wrong rows on expand or collapse.
- fix: Use an unambiguous path encoding such as JSON-encoded key segments, or assign ids from a counter.

#### [MED][PERF] Prompt detection parses every visible line in full on every render, and the parser is quadratic in line length
- where: src/lib/terminal/ansi.ts:133-156 (per character: `text.slice(cursor)` plus three unanchored regex scans of the remainder); src/lib/terminal/output.ts:102-103 (full `ansiPlainText` before the 96-character cutoff); src/components/terminal/terminal-output.tsx:58 (`isPromptLine` called inside an unmemoized `renderLine`)
- what: Each character causes a scan of the rest of the line, so one 8 192-character line costs on the order of 10^8 character steps. `isPromptLine` parses the whole line before rejecting any line over 96 characters, and it runs for every visible row on each render.
- why: Minified or JSON output lines, which the MAX_LINE_LENGTH split is designed to keep, make scrolling and re-rendering the terminal pane slow.
- fix: Anchor the SGR and CSI matches at the cursor (sticky regex), and test the length or a cheap prefix before parsing in `isPromptLine`.

#### [MED][FAILURE] Terminal input is serialized per session with no backlog bound, so keystrokes queue and replay late
- where: src/lib/terminal/client.ts:172-179 (each send chains on the previous one); 195-208 (each send may take up to 15 s)
- what: Every `sendTerminalInput` waits for the previous send in its session to settle, and each one can run for the full 15 s timeout. The chain has no depth limit.
- why: When the gateway hangs, every keystroke typed in the meantime is queued and dispatched one at a time, minutes later. Stale input, including destructive commands, can reach the shell long after the operator typed it.
- fix: Cap the queue depth, fail fast when the transport is unhealthy, and drop or mark pending keystrokes when the chain stalls.

#### [MED][BUG] A streaming reply that ends in a terminator is spoken as a finished sentence, so "3.14" becomes "3" then "14"
- where: src/lib/voice/handsfree-reply.ts:145-156 (`next === undefined` at the end of a streaming text is treated as a boundary); src/context/handsfree-voice-provider.tsx:804-808 (`streaming: text.streaming` passed to the plan)
- what: The scan treats a terminator at the very end of the text as a sentence end. The "still inside something" check only applies when a following character exists, so it never runs while the reply is still streaming.
- why: The text "Version 3." is handed to the synthesizer as a complete sentence. The next delta "14 is out" is then spoken as a separate utterance, and the cursor has already moved past the dot, so the mistake is never corrected.
- fix: While `streaming` is true, do not accept a terminator that is last in the text as a boundary, and advance only on a following whitespace or a line break.

#### [LOW][BUG] A success result with a `message` string is flagged as a failure
- where: src/lib/terminal/json-tree.ts:79-83
- what: `record.error ?? record.message` treats any non-empty `message` as an error, and `jsonExitSignal` then marks the result failed with that text as the label.
- why: A successful RPC result that carries an informational `message` gets the failure accent in the command sheet.
- fix: Read only `error` (and `exitCode`/`ok` as they already are), and treat `message` as informational text.

#### [LOW][BUG] Long lines are split by UTF-16 units, which can cut an escape sequence or a surrogate pair
- where: src/lib/terminal/output.ts:36-43 (splitLine), applied at 73-84
- what: Continuation segments are cut at fixed character offsets with no regard for ANSI sequences or surrogate pairs.
- why: On a colored line over 8 192 characters, an SGR sequence is split and its tail (`1m...`) renders as text. An emoji split at the boundary becomes a lone surrogate.
- fix: Split on code-point and escape-sequence boundaries, or carry the ANSI state into each continuation line.

#### [LOW][FUNC] Prompt detection flags ordinary output that ends in a colon or percent sign
- where: src/lib/terminal/output.ts:110 (`/[\\/@:~]|\(.*\)/` returns true for any stem containing a colon)
- what: A line such as `CPU usage: 45%` or `Price: $` passes the stem test because of the colon, and is marked as a prompt.
- why: Prompt-accented lines are used to find where commands were entered. Output lines that look like prompts make that navigation point to the wrong lines.
- fix: Tighten the stem rule so that a colon alone does not qualify, or require a path, user@host or drive shape.

#### [LOW][PERF] The "no re-scan" digest still reads the whole settled prefix on every delta
- where: src/lib/voice/handsfree-reply.ts:235 (`prefixHash(input.fullText, settled)` on every plan); comment at 219-231 claims the cursor avoids re-reading the prefix
- what: The digest is recomputed over the entire settled prefix each time the plan runs, so the cost is still linear in the reply length per delta.
- why: The comment says resuming "does not cost the check", which is not true. Per-delta cost remains proportional to reply length, though with a small constant.
- fix: Keep the verified digest in the cursor and check only the newly settled characters, or drop the claim from the comment.

#### [LOW][PERF] Every partial transcript triggers an unthrottled storage write for recovery
- where: src/lib/voice/handsfree-recovery.ts:26-40 (saveHandsfreeRecovery); called per partial at src/context/handsfree-voice-provider.tsx:491 and 497
- what: Each partial result serializes the transcript and issues an async `setItem`, with no debounce.
- why: Partials arrive several times a second, so storage traffic and write load grow with speech rate and length. The writes are fire-and-forget, so their completion order is not guaranteed.
- fix: Debounce or throttle the recovery write, and flush it on final results and on teardown.

#### [LOW][QUALITY] Comment gives Spacing.four as 16, but the token is 24
- where: src/lib/terminal/rpc-insets.ts:3-4 (comment), 6 (literal 16); src/constants/tokens.ts:94 (`four: 24`)
- what: The comment says the base padding is `Spacing.four (16)`. The current token value is 24, and the literal was not updated.
- why: Future readers and tests that rely on the comment will reason from a value that no longer matches the design token.
- fix: Correct the comment, or derive the literal from the token once jest can import it.

#### [LOW][QUALITY] Docs say a failed reply ends the call, but the reducer reopens listening
- where: src/lib/voice/handsfree-reply.ts:49-52 (doc on isFailedReply); src/lib/voice/handsfree-session.ts:399-405 and 413-417 (`reply-failed` goes to `afterReply`, not an end)
- what: The doc says a failed reply "ends the call as `send-failed`". The reducer treats `reply-failed` as a recoverable turn that stops speech and reopens recognition.
- why: A reader of the doc will expect the wrong terminal behavior, which hides the recovery path this code actually has.
- fix: Update the doc to describe the reopen-listening behavior.

### src/lib/voice/voice-stream-protocol.ts ... src/components/app-lock-gate.tsx

#### [MED][BUG] Approval inbox per-row buttons stay enabled during a batch
- where: src/components/activity/approval-inbox.tsx:203, 210 (per-row `disabled={approvalBusy === row.approvalId}`); batch buttons at 223, 231 use `batchBusy`
- what: While `decideAll` loops over the captured id list, the per-row Approve and Deny buttons are only disabled for the row currently in `approvalBusy`. The batch flag is not applied to them.
- why: An operator can decide a row the loop has not reached yet. The row is then refused by the Gate when the loop reaches it, that refusal is counted in `batchFailure`, and the notice reports a failure for a decision the operator actually made.
- fix: Disable the per-row buttons with `batchBusy` as well, e.g. `disabled={batchBusy || approvalBusy === row.approvalId}`.

#### [MED][FUNC] Widget clear reaches only the Android card, so the iOS widget keeps names and the last result
- where: src/lib/widget/widget-device.ts:229-237 (`clearWidgetCard`); src/context/gateway-provider.tsx:6697 (caller on the no-gateway branch)
- what: `clearWidgetCard` calls only `loadAndroidWidgetModule()` and `clearPayload()`. On iOS nothing is cleared. `src/components/widget/glanceable-widget.tsx` exposes only `updateSnapshot`, with no clear.
- why: When the last gateway is removed, the provider calls `clearWidgetSnapshot()` so the card stops showing that gateway's Bot names and last result. On iOS those stay on the home screen, which is the exact leak the provider comment describes.
- fix: Add an iOS clear path (an empty snapshot or a widget reload) to `clearWidgetCard`, or state in the code that iOS is intentionally left stale.

#### [MED][BUG] A companion push and an app snapshot coalesce away each other's queued write
- where: src/lib/widget/widget-device.ts:169-180 (`enqueueWidgetJob` drops the newest queued job of kind 'write'); src/lib/widget/widget-push-task.ts:173 (`handleWidgetPush` uses `enqueueWidgetWrite`, which also creates kind 'write', at widget-device.ts:123-127)
- what: Any new 'write' job resolves the queued 'write' job with `false` and removes it. Push writes and app snapshot writes share that kind, so each can evict the other.
- why: A push evicted by a later app write resolves false and is never re-offered, so its work line and approval count are lost (the Gate does not resend). The header of widget-push-task.ts (lines 170-173) says pushes must not be overtaken or dropped by snapshot writes.
- fix: Give push jobs their own kind that is never coalesced with app snapshots, so only snapshot writes coalesce with each other.

#### [MED][FUNC] Cron run rows read "completed" for runs that errored
- where: src/components/activity/cron-job-sheet.tsx:310-314; type at src/lib/gateway/cron.ts:50-59 (`CronRun.error`)
- what: The run subtitle is `running` or `completed` only. `CronRun.error` is declared but never read by any cron component.
- why: A scheduled run that failed reads as a success with only its turn count, so an operator sees no failure on the run history.
- fix: Show the run's error (e.g. a `failed` word and the message) in the subtitle when `run.error` is set.

#### [MED][FUNC] Routine title filter becomes a dead end when the list shrinks to three jobs or fewer
- where: src/components/activity/cron-section.tsx:167-169 (filter applied with no count gate), 223 (`if (jobs.length > 3)` hides the field and its Clear button at 233-239)
- what: The `titleFilter` still narrows `sorted` after the list drops to three or fewer jobs, but the field and the "Clear" button that render it live inside the `jobs.length > 3` block.
- why: If a filter is set and a job is removed or stops appearing, the list shows a filtered subset with no visible filter and no way to clear it.
- fix: Gate the filter application on the same condition as the field (`jobs.length > 3`), or render the field and Clear button regardless of count.

#### [LOW][BUG] Approval decision timer is never cleared, and the resolver is not keyed to the run
- where: src/components/activity/approval-decision-card.tsx:72 (`setTimeout(() => onResolve(...), duration)`, no cleanup); src/app/(tabs)/activity.tsx:214-218; src/context/gateway-provider.tsx:4598-4602 (`resolveRunApproval` calls the single shared `runApprovalResolverRef`)
- what: The decision is sent after the exit animation by a timer that is never cancelled on unmount. The callback resolves whichever approval is currently pending through the shared ref and takes no run id.
- why: If a different run's approval becomes pending during the animation window, the operator's decision for run A resolves run B. A timer that fires after unmount still runs the callback.
- fix: Clear the timer in a cleanup and pass the card's `runId` through `resolveRunApproval` so the resolver only answers the matching run.

#### [LOW][BUG] A companion push without `result` wipes the card's last result, unlike the other fields it falls back on
- where: src/lib/widget/widget-push-task.ts:131 (vs. fallbacks at 128-130 and 133)
- what: `work` and `approvalsPending` fall back to `last` when the push omits them, but in the non-stale path `result` becomes `undefined` when the push omits it.
- why: A push that carries only a work line clears the last judged result from the card. The header (lines 2-12) says merging exists so an omitted key does not wipe the card.
- fix: Fall back to `last?.result` the same way `work` does, or document that a push clears the result on purpose.

#### [LOW][PERF] Scorecard per-card folds run on every render, outside the memo
- where: src/components/activity/scorecards-section.tsx:321-327 (per-card `filterRunsByBot`, `medianRunMs`, `scorecardApprovals`, copy builders); only `buildScorecards` is memoized at line 178
- what: Each card rescans the whole device run list and recomputes its line on every render, including the renders caused by the weekly-report switch and the focus refresh.
- why: The cost grows with bots times runs on each render of a surface that re-renders often.
- fix: Compute each card's rows and facts inside the `useMemo` keyed on `runs`, `routineHealth` and `spendRows`.

#### [LOW][QUALITY] Superseded-read guard in CronSection can never be true
- where: src/components/activity/cron-section.tsx:86, 90, 93 (`id !== requestId.current`)
- what: `load()` joins any read still in flight (lines 73-74), so a new `requestId` is only minted when no read is outstanding. The `id !== requestId.current` checks therefore never fire.
- why: The comment at lines 67-69 claims a superseded read is kept from painting. The branches are unreachable, which misleads later edits into thinking the race is guarded.
- fix: Remove the dead guard and the `requestId` ref, or keep it and correct the comment.

### src/components/avatar/bot-figure.tsx ... src/components/chat/chat-roster.tsx

#### [MED][PERF] Every colour-wheel drag tick rebuilds the ring art and the whole studio
- where: src/components/avatar/colour-wheel.tsx:89-112 (WheelArt), colour-wheel.tsx:138-156 (onChange path); src/components/avatar/look-studio-sheet.tsx:118, 161, 223-250
- what: WheelArt is a plain component that depends only on `size`, but it is re-rendered on every drag move and regenerates 240 sector path strings each time. Each move also calls `onChange`, which runs `setDraft` in Studio; Studio builds a new `look` object and re-renders the form and face rails (about 18 BotFigure tiles, each with its own Svg gradients).
- why: The wheel is the primary interaction, and every pointer move redoes all of this work on the JS thread, so drag stutters on mid-range Android phones.
- fix: Memoise WheelArt on `size`, memoise the rail tiles on their props, and keep the in-flight drag hues local to the wheel, committing to Studio state only on release or on a throttled tick.

#### [MED][FAILURE] "Keep this look" reports success even when the write to storage failed
- where: src/components/avatar/look-studio-sheet.tsx:142-146 (keep), look-studio-sheet.tsx:143 (await saveBotLook); src/lib/avatar/look-store.ts:90 (setItem swallowed by `.catch(() => undefined)`)
- what: saveBotLook updates the in-memory map and then swallows any setItem error, so `keep()` always resolves. The studio then fires `haptics.success()` and closes.
- why: If persistence fails (storage full or unavailable), the operator sees a success, the look holds for this session only, and on the next launch the Bot silently reverts to its natural look.
- fix: Have saveBotLook return a boolean, as saveApprovalPolicies does, and keep the sheet open with a line of copy when it returns false.

#### [MED][FAILURE] Toggling one Bot's auto-approve can erase every other Bot's opt-in on a transient read error
- where: src/components/chat/bot-approval-policy.tsx:47-48; src/lib/gateway/approval-policy.ts:97-98 (loadApprovalPolicies returns `{}` on any failure)
- what: toggle() loads the whole policy map, sets this Bot's key, and saves the map back. When the load fails or the stored JSON is unreadable, the load returns `{}`, so the save writes back only this Bot's entry.
- why: Every other Bot's stored auto-approve choice on the device is silently deleted. The direction is fail-safe (less auto-approval), but the operator loses settings with no message.
- fix: Let loadApprovalPolicies distinguish "no data" from "unreadable" (for example return null), and refuse the save when the read was unreadable.

#### [LOW][BUG] Roster preview cuts the Bot's purpose at any dot, not only at sentence ends
- where: src/components/chat/chat-roster.tsx:103-104
- what: The first-sentence regex `/^[^.!?]+[.!?]?/` stops at the first `.`, so a version number or abbreviation ends the line early.
- why: A description such as "Ships v1.2 releases." shows as "Ships v1" in the roster row, and "Runs on node.js tasks" shows as "Runs on node". This happens whenever the Bot is routable and has a description.
- fix: Split only on a full stop followed by whitespace or end of string, for example `/^.*?[.!?](?=\s|$)/`.

#### [LOW][FUNC] Group crest initials come from the Bot id, not its display name
- where: src/components/chat/bot-avatar.tsx:110-111 (GroupMember calls `useBotLook(botId)` with no name); src/components/chat/bot-avatar.tsx:73-80 (GroupAvatar takes only memberIds); src/components/chat/chat-roster.tsx:291; compare chat-roster.tsx:329 and src/components/chat/bot-panel-sheet.tsx:52, which pass the display name; src/lib/bot-avatar.ts:195 (`botInitial(displayName?.trim() || botId)`)
- what: A solo avatar derives its monogram initial from displayName, but a group crest member has no name, so the initial falls back to the id.
- why: For monogram-face Bots, the same Bot shows a different letter in a room crest than in its solo avatar whenever the id does not start with the display name's letter (for example id "hermes-forge" shows "H" where the name "Forge" shows "F").
- fix: Pass display names into GroupAvatar (or resolve them from the fleet snapshot inside GroupMember) so the initial matches the solo avatar.

#### [LOW][FUNC] The colour wheel's accessible container hides its centre button from screen readers
- where: src/components/avatar/colour-wheel.tsx:201-206 (outer View sets `accessible`, role adjustable); src/components/avatar/look-studio-sheet.tsx:162-172 (PressableScale "as it will look", rendered as a child of the wheel at colour-wheel.tsx:246-253)
- what: The wheel's container is `accessible`, which merges its children into one element on iOS and Android, so the centre PressableScale (the "touch it and it lights up" button) is no longer focusable on its own.
- why: A VoiceOver or TalkBack user cannot reach the reaction control, and the wheel's adjustable label ("Colour") does not announce it.
- fix: Make the wheel an adjustable element without `accessible` grouping of its children, or give the centre control its own accessibility focus outside the grouped container.

#### [LOW][PERF] Idle Bot figures run two infinite loops and a blurred aura whose output is zero at rest
- where: src/components/avatar/bot-figure.tsx:158-159 (`cycle` and `pulse` repeat forever on every live figure); bot-figure.tsx:185-186 (pulse only enters the aura multiplied by `think`, which is 0 at rest); bot-figure.tsx:212-229 (aura View with a blurred boxShadow is rendered for every live figure); `cycle` is read only by VisorFace (line 447) and StarryFace (line 587)
- what: Every live figure starts `cycle` and `pulse` infinite animations and mounts a shadowed aura, even when the figure is idle and neither the aura nor `pulse` is visible.
- why: A roster with many visible rows (the list is windowed, but dozens of rows can still mount) keeps several UI-thread animation drivers and a blurred shadow layer per row running for no visible effect.
- fix: Start `pulse` only while `mood === 'thinking'`, start `cycle` only for the visor and starry faces, and skip the aura view when it would render at zero opacity.

#### [LOW][BUG] Hold-to-talk teardown is keyed on the text callback's identity, not on unmount
- where: src/components/chat/chat-composer.tsx:269-278 (effect with deps `[onChangeText]`)
- what: The cleanup that retires the live recognizer and marks the hold released runs on every change of the `onChangeText` identity, not only when the composer unmounts. The comment states the intent as "a hold that outlives this composer".
- why: Today the only caller passes a stable setter (src/components/chat/chat-screen.tsx:2945, `onChangeText={setDraft}`), so nothing fires. Any future caller that passes an inline handler would cancel the recognizer on every parent render during a hold.
- fix: Keep the unmount-only cleanup in an effect with `[]` deps and read the latest callback through a ref.

#### [LOW][QUALITY] The iOS and shared ChatEmptyState implementations have diverged
- where: src/components/chat/chat-empty-state.ios.tsx:21-30; compare src/components/chat/chat-empty-state.tsx:27-48
- what: The iOS variant has no brand mark, no hero or rule layout, and no secondary row; its "Go to Home" action uses a SwiftUI button while the shared variant uses the kit Button for every action. The two files take the same props.
- why: The same empty state looks and behaves differently on iOS and on other platforms, and a change to one copy will not reach the other.
- fix: Move the shared layout into one component and keep only the native ContentUnavailableView as a platform-specific piece inside it.

### src/components/chat/chat-screen.tsx

#### [MED][BUG] Photo picker result can land in a different thread's composer
- where: src/components/chat/chat-screen.tsx:1359-1391 (handleAttach), 754-759 (clear on thread change), 744-749 (stated rule)
- what: `handleAttach` awaits the OS picker and then appends `picked.attachments` with no check that the thread is still the one the picker was opened for.
- why: The clear effect at 754-759 runs only when `attachmentsThread` changes, which is before the picker resolves. If the surface changes while the picker is open (for example a Bot Chat requested by a quick-reply or deep link, gateway-provider.tsx:6852-6856, or `showSurface`), the photos are appended to the new thread's composer and sent with its turn. The comment at 744-749 says this must never happen.
- fix: Capture the thread key before launching the picker and drop the picked assets if `draftThread` has changed when the promise resolves.

#### [MED][BUG] Auto-dismiss timer for the error banner is not restarted when the error changes
- where: src/components/chat/chat-screen.tsx:345-395 (LastErrorBanner; effect deps at 391-395), 2619-2627 (mount with no key)
- what: The effect that schedules the 12 s dismissal depends only on `[selfClearing, onDismiss]`, not on `error`. The banner is mounted at one position with no key.
- why: If a second dismissible error replaces the first while the banner is mounted (the provider sets `lastError` directly, gateway-provider.tsx:1722), the first timer keeps running and clears the new error after whatever time remains on it, which can be under a second.
- fix: Add `error` to the effect deps or key the banner by error identity so each error gets its own timer.

#### [MED][PERF] Wide spend read is issued even after the effect has been cancelled
- where: src/components/chat/chat-screen.tsx:2092-2117, especially 2106-2113
- what: After the narrow `sessions.list` read resolves, the effect stamps `spendWideAtRef` and sends the 200-row `sessions.list` without checking `cancelled`. The `cancelled` guard exists only in `applyRead` (2080).
- why: When the operator leaves the thread, or a finished turn re-runs the effect through `spendEffectKey` (1782-1784), the wide read still goes to the single-threaded Gate for a surface whose result is then discarded. The stamp then suppresses the wide read the current thread is owed for `THREAD_SPEND_WIDE_MIN_READ_MS`.
- fix: Check `cancelled` after the narrow read and before stamping `spendWideAtRef` or issuing the wide request.

#### [LOW][FUNC] Copy-failure notice stays on screen after the error banner is gone
- where: src/components/chat/chat-screen.tsx:537, 2625, 2629-2633
- what: `copyNotice` is rendered whenever it is set, regardless of `lastError`. It is cleared only by a later successful copy.
- why: After the banner is dismissed (`clearLastError`, or the 12 s self-clear at 343/393), the line "The details could not be copied to the clipboard..." keeps showing with no banner it refers to.
- fix: Clear `copyNotice` when `lastError` becomes null, or render the notice inside the banner.

#### [LOW][QUALITY] Per-Bot read logic is hand-copied in each effect and each retry handler, and the copies differ
- where: src/components/chat/chat-screen.tsx:572-589 vs 590-603 (soul); 1923-1951 vs 1823-1846 (routines); 1973-2003 vs 1953-1971 (skills); 2030-2067 vs 2005-2028 (toolsets)
- what: Each Bot-scoped fetch-and-fold is written twice: once in a mount effect with a `cancelled` guard, and again in a `useCallback` retry handler without one.
- why: Any change to the read or the fold must be made in both copies, and they have already drifted (only the effects guard against stale results). This is the kind of duplication that lets a fix land in one path and not the other.
- fix: Move each fetch-and-fold into one helper that takes an `isCurrent` callback, and have both the effect and the retry call it.

### src/components/chat/command-history-section.tsx ... src/components/chat/skills-pane.tsx

#### [MED][FUNC] Create-group copy promises up to 3 rounds, but a send runs one round
- where: src/components/chat/create-group-sheet.tsx:67; src/lib/gateway/groups.ts:14 (`GROUP_ROUNDS_ON_SEND = 1`) and groups.ts:304 (comment: a phone send is a single round)
- what: The sheet tells the operator "every member replies in turn, up to 3 rounds", while the send path plans with `maxRounds` defaulting to 1.
- why: Operators are told a message can produce three rounds of replies and get one. The copy contradicts the behaviour the outcome line reports.
- fix: Change the copy to describe a single round, or derive the text from `GROUP_ROUNDS_ON_SEND`.

#### [MED][BUG] New Agent form keeps the previous draft after a successful create or edit
- where: src/components/chat/new-agent-sheet.tsx:80-88 (`reset()`, called only from BaseSheet `onClose` at 95-98); src/components/chat/chat-screen.tsx:2391-2392 (sheet always mounted, key `'create'`) and chat-screen.tsx:2415 (success path sets `setNewAgentVisible(false)` without reset)
- what: `reset()` runs only when the user dismisses the sheet. A successful submit hides it from the parent, the component stays mounted with the same key, and its name, description, soul, model and provider state survive.
- why: The next "New Agent" opens prefilled with the last Bot's name, so tapping Create again tries to create a duplicate profile. The edit sheet similarly keeps stale draft values for that Bot's key.
- fix: Reset the form whenever `visible` goes from true to false (or on successful submit) rather than only in the dismiss handler.

#### [MED][BUG] Routine add wipes what the operator types while the add is in flight
- where: src/components/chat/routines-pane.tsx:97-111 (submitCreate); :200-202 (title, schedule and prompt TextFields have no `editable={!busy}`); src/lib/gateway/routines.ts:40-47 (applyRoutineCreate)
- what: Fields stay editable while `creating` is true. On success, `applyRoutineCreate` blanks title and prompt; on failure it restores the submitted values. Either way the text typed during the request is overwritten.
- why: A slow create (a network round-trip) followed by a typed next routine loses that text, or on refusal reverts it to the old submission.
- fix: Disable the inputs while creating, or only clear/restore a field if its value still equals the submitted one.

#### [MED][BUG] Single `*` is treated as italic with no word boundary
- where: src/components/chat/markdown/parser.ts:121-136 (`boundaryOk = marker === '*' || ...`)
- what: The italic branch opens on any `*` and closes on the next `*`, so "2 * 3 * 4" becomes "2 " + italic " 3 " + " 4" with the asterisks removed. The `_` branch has a boundary check but `*` does not.
- why: Arithmetic and glob-like text in model replies is mis-rendered as emphasis and loses its asterisks. Users see changed text, not just styling.
- fix: Apply CommonMark-style flanking rules to `*`: no opener followed by whitespace, no closer preceded by whitespace.

#### [MED][BUG] Double underscores in identifiers are parsed as bold
- where: src/components/chat/markdown/parser.ts:93-107 (bold branch for `__` has no boundary check)
- what: `__` opens bold anywhere, so "__init__.py" outside backticks becomes "init" in bold with both underscore pairs removed.
- why: Python dunder names and similar identifiers in prose are altered in displayed text, and the change is silent.
- fix: Require the same word boundary for `__` as the `_` italic branch uses, or only treat `__` as bold when it is preceded by whitespace or start of text.

#### [MED][BUG] Ordered lists always renumber from 1
- where: src/components/chat/markdown/markdown-text.tsx:94 (`${index + 1}.`); src/components/chat/markdown/parser.ts:223-236 (the list block stores no start number)
- what: The parser keeps only `ordered` and `items`; the renderer labels items from 1. A list resumed after a code block or paragraph ("1. 2. [code] 3. 4.") is shown as "1. 2. ... 1. 2.".
- why: LLM replies often interleave lists with code blocks, so visible step numbers are wrong and the reader loses the sequence.
- fix: Record the first item's number on the list block (`start`) and offset the rendered label by it.

#### [LOW][BUG] Four-backtick fences close on the first three-backtick line
- where: src/components/chat/markdown/parser.ts:166-181 (closer is `fenceChar.repeat(3)` at 169; search at 171)
- what: The closing fence is matched against a fixed three-character string, ignoring the opener's length. A ````-fenced block containing a line that starts with ``` ends early, and the rest of the block renders as prose.
- why: Code samples that show fenced code inside a longer fence render broken. The case is uncommon but produces wrong output with no error.
- fix: Store the opener's run length and close only on a fence line with at least that many fence characters.

#### [LOW][QUALITY] Misleading name for the streaming flag in the activity toggle
- where: src/components/chat/message-bubble.tsx:60 (`const activitySettled = !!message.streaming;`), used at 61 and 129
- what: `activitySettled` is true while the message is still streaming, which is the opposite of what the name says. The toggle at 129 depends on that inverted meaning.
- why: The next change to this logic is easy to get backwards because the name contradicts the value.
- fix: Rename to `isStreaming` (or `isLive`) and state the open-by-default rule in terms of it.

#### [LOW][QUALITY] Dead and overridden styles in the room view
- where: src/components/chat/group-room-view.tsx:873 (`scopeNote: {}`), :887 (`memberChipPin: { maxWidth: 120 }`, overridden inline at 578, 582 and 586 by `memberPinMaxWidth`), :902 (`metaLine: {}`)
- what: Three style entries are empty or never win: the empty objects are unused by any render path, and `memberChipPin.maxWidth` is always replaced by the inline style.
- why: The static value suggests a bound that the inline style actually sets, which misleads anyone tuning chip widths.
- fix: Delete the unused entries and keep the single source of the chip max width.

#### [LOW][PERF] Inline-code scan copies the rest of the message for every backtick
- where: src/components/chat/markdown/parser.ts:63 (`text.slice(i).match(/^`+/)`)
- what: At each backtick the parser slices the remaining input before matching the run length, so the work is proportional to the length of the message for every backtick it sees.
- why: On long replies with many backticks the parse does quadratic copying. It runs once per completed message, so the cost is modest but unnecessary.
- fix: Count the run length by scanning forward from `i` (or use a sticky regex with `lastIndex`) instead of slicing the string.

### src/components/chat/slash-command-palette.tsx ... src/components/gateway/environment-card.tsx

#### [MED][BUG] Connected toast can stay up after the gateway drops
- where: src/components/connected-toast.tsx:33-49
- what: The effect's cleanup clears the 2 s hide timer on every re-run, and the re-run path returns early without re-arming it. The effect re-runs whenever `status`, `activeGateway` or `activeHello` change.
- why: If the status leaves `connected` (or `activeGateway`/`activeHello` is replaced) inside the 2 s window, the timer is cleared and `visible` stays true. The toast then keeps reading "gateway online" while disconnected until the next connect transition.
- fix: Keep the hide timer in its own effect keyed on `visible`, or set `visible` to false in the cleanup path when the status is no longer `connected`.

#### [LOW][FUNC] ExternalLink drops the caller's onPress and leaves openBrowserAsync rejections unhandled
- where: src/components/external-link.tsx:11-22
- what: `{...rest}` is spread before `href` and `onPress`, so the component's own `onPress` replaces any `onPress` the caller passes. The async `onPress` also awaits `openBrowserAsync` with no try/catch.
- why: A caller's press handler never runs, with no error. A rejected `openBrowserAsync` becomes an unhandled promise rejection from the link tap.
- fix: Destructure `onPress` out of props, call it inside the handler, and wrap the browser open in try/catch.

#### [LOW][QUALITY] ExternalLink is dead code
- where: src/components/external-link.tsx:7
- what: A repo-wide search finds no importer of `ExternalLink` outside its own definition.
- why: The component carries the onPress and native-browser logic above with no consumer, so that logic is never exercised.
- fix: Delete the file, or wire it to the call sites that need an in-app browser.

#### [LOW][BUG] Context-size label rounds to wrong values
- where: src/components/chat/thread-config-sheet.tsx:106-110
- what: `formatContext` divides by 1000 and rounds, so 1500 renders "2k ctx" and 1,000,000 renders "1000k ctx".
- why: Any model with a context of 1M or a non-round count shows a misleading size in the Models list.
- fix: Use one decimal for thousands and switch to "M" at 1,000,000.

#### [LOW][FUNC] Edit on an instance whose kind is not registered does nothing visible
- where: src/components/gateway/capabilities-section.tsx:96-111 and :234
- what: `startEdit` sets `draft` from the instance even when `kinds` has no matching entry. The form is rendered only when `draft && selectedKind`, so the draft is set but the list stays on screen.
- why: Tapping an instance whose kind is missing from the registry gives no feedback, and the instance cannot be edited. `saveDraft` also returns silently at line 122 in the same state.
- fix: Show an explicit "kind not available" message from `startEdit` instead of setting a draft that never renders.

#### [LOW][BUG] Native Skia canvas ignores the documented square default for height
- where: src/components/fleet/constellation-canvas.native.tsx:100-102 and :127-128; compare src/components/fleet/constellation-canvas-fallback.tsx:33
- what: The fallback computes `height ?? size`, but the native path passes `height` through as undefined to its `<View>` and `<Canvas>` style. `ConstellationView` (constellation-view.tsx:88) passes only `size`.
- why: The layout is computed for a square box while the Skia canvas gets no explicit height, so the map area depends on Skia's default sizing and can differ from the fallback.
- fix: Default `height` to `size` in `SkiaConstellation`, as the fallback does.

#### [LOW][QUALITY] Dead maxHeight on the palette list style
- where: src/components/chat/slash-command-palette.tsx:208 and :126
- what: `styles.list` sets `maxHeight: 380`, but the list is always rendered with an inline `{ maxHeight: listMaxHeight }` that overrides it.
- why: The static 380 is never applied, which misleads anyone tuning the palette height.
- fix: Remove `maxHeight` from `styles.list`.

#### [LOW][QUALITY] Any wss:// gateway is labelled "Tailscale/TLS"
- where: src/components/gateway/compact-gateway-list.tsx:78-81
- what: `secureLabel` returns "Tailscale/TLS" when `url` starts with `wss://`, even when the gateway is not on Tailscale.
- why: A TLS gateway reached over a non-Tailscale host is shown with the wrong transport label on the dashboard.
- fix: Label `wss://` as "TLS" and reserve "Tailscale" for `discoverySource === 'tailscale'`.

### src/components/gateway/environment-registration-form.tsx ... src/components/glass-collapsible.tsx

#### [MED][BUG] Cancel during the start window cancels the wrong run and orphans the new one
- where: src/components/gateway/environment-run-launcher.tsx:250-265 and :284-293
- what: start() calls retire() and sets running=true, but never clears activeRunId before awaiting client.startRun. cancel() then reads the stale activeRunId (the previous run, or null) and calls cancelRun on it. When startRun resolves, the token no longer matches (line 264) so the new run is never followed or cancelled.
- why: Tapping "Cancel run" while a run is starting leaves the new Gate run executing with no way to stop it from this sheet, and the UI flips back to idle. It can also send a cancel to an already-finished earlier run.
- fix: Clear activeRunId at the top of start(), and have cancel() during startup await the startRun result and cancel that run id.

#### [MED][FAILURE] Cancel-run failure is swallowed and the UI reports the run as stopped
- where: src/components/gateway/environment-run-launcher.tsx:288-292
- what: `client.cancelRun(...).catch(() => undefined)` discards the rejection, then setRunning(false) and refreshRuns() run as if the cancel succeeded.
- why: If the Gate refuses or cannot be reached, the sheet returns to "Start run" while the run keeps going on the Gate, with no error shown to the operator.
- fix: Catch the error, keep running state, and surface the cancel refusal through setError like the other actions in this sheet.

#### [MED][BUG] addGateway rejection in the discovered-gateway add path is unhandled
- where: src/components/gateway/gateway-home-dashboard.tsx:118-123 (wired at :205); same pattern in src/hooks/use-gateway-settings-screen.ts:124-129 (used by gateway-management-section.tsx:105)
- what: handleAddDiscovered awaits addGateway(...) outside any try/catch. The try only wraps connectGateway (lines 125-130). addGateway's storage write (gateway-provider.tsx:3717-3729) can reject.
- why: A failed save of a discovered gateway produces an unhandled promise rejection and no message on screen, the same silent failure the file's own comments say was fixed for deleteGateway and connectGateway.
- fix: Wrap the addGateway call in the same try/catch as connectGateway and route the error into setConnectFailure.

#### [MED][FAILURE] TLS approval rejections are discarded and the sheet has already closed
- where: src/components/gateway/tls-fingerprint-guard.tsx:21 (provider: src/context/gateway-provider.tsx:6034-6045; sheet haptic: src/components/gateway/tls-fingerprint-change-sheet.tsx:105-108)
- what: The guard calls `void approveTlsFingerprintChange()`, which clears tlsFingerprintChange (line 6041) before awaiting upsertGateway and attachClient with no try/catch. The sheet closes on the cleared state, and the rejection is dropped by `void`. The success haptic also fires before the approve completes.
- why: If persisting the trusted fingerprint or reconnecting fails, the user sees the sheet dismiss and the gateway simply stays disconnected, with an unhandled rejection and no message.
- fix: Await the approval in the guard, keep the sheet open on failure and show the error, and fire the success haptic only after the approval resolves.

#### [LOW][BUG] Double tap on Revoke sends two device.revoke calls and leaves a stale error
- where: src/components/gateway/paired-devices-pane.tsx:65-79, :144-155 (revoke button :134)
- what: ConfirmSheet is given no `busy` prop and executeRevoke has no in-flight guard, unlike the delete flow in gateway-home-dashboard.tsx:251-253. The second call's catch (line 77) sets revokeError for "unknown id", and the open path at line 134 never clears revokeError.
- why: A quick double tap sends two revokes; the second fails after the first succeeded, and its error text is shown as the message on the next Revoke sheet opened for a different device.
- fix: Add a ref-based in-flight guard and pass `busy` to ConfirmSheet, and clear revokeError when a target is chosen.

#### [LOW][QUALITY] "Not offered" count includes undeclared groups the comment says are not capabilities
- where: src/components/gateway/gateway-capabilities.tsx:14-16, :21-24, :26, :51-55
- what: The comment says undeclared groups "are not capabilities the connected one lacks", but `otherGroups` filters from the full `groups` (which includes status 'undeclared') and `hiddenCount` is computed from `groups.length`. The toggle therefore reads "Show N not offered" counting undeclared groups.
- why: The label overstates how many capabilities the gateway lacks, contrary to the rule the same file states for the ratio.
- fix: Derive otherGroups and hiddenCount from `counted` (declared groups only), or drop undeclared groups from the toggle as well.

#### [LOW][QUALITY] Home capability count uses a status value that no group can have
- where: src/components/gateway/gateway-home-dashboard.tsx:96-102 (status type at src/lib/gateway/types.ts:417)
- what: The filter checks `['available', 'ready', 'fresh']`, but 'fresh' is not in the GatewayCapabilityGroup status union (types.ts:417). It belongs to the snapshot-level status at types.ts:425.
- why: The dead literal suggests a rule the data never satisfies, and the home count rule is not the same as the one used in gateway-capabilities.tsx:17-18 (ready or available only).
- fix: Remove 'fresh' and share one predicate for "ready capability" between the home stat and GatewayCapabilities.

#### [LOW][PERF] Each streamed event copies and re-folds the full run transcript
- where: src/components/gateway/environment-run-launcher.tsx:228 and :109
- what: Every event runs `setEvents((current) => capRunEvents([...current, event]))`, which copies up to 2000 events, and `useMemo` re-runs `environmentRunView(events)` over the whole array on each change.
- why: Work per event is linear in the run length, so a chatty run costs roughly quadratic total work while the sheet re-renders on every frame.
- fix: Batch incoming frames (e.g. flush every animation frame) and fold incrementally rather than recomputing from the full array.

#### [LOW][FAILURE] OAuth attempt poll retries forever on non-terminal errors
- where: src/components/gateway/providers-section.tsx:73-104 (return true at :93; interval from src/lib/gateway/provider-oauth.ts:9)
- what: pollOnce returns true for any error that is not "unknown attempt" or "poll unsupported", so schedule() reschedules a fixed 3 s poll with no retry cap or backoff.
- why: If the Gate stays unreachable while the sheet is open, the phone keeps polling every 3 s with no limit and no message beyond the stale "Continue authorization" text.
- fix: Count consecutive failures, back off, and stop after a limit with a visible message.

#### [LOW][FAILURE] Failure to open the authorization browser is swallowed
- where: src/components/gateway/oauth-progress-sheet.tsx:31
- what: `WebBrowser.openBrowserAsync(authorizationUrl).catch(() => undefined)` discards any rejection.
- why: The "Open in browser" button does nothing visible when the browser cannot open, so the user is stuck on the sheet with no way to know the authorization did not start.
- fix: Catch the error and show a short message in the sheet, or fall back to showing the URL to copy.

#### [LOW][QUALITY] Collapsible toggle has no button role or expanded state
- where: src/components/glass-collapsible.tsx:21-31
- what: The heading PressableScale sets no accessibilityRole or accessibilityState, while sibling toggles in this chunk set both (gateway-home-dashboard.tsx:313-320, provider-card.tsx:63-68, gateway-capabilities.tsx:45-49).
- why: Screen-reader users cannot tell that the Diagnostics and other collapsible headings are buttons or whether they are expanded.
- fix: Add accessibilityRole="button", accessibilityLabel with the title, and accessibilityState={{ expanded: isOpen }}.

#### [LOW][QUALITY] Home dashboard duplicates the gateway delete and connect-failure state machine
- where: src/components/gateway/gateway-home-dashboard.tsx:59-71, :241-271 (duplicated in src/hooks/use-gateway-settings-screen.ts, consumed by src/components/gateway/gateway-management-section.tsx:15-35)
- what: The home dashboard reimplements deleteCandidate, deletePending, deletePendingRef, deleteFailure, and connectFailure handling that the settings hook already provides, with the same copy.
- why: Two copies of the same confirm-and-delete logic can drift, which has already happened: the hook's version and the home version handle addGateway and connect failures differently.
- fix: Move the delete and connect-failure logic into one hook and consume it from both screens.

### src/components/home-briefing-card.tsx ... src/components/ui/EmptyState.tsx

#### [MED][FAILURE] Transient WebGL context loss permanently drops the web stage to the CSS fallback
- where: src/components/layout/stage-gl.ts:75, 110-112, 175-179 (tick calls onUnavailable when draw fails); src/components/layout/AmbientCanvas.web.tsx:42, 49, 69 (unlit is only ever set true)
- what: While the context is lost, build() returns null and draw() returns false, so tick() calls entry.onUnavailable(), which sets unlit=true. The component then replaces the canvas with CssLamp and nothing ever sets unlit back to false.
- why: When the browser restores the context (handler at stage-gl.ts:57-60 wakes the loop), the canvas is already unmounted, so the stage stays a flat gradient for the rest of the component's life, and the entry keeps drawing into a detached canvas. Triggers on GPU resets or mobile browser context loss.
- fix: Treat a lost context as a pause rather than unavailability (skip onUnavailable while gl.isContextLost()), or remount the canvas and reset unlit on webglcontextrestored.

#### [MED][BUG] Drawer keeps the previous gateway's Bot roster after a gateway switch
- where: src/components/nav/side-drawer-content.tsx:543 (team state), 582-597 (cached paint only overwrites when a cache exists for the new gateway), 599-640 (live read overwrites only on success), 668-684 (openTeammate)
- what: `team` is never cleared when gatewayId changes. The cache effect only replaces it if a roster is cached for the new gateway, and the live read replaces it only on success.
- why: After switching gateways, the drawer lists the old gateway's Bots until the new read lands. If that read fails, the old rows stay beside the error note. Tapping one calls openBot with a Bot id from another gateway.
- fix: Reset team and teamNote when gatewayId changes (or key the state by gatewayId) before the cache and live reads run.

#### [MED][BUG] Shell session open is not in-flight aware, so a mode switch during open leaks a stream
- where: src/components/terminal/terminal-screen.tsx:94-132 (startTerminal; sessionRef assigned only after the await at 124), 147-153 (start effect guarded only by !sessionRef.current), 139-145 (cleanup closes only an already-assigned session)
- what: Switching Shell to RPC and back to Shell (or a status or activeGateway identity change) while the first openTerminalSession is still pending re-runs the effect, which sees sessionRef still null and opens a second session. Both resolve; the second assignment overwrites the first without closing it.
- why: The first SSE stream stays open on the gateway, and its output keeps appending into the same pane through the shared appendOutput. If the gateway changes during the await, the old gateway's session is assigned after cleanup has already run and stays open.
- fix: Track a pending-open ref. Ignore a second start while one is in flight, and when the await resolves, close the new session if the gateway or request token changed.

#### [MED][PERF] JSON command results in the inline card are not height-capped, which defeats virtualization
- where: src/components/terminal/command-result-view.tsx:40-50 (JSON branch ignores the preview flag; the cap at 27-33 applies only to text); src/components/terminal/json-view.tsx:55-68 (FlatList with no height bound); src/components/terminal/terminal-screen.tsx:432-441 (JSON rendered inside the outer FlatList cell)
- what: A preview result that parses as JSON renders a full JsonView FlatList with no maxHeight inside the outer FlatList's single item, so the inner list has no viewport bound.
- why: A large gateway JSON result (for example a long session list) mounts every row, and the nested virtualized lists lose their windowing. The text path has the cap; the JSON path does not, so the two behave inconsistently.
- fix: Apply the same maxHeight and nestedScrollEnabled wrapper to the JSON branch when preview is true.

#### [LOW][BUG] JsonView keeps the previous result's expansion state
- where: src/components/terminal/json-view.tsx:31-35 (initial computed by useMemo, but useState(() => initial) only uses it on mount); src/components/terminal/terminal-screen.tsx:420-421 (keyExtractor fixed to 'result', so the same JsonView instance is reused for each new result)
- what: The `initial` expansion set is recomputed for each new root but never applied after mount, and the list item keeps its key, so the view stays mounted across commands.
- why: The second command's tree opens and collapses according to the first command's manual toggles, and maxDepth is ignored.
- fix: Key JsonView by result content, or reset expanded when root changes.

#### [LOW][FUNC] Copy feedback is shared by both command rows and the reset timer is never cleared
- where: src/components/pairing-panel.tsx:89-95 and 102-108 (both rows use kind="cmd"), 35-36 (Copied label), 56-61 (setTimeout at 60, never cleared)
- what: Both command rows share one kind, so copying one shows "Copied" on both. Each copy schedules a 2 s reset that is not cleared on unmount or on a new copy.
- why: The operator sees confirmation on the row they did not copy. A second copy inside 2 s is cleared early by the first timer, and a timer can call setState after unmount.
- fix: Give each row a distinct kind and clear the timer in a ref-backed effect cleanup.

#### [LOW][SECURITY] Gateway-supplied requestId is pasted unescaped into a copied shell command
- where: src/components/pairing-panel.tsx:52-54 (approveCommand interpolates pairingDetails.requestId directly); 102-108 (copied to clipboard)
- what: The request id from the gateway goes into `openclaw devices approve ${requestId}` with no validation.
- why: An id containing shell metacharacters or newlines is pasted as-is into the operator's terminal when they follow the steps.
- fix: Accept only ids matching a strict pattern (for example /^[A-Za-z0-9_-]+$/) and fall back to the placeholder otherwise.

#### [LOW][FUNC] ConfirmSheet "danger" renders the violet primary button, not the destructive variant
- where: src/components/ui/ConfirmSheet.tsx:51-53 (variant={danger ? 'primary' : 'secondary'})
- what: The danger flag maps to the brand primary variant. The destructive variant, which is red, exists in Button and is used by approval-decision-card.tsx:130 for Deny.
- why: Removal and disconnect confirmations (cron-job-sheet.tsx:230, chat-overflow-sheet.tsx:243) look like ordinary primary actions rather than destructive ones.
- fix: Map danger to variant 'destructive' and keep 'secondary' for the non-danger case.

#### [LOW][FUNC] iOS Button ignores size, busy, expanded, selected and accessibilityHint
- where: src/components/ui/Button.ios.tsx:9-15 (props not destructured), 38 (controlSize hard-coded to 'large')
- what: The iOS button takes only label, onPress, variant, disabled and style, so size="sm" callers render at large size.
- why: Small buttons (EmptyState.tsx:35, home-briefing-card.tsx:171) look different on iOS than on Android and web, and busy and accessibility state are dropped on iOS.
- fix: Map size to controlSize('small' or 'large') and forward the accessibility and busy props.

#### [LOW][BUG] Failed send restores stale text and overwrites what the operator typed during the request
- where: src/components/terminal/terminal-screen.tsx:171 (input cleared before the await), 180 (setInput(value) on failure)
- what: The input is cleared before sendTerminalInput is awaited. On failure the original text is written back unconditionally.
- why: Anything typed while the request is in flight is replaced by the failed command.
- fix: Restore only when the current input is still empty, or merge the two.

#### [LOW][BUG] A 404 leaves sessionRef set, so the shell is not restarted on mode re-entry
- where: src/components/terminal/terminal-screen.tsx:182-186 (404 sets terminalConnected false but leaves sessionRef.current set), 148 (start guard checks !sessionRef.current)
- what: After a 404 the stale session stays in sessionRef, so the start effect never reopens the shell.
- why: Switching away from Shell and back shows "starting…" with no session. Only the banner Retry recovers it.
- fix: Null sessionRef.current on the 404 path together with setTerminalConnected(false).

#### [LOW][PERF] Each command log is parsed twice
- where: src/components/terminal/command-log-sheet.tsx:38 (describeCommandResult for model.kind); src/components/terminal/command-result-view.tsx:19 (same parse again)
- what: Both components memoize describeCommandResult on the same log independently.
- why: Every open of the sheet parses large JSON logs twice.
- fix: Pass the parsed model into CommandResultView, or have the sheet use CommandResultView's result.

### src/components/ui/ErrorCard.tsx ... src/app/dev/preview.tsx

#### [MED][PERF] Home refresh fans out three gateway reads concurrently
- where: src/app/(tabs)/home.tsx:51 (contrast src/app/(tabs)/activity.tsx:126-133)
- what: `onRefresh` runs `refreshCapabilities()`, `refreshGateways()` and `reloadHistory()` through one `Promise.all`, so all three hit the gateway at once.
- why: activity.tsx's own comment says the repo documents the host as serving one request at a time and that the same fan-out was deliberately replaced with sequential reads. Home reintroduces the concurrent pile on every pull-to-refresh, so the spinner waits on contention rather than work.
- fix: Await the three reads sequentially in the same order as activity.tsx.

#### [MED][FUNC] Fourth Bot selection is shown as picked but silently dropped from the council
- where: src/app/council.tsx:185-189 (toggleBot, no cap), :177-183 (targets via councilTargets(..., 3)), :375-382 (chips use selected.includes); src/lib/gateway/council.ts:43 (break at limit)
- what: `toggleBot` appends any number of Bots to `selected`, and the chip is highlighted whenever its id is in `selected`. `targets` is capped at 3 by `councilTargets`, so the fourth Bot is highlighted but never asked.
- why: With four chips lit and the counter reading "Bots to compare (3/3)", the operator believes all four are compared. The fourth Bot's answer never appears, and nothing names the drop.
- fix: Refuse or disable the fourth toggle in `toggleBot` (or disable unselected chips at 3) so the highlight matches the compared set.

#### [MED][FUNC] Gateway connect refusal is shown as a failed refresh, and Retry does not reconnect
- where: src/app/(tabs)/activity.tsx:197-204 (ErrorCard copy and onRetry), :291-293 (onSelect -> connectGateway catch writes refreshError)
- what: A failed `connectGateway` from the Gateways list is written into `refreshError`, which renders with the fixed copy "Activity's gateway reads" / "Retry the refresh." and `onRetry={() => void onRefresh()}`.
- why: The operator is told a read failed and that a refresh will fix it. Refresh re-reads capabilities and gateways but never calls `connectGateway`, so Retry cannot recover the connect that was refused.
- fix: Give connect failures their own error state with connect-specific copy and a retry that calls `connectGateway(gateway)` again.

#### [LOW][BUG] Stale council round overwrites the live room ref and strands the newer room
- where: src/app/council.tsx:237-238 (roomId and liveRoomRef written without a mine() check), :245-247
- what: After `botGroups.create` resolves, `liveRoomRef.current = room.id` is set unconditionally. The `!mine()` guard that drops a stopped round's room only runs afterward at :245.
- why: If Stop is pressed and a new round starts while an old create is still pending, the old resolution overwrites the new round's tracked room id and then clears it. A later Stop on the new round finds no `liveRoomRef` and does not delete that room, so it lingers until the pending-room sweep.
- fix: Only write `liveRoomRef` and `roomId` after checking `mine()`, or keep the ref per round token.

#### [LOW][QUALITY] Banner clock reads Date.now() during render, contrary to its own comment
- where: src/components/voice/handsfree-call-banner.tsx:50-53 (comment at :42-45)
- what: The `getSnapshot` passed to `useSyncExternalStore` is `() => Math.floor(Date.now() / 1000)`, and React calls it on every render.
- why: The comment says no impure `Date.now()` is read during render, but this is exactly that. It also means the snapshot is not cached and can differ between the two calls React makes in dev.
- fix: Store the current second in an external store that the interval updates, and have `getSnapshot` return that stored value.

#### [LOW][QUALITY] Hardcoded hex for the End button fill bypasses the theme tokens
- where: src/components/voice/handsfree-call-banner.tsx:224
- what: `end: { backgroundColor: '#7f1d1d' }` is a literal color, while the same button's border uses `tokens.statusDisconnected`.
- why: The End control gets a second, unthemed red that will not follow palette or light/dark changes made to the token.
- fix: Use a token (for example `tokens.statusDisconnected` or a dim variant) for the fill.

#### [LOW][QUALITY] WebBadge is dead code
- where: src/components/web-badge.tsx:6-12
- what: `WebBadge` is exported but no file imports it or the module path (a repo-wide grep finds only its own definition).
- why: An unreferenced component ships in the bundle and misleads readers into thinking the web badge is rendered somewhere.
- fix: Delete the file, or wire it into the screen it was written for.

#### [LOW][FUNC] Segmented control draws its thumb on the first segment when the selected key is not an option
- where: src/components/ui/SegmentedControl.tsx:42-45 (`Math.max(findIndex, 0)`), :50-53 (indicator translateX)
- what: If `selectedKey` matches no option, `selectedIndex` clamps to 0 and the thumb slides under the first segment. Every label then renders `tertiary` because none matches `selectedKey`.
- why: The control shows the first option as lit while no option is selected and `accessibilityState` reports none as selected, so the visual and the accessible state disagree.
- fix: Hide the thumb when no option matches, instead of clamping to index 0.

#### [LOW][FUNC] Unmapped glyph names render a gear with no signal
- where: src/components/ui/WebSymbol.tsx:18-19
- what: `GLYPHS[normalized] ?? GLYPHS.gearshape` silently substitutes the gear for any name not in the map. The map is keyed by camelCase names (`chevronRight`), while the rest of the app passes web names such as `chevron_right`, `warning` and `verified`.
- why: Any caller that passes one of those names gets a gear icon with no warning, which looks like a wrong or broken icon rather than a missing one.
- fix: Add the snake_case web names the app actually uses to `GLYPHS`, and fall back to a visible placeholder or log in dev instead of the gear.

#### [LOW][QUALITY] Hooks called inside JSX attribute expressions in the Skia indicator
- where: src/components/voice/handsfree-call-indicator.native.tsx:84-89
- what: `useDerivedValue` is invoked inline in the `r` and `opacity` props of `<Circle>` inside `SkiaIndicator`, rather than being hoisted to the top of the component.
- why: The hooks run only because the JSX is unconditional. This is fragile under refactors and allocates new derived values on every render; hoisting them removes both risks.
- fix: Declare the `r` and `opacity` derived values as named constants above the `return`.

#### [LOW][QUALITY] Dev-only preview route and its mock fixtures ship in the release bundle
- where: src/app/dev/preview.tsx:33-39 (module-level mock sessions), :18-20 imports of `@/lib/dev/preview-scenarios`; gate only at src/app/dev/_layout.tsx:6-8
- what: `preview.tsx` is a file under `src/app/`, so expo-router bundles it in every build. The only guard is a runtime `__DEV__` redirect in the dev layout.
- why: Mock fixtures and the lab screen remain in production JavaScript, adding bundle weight and an extra route surface for no purpose.
- fix: Gate the route at build time (for example by moving it out of `app/` or excluding it from non-dev builds) rather than only at runtime.

### src/app/fleet.tsx ... src/app/runs.tsx

#### [MED][BUG] Handoff file note prints the whole packet instead of its length
- where: src/app/gateway/import.tsx:94
- what: `picked.content.toLocaleString()` is called on a string, which returns the string unchanged, so the note is built from the full file text.
- why: after "Pick file" succeeds, the card shows `Read packet.json: <entire packet JSON> characters.` on every successful pick, so a large packet floods the screen and the count the line claims is never a count.
- fix: use `picked.content.length.toLocaleString()` for the count.

#### [MED][BUG] App-lock switch shows ON after a failed save
- where: src/app/gateway/settings.tsx:171-174 (handler), src/lib/settings/app-lock.ts:129-137 (saveAppLock)
- what: `handleAppLock` sets the switch state to `next` before calling `saveAppLock`, and `saveAppLock` swallows its own write error in `catch {}` and returns void, so the caller cannot tell the write failed.
- why: if the write fails, the switch stays on and the screen claims the lock is holding while storage says it is off. The file's own widget-privacy handler (lines 419-435) reverts on a failed write, so this is inconsistent with the rule the file states for stored preferences.
- fix: have saveAppLock return a boolean (as saveWidgetResultHidden does) and revert `appLock` to the previous value with an error line when it is false.

#### [MED][BUG] Spend totals and Bot rows survive a gateway switch
- where: src/app/gateway/spend.tsx:110, 112, 161-162, 168, 274-281
- what: `state` (session totals) and `botReport` are never reset when `activeGateway` changes; `loadSpend` only ever calls `applySessionSpendRead(previous, ...)`, and a failed read keeps `previous.sessions` (session-analytics.ts:163-170).
- why: after switching from gateway A to B, the total card and per-Bot section keep showing A's spend, under B's name, until B's read lands. If B's read fails, A's total stays on screen beside the error card. The per-Bot ledger is reset on gateway change (lines 210-213) but the data it guards is not.
- fix: clear `state` and `botReport` (or key them by gatewayId) when the gateway changes, so a previous gateway's numbers are never shown.

#### [MED][FAILURE] Budget caps can be overwritten after a failed load
- where: src/app/gateway/spend.tsx:122-133, 146-149; src/lib/gateway/budgets.ts:162-170
- what: `loadBudgets` returns `{}` on any read or parse error, and the screen treats that as the loaded value and marks `budgetsLoaded`. The writer effect then saves the whole map on the first cap edit.
- why: if the stored caps are unreadable once (transient storage error or corrupt JSON), the first cap set on any Bot writes `{ thatBot: cap }` over the stored map and deletes every other Bot's cap, with no sign to the operator.
- fix: have loadBudgets report failure separately, and block writes until a read has succeeded.

#### [MED][PERF] Status flaps abort and restart the per-Bot spend fan-out in Runs
- where: src/app/runs.tsx:459 (loadBotSpend deps include `status`), 463-468 (focus effect returns `stopSpendWave`), comment at 329-337
- what: the focus effect depends on `loadBotSpend`, which changes identity on every `status` change. Its cleanup, `stopSpendWave`, aborts the in-flight wave and drops the ticket, and the effect then re-runs `loadBotSpend()`.
- why: each connection-monitor self-heal (connected to reconnecting to connected) cancels a running wave of one roster read plus one 200-row catalogue read per Bot, then starts it again from zero, which is the churn the comment at 329-337 and the Spend screen's ledger exist to prevent.
- fix: take `status` out of the focus-effect identity (read it through a ref) so only blur or unmount stops the wave.

#### [MED][FUNC] Focused run is never cleared, so the list re-scrolls on every update
- where: src/app/runs.tsx:152, 510, 516-526
- what: `focusedRunId` is set once from a notice tap and never reset. The scroll effect depends on `[focusedRunId, listData]`, and `listData` changes whenever run rows update.
- why: after a notice opens Runs, every later change to the run list (live events, status updates) calls `scrollToIndex` on the focused row again, pulling the list back while the operator is scrolling elsewhere. The row also stays highlighted indefinitely.
- fix: scroll once per focus request (key the scroll effect on `focusRequest`, or clear `focusedRunId` after the scroll), not on every `listData` change.

#### [MED][FAILURE] One failed status poll ends the voice install watch with the install button back
- where: src/app/gateway/settings.tsx:372-391 (poll catch breaks the loop), 646-651 (install row condition `... || installNote`)
- what: any error from a single `voice.install.status` call breaks out of the watch with no retry. The watch then reads capabilities and sets `installing` to false, while `installNote` still holds "Downloading the PC voice models…" from line 331.
- why: a transient RPC failure during a ~2 GB install on a relayed path makes the row show "Install on this PC (≈2 GB download)" again while the Gate is still installing, and tapping it starts another install. The watch never reports that it stopped following the install.
- fix: retry transient status failures with the existing backoff, and show a "lost contact, checking" note instead of leaving the install row reachable.

#### [MED][SECURITY] Deep link pre-fills a host and token that one Save sends to
- where: src/app/gateway/add.tsx:24-35 (params pre-fill url and token), 59-72 (identity and access request sent to the URL on Save); src/app/_layout.tsx:436-438 (deep link routes to /gateway/add with the link's params); README.md:122 (documented `versutus://add?url=...&token=...` form)
- what: an external `versutus://add` link fills the gateway URL and a bearer token into the add form, and Save sends the device identity and token to that URL with no host confirmation.
- why: any app or web page that can open the custom scheme can make the phone pair with, and then send chat traffic to, a host of its choice after one tap on Save. The token also sits in the URL that the OS and intent logs can record.
- fix: require an explicit confirmation step that shows the host before any identity or token is sent, and do not accept a token from the link at all.

#### [LOW][BUG] Copy-confirmation timers are not cleared
- where: src/app/gateway/settings.tsx:437-442
- what: `copyText` starts a new 2 s `setTimeout` on every copy and never clears the previous one or the one on unmount.
- why: a second copy within 2 s is cleared early by the first timer, which hides its "copied" state 1.5 s sooner than intended. A timer that fires after unmount calls setState on an unmounted screen.
- fix: keep the timer id in a ref, clear it before starting a new one, and clear it on unmount.

#### [LOW][QUALITY] Bot-tap logic is duplicated in two handlers
- where: src/app/fleet.tsx:241-261 (handlePressNode) and 323-342 (openBotSheetChat)
- what: the same `botTap` call with the same `openBot`, `requestSurface`, `router.navigate` and roster-fallback callbacks appears twice.
- why: a change to the open path (fallback, navigation target, error handling) has to be made in two places, and they can drift apart; the sheet's Open Chat would then stop matching the star tap.
- fix: extract one `openBotChat(botId)` helper and call it from both handlers.

#### [LOW][QUALITY] Platform file duplicates the base file
- where: src/app/onboarding.android.tsx:1 and src/app/onboarding.tsx:1
- what: both files are the same one-line re-export of `OnboardingScreen`.
- why: the `.android` suffix changes nothing, so the Android variant is dead weight and a second place to keep in sync.
- fix: delete `onboarding.android.tsx` unless a real Android difference is planned.

#### [LOW][FUNC] Save error stays on screen after the URL is edited
- where: src/app/gateway/add.tsx:136-141 (handleUrlChange), 208-213 (ErrorCard)
- what: `handleUrlChange` clears `identified`, `accessNote` and `accessStatus` but not `saveError`.
- why: an error from the previous URL remains visible above the new URL's form, and its Retry runs `handleSave` against the new URL, so the error no longer describes what Retry will do.
- fix: clear `saveError` in `handleUrlChange` too.

### src/hooks/use-bot-look.ts ... gate/core/cli-environments/backends/claude-code.mjs

#### [MED][BUG] Add-discovered gateway: addGateway rejection is unhandled
- where: src/hooks/use-gateway-settings-screen.ts:124-134
- what: `handleAddDiscovered` awaits `addGateway(...)` with no try/catch, while the connect path right below it was explicitly guarded. The sibling copy in src/components/gateway/gateway-home-dashboard.tsx:118-123 has the same gap.
- why: `addGateway` (src/context/gateway-provider.tsx:3717) awaits `addGatewayProfile` storage writes and `saveAppSettings`, so a storage failure rejects. The rejection escapes the onPress handler as an unhandled promise rejection and nothing reaches the screen, which is the exact failure the file's own header says it fixed for connect and delete.
- fix: Wrap the add in try/catch and route the error into `setConnectFailure` or a dedicated add-failure state, as `handleConnect` does.

#### [MED][BUG] Notification prefs: previous gateway's switches stay enabled after a failed read
- where: src/hooks/use-notification-preferences.ts:169-199 (load), 223-232 (gateway-switch effect), 189-196 (catch); src/components/gateway/notifications-section.tsx:211, 249, 264 (`disabled={saving || !synced}`)
- what: On a gateway switch the effect clears the write queue but never resets `synced`, `prefs` or `confirmedRef`. `load()` sets `synced` only on success, and its catch sets `error` without clearing `synced`.
- why: If the new gateway's read fails, or the read is still in flight, `synced` stays true with the old gateway's prefs on screen. The switches stay enabled and show the old gateway's values, and a tap then writes onto the new gateway's row. The comments at lines 117-120 and 285-287 say the switches must lock until the Gate's own settings are read, so this contradicts the design.
- fix: Reset `synced` to false, and `prefs` and `confirmedRef` to defaults, on gateway change and at the start of `load()`, and set `synced` false in its catch.

#### [MED][BUG] Claude Code stdout decoded per chunk, corrupting multi-byte characters split across chunks
- where: gate/core/cli-environments/backends/claude-code.mjs:461-466
- what: `buffer += String(chunk)` converts each raw Buffer chunk to a string on its own, with no StringDecoder and no `setEncoding`.
- why: A UTF-8 sequence (emoji, CJK, accented text) that straddles a chunk boundary decodes to U+FFFD on both sides. The assembled reply and the streamed deltas then contain replacement characters whenever stream-json output is large enough to split.
- fix: Use `child.stdout.setEncoding('utf8')` or a `StringDecoder` for the stream.

#### [MED][BUG] Stop on the wrong Claude Code turn: `abort()` targets the last turn started, not the one asked for
- where: gate/core/cli-environments/backends/claude-code.mjs:181 (single `inflight` slot), 357 (overwritten per turn), 492 (cleared only if still current), 512-514 (`abort()` takes no session id)
- what: `inflight` is one slot shared by every `sendMessage` call. Turns are not serialized, and the backend is a single shared instance per environment (backend-manager.mjs:159-161 for per-turn environments), so concurrent chats on Claude Code each write the slot.
- why: `abort()` cancels whichever turn started last. Stopping chat A can kill chat B's agent, while chat A keeps running with no handle to stop it. The comment at line 179 assumes only one turn can run, which nothing enforces.
- fix: Key the in-flight turns by session id and have `abort(sessionId)` cancel that turn only, or serialize turns per environment.

#### [MED][BUG] Executable paths containing spaces are reported as not installed
- where: gate/core/cli-environments/adapters/shared.mjs:31-32
- what: `runCli` checks `access(executablePath.split(' ')[0])`, but it spawns the full, unsplit path on line 36.
- why: A path such as `C:\Program Files\...\cli.exe` checks `C:\Program`, which fails. `runCli` rejects, and probeVersion (line 90-93) turns that into `not_installed: executable not runnable` for a binary that spawns fine.
- fix: Check `access(executablePath)` as probeVersion already does on line 83.

#### [MED][FAILURE] A dead environment with a cached catalogue makes every routing turn wait the full read timeout
- where: gate/core/cli-environments/backend-model-route.mjs:205-207, 207, 230-231
- what: `loadCatalogue` returns the cached copy at line 230 before it ever records `unreadable`. `catalogueFor` therefore never marks an environment that has a copy, and it calls `loadCatalogue` again on every lookup once the TTL has passed (line 207).
- why: For an environment that stopped answering after its first successful read, each routing lookup past the 60 s TTL awaits up to `CATALOGUE_READ_TIMEOUT_MS` (5 s) before falling back to the stale copy, on every turn. The short-circuit at lines 205-206 is meant to prevent exactly this re-parking, but it only applies to environments with no copy.
- fix: Record `unreadable` (or a retry-after timestamp) whether or not a stale copy exists, and serve the stale copy without re-reading within the window.

#### [MED][FAILURE] Corrupt legacy secrets store is treated as empty
- where: gate/core/capabilities/secrets.mjs:83-90 (readLegacyStore), 67-70 (listSecretNames), 72-81 (migrate)
- what: `readLegacyStore` catches every error, including a missing file, a truncated file and a JSON parse failure, and returns an empty store.
- why: A damaged `secrets/store.enc.json` looks like "no secrets". `listSecretNames` returns [], the migration to the vault migrates nothing without error, and `getSecret` returns undefined for refs that still exist. This is the silent-drop pattern that readJsonFile in atomic-file.mjs was written to prevent.
- fix: Return `missing` only on ENOENT and throw on any other read or parse failure, as readJsonFile distinguishes `corrupt`.

#### [MED][PERF] Credential bindings are decrypted and re-logged on every backend lookup
- where: gate/core/cli-environments/backend-manager.mjs:169 (resolveCredentials called before the server cache check), 261-287 (vault reads, onCredentialIssue at 280, onDiagnostic at 284)
- what: `get()` resolves every credential binding from the vault on each call, before checking whether a server already exists. A binding that does not resolve is re-reported through `onCredentialIssue`/`console.warn` on each call.
- why: Every request that reaches a backend reads and decrypts the vault again, and a missing optional binding floods the log on each request rather than once.
- fix: Resolve credentials once when the server is created (or per record change), and report an unresolved binding once per start.

#### [LOW][BUG] setEnabled reports success and registers push even when the Gate refused the write
- where: src/hooks/use-notification-preferences.ts:360-372
- what: `await setPatch({ enabled: true })` discards the boolean that `setPatch` resolves with (false when the Gate refused and prefs were rolled back). The function then runs `syncPushRegistration` and returns true. The disable branch also ignores the result and returns true.
- why: The toggle is reverted by the rollback, yet the caller is told the enable succeeded and a push token is registered for a preference the Gate never stored.
- fix: Return `false` when `setPatch` resolves false, and skip the push sync in that case.

#### [LOW][QUALITY] `void wave.settled` is a no-op statement
- where: src/hooks/use-gateway-reachability.ts:107
- what: `void wave.settled;` reads a property and discards it. It neither awaits the wave nor attaches a rejection handler.
- why: It looks like a completion hook but does nothing, so any rejection from `runCapped` (reachability-wave.ts:251, which uses Promise.all) is left unobserved and the statement misleads readers.
- fix: Delete the line, or await or `.catch` the promise if completion matters.

#### [LOW][QUALITY] `Fonts` export is dead and its serif value contradicts the design comment
- where: src/constants/tokens.ts:163-182 (and the header at 135-138)
- what: `Fonts` is exported and not referenced anywhere in src. Its `serif` key resolves to `'ui-serif'` on iOS and `'serif'` elsewhere, not Instrument Serif.
- why: The header says titles are set in Instrument Serif, and real consumers (src/components/ui/Text.tsx:27-28) use `FontFamily.serif`, so a future reader who picks `Fonts.serif` gets a system serif instead of the brand face.
- fix: Delete `Fonts`, or set its serif to `FontFamily.serif`.

#### [LOW][QUALITY] Identical ternary branches
- where: gate/core/cli-environments/adapters/shared.mjs:83
- what: `executablePath.endsWith('.mjs') ? executablePath : executablePath` returns the same value on both branches.
- why: It reads as if the `.mjs` case was meant to differ, which suggests an intended branch was lost.
- fix: Replace it with `access(executablePath)`.

#### [LOW][QUALITY] `getSecret` wraps `vault.get` in a try/catch that only rethrows
- where: gate/core/capabilities/secrets.mjs:51-58
- what: The try/catch re-throws the same error unchanged.
- why: It does nothing and suggests error handling that is not there.
- fix: Remove the wrapper and await `vault.get` directly.

#### [LOW][PERF] Every listMessages call reads the whole transcripts directory
- where: gate/core/cli-environments/backends/claude-code.mjs:327
- what: `(await transcripts())` runs a readdir of the project directory before the `reserved` lookup, so it runs even for ids that are not reserved.
- why: The comment at lines 165-167 says the readdir is avoided once a transcript exists, but the code pays it on every message read, growing with the number of conversations.
- fix: Check `reserved.has(sessionId)` first and only list the directory when that is true.

#### [LOW][BUG] IPv6 loopback base URLs are rejected
- where: gate/core/capabilities/provider/kind.mjs:4 (isLoopback), 40
- what: `isLoopback` compares `new URL(baseUrl).hostname` to `'::1'`. WHATWG URL reports IPv6 hostnames with brackets, as `'[::1]'`.
- why: `http://[::1]:PORT` is refused with "must use https", even though the function exists to allow loopback over http.
- fix: Compare against `'[::1]'` (or accept both forms).

#### [LOW][QUALITY] `gateHome` parameter is accepted and never used
- where: gate/core/capabilities/registry-methods.mjs:48
- what: `createRegistryMethods({ root, getState, reload, gateHome })` destructures `gateHome`, and nothing in the file reads it.
- why: It suggests the registry writes under the Gate home when it does not, which misleads readers about where instances are stored.
- fix: Drop the parameter, or use it where the registry paths are built.

### gate/core/cli-environments/backends/codex.mjs ... gate/core/cli-environments/schema.mjs

#### [MED][BUG] An already-aborted OpenCode send still posts the prompt
- where: gate/core/cli-environments/backends/opencode.mjs:596-597, 706-721
- what: openTurnBus settles as `aborted` before any subscription exists when the signal is already aborted, so `turn.ready` resolves at once and sendMessage still POSTs `prompt_async`. The abort is only acted on afterwards in `wait()`, which calls `stopTurn`. A Stop pressed during the up-to-3 s ready wait has the same effect.
- why: A cancelled message is still written into the session and starts a model turn, costing tokens and leaving the answer in history, before a best-effort stop capped at 2 s runs.
- fix: Check `signal?.aborted` before posting and skip the POST; make the ready wait respond to the signal.

#### [MED][FUNC] Stop does not cancel an OpenCode turn on the prompt_async 404 fallback
- where: gate/core/cli-environments/backends/opencode.mjs:718-719
- what: The blocking `/message` fallback POST is sent without `signal`, so the caller's abort is ignored and the request runs until the 180 s idle bound.
- why: On servers without `prompt_async`, Stop leaves the OpenCode turn running and the Gate waiting for up to three minutes, the outcome the file's own comment at lines 603-606 says must not happen.
- fix: Pass the caller signal into that call and call `stopTurn` when it aborts.

#### [MED][FAILURE] An OpenCode turn with a running tool part has no time ceiling
- where: gate/core/cli-environments/backends/opencode.mjs:562, 196-198, 386-391
- what: `arm()` returns without setting a timer whenever any tool part is in state `running`, so silence is never bounded while a tool is running.
- why: A tool part that never reaches completed or error (a crashed tool, a lost terminal event) keeps sendMessage pending forever with no reply and no failure. codex.mjs:177-197 by contrast applies a fixed 180 s bound regardless of progress.
- fix: Add an absolute per-turn ceiling independent of tool progress, and name the running tool in the failure.

#### [MED][BUG] Stdout is decoded chunk by chunk, corrupting multi-byte characters
- where: gate/core/cli-environments/jsonrpc-stdio.mjs:14-16 (and stderr at 33)
- what: `buffer += String(chunk)` converts each Buffer separately, so a UTF-8 sequence split across pipe reads becomes U+FFFD.
- why: Long Codex replies containing emoji, CJK or accented text are corrupted silently at chunk boundaries (pipe reads are typically up to 64 KB), and the damage lands in the answer text.
- fix: Call `child.stdout.setEncoding('utf8')` or decode through a `StringDecoder`.

#### [MED][FAILURE] Hermes metadata writes have no time bound
- where: gate/core/cli-environments/backends/hermes.mjs:259, 276, 392, 408
- what: createSession, deleteSession, createJob and removeJob use the unbounded `call()`; only reads go through `readCall`'s 30 s ceiling.
- why: The comment at lines 140-149 records 9-12 minute hangs on this host under state.db contention. A create or delete in that state hangs the request forever, and createSession is on the path of opening Bot Chat.
- fix: Route these metadata writes through a bounded call that raises the same backend_timeout error as readCall.

#### [MED][FAILURE] A failed createBot leaves a profile that can never be retried
- where: gate/core/cli-environments/backends/hermes.mjs:719-725, 740-775
- what: The CLI creates the profile at line 740 before the .env (758), SOUL.md (760) and model/provider pins (763-775) are written. None of those steps is rolled back, unlike updateBot, which runs inside withBotEditRollback.
- why: A failure after the profile exists leaves a directory with no API_SERVER_KEY, the request reports an error, and every retry is refused with `bot_exists` (719-725), so the directory can only be removed by hand.
- fix: Remove the profile directory, or wrap the whole create in the same rollback helper, whenever a step after the CLI create fails.

#### [MED][SECURITY] updateBot returns raw CLI stderr that the file itself says can carry credentials
- where: gate/core/cli-environments/backends/hermes.mjs:866-868, 879-881 (contrast the scrub at 729-731)
- what: updateBot builds its client-facing error from `pin.stderr`. runCreateCommand discards CLI output for exactly this reason: "can contain inherited credentials".
- why: Credentials printed by a failed `config set` reach the phone through the updateBot error, while createBot is careful not to leak them.
- fix: Use fixed messages in updateBot, as createBot does, and keep stderr out of client-facing errors.

#### [MED][SECURITY] Rollback re-creates secret-bearing Bot files with the default file mode
- where: gate/core/cli-environments/hermes-bot-edit.mjs:34-38; gate/core/atomic-file.mjs:44-50; gate/core/cli-environments/backends/hermes.mjs:856, 758
- what: The edit path writes config.yaml and .env with mode 0600, but withBotEditRollback restores the original bytes with `writeFileAtomic(path, bytes)` and no `mode`, so the renamed file gets the process default (umask-based, typically 0644).
- why: After any failed Bot edit, provider keys in config.yaml and the listen key in .env become readable by other local users on macOS and Linux, which is the exact property the 0600 writes exist to keep.
- fix: Pass `{ mode: 0o600 }` for secret-bearing paths, or capture and restore the original mode along with the bytes.

#### [MED][SECURITY] Dot-only environment ids escape the run archive root
- where: gate/core/cli-environments/run-archive.mjs:17-21, 75-77; gate/core/cli-environments/schema.mjs:113
- what: safeSegment keeps `.` and `..` (both characters are in its allowed set), and schema validation only requires a non-empty string id. An environment id of `..` makes environmentDir resolve to the archive's parent directory.
- why: Run files for that environment are written to `<parent>/<runId>.json`, outside the archive root, through mkdirSync and appendFileSync. The id is accepted from environments.create (gate/core/cli-environments/rpc.mjs:37-39).
- fix: Reject ids that are `.` or `..` (or any id outside a safe charset) in schema.mjs, and make safeSegment fall back for dot-only results.

#### [MED][BUG] A reused run id overwrites that run's archived history
- where: gate/core/cli-environments/run-archive.mjs:95-97; gate/core/cli-environments/supervisor.mjs:376 (the duplicate check at 229 runs only during hydration)
- what: record() uses writeFileSync, which truncates an existing file, and the run id is taken from `request.runId` when a caller supplies one.
- why: Once a run is evicted from memory, a new run that reuses its id truncates the on-disk history of the old run, which is the record the Recent runs replay reads.
- fix: Open the file with the 'wx' flag and refuse to start a run whose id already has an archive.

#### [MED][FUNC] The invocation token is issued but no production code verifies it
- where: gate/core/cli-environments/invocation-tokens.mjs:56-84; gate/core/cli-environments/process-environment.mjs:46-47
- what: The Gate puts VERSUTUS_CLI_INVOCATION_TOKEN into every CLI environment, but verifyInvocationToken is called only from tests (a non-test grep of gate/ finds no caller).
- why: The audience, run-binding and single-use checks protect nothing in production, so the token a CLI child carries is never checked on the callback path it was issued for.
- fix: Verify the token on the chat/callback route with audience and runId binding, or remove the machinery and document the token as informational.

#### [LOW][FAILURE] A codex subscription stays open for three minutes when turn/start fails
- where: gate/core/cli-environments/backends/codex.mjs:273-274
- what: awaitTurn subscribes before `turn/start`. If that request rejects, sendMessage throws without releasing the subscription, which only ends when its 180 s timer fires.
- why: Each failed send leaves a bus listener and its closure alive for up to three minutes, and a burst of failing sends accumulates them.
- fix: Release the subscription in a catch around the turn/start await.

#### [LOW][QUALITY] Codex `subscribe` returns a handler that cannot be unsubscribed, and nothing in production calls it
- where: gate/core/cli-environments/backends/codex.mjs:348-350
- what: `subscribe(sessionId, onEvent)` returns `scopedHandler(...)`, a function with no way to unregister it. Its only caller is gate/__tests__/codex-backend.test.mjs:340.
- why: The method reads like a subscription API but leaks any listener a future caller registers through it.
- fix: Delete it, or return an unsubscribe that removes the handler from the connection.

#### [LOW][BUG] A message limit of 0 returns the whole transcript
- where: gate/core/cli-environments/backends/codex.mjs:250; gate/core/cli-environments/backends/hermes.mjs:284; gate/core/cli-environments/backends/opencode.mjs:684
- what: `mapped.slice(-limit)` with limit 0 is `slice(0)`, which returns every message.
- why: A caller asking for zero messages receives the full history, which can be a large payload.
- fix: Return an empty array when limit is zero or less before slicing.

#### [LOW][PERF] Single-Bot lookups read every profile on disk
- where: gate/core/cli-environments/backends/hermes.mjs:570, 592, 610
- what: getBot, getBotMemory and setBotMemory call listHermesBots, which reads three files per profile, only to confirm that one id exists. getHermesBot (gate/core/cli-environments/hermes-profiles.mjs:300-321) exists for this and its comment says the roster walk was the problem.
- why: Each soul, memory read or memory write reads every profile's .env, profile.yaml and config.yaml.
- fix: Use getHermesBot for the existence check.

#### [LOW][BUG] Group and handoff session lookups list without a limit
- where: gate/core/cli-environments/backends/hermes.mjs:628, 651
- what: deliverGroupMessage and handoffMention call `listSessions()` with no limit, the case the comment at lines 219-221 says returns only Hermes' default page.
- why: A room or Bot Chat outside that page is not found, so each send attempts createSession, gets the "already in use" refusal, and falls back to a second lookup.
- fix: Pass an explicit limit, or look the session up by title directly.

#### [LOW][QUALITY] setBotMemory reports character count as `bytes`
- where: gate/core/cli-environments/backends/hermes.mjs:613
- what: `text.length` counts UTF-16 code units, not bytes.
- why: The reported `bytes` is wrong for any non-ASCII memory text (an emoji is two units and four bytes).
- fix: Use `Buffer.byteLength(text, 'utf8')`.

#### [LOW][FAILURE] The OpenCode silence timer survives turn.close()
- where: gate/core/cli-environments/backends/opencode.mjs:563, 592-595, 713
- what: close() aborts the feed and detaches the caller's abort listener, but never clears the timer armed by arm(). The 404 fallback and the prompt_async failure both call close() and never await the outcome.
- why: The silence timer and its closures stay alive after the turn is abandoned, and later settle a promise nobody awaits.
- fix: Clear the timer and settle the outcome inside close().

#### [LOW][BUG] A child killed by a signal is only noticed at the start deadline
- where: gate/core/cli-environments/native-server.mjs:166-167, 189-191
- what: `exited` is set from the exit code, which is null when the child dies from a signal, and null is also the "still running" sentinel.
- why: The start loop never sees the exit, so a crashed server is reported as "did not become reachable" only after the full 30 s start timeout.
- fix: Track an explicit exited flag separate from the exit code.

#### [LOW][FAILURE] close() drops pending RPC waiters without rejecting them
- where: gate/core/cli-environments/jsonrpc-stdio.mjs:121-124
- what: close() empties `pending` without calling reject. fail() (line 45) does reject, so the two paths differ.
- why: Callers of an in-flight request wait out its full 120 s timer instead of failing at once when the transport is closed.
- fix: Reject every pending waiter in close(), as fail() does.

#### [LOW][FAILURE] One unreadable environment directory aborts the whole archive load
- where: gate/core/cli-environments/run-archive.mjs:125
- what: `readdir(environmentPath)` sits outside the try that protects each run file, so one failure rejects load() for every environment.
- why: The comment at lines 106-107 promises an unreadable file never keeps the Gate from starting, and a directory-level failure does.
- fix: Wrap the per-directory readdir in the same try and skip that environment.

#### [LOW][BUG] Bot group members are not type-checked on create
- where: gate/core/cli-environments/bot-groups.mjs:9-15, 165-166
- what: validateGroup builds its member list with `new Set(memberIds ?? [])` and checks neither the type of the input nor of its entries. A string input would be split into characters.
- why: Without a roster resolver (assertKnownMembers returns early at lines 80-81), a room is persisted with non-string or single-character member ids that only fail at first send. addMembers already validates these.
- fix: Reject non-array input and non-string entries in validateGroup.

### gate/core/cli-environments/stdio-server.mjs ... gate/core/providers/oauth/attempt-store.mjs

#### [MED][SECURITY] Credential refs are not confined to the vault directory
- where: gate/core/credentials/vault.mjs:38-42; refs come from gate/core/providers/schema.mjs:68 and gate/core/cli-environments/schema.mjs:199-202 (both `requireString` only)
- what: `fileFor(ref)` only replaces `/` with `-` before `join(this.dir, `${ref}.${ext}`)`. `..` segments and Windows `\` separators pass through, and `join` normalises them.
- why: A provider `credentialRef` or environment `credentialBindings` value such as `..\..\x` makes `set` write, `get` read and `delete` remove `*.dpapi` or `*.sealed` files outside `credentials/`. Providers RPC delete (providers/rpc.mjs:120-121) then calls `vault.delete` on that ref.
- fix: Reject refs that do not match a strict pattern, or resolve the path and require it to stay under `this.dir`.

#### [MED][BUG] Concurrency slot check runs before awaits, so two concurrent starts can both pass
- where: gate/core/cli-environments/supervisor.mjs:339-344 (busy check), :363 (`await adapter.probe`), :381 (`await this.resolveRunCredentials`), :428-429 (`runs.set` / `trackLive`)
- what: `startRun` counts active runs, then awaits the CLI probe and the vault before registering the run in `runs` and `liveRuns`.
- why: Two POST `/runs` requests on an environment with `maxConcurrentRuns` 1 both see zero active runs during the probe await, and both spawn. The probe spawns a real CLI, so the window is real.
- fix: Reserve the slot synchronously (track the run or a pending counter) before the first await, and release it on failure.

#### [MED][BUG] A caller-supplied `runId` overwrites an existing run's bookkeeping
- where: gate/core/cli-environments/supervisor.mjs:376 (`request.runId ??`), :428 (`this.runs.set`), :429 (`trackLive`); gate/core/server.mjs:3779-3782 (body spread)
- what: `runId` is taken from the request and no duplicate check is made. The route passes the parsed body through.
- why: Reusing an existing id replaces that run's entry. When the old run finishes, `untrackLive` deletes the shared id from `liveRuns`, so the environment reads as idle while the new run is live. `cancel(oldId)` then cancels the new run.
- fix: Generate run ids server-side, or reject a `runId` that already exists in `this.runs`.

#### [MED][BUG] The route spreads the body after the path `environmentId`, so the body can redirect the run
- where: gate/core/server.mjs:3779-3782
- what: `startRun({ environmentId: decodeURIComponent(runStart[1]), ...body })` lets `body.environmentId` override the id from the URL.
- why: `POST /v1/environments/A/runs` with `{"environmentId":"B"}` starts the run on B. The URL no longer names the environment that does the work, and `body.endpoints`, `body.runId` and `body.providerRef` are also accepted unchecked.
- fix: Put the path id last, or whitelist the fields the body may set.

#### [MED][SECURITY] Request-supplied `endpoints.chat` is injected into the child's `VERSUTUS_GATE_CHAT` with no check
- where: gate/core/cli-environments/supervisor.mjs:412, :794-796 (`request.endpoints ?? ...`); gate/core/cli-environments/process-environment.mjs (`child.VERSUTUS_GATE_CHAT = request.endpoints.chat`); the body reaches it via gate/core/server.mjs:3779-3782
- what: `endpointsFor` returns the caller's `endpoints` before the Gate's own port, and the value is written into the child's environment, together with `VERSUTUS_CLI_INVOCATION_TOKEN`.
- why: A paired caller can point the CLI's callback URL at any host, and the run's invocation token travels with it. The Gate's own port is supposed to be the only valid target (the comment at :787-793 says so).
- fix: Take endpoints only from the Gate's own configuration, never from the request body.

#### [MED][BUG] Environment state written by `finish()`, `execute()` and `stop()` drops the probe that `recordState` keeps
- where: gate/core/cli-environments/supervisor.mjs:430, :851-853, :300 versus :276-279 (`recordState` stores `{state, probe}`) and :271-274 (comment says the probe travels with the state)
- what: After a run starts, ends, or the environment is stopped, the entry is replaced with `{ state }` only.
- why: The probed CLI version disappears from `environmentState` after the first run. Readers such as the manifest and backend-manager's describe, which the comment names as reading `probe`, then see no version.
- fix: Merge into the existing entry (`{ ...prev, state }`) instead of replacing it.

#### [MED][FUNC] Stopping an environment does not block new runs
- where: gate/core/cli-environments/supervisor.mjs:299-304 (`stop` sets `'stopped'`), :337-430 (`startRun` never checks it and sets `'busy'` at :430), :846-848 (comment says only `check`/`start` move off `stopped`)
- what: `startRun` ignores the `stopped` state, and the unconditional `busy` write at :430 overwrites it.
- why: The phone's Stop cancels current runs, but the next POST `/runs` runs anyway and clears the stopped state without any `start` call, which contradicts the code's own stated contract.
- fix: Refuse `startRun` while the environment is `stopped`, with a message that says to start it first.

#### [MED][BUG] An unreadable credential file is reported to the operator as "no value is stored"
- where: gate/core/credentials/vault.mjs:82-100 (stat/readFile errors other than ENOENT set `unreadable` and return `undefined`); gate/core/cli-environments/supervisor.mjs:648-653 (`get` result used with no error), :446-450 (message picks the "never saved" branch)
- what: `readThrough` swallows non-ENOENT stat and read errors and returns `undefined`, so `get` cannot throw for them. `resolveRunCredentials` then records no error.
- why: A locked or EPERM `.dpapi` file is reported as "no value is stored for that reference — set the key on the Providers screen", which is the wrong remedy. The distinction the comment at :446-448 promises is lost. `vault.inspect` already knows the real reason.
- fix: Have `resolveRunCredentials` call `vault.inspect` when `get` returns undefined and report `unreadable` with its error code.

#### [MED][FAILURE] Exited children stay in the job's list across respawns, so `stop()` can taskkill recycled pids
- where: gate/core/cli-environments/stdio-server.mjs:64 (`job.add`), :82-87 (exit handler does not remove the child), :121-136 (`terminate` then `reset`); gate/core/cli-environments/windows-job.mjs:19-21 (`add`), :43-50 (`terminate` kills every listed pid)
- what: `job.add(spawned)` runs on every start, but only `stop()` clears the list. A child that dies on its own (`exit`) stays in it.
- why: After one or more crashes and respawns, the next `stop()` runs `taskkill /T /F` on every earlier pid. Those pids are dead and Windows reuses them, so an unrelated process can be killed. The comment at windows-job.mjs:23-29 names this exact hazard as the reason for `reset`.
- fix: Remove the child from the job in the exit handler, or call `job.reset()` before each respawn.

#### [MED][BUG] Cron run status reads "completed" for a session that ended in error, and `error` is the literal string "error"
- where: gate/core/cron-view.mjs:48 (`status: finishedAt ? 'completed' : 'running'`), :50 (`error: session.end_reason === 'error' ? (session.end_reason ?? null) : null`)
- what: Status ignores `end_reason`. `error` is set to the constant `'error'`, not a message.
- why: A failed cron run that has an `ended_at` shows as completed in history and carries no real error text.
- fix: Derive status from `end_reason` (error gives `failed`), and take the message from the session when one exists.

#### [MED][PERF] Every chat, health and model call re-fetches the local provider's manifest
- where: gate/core/providers/factory.mjs:21 (`chat`), :28-35 (`materialize` calls `createLocalProviderAdapter` each time); gate/core/providers/local/adapter.mjs:13 (`await client.discover()`)
- what: Each method call builds a new adapter and runs `discover()`, a network GET of the manifest, before doing its own request.
- why: Each turn on a `local_interface` provider pays an extra round trip, plus the 30 s clamp for that GET, and `disconnect()` also fetches the manifest. The cost lands on every turn.
- fix: Build the local adapter once per provider config generation and reuse it until the registration changes.

#### [LOW][FAILURE] A crash during key-file creation leaves an empty key file that every later read rejects
- where: gate/core/credentials/sealed-backend.mjs:176-190 (`getKey` creates with `wx` and then writes), :159-171 (`read` throws `credential_key_corrupt` on empty content)
- what: Creation opens the file before writing the key. If the process dies between those steps, the file is empty.
- why: `getKey({create:true})` sees the file as present, so it calls `read()`, which throws instead of returning null. The key is never recreated and every protect fails until someone deletes the file by hand.
- fix: Write the key to a temp file and rename it into place, or treat an empty key file as absent when no value has been sealed yet.

#### [LOW][FAILURE] `list()` sorts by `record.id`, and `get()` returns records that were never validated
- where: gate/core/cli-environments/store.mjs:76 (`a.id.localeCompare`), :79-82 (`get` returns any JSON whose read was `ok`)
- what: Only `put` runs the schema validator. A hand-edited or damaged `.json` with no `id` comes back from `get`.
- why: `list()` then throws `TypeError` on that entry, so `environments.list` fails for every environment, not just the bad one.
- fix: Validate records in `get` (skip and log invalid ones), or guard the sort against a missing id.

#### [LOW][SECURITY] The workspace policy is lexical only, so a junction or symlink inside a root escapes the check
- where: gate/core/cli-environments/workspace-policy.mjs:10-21
- what: `assertWorkspaceAccess` calls `resolve(raw)` and compares the prefix to the roots. It never calls `realpath`, although the variable is named `canonical`.
- why: A junction or symlink under an allowed root that points outside it passes the check, and the run's cwd is set to that path.
- fix: Resolve the real path (`fs.realpath`) on both the request and the roots before comparing.

### gate/core/providers/oauth/device-code.mjs ... gate/core/serial-reload.mjs

#### [MED][BUG] Unreadable provider state falls back to a fabricated legacy state that later writes persist
- where: gate/core/providers/store.mjs:118-129 (fallback at 126-129); gate/core/providers/service.mjs:161-187, 291-318 (commits that spread fresh.state)
- what: when the state file cannot be read and this process has never read it, get() returns a `legacy_bootstrap` stale state with no auth, backoff or model list.
- why: a Windows lock on the state file makes the provider read as "Set key" with no models, and the next check or refresh commits that stand-in back over the real state file, discarding its catalog and backoff.
- fix: Return an explicit unreadable marker to the callers and refuse to commit a check or refresh built on a stand-in state.

#### [MED][BUG] providers.create overwrites an existing provider without checking for it
- where: gate/core/providers/service.mjs:74-83; gate/core/providers/rpc.mjs:66; gate/core/providers/store.mjs:132-152
- what: create() never checks whether the id exists and calls store.put, which replaces both the registration and the state file, outside the per-provider commit queue.
- why: a repeated create silently resets the auth, backoff, catalog and last chat outcome of a working provider and still returns ok:true, and it can race an in-flight update or check.
- fix: Refuse an existing id with a provider_exists error inside commit(id, ...), as update() already does.

#### [MED][SECURITY] Deleting an OAuth provider leaves its refresh token in the vault and hides vault failures
- where: gate/core/providers/service.mjs:139-143; compare credentialRefFor at service.mjs:567-570
- what: delete() reads only registration.credentialRef, which the schema forbids for oauth mode, so the `oauth/<id>` entry is never removed, and any vault.delete error is swallowed by `.catch(() => undefined)`.
- why: a live refresh token stays in the vault with no surface able to list or revoke it, which is the exact outcome the comment at line 139-140 says to prevent, and deleted:true is reported even when the secret was not removed.
- fix: Delete `credentialRefFor(record.config)` (and revoke through oauth.disconnect), and propagate vault failures instead of swallowing them.

#### [MED][PERF] Every check and catalog refresh requests the model list twice
- where: gate/core/providers/service.mjs:280-285 (refresh calls listModels), 390-393 (inspect calls adapter.health); gate/core/providers/profiles/registry.mjs:47-50 (health calls listModels and discards the result)
- what: inspect() runs health(), which fetches the full catalog and throws it away, and runRefreshCatalog then fetches it again.
- why: each refresh or check sends two identical catalog requests to the vendor, spending rate-limit budget on every "Refresh catalog" tap and doubling latency.
- fix: Have health() perform a cheap credential check, or let inspect() skip its catalog probe when the caller needs the models.

#### [MED][FUNC] providers.auth.disconnect leaves the provider advertised as ready
- where: gate/core/providers/rpc.mjs:113-124
- what: disconnect deletes the credential and forgets the adapter, but writes no state and does not call onChanged; unlike setApiKey and delete it uses status() rather than statusAndReload().
- why: the stored auth and readiness stay `ready` and the manifest is not refreshed, so a disconnected provider keeps offering its models until someone runs Check, and the next chat fails with missing_credentials.
- fix: Use statusAndReload and record auth `missing` (and readiness) in the stored state, as noteCredentialSet does for setApiKey.

#### [MED][FUNC] Quiet hours can never be cleared through notifications.preferences.set
- where: gate/core/push-rpc.mjs:36-48 (validQuietHours), 124; gate/core/push-tokens.mjs:75-77
- what: validQuietHours(null) throws, but preferencesFrom returns `quietHours: null` for "not set", so a get-then-set round trip fails.
- why: once quiet hours are set, no client can remove them through this RPC, and sending the value that get returned for "off" is refused with "quietHours must contain integer...".
- fix: Treat null as "clear" in validQuietHours and let the store write it.

#### [MED][FAILURE] A failed receipt collection is dropped without any log, so dead tokens are never pruned
- where: gate/core/push-notifier.mjs:327-341 (silent return at 331); gate/core/push-send.mjs:45-76
- what: `if (receiptResult?.ok !== true) return;` discards the failure, and collectReceipts reports errors by returning ok:false rather than throwing, so the catch at 335 never runs.
- why: when Expo's receipts endpoint fails, DeviceNotRegistered tokens are never removed and nothing in the Gate log shows why notifications keep going to dead phones.
- fix: Log receiptResult.error (redacted) when ok is false, as the thrown case already does.

#### [MED][FAILURE] Expo push requests have no timeout and notify() awaits them
- where: gate/core/push-send.mjs:26-37 (postJson fetch at 27), 59, 93; gate/core/push-notifier.mjs:380
- what: each fetch to exp.host has no AbortSignal or timeout, and notify() awaits send() before it returns.
- why: if exp.host accepts the connection and stalls, each notify hangs and keeps its dedupe key claimed until the runtime's socket timeout ends it, notifications.test hangs with it, and concurrent events pile up with no cap.
- fix: Pass an AbortSignal.timeout (around 10 s) through postJson and treat the abort as a transport failure.

#### [MED][BUG] Every failed catalog response is labelled catalog_timeout for keep-bootstrap profiles
- where: gate/core/providers/profiles/registry.mjs:67-72 (line 71)
- what: for profiles with keepBootstrapIfEmpty (nvidia-nim, openai-compatible), any non-OK catalog response gets error.code = 'catalog_timeout', not only timeouts.
- why: a 401 or 500 from the vendor is reported to any code that reads error.code as a timeout, so the real cause is misdescribed.
- fix: Set catalog_timeout only inside the bounded-timeout branch (lines 75-82) and leave non-OK responses to status-based classification.

#### [MED][BUG] OAuth begin() returns an attempt that has no authorization URL when the issuer omits its endpoint
- where: gate/core/providers/oauth/refresh.mjs:26-31 (begin), 18-22 (comment claims such attempts are refused); gate/core/providers/oauth/pkce-callback.mjs:12, 117-128
- what: begin() refuses a missing profile but not a discovery document without authorization_endpoint, and createPkceAttempt then leaves attempt.authorizationUrl undefined and returns the attempt anyway.
- why: the sign-in sheet opens with no URL to follow, which is the failure the comment says is refused, and the loopback listener stays up until the 10-minute TTL.
- fix: Throw in begin() when metadata.authorization_endpoint is absent, before createPkceAttempt starts a listener.

#### [MED][FAILURE] OAuth discovery and token requests have no timeout and one stalled refresh blocks every caller for that provider
- where: gate/core/providers/oauth/refresh.mjs:131-132 (discovery and refresh request), 53 (code exchange), 90-96 (getAccess inflight map); gate/core/providers/oauth/discovery.mjs:11
- what: none of these fetches has a signal or timeout, and getAccess shares one pending refresh per providerId, which is removed only when that promise settles.
- why: a stalled token endpoint holds every getAccess for that provider until the runtime's own socket timeout expires, while the phone's sign-in or chat waits.
- fix: Pass an AbortSignal.timeout to each fetch, as the profile adapter's boundedRequest already does for catalog calls.

#### [MED][FAILURE] A hung revocation endpoint blocks local disconnect
- where: gate/core/providers/oauth/revocation.mjs:4-12; gate/core/providers/oauth/refresh.mjs:104-111
- what: revokeToken awaits fetch with no timeout, and disconnect awaits it before the local vault.delete at refresh.mjs:111.
- why: a revocation endpoint that never answers leaves the local grant in place and the Disconnect action never completes, because the try/catch only handles thrown errors, not stalls.
- fix: Bound the revocation request and delete the local grant regardless of the remote outcome.

#### [MED][FAILURE] Device-code polling ends the whole sign-in on one transient network error
- where: gate/core/providers/oauth/device-code.mjs:47-58 (rethrow at 58); 11-20 (poll fetch, no timeout)
- what: pollUntilAuthorized retries only authorization_pending and slow_down, and rethrows everything else, including a fetch failure that has no .code.
- why: a single dropped connection during the wait ends the sign-in, although the device-code flow is designed to keep polling until the deadline, and each poll can also hang with no timeout.
- fix: Treat errors without an OAuth code (network or timeout) as transient and keep polling until the deadline, with a per-request timeout.

#### [MED][BUG] Token responses are stored without checking access_token, and a refresh with no refresh token sends the literal "undefined"
- where: gate/core/providers/oauth/refresh.mjs:155-158, 166-173 (tokenRecord), 132-140 (refresh body)
- what: tokenRecord copies payload.access_token without validation, and refreshIfNeeded sends `refresh_token: stored.refreshToken` even when that value is undefined.
- why: a 200 without access_token (for example from a captive portal or proxy) is stored as a valid one-hour grant with accessToken undefined, and a grant issued without a refresh token gets a bogus refresh request that the vendor answers with invalid_grant, which deletes the record (refresh.mjs:148-150).
- fix: Reject payloads without access_token before storing, and return needs_reauth without a network call when there is no refresh token.

#### [LOW][SECURITY] First request to the loopback callback settles the sign-in, whatever its state
- where: gate/core/providers/oauth/pkce-callback.mjs:76-104 (resolveCallback at 103), 28-33 (settled guard)
- what: the handler resolves the attempt with whatever the first request to /oauth/callback carries, and checks state only later in consumePkceAttempt.
- why: a local process or stray request that reaches the random port first ends the attempt with a bogus or error callback, and the handler then closes the listener, so the real browser redirect finds nothing.
- fix: Answer requests whose state does not match with 400 and do not resolve the attempt, so only the state-bound callback can end it.

#### [LOW][BUG] IPv6 loopback is never matched because WHATWG URL hostnames keep their brackets
- where: gate/core/providers/profiles/registry.mjs:124; gate/core/providers/oauth/discovery.mjs:1, 6
- what: the hostname of `http://[::1]:port` is `[::1]`, but both checks compare against `'::1'`.
- why: a loopback IPv6 base URL or issuer is rejected as "origin not allowed" or "issuer host is not pinned", although the code intends to allow loopback.
- fix: Compare against `'[::1]'` or strip the brackets before comparing.

#### [LOW][FUNC] requestPolicy.timeoutMs does not bound chat requests
- where: gate/core/providers/profiles/registry.mjs:87-112 (chat forwards only the caller's signal at 102); gate/core/providers/factory.mjs:66 passes timeoutMs
- what: timeoutMs is applied only in listModels (line 57), and chat() forwards only the caller's signal.
- why: the operator-set request budget that the schema accepts and factory.mjs describes as the socket budget does not stop a hung vendor from holding a non-streaming chat request.
- fix: Combine the caller's signal with a timeout for non-streaming chat calls.

#### [LOW][FUNC] registration.protocol is validated but never used
- where: gate/core/providers/schema.mjs:62-70, 72-80 (validation); gate/core/providers/profiles/registry.mjs:89 (adapter uses profile.protocol); gate/core/providers/factory.mjs:48-54
- what: a remote registration's protocol is checked against REMOTE_PROTOCOLS, but the wire format is chosen from the shipped profile.
- why: a provider registered with protocol openai_chat under providerType anthropic is accepted and then spoken to in Anthropic format, and `openai_responses` passes validation with no implementation behind it.
- fix: Either drop the field from the schema or require it to match profile.protocol and reject mismatches during validation.

#### [LOW][SECURITY] API keys can be sent over plain http
- where: gate/core/providers/schema.mjs:67 (baseUrl only checked as a non-empty string); gate/core/providers/profiles/registry.mjs:117-131 (assertAllowedOrigin compares origin only)
- what: baseUrl is never checked for scheme, and assertAllowedOrigin does not look at the protocol.
- why: an openai-compatible registration with `http://host` sends the Bearer key in cleartext to a remote host, and the origin check passes because the registration's own origin is the allowlist.
- fix: Require https for non-loopback hosts in validateRegistration and assertAllowedOrigin.

#### [LOW][BUG] Cached OAuth adapter keeps the access token it was built with
- where: gate/core/providers/service.mjs:21-29 (adapterFor cache), 333-351 (chat); gate/core/providers/factory.mjs:47, 82-89
- what: the adapter is cached per provider and closes over the access token resolved when it was built, and nothing rebuilds it when the grant refreshes.
- why: once the token expires (about an hour) chat keeps sending it until restart or an edit, and the vendor's 401 is recorded as needs_reauth. This is latent today because releaseOAuthProfiles is empty (gate/core/server.mjs:1405), so no OAuth provider reaches it yet.
- fix: Resolve the token per request in chat(), or call forgetAdapter when getAccess returns a new token.

#### [LOW][FUNC] Editing the endpoint or key keeps the old "ready" verdict, and a disabled provider is assumed to have a credential
- where: gate/core/providers/service.mjs:524-547 (stateAfterUpdate; state changes at 540-545), 355-365 (inspect, disabled branch with present: true)
- what: a change to baseUrl, providerType or credentialRef clears backoff and marks the catalog stale, but leaves auth and readiness as they were; a disabled provider's inspect assumes the credential is present.
- why: after editing the endpoint or key the card keeps saying ready for the new target until someone runs Check, and a disabled provider with no key can be recorded as auth ready, which carries over when it is re-enabled.
- fix: When reachesElsewhere is true, reset auth and readiness the way stateAfterUpdate already does on re-enable, and check the credential even for disabled providers.

#### [LOW][BUG] A stored registration whose id differs from its file name is read inconsistently
- where: gate/core/providers/store.mjs:112-114 (config id overrides the filename), 118 (state read by filename), 108-111 (comment says the filename is canonical)
- what: the id inside the file overrides the file name when it is a non-empty string, but the state is still read from `<filename>.json`.
- why: a renamed or hand-copied registration is listed under its internal id, providers.get with that id looks for a file that does not exist, and its state is read from a different file.
- fix: Treat a mismatch between file name and internal id as a corrupt record, or use the filename consistently.

#### [LOW][FAILURE] A failed chunk discards the results of chunks that were already delivered
- where: gate/core/push-send.mjs:91-116 (send), 57-75 (collectReceipts)
- what: when a later chunk's POST fails, the whole call returns errorResult and the tickets, ticketTokens and deadTokens from earlier chunks are dropped.
- why: the notifier then releases its dedupe key, so a retry re-sends notices that were already delivered, and DeviceNotRegistered tokens from those chunks are never pruned. This needs more than 100 messages in one send, roughly 50 devices.
- fix: Return partial results with a per-chunk error instead of discarding the earlier chunks.

#### [LOW][PERF] Debounced reload fires delayMs after the first request, not after the last
- where: gate/core/serial-reload.mjs:79-91 (doc at 79-82 says "a moment after the last of them"; `if (timer) return;` at 85 fixes the fire time to the first call)
- what: the timer is not reset by later requests, so under a steady stream of requests the reload runs every delayMs.
- why: correctness holds, since each request still gets a reload that starts after it, but the cost is not the debounce the comment promises under a sustained burst.
- fix: Reset the timer on each call if a true trailing debounce is intended, or correct the doc comment to describe the throttle.

#### [LOW][BUG] A corrupt vault value makes OAuth disconnect throw before the grant is deleted
- where: gate/core/providers/oauth/refresh.mjs:98-100 (disconnect calls readTokens first), 184-187 (unguarded JSON.parse at 186)
- what: readTokens calls JSON.parse on the vault value with no guard, and disconnect calls it before anything else.
- why: a damaged `oauth/<id>` entry makes disconnect throw a SyntaxError every time, so the local grant can never be removed through the RPC.
- fix: Catch the parse error in readTokens and treat the entry as absent, so disconnect still deletes it.

### gate/core/server.mjs

#### [MED][SECURITY] Replayed signed pairing request returns the device's bearer token
- where: gate/core/server.mjs:2313-2320
- what: When the access request is a replay of one already accepted, the route looks up the existing non-revoked device grant and returns its `token` in the response body to whoever sent that request.
- why: The signed body is not secret, so anyone who captured one pairing request (plain HTTP on a LAN or tailnet leg, a log, a proxy) can replay it and receive the bearer token that authenticates every `/v1` route, including the shell route.
- fix: Return the token only on the original accepting response, or require a fresh proof of possession before reissuing it on a replay.

#### [MED][SECURITY] Role and scopes are self-declared by the pairing request and never enforced; every device token reaches the shell
- where: gate/core/server.mjs:2301 (`role: body.role ?? 'operator'`), 2341-2347 (issue with request-supplied role and scopes), 3158-3196 (`/v1/terminal/stream`), 4421 (RPC dispatch)
- what: The unauthenticated access route stores whatever `role` and `scopes` the caller sends when the pairing window is open. No code path checks `role` or `scopes` before a route runs; the only checks are the bearer token and the terminal `owner` match.
- why: Anyone who can reach the port during an open pairing window gets a token with any role they choose, and that token opens `/v1/terminal/stream`, which spawns a shell on the host. The field looks like an access control but does nothing.
- fix: Derive role and scopes from the operator's approval, not from the request, and enforce scopes on the shell and run routes.

#### [MED][BUG] Chat that names only a providerId is sent a model advertised by a different provider
- where: gate/core/server.mjs:4286-4288 (fallback), 4306 (`finishProviderChat(body.providerId, body, ...)`); guard comment at 4259-4263
- what: The guard at 4264 only refuses when both `model` and `providerId` are missing. When `providerId` is present but `model` is not, line 4286 sets `body.model` to `advertised[0].modelId`, which is the first model of any provider. The turn is then sent to `body.providerId` with that model.
- why: The comment at 4259-4263 says this first-model-of-any-provider fallback was removed on 2026-09-16 because it sent chats to the wrong provider. This path reintroduces it, so the vendor gets a model it does not serve and the failure is reported as a vendor error.
- fix: When `providerId` is set and `model` is not, refuse with `scope_required`, or pick the first model from that provider's own catalog.

#### [MED][BUG] Environment run start lets the request body override the path's environment id
- where: gate/core/server.mjs:3779-3782
- what: `environmentService.startRun({ environmentId: decodeURIComponent(runStart[1]), ...body })` spreads the body after the path value, so a body field `environmentId` replaces the id from `/v1/environments/{id}/runs`.
- why: A POST to environment A can start the run in environment B, and the returned `runId` then cannot be reached through the path the caller used. Any per-environment policy keyed on the path is bypassed.
- fix: Spread the body first and set `environmentId` from the path last, or reject a body that names a different environment.

#### [MED][FAILURE] A throw from getSecret in proxyChat leaves a named turn registered and journalled as running
- where: gate/core/server.mjs:785 (`await getSecret(...)`, outside any try), 2059-2082 (durable turn bound in `dispatchChat` before `proxyChat`), 4479-4515 (outer catch)
- what: `dispatchChat` binds the durable turn (journal entry, `inFlightTurns` key, status line) before calling `proxyChat`. Inside `proxyChat`, `getSecret` runs before the try that guards `buildChatRequest`, and `getSecret` rethrows vault and legacy-secret read errors. The exception escapes, the outer handler writes a 500, and nothing calls `endTurn` or `finishStream`.
- why: The turn stays `running` in the journal and in `inFlightTurns` until the phone sends Stop or the Gate restarts. A phone that replays it sees a turn that is still running, and the entry is never reclaimed while the Gate runs.
- fix: Move the `getSecret` call inside a try that calls `failDurableBeforeStream(durable, ...)` before writing the error, as the neighbouring paths do.

#### [MED][FAILURE] Legacy non-streamed provider reply has no bound on the body read
- where: gate/core/server.mjs:826-829 (`clearWatchdog()` in finally), 833 (`upstreamResponse.text()`), 844 (`upstreamResponse.json()`)
- what: The header watchdog is cleared as soon as headers arrive. The non-streaming branch then awaits `.text()` or `.json()` with no idle timer. The streaming relay has `readWithin` for this, but this branch does not.
- why: A vendor that sends headers and then stops sending the body keeps the request open indefinitely. For an unnamed turn only the phone leaving releases it, so the user sees an endless wait with nothing reported.
- fix: Keep an idle or total deadline across the body read for non-streamed responses, as `readWithin` does for streams.

#### [LOW][BUG] A negative `limit` gives wrong results on both session list and message routes
- where: gate/core/server.mjs:3633 and 3655 (`Number(...) || undefined`, then `sessions.slice(0, limit)`), 3693-3733 (`lower = Math.max(0, upper - limit)`)
- what: `limit=-5` passes the `|| undefined` check because -5 is truthy. On the session list, `slice(0, -5)` drops the last five rows. On messages, `lower` becomes greater than `upper`, so the page is empty with `hasMore: true` and `nextBefore: null`.
- why: A client that sends a negative limit gets truncated or empty pages it cannot page past, and the indexed path already rejects non-positive limits, so the two routes disagree.
- fix: Treat a non-positive or non-integer `limit` as absent, or reject it with a 400, before either route uses it.

#### [LOW][BUG] Provider-model lookup dereferences `config.models` without a guard
- where: gate/core/server.mjs:4315 (`item.config.models.includes(body?.model)`); guarded versions at 3979 and 4280
- what: The same roster is read with `provider.config.models || []` in two other places, but the `find` at 4315 calls `.includes` on `item.config.models` directly.
- why: A legacy provider whose config has no `models` field throws a TypeError when the model is not advertised, so the client gets a 500 instead of the intended 404 `unknown_model`.
- fix: Use `(item.config.models ?? []).includes(...)`, as the other two lookups do.

#### [LOW][BUG] RPC dispatch finds inherited Object.prototype members as methods
- where: gate/core/server.mjs:4421 (`registryMethods[rpcMethod] ?? gatewayMethods[rpcMethod] ?? ...`)
- what: `registryMethods` and `gatewayMethods` are plain object literals, so lookups for names such as `constructor`, `toString` or `hasOwnProperty` return inherited functions and not `undefined`.
- why: An authenticated call to method `constructor` runs `Object(params)` and returns the echo instead of 404 `unknown_method`, and `__proto__` fails with an internal TypeError message.
- fix: Look up with `Object.hasOwn(table, rpcMethod)`, or build the tables with `Object.create(null)`.

#### [LOW][FUNC] Non-local voice sessions silently get the scripted test engine
- where: gate/core/server.mjs:4529-4533 (`session.engine === 'local' && !scriptedEngineEnabled() ? LocalEngine : ScriptedEngine`); gate/core/voice/voice-rpc.mjs:277 and 380-393
- what: Any engine other than `'local'` is built as `ScriptedEngine` in production, with no error. Today `chooseEngine` only returns `'local'` because `codex` is never `ready` (gate/core/voice/codex-status.mjs:41-46), so this is latent.
- why: If the codex engine is later marked ready, a codex call would run the scripted replies with no sign of it, and the operator would see fake answers.
- fix: Make `createEngine` throw for an engine that has no implementation, or make the scripted engine opt-in by name.

#### [LOW][FUNC] Job routes ignore a `backendId` sent in the body unless a Bot is named
- where: gate/core/server.mjs:3287-3290 (POST /v1/jobs), 3584-3586 (job run/pause/resume), 3289 and 3609 use `body.backendId`; the non-Bot branch at 3290 and 3586 goes through `resolveBackendFor`, which reads only the URL query (2770-2776)
- what: With no Bot, `body.backendId` is ignored and the backend is chosen by capability. With a Bot, the same field is honoured. Runs (2911) and chat (4107) honour the body field in both cases.
- why: A job created with an explicit body `backendId` lands on whichever backend sorts first, which is the wrong-environment outcome the scope rules are meant to prevent.
- fix: Read `body.backendId` in the non-Bot branch too, or pass it into `resolveBackendFor` the same way the other routes do.

#### [LOW][FUNC] Env override for the detached-turn ceiling can overflow setTimeout
- where: gate/core/server.mjs:1338 (`Number(process.env.VERSUTUS_GATE_DETACHED_TURN_MAX_MS) || DEFAULT_DETACHED_TURN_MAX_MS`), used at 482-483
- what: The value is not bounded. Any value above 2147483647 ms (about 24.8 days) is passed to `setTimeout`, which Node clamps to 1 ms.
- why: An operator who sets a ceiling longer than about 24.8 days gets every detached turn ended with `turn_max_age` almost at once.
- fix: Clamp the env value to the `setTimeout` maximum, or reject values above it at startup.

#### [LOW][SECURITY] Internal error messages are echoed to the caller in 500 responses
- where: gate/core/server.mjs:4506-4511 (`message: err.message`); pre-auth route reachable at 2287-2361
- what: Any uncaught route error is returned with its raw `message`. The pre-auth access route can reach this path, and file-system errors carry absolute paths.
- why: Callers learn internal paths and library messages from the Gate's error text, which the auth-failure logging was written to avoid.
- fix: Return a generic message in the 500 body and keep the detail in the server log.

#### [LOW][QUALITY] Misplaced JSDoc: a block about parseQualifiedModel sits above newThreadTitle's doc
- where: gate/core/server.mjs:709-710
- what: The comment `/** Backend models are providerId/modelId, since a CLI reaches many vendors. */` sits directly above a second JSDoc block for `newThreadTitle` (710-720), while the function it describes is `parseQualifiedModel` at 731.
- why: The stacked comments describe the wrong functions, so a reader following them will misread the model-id format and the title rules.
- fix: Move the first comment above `parseQualifiedModel`, and keep the `newThreadTitle` block on its own function.

### gate/core/service/browser.mjs ... gate/core/voice/engines/worker-pool.mjs

#### [MED][FAILURE] Corrupt token store is re-quarantined on every authenticated request
- where: gate/core/tokens.mjs:24-27, 34-47, 80; caller gate/core/server.mjs:2441
- what: `verify()` calls `#read()`, which for a corrupt file copies it to `<path>.corrupt-<Date.now()>` and logs "Minting a new bootstrap token", but returns null without rotating. `#cached` stays null, so every call repeats the copy.
- why: while the file is corrupt, every request that carries an Authorization header copies the file again and writes a console.error. That is a request-triggered disk and log fill, and the log claims a new token was minted when none was until a restart.
- fix: quarantine once per process (or only from ensureToken), and have verify() return false without touching the file.

#### [MED][BUG] Upstream-refusal regex matches normal replies that end with a "... said HTTP NNN: text" clause
- where: gate/core/upstream-refusal.mjs:20-24; used at gate/core/server.mjs:1138-1141, 1559, 4210
- what: the lead-in is `[\s\S]*\b(provider|endpoint|...)\s+(said|returned|...)`, which can start anywhere in the text, and the tail is `.+$` on the final line. The status line is not required to be the claim.
- why: a real reply such as "I called the endpoint twice. The endpoint returned HTTP 200: OK on the first try." matches. It is then replaced by an upstream_error, the turn is marked failed, and the model-health table records a failure for a model that answered.
- fix: anchor the optional lead-in to the start of the text (drop the leading `[\s\S]*`) and require the whole reply to be one status line.

#### [MED][BUG] Renaming a session keeps the old title in `preview` when preview fell back to the title
- where: gate/core/session-index.mjs:418-431, specifically line 426
- what: `preview: row.preview ?? title` only replaces `preview` when it is null or undefined.
- why: the comment above says upstream `preview` falls back to the title, so a session with no messages has `preview` equal to the old title. That value is not nullish, so the list keeps showing the old name after a rename until the next live read, which is the exact bug the comment says this code prevents.
- fix: update `preview` when it equals the previous title (or when the upstream preview was the fallback), not only when it is nullish.

#### [MED][BUG] Stale-lock reclaim is check-then-delete, so it can remove a live owner's lock
- where: gate/core/service/instance-lock.mjs:37-44, 54-60, 112
- what: after a failed create, the code reads the lock, decides it is stale, then calls `rm(lockPath)` unconditionally before retrying the create. A lock file that is empty or half-written (created at line 112, pid written at line 66) fails JSON.parse and is treated as stale.
- why: if another process reclaims the stale lock between the check and the rm, the rm deletes that process's live lock, and both processes then acquire the lock. The same happens during the open-then-write window, when a second start reads an empty file and removes the first owner's lock. Two Gate or supervisor instances can then run at once.
- fix: reclaim by renaming the stale file aside and re-verifying its contents, or check the pid again immediately before the unlink.

#### [MED][BUG] Probe result from a dead child is applied to its replacement and forks the probe loop
- where: gate/core/service/supervisor.mjs:156-179, specifically the check at line 164
- what: `_probeLoop` awaits `this._probe()` (up to 10 s in cli.mjs:633-636) and then checks only `this._stopping || !this._child`. It does not check that `this._child` is the child it probed.
- why: if the child exits during a slow probe, `_spawn` starts a replacement after the 1 s backoff. The stale probe then resolves against the new child. If it is healthy it schedules a second permanent probe chain alongside the grace chain. If it fails it adds a failure to the new child's count, so the new child can be killed sooner than the designed four failures.
- fix: capture `const child = this._child` before the await and return if `this._child !== child` afterwards.

#### [MED][BUG] Turn ids that sanitise to the same file name overwrite each other's journal
- where: gate/core/turns/turn-journal.mjs:73-79, 164, 169, 642, 678-681
- what: the live-turn check and the map key use the raw `turnId` (`turnKey`, line 169, and `live.has`, line 642), but the file is `safeSegment(turnId).jsonl` (line 164). `safeSegment` turns every character outside `[A-Za-z0-9._-]` into `_`, strips leading dots, and falls back to `'turn'` for an empty result.
- why: two different turn ids such as "a/b" and "a_b", or "..." and "!!!" (which becomes `turn`), pass the duplicate guard. The second `begin` then overwrites the first turn's meta file and deletes its `.text` sidecar, and the first turn's later appends land in the second turn's file.
- fix: derive the key from the sanitised file name, or refuse a turn id whose sanitised name is already live.

#### [MED][SECURITY] The https-only guard for OAuth authorization URLs is dead code, and the app comment relies on it
- where: gate/core/service/browser.mjs:1-18 (assertSafeAuthorizationUrl, openAuthorizationUrl); gate/core/providers/oauth/pkce-callback.mjs:12, 127; src/lib/gateway/provider-oauth.ts:28-31
- what: nothing in production code calls `assertSafeAuthorizationUrl` or `openAuthorizationUrl`; the only references are the definition, tests and a comment. `createPkceAttempt` only runs `new URL(authorizationEndpoint)` and then returns `authorizationUrl.toString()` to the phone through rpc.mjs:104. The app comment says "The Gate already refuses to open one that is not https".
- why: any non-https endpoint that reaches `createPkceAttempt` is handed to the phone unchanged, and the documented protection does not exist. Whether a non-https endpoint can reach it depends on where `authorizationEndpoint` is set, which is outside this chunk.
- fix: call `assertSafeAuthorizationUrl` on `authorizationEndpoint` inside `createPkceAttempt` (before the loopback listener starts), and delete `openAuthorizationUrl` if nothing uses it.

#### [LOW][BUG] A requested graceful restart is counted as a crash and delayed by backoff
- where: gate/core/service/supervisor.mjs:105-119 (requestRestart), 181-207 (_onExit, lines 193-202)
- what: `requestRestart` sends a shutdown and leaves `_stopping` false. The child's exit then goes through `_onExit`, which increments `_restarts` and `_failures` and picks the crash backoff delay (1 s, 2 s, ... up to 60 s).
- why: repeated `service restart` calls within the 10-minute stable window escalate the delay, so a deliberate restart can wait up to 60 s for the Gate to come back.
- fix: flag a requested restart so `_onExit` respawns immediately and does not increment `_failures`.

#### [LOW][QUALITY] Dead status assignment, and status reads "running" from spawn
- where: gate/core/service/supervisor.mjs:124 and 129
- what: line 124 computes 'starting' or 'restarting', and line 129 unconditionally overwrites it with 'running' before any probe has run.
- why: the first value is never observed, and `service status` reports 'running' for the whole 90 s grace period even when the Gate never answers.
- fix: remove the dead ternary and report a distinct starting state until the first healthy probe.

#### [LOW][PERF] Supervisor log does a stat and a synchronous append for every line
- where: gate/core/service/rotating-log.mjs:38-51, 63-66, 68-74
- what: `_append` calls `_rotate()`, which runs `statSync`, and then `appendFileSync`, once per line. The supervisor feeds the child's stdout and stderr through this path (cli.mjs:629-630).
- why: a chatty Gate child produces two synchronous filesystem calls per line on the supervisor's event loop, which also runs the probe and state-write timers.
- fix: track the file size in memory, and batch or async-append the lines.

#### [LOW][FAILURE] A failed rotation rename throws out of write() and drops the rest of the chunk
- where: gate/core/service/rotating-log.mjs:84 (renameSync with no guard), called from 64 and 38-51
- what: the final `renameSync(this.path, ...)` in `_rotate` is not wrapped. On Windows a sharing violation (EPERM or EBUSY, for example from a reader or antivirus) throws out of `_append`.
- why: the exception escapes the line loop in `write()`, so every remaining line in that chunk is lost. cli.mjs wraps the write in `guard`, which logs to the console and nothing more, so the lines are gone with no trace.
- fix: retry the rename the way renameWithRetry does in turn-journal.mjs, and do not let one failed line abort the rest of the chunk.

#### [LOW][FAILURE] Scheduled task hardcodes the node path instead of the interpreter that installed it
- where: gate/core/service/windows-task.mjs:18 (default nodeExe); gate/cli.mjs:583
- what: `serviceInstall` calls `buildTaskDefinition` without `nodeExe`, so the task runs `C:\Program Files\nodejs\node.exe`. `serviceRun` uses `process.execPath`, so the supervisor itself may run from a different node.
- why: on a machine where node is installed elsewhere (nvm-windows, Volta, Scoop), each trigger fails to start the supervisor, and RestartOnFailure retries it 999 times with no Gate running and no message.
- fix: pass `nodeExe: process.execPath` from `serviceInstall`, and fail the install if that path is not the default.

#### [LOW][QUALITY] buildTaskDefinition accepts gateHome and never uses it
- where: gate/core/service/windows-task.mjs:19, 32
- what: `gateHome` is destructured and never passed to `taskXml` or written into the task definition.
- why: a caller that supplies a gate home gets no effect, and the task keeps the supervisor's default paths.
- fix: remove the parameter, or pass it to the task as an environment variable or argument.

#### [LOW][PERF] list() synchronously opens and reads every turn file on each request
- where: gate/core/turns/turn-journal.mjs:702-729, specifically the readMetaLine call at line 715
- what: `list()` reads the directory and then calls `readMetaLine` (openSync, readSync, closeSync) on each `.jsonl` file, on every request. The index built by `prune` already holds each turn's status and time for every caller, but not sessionId, so `list` cannot use it as is.
- why: with up to 300 retained turns per caller, one list request makes roughly 900 synchronous syscalls on the Gate's single event loop, which the file's own comments say must be avoided.
- fix: store the fields `list` needs (sessionId, model, startedAt) in the in-memory index and answer from it.

#### [LOW][FAILURE] Service commands run launchctl and plutil without a timeout
- where: gate/core/service/launchd-agent.mjs:173-181 (runCommand, spawnSync with no timeout)
- what: `runCommand` calls `spawnSync` with no `timeout` option, and every `service` subcommand goes through it.
- why: a launchctl call that never returns hangs `service stop` and `service status` indefinitely, which is the failure diagnostics.mjs:186-191 describes for probes.
- fix: pass a timeout to spawnSync and map a timeout to a named failure.

### gate/core/voice/media-socket.mjs ... gate/core/voice/voice-session.mjs

#### [MED][BUG] Bot thread silently routed to an environment that does not own the Bot
- where: gate/core/voice/voice-backend.mjs:198-203 (fallback), documented null return at :70
- what: For a Bot thread, when no environment's forBot() accepts the Bot, the code falls to `list()[0]` and returns that backend itself whenever it has no forBot method (`return backend;` at :203).
- why: Backends without Bots (the server comments say Claude Code has none; server.mjs:1766-1776 returns 501 for them) would answer a Bot's spoken turn with no error, while the typed path refuses (server.mjs:1771-1776). The docstring promises null, so an unowned Bot's call goes to the wrong backend.
- fix: When botId is set and the selected backend lacks forBot, return null (as the forBot-throws branch does) instead of the bare backend.

#### [MED][BUG] voice.session.stop drops the caller's reason, so normal hang-ups are recorded as audit errors
- where: gate/core/voice/voice-rpc.mjs:432 (`registry.end(params.voiceSessionId)`), :433 (reason only logged); consequence in gate/core/voice/runtime.mjs:168-172
- what: The reason sent by the phone (`reason: 'user'` at src/context/handsfree-voice-provider.tsx ~693-696) is not passed to registry.end, which defaults to 'unspecified'. The media socket then ends the call with that reason and the audit line carries it as `error`.
- why: readVoiceUsage treats any error other than 'user' as lastError, so every hang-up that lands its stop RPC before the socket's own end frame shows 'unspecified' as the Gate's last voice error.
- fix: Pass `params.reason` (validated to a known set) through to registry.end.

#### [MED][BUG] Re-attaching a call never closes or unhooks the previous socket
- where: gate/core/voice/media-socket.mjs:713-716 (attach replaces `ws`), :726-732 (per-socket listeners)
- what: attach() assigns `ws = newWs` without closing the old socket, and the old socket keeps its 'message' listener bound to onMessage.
- why: The file's own comment (:307-312) expects a second upgrade while the first socket is still open (half-open Tailscale). Then the old socket's binary audio is still pushed into engine.pushAudio alongside the new socket's, and the old socket is never closed, leaking a connection until TCP times out.
- fix: In attach(), close the previous socket with a reason and remove its listeners before adopting the new one.

#### [MED][FAILURE] Model download and uv have no timeout, so a stalled install wedges voice install until restart
- where: gate/core/voice/runtime.mjs:64 (fetchImpl with no signal), :71 (pipeline), :86-93 (uvRunner spawn); gate/core/voice/voice-rpc.mjs:343-357 (installState.running never clears)
- what: fetchVerified() and uvRunner() wait with no AbortSignal or timeout. voice.install.start sets `running: true` and clears it only when install.start() settles.
- why: A stalled HTTP body or a hung `uv pip install` leaves running=true indefinitely, so every later voice.install.start returns 409 install_in_progress and voice.capabilities reports 'installing' until the Gate restarts.
- fix: Add a per-request timeout/abort signal to fetch and a watchdog around the uv child process, and surface a timeout as an install error.

#### [MED][FAILURE] A hash-mismatched partial download is never discarded, so every later install fails the same way
- where: gate/core/voice/runtime.mjs:61-67 (resume from `.part`, 416 path), :73-81 (hash_mismatch leaves `.part` in place)
- what: On hash mismatch the `.part` file is kept, and the next fetchVerified() resumes from its size with a Range header.
- why: A corrupt partial is resumed forever and mismatches again, and a partial already at full size gets a 416 that throws "download failed" on every attempt. Nothing in this chunk deletes the bad partial, so install stays broken until someone removes the file by hand.
- fix: Delete `${dest}.part` on hash_mismatch (and on 416) so the next attempt starts clean.

#### [MED][PERF] Synchronous full read of an unbounded audit log on every capabilities call and session start
- where: gate/core/voice/runtime.mjs:147-183 (readVoiceUsage reads all of audit.jsonl at :152), :186-212 (voiceStatus), :214-235 (localStatus re-parses models.lock.json); called from voice-rpc.mjs:377 and gate/core/server.mjs:1717
- what: Each voice.session.start and voice.capabilities call runs voiceStatus(), which synchronously reads and splits the whole audit.jsonl and reads the lock file.
- why: gate/core/voice/audit.mjs:59-70 only appends and never rotates, so the file grows with every call. The cost of starting a call grows with the Gate's history and blocks the event loop each time.
- fix: Keep a running per-day total in memory (or a small index file) and read only today's tail, and cache the lock and existence checks until the install changes.

#### [LOW][FAILURE] Audit write failure inside end() leaves the call half-alive
- where: gate/core/voice/media-socket.mjs:770 (endingNow set), :798 (dispatch socketClosed), :469-489 (audit effect calls audit?.()), :799-811 (ended, registry.end, ws.close never reached); audit writer gate/core/voice/audit.mjs:59-70 (appendFileSync)
- what: The audit callback runs synchronously inside the reducer effects of end()'s dispatch. An exception there escapes before `ended = true`, `registry.end`, and `ws.close`, and `endingNow` stays true.
- why: A disk or permission error on audit.jsonl (plausible on Windows) leaves the socket open, the call un-ended, and every later end() call a no-op because `endingNow` is still set.
- fix: Wrap the audit callback in try/catch inside runEffect, or move the audit line out of the synchronous teardown path.

#### [LOW][FAILURE] Text frames are not size-capped at the socket, so the 4 KB control limit applies only after buffering
- where: gate/core/voice/media-socket.mjs:136 (WebSocketServer with no maxPayload), :701 (data.toString() before parsing); gate/core/voice/protocol.mjs:68 (4 KB check on the string)
- what: Only binary frames are capped (MAX_MEDIA_FRAME_BYTES at :678). Text frames fall back to the ws default maxPayload (100 MiB) and are converted to a string before the 4096-byte check runs.
- why: An authenticated phone, or a holder of the bootstrap token, can make the Gate buffer and stringify very large text frames before rejecting them.
- fix: Set `maxPayload` on the WebSocketServer to a small bound (for example 8 KB) and check text length before toString().

#### [LOW][FAILURE] voiceDoctor throws on a stray line of stdout instead of naming the failed check
- where: gate/core/voice/runtime.mjs:300 (`JSON.parse(probe.stdout)` unguarded), docstring promise at :274-276
- what: A zero-exit probe whose stdout is not exactly the JSON line (a library printing a warning to stdout, for example) makes JSON.parse throw.
- why: The documented contract is that a failing check names itself instead of throwing, and this path skips it, so voice doctor crashes with a raw SyntaxError.
- fix: Parse the last stdout line inside try/catch and report an 'imports' check failure with the raw output when it does not parse.

#### [LOW][FUNC] A failed install pins the local engine to 'unavailable' for the life of the process
- where: gate/core/voice/voice-rpc.mjs:323-331 (decorate overrides local state), :361-362 (voice.install.status)
- what: Once installState.error is set, every capabilities and status reply reports local as unavailable with that stale error, and it is cleared only by starting another in-app install.
- why: Models installed afterwards from the CLI (voice install) are invisible to the phone and to voice.session.start until the Gate restarts or the user re-runs the install from the phone.
- fix: Re-check install?.status() / voiceStatus() when the error is set, instead of trusting the stale error string.

#### [LOW][QUALITY] speechChunks is dead in the Gate and does not bound a single long sentence
- where: gate/core/voice/sentences.mjs:68-86 (no non-test caller under gate/ outside this file; the reply-splitting path for the Gate uses completeSentenceLength in voice-session.mjs), :76-80 (a sentence longer than maxLength is pushed as one oversized chunk)
- what: speechChunks() is exported and implies a maxLength bound, but a sentence longer than maxLength (or a reply with no punctuation) is emitted whole.
- why: Dead code drifts from its src/ twin (src/lib/voice/speech-chunks.ts), and anyone who wires it up gets chunks larger than the engine's maxSpeechInputLength.
- fix: Delete it from the Gate if unused, or split oversized sentences at whitespace before emitting chunks.

#### [LOW][SECURITY] Unsanitized query and request values are written raw into the Gate log
- where: gate/core/voice/media-socket.mjs:164-167 (voiceSessionId from the query string logged verbatim); gate/core/voice/voice-rpc.mjs:433 (params.reason logged verbatim)
- what: Both values are interpolated into console lines with no escaping, and URL-decoding turns %0A into a real newline.
- why: A crafted voiceSessionId or reason can forge additional log lines on the Gate console and in the audit trail.
- fix: Truncate and strip control characters from these values before logging, or JSON-encode them.

#### [LOW][BUG] A synchronous throw from streamEvents fails the turn despite the telemetry-only feed contract
- where: gate/core/voice/turn-runner.mjs:566-569 (streamEvents called outside the try), :576-579 (only the promise rejection is handled), :576-578 comment ("A feed that fails is telemetry, not a turn failure")
- what: `backend.streamEvents(...)` is invoked outside the try block at :581, and only its returned promise is guarded.
- why: A backend whose streamEvents throws synchronously aborts the whole turn through the outer catch (:688-693), even though the comment promises feed failures never fail a turn.
- fix: Wrap the streamEvents call in try/catch and route the failure to warnTelemetry() as the async path does.

### gate/voice-worker/run-tests.mjs ... modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/HandsfreeRecognizerErrorsTest.kt

#### [MED][FUNC] Send earcon plays only on the first send of each service instance
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:755-766
- what: `pool.load` runs only while `earconId == 0`, but `pool.setOnLoadCompleteListener { ... pool.play(...) }` is re-armed on every `playSendEarcon()` call. After the first load completes, later calls never fire the load-complete callback, so nothing plays.
- why: Every send after the first in a service's lifetime is silent, even though the earcon is meant to confirm each send.
- fix: Track the loaded state and play directly when the sample is already loaded, or set the load listener once when the pool is created.

#### [MED][FAILURE] Unbounded retry loop for ERROR_CLIENT and ERROR_RECOGNIZER_BUSY
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeRecognizerErrors.kt:15-16; modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:488-492 (BUSY_RETRY_MS at line 1069); test pin at modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/HandsfreeRecognizerErrorsTest.kt:20-23
- what: `classify` returns RETRY_LATER for CLIENT and BUSY regardless of `consecutiveFailures`, unlike the network errors that escalate to FATAL after `MAX_TRANSIENT_FAILURES`. `onError` keeps incrementing `consecutiveRecognizerFailures` and reposts a restart after `BUSY_RETRY_MS * n`, and the test asserts RETRY_LATER at 5 failures.
- why: A persistently busy or client-failed recognizer keeps the call in a silent retry loop with delays growing toward tens of seconds and never reaches fatalError, so the operator sees a call that is nominally listening and never hears anything.
- fix: Route CLIENT and BUSY through the same `MAX_TRANSIENT_FAILURES` cap used for network errors and end the call with fatalError past it.

#### [MED][FAILURE] PlaybackLoop swallows every throwable, so a dead AudioTrack goes unreported
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/PlaybackLoop.kt:32-33 (consumer at modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeGateMedia.kt:279-285)
- what: `catch (_: Throwable) { // A dead AudioTrack ends this call's playback }` ends the loop with no callback, log or error frame.
- why: When the AudioTrack dies mid-call, the thread exits, the JS side keeps showing "Speaking", and no fatal error reaches the call or the Gate, so replies play silently with nothing to recover from.
- fix: Keep the throwable from escaping, but report it through a failure callback so `HandsfreeGateMedia` can emit a fatal media error frame.

#### [MED][QUALITY] Endpointing policy is half-wired: unused constructor params, unused no-speech timeout, and the no-speech decision is never made here
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeEndpointing.kt:18-19 (unused `possiblyCompleteSilenceMs`, `minimumSpeechMs`), :36-40 (`reset`), :69 (`classifySilence`), :72-75 (`silenceElapsed`), :87 (`NO_SPEECH_TIMEOUT_MS`); usage in modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:510-515 and :551-562
- what: The class doc says the service uses it to decide finished turn versus no speech, but the service decides from the `onResults` text, and nothing in production calls `classifySilence`, `silenceElapsed`, `reset`, or reads `NO_SPEECH_TIMEOUT_MS`. `onVoice` marks `heardSpeech` on any single sample, so the 300 ms minimum-speech rule is not applied to the ceiling decision.
- why: The documented 10 s no-speech timeout (pinned by HandsfreeEndpointingTest line 15) is never enforced, so the policy the doc describes is not what runs.
- fix: Enforce the no-speech timeout and minimum-speech rule in the service, or delete the unused members and correct the class doc.

#### [MED][SECURITY] Signed launch link is replayable for 30 days and accepts future timestamps indefinitely
- where: modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeLaunchKey.kt:38-39, 61-64; modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeVoiceModule.kt:219-227
- what: `verify` only rejects `now - ts > MAX_AGE_MS`, with no nonce, no consumed-link record and no lower bound on `ts`. A link with `ts` in the future passes that check for as long as the signature holds.
- why: Any captured `versutus://call` link (from a logged intent, a shared URL or the clipboard) can re-open the microphone for up to 30 days, which is the exact threat the §4.4 signing is meant to block.
- fix: Record consumed `ts`/sig values in app storage, shorten the window, and reject `ts` beyond now plus a small clock-skew allowance.

#### [MED][FAILURE] Stale control.json "stop" shuts down the next supervisor after a `service stop` that did not consume it
- where: gate/cli.mjs:704-718 (serviceStop writes control at 709 and never removes it), 754-758 (serviceStart, no cleanup); consumer at gate/cli.mjs:666-690 (poll reads and deletes control at 669 and 677)
- what: `serviceStop` writes `{action:'stop'}` to control.json and waits up to 20 s. If no supervisor consumed it (already dead or hung), the file stays, and `serviceStart` does not clear it, so the next supervisor's first poll reads 'stop' and exits.
- why: After `service stop` on a dead supervisor, `service start` brings the Gate up and it is torn down within about 2 s, staying down until the 5-minute Scheduled Task trigger relaunches it.
- fix: Delete control.json in `serviceStart` (and at the end of `serviceStop`), or stamp control requests with a time and ignore stale ones.

#### [MED][SECURITY] Legacy flavor codecs ignore apiKey and emit no auth; the legacy proxy route sends unauthenticated requests
- where: gate/flavors/openai.mjs:20-49 (`apiKey` unused); gate/flavors/anthropic.mjs:7-8 (doc says `x-api-key` is set), :29-58 (only `anthropic-version` set); gate/core/server.mjs:785-804 (apiKey computed, passed, unused), :804 (`fetch` uses `upstreamRequest.init` with no auth), :2078-2081 (fallback to `proxyChat` when no v2 record)
- what: Both `buildChatRequest` functions accept `apiKey` and never place it in a header. Only the profile path in gate/core/providers/profiles/registry.mjs:98-103 adds auth, and `proxyChat` sends the flavor init as-is.
- why: A provider that exists only in the legacy registry (no v2 record, so `dispatchChat` falls back to `proxyChat`) reaches the vendor with no credential and fails with 401 on every call. The codec doc claiming `x-api-key` is also wrong.
- fix: Route the legacy fallback through the profile's `authHeaders`, or remove the legacy fallback and fix the flavor docs.

#### [LOW][QUALITY] add-environment does not guard `store.put`, unlike add, so validation failures surface as "Fatal error"
- where: gate/cli.mjs:189-212 (no try around `store.put`), compare :91-114 in `handleAdd`; top-level handler at :981-984
- what: `handleAddEnvironment` awaits `store.put`, which throws on schema validation (e.g. a missing `--root` value stored as an undefined root), with no try/catch. The error reaches `main().catch` and prints `Fatal error: ...`, while `handleAdd` wraps its put and prints a usage-style message.
- why: Inconsistent error handling; a bad `--root` gives a generic fatal message instead of the command's usage text.
- fix: Wrap the put in try/catch with the same error style as `handleAdd`, and validate that `--root` and `--path` have values before use.

#### [LOW][QUALITY] Duplicated Windows user-name logic in two places
- where: gate/cli.mjs:552-554 (`serviceUser`) and :800 (`handleDoctor`)
- what: `handleDoctor` recomputes `DOMAIN\USER` inline instead of calling `serviceUser()`, and the two can drift.
- why: Two copies of the same rule for the same value; a future change to one will silently leave the other behind.
- fix: Call `serviceUser()` from `handleDoctor`.

### modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/HandsfreeStartOwnershipTest.kt ... modules/versutus-widget/src/VersutusWidgetModule.ts

#### [MED][BUG] iOS tap appends audio to a request already ended by endAudio
- where: modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:360-363 (endAudio at :366 and :369)
- what: `request.append(buffer)` runs before the `if isFinishingTurn { return }` check, so the check only skips the endpointing branch below it.
- why: Once a turn is finishing, every later tap buffer (about every 23 ms) is still appended to a request that was already closed with `endAudio()`, until the final result arrives. The guard does not do what its position suggests.
- fix: Move the `if isFinishingTurn { return }` check above `request.append(buffer)`.

#### [MED][FAILURE] iOS failed start leaves the audio session active
- where: modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:144 (activate), :162-165 and :311 (failure returns), :742 (endLocked early return)
- what: `activateAudioSession()` sets the AVAudioSession active before `startEngineIfNeeded()` runs. When that returns false (engine start failure or the zero sample-rate guard at :311), `startSession` only sets `sessionActive = false` and resolves "unavailable".
- why: `endLocked` returns early when `sessionActive` is false (:742), so `setActive(false)` is never called. A failed start keeps a playAndRecord voice-chat session active for the rest of the process, interrupting other audio.
- fix: Deactivate the session in the failure branches (or in one shared failure helper), mirroring the tail of `endLocked`.

#### [MED][BUG] iOS endpointing test fails on Double rounding
- where: modules/handsfree-voice/ios/Tests/HandsfreeEndpointingTests.swift:18
- what: The test calls `onVoice(at: 1.0)` and then asserts `shouldFinishForSilence(at: 1.9)` is true, with `completeSilence` 0.9.
- why: In Double, `1.9 - 1.0` is 0.8999999999999999, which is below 0.9, so `now - last >= completeSilence` is false and `XCTAssertTrue` fails on every run.
- fix: Use a sample time such as 2.0 (or 1.95), or compare with a tolerance.

#### [LOW][FAILURE] iOS termination teardown is only queued, not run
- where: modules/handsfree-voice/ios/HandsfreeVoiceAppDelegateSubscriber.swift:12; modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:723-729
- what: `applicationWillTerminate` calls `teardown`, which calls `end`, which dispatches `endLocked` with `audioQueue.async`.
- why: The process can exit once `applicationWillTerminate` returns, before the queued block runs. The mic and audio-session release that the subscriber exists for is then not guaranteed.
- fix: Run `endLocked` via `audioQueue.sync` on this path (safe, since audioQueue never blocks waiting on main), or release the session directly.

#### [LOW][QUALITY] Endpointing "Ms" constants are in seconds
- where: modules/handsfree-voice/ios/HandsfreeEndpointing.swift:17, :19, :21 (init parameters :36-38)
- what: `completeSilenceMs = 0.9`, `noSpeechTimeoutMs = 10` and `utteranceCeilingMs = 60` are `TimeInterval` values in seconds.
- why: The names say milliseconds, so anyone mirroring these values by name (the file says it mirrors Android) can make a 1000x error.
- fix: Rename to `...Seconds`, or state the unit in the name and comment.

#### [LOW][QUALITY] Bare-quote check in JSON escape test is too weak
- where: modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/JsonEscapeTest.kt:46-48
- what: The loop accepts a `"` when the preceding character is a backslash.
- why: A raw quote right after an escaped backslash (`\\"`) passes this check, so a regression that leaves a bare quote there goes undetected.
- fix: Walk the string as escape tokens (as the test's own `unescape` does) and flag any `"` not consumed by an escape.

#### [LOW][QUALITY] Refresh-interval test pins a function production never calls
- where: modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetRefreshWorker.kt:32 and :35; modules/versutus-widget/android/src/test/java/com/versutus/widget/WidgetRefreshPolicyTest.kt:7-9
- what: `WidgetRefreshPolicy.intervalMinutes()` is referenced only by its test. `enqueue` builds the request from the `HOURS` constant (:35).
- why: "the refresh runs every six hours" passes whatever period `enqueue` actually uses, so a change to `HOURS` or the builder call is not caught.
- fix: Build the periodic request from the same function the test checks, or delete the unused function and assert the interval on the enqueued request.

#### [LOW][PERF] Periodic widget refresh is never cancelled
- where: modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetRefreshWorker.kt:34-40; VersutusWidgetModule.kt:43 and :50-54; VersutusStatusReceiver.kt:6-8
- what: `enqueue` runs on every `setPayload`, and nothing cancels the unique work. The receiver does not override `onDisabled`, and `clearPayload` does not cancel it.
- why: After the last widget is removed, or the gateway is cleared, a no-network worker keeps waking the device every six hours to redraw zero widgets, with no end.
- fix: Call `WorkManager.cancelUniqueWork(WidgetRefreshPolicy.uniqueName())` from `onDisabled` and from `clearPayload`.

#### [LOW][FUNC] "Today" and "Yesterday" labels can lag by up to six hours
- where: modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetRefreshWorker.kt:14-15 and :29; WidgetStamp.kt:30-32
- what: The day label is recomputed only when the card is drawn, which happens on a JS write or on the six-hour tick.
- why: A card written in the evening keeps reading "Written Today HH:mm" until the next tick after midnight, although the worker comment says the timer exists so "Today" becomes "Yesterday".
- fix: Schedule the next redraw at local midnight, or use a shorter period, so the label rolls over on time.

#### [LOW][QUALITY] Pin-save failure is shown but never logged
- where: modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetConfigureActivity.kt:89-90
- what: The `catch (error: Exception)` shows a generic Toast and discards the exception without logging it.
- why: A failure in `updateAppWidgetState` or `getGlanceIdBy` (for example, a widget removed mid-save) leaves nothing in logs, so a "could not save" report cannot be diagnosed.
- fix: Log the exception (Log.w or Log.e with the throwable) before showing the Toast.

### plugins/with-openclaw-discovery.js ... eslint.config.js

#### [MED][BUG] Live smoke reports a stop check as PASS whether or not the stop succeeded
- where: scripts/smoke-live-gateway.mts:201-202
- what: `await withTimeout('POST runs/stop', ...)` discards its result, then `check('runs.stop accepted', true)` runs unconditionally.
- why: when the stop call fails or times out, `withTimeout` logs a FAIL line but the harness still records a passing `runs.stop accepted` check, so the failure is hidden in the summary.
- fix: keep the stop result and check it (for example, `check('runs.stop accepted', result !== null)`).

#### [MED][BUG] Live smoke prints "All live checks passed." when no token was found and the authenticated checks were skipped
- where: scripts/smoke-live-gateway.mts:256-258, 340
- what: with no key, the connect path, capability checks and surface checks are reduced to a `[SKIP] no token available` line. `failures` stays 0, so the final line is `All live checks passed.`
- why: an operator without a token gets a green summary for a run that exercised none of the authenticated surfaces.
- fix: count skipped-for-missing-token as a failure (or print a distinct "NOT RUN" result and a non-zero exit code).

#### [MED][BUG] Handsfree native-config checks pass vacuously when the native files are missing or the service tag is removed
- where: scripts/verify-config.mts:250, 264, 266-289, 291
- what: `serviceManifest` and `serviceSource` default to `''` when the files do not exist. The forbidden-declaration checks run against `''` and pass, and the service-attribute block is gated on `if (serviceManifest.includes('<service'))`, so it emits neither pass nor fail when the `<service` tag is absent.
- why: deleting or moving `HandsfreeCallService` (or its manifest) silently turns the "microphone-only, non-exported, stop-with-task" guard into a green check.
- fix: fail when either native file is missing and when the manifest has no `<service` declaration.

#### [MED][BUG] Worklet-call check skips every import that is not an `@/` alias
- where: scripts/verify-config.mts:387-392
- what: `if (!spec.startsWith('@/')) continue;` drops relative specifiers (`./x`, `../x`) before resolution, and the target lookup only tries `.ts/.tsx` and `index` files.
- why: a worklet that calls a helper imported via a relative path, or from a `.js/.mjs` module, is never inspected, so the exact Android force-close class this check exists for can pass the gate.
- fix: resolve relative specifiers against the importing file's directory and accept all module extensions the bundler resolves.

#### [MED][BUG] Orphaned-context-key check counts a key as consumed if its name appears anywhere in the consumer source
- where: scripts/verify-config.mts:178-185
- what: `new RegExp('\\b' + key + '\\b').test(consumers)` runs over the concatenated text of every file under `src/app`, `src/components` and `src/hooks`, including comments and string literals.
- why: a dead context key with a common name (for example `status`, `error`, `refresh`) matches some unrelated occurrence and is reported as consumed, so the check cannot catch the `tlsFingerprintChange`-style orphan it was written for.
- fix: check for member access or destructuring from the context hook (for example `useGateway()` destructuring), not for a bare word match.

#### [MED][FAILURE] Signoff leg timeout can never fire on Windows, so a hung `npm run verify` blocks the whole run
- where: scripts/smoke-signoff.mjs:65, 71-78, 117
- what: legs are spawned with `shell: true`, so on Windows the child is `cmd.exe`. The timeout calls `child.kill()`, which only kills the shell, and the promise waits for `'close'`.
- why: `'close'` does not fire until the piped stdio of every grandchild (`npm`, `node`, jest) closes. Any grandchild that survives the shell kill keeps the promise pending, so the 25-minute `verify` timeout is ineffective and the sign-off run never finishes or records a row.
- fix: kill the whole tree (`taskkill /T /F /PID`) on timeout, or resolve on `'exit'` after the timeout instead of waiting for `'close'`.

#### [MED][SECURITY] Plist disables App Transport Security for every request, not just the Gate hosts
- where: plugins/with-openclaw-discovery.js:16-20
- what: `NSAppTransportSecurity` is set to `NSAllowsArbitraryLoads: true` alongside `NSAllowsLocalNetworking: true`.
- why: this turns off the TLS requirement for all network traffic from the shipped iOS app, including any HTTPS-less request to a third-party host added later. The comment only justifies the Gate's plain-HTTP LAN/tailnet use.
- fix: keep `NSAllowsLocalNetworking`, and add `NSExceptionDomains` entries for the specific Gate hostnames (the comment says wildcards are not possible, but the concrete tailnet host can be listed).

#### [MED][SECURITY] Desktop agent prints the operator bearer token to stdout and stores it in plain text
- where: scripts/register-desktop-agent.mjs:46-55, 58-63
- what: the grant response's `token` is copied into the `out` object and `console.log`-ed as JSON, and the same token is written in plain JSON to `gate/.grok-desktop-device.json`. The granted role carries `terminal:use` and `sessions:manage`.
- why: anyone with terminal scrollback, CI logs or shell history can take an operator-level credential that the script never needed to echo. Cross-file note: the Gate's replay branch (gate/core/server.mjs:2313-2318) returns the existing token to any sender of a captured signed access body, so the token is reachable by replay on the plain-HTTP link.
- fix: print only the device id and status, and write the token file with owner-only permissions.

#### [MED][FAILURE] Replay probe deadline is only checked between reads, so a stalled stream hangs forever
- where: scripts/replay-probe.mjs:60-62, 141-143, 111, 186-193
- what: the 150-second deadline is tested before each `reader.read()`, but the `await reader.read()` itself has no timeout. The initial `fetch` calls (lines 111 and 186) have no timeout either.
- why: if the Gate stops sending bytes mid-stream without closing the connection, the probe blocks indefinitely and the sign-off evidence step never completes.
- fix: race each read against a timer (or use `AbortSignal.timeout` on the fetch) so the deadline is enforced while blocked.

#### [LOW][BUG] Worklet-call check passes even when it inspected zero worklet bodies
- where: scripts/verify-config.mts:375-376, 402-403
- what: the body extraction depends on a `code:"..."` pattern in Babel output. If that pattern does not match, `inspected` stays 0, and the final branch still prints a pass ("0 cross-module worklet call(s), all workletized").
- why: a Babel or worklets plugin output change silently turns this gate into a no-op.
- fix: fail when `inspected === 0` for a codebase that has worklet hooks.

#### [LOW][BUG] Replay "identical to live" check compares only event type names, and the first-frame check passes vacuously when the live stream is empty
- where: scripts/replay-probe.mjs:76-84, 199-205
- what: `kinds()` reduces frames to `type`/`event` names, and the comparison at line 205 uses those names only. The header claims "identical frame for frame". Line 200-203 compares `kinds(repFrames)[0] === kinds(liveFrames)[0]`, which is `undefined === undefined` when the live stream failed to produce frames.
- why: payload or sequence differences are never detected, and a failed live stream can still show a green "first frame matches" line.
- fix: compare sequence numbers and payloads (or a normalised JSON of each frame), and require `liveFrames.length > 0` before comparing.

#### [LOW][BUG] Wedge loop replay check compares only event types, despite the "replays identically" claim
- where: scripts/smoke-wedge-loop.mjs:300-306
- what: the check compares length and `event.type` only, then prints "replays identically from sequence 1".
- why: a replay that returns the same types with wrong sequence numbers or payloads still passes, so the leg proves less than its pass line says.
- fix: compare `sequence` and a payload digest for each event, as the restart leg already does for sequence start only.

#### [LOW][BUG] Cancel-proof process scan silently degrades to root-pid only when PowerShell fails
- where: scripts/smoke-wedge-loop.mjs:178-184, 362, 384
- what: `safeDescendants` catches every error and returns `[]`, so the watched descendant set is empty without any log line.
- why: on a real CLI run where the process probe breaks, the leg still reports "cancel landed ... verified gone" and the orphan-tree proof the comment promises is quietly dropped.
- fix: record the probe failure and fail the leg (or at least print a warning) when the descendant scan errors on Windows.

#### [LOW][BUG] Smoke assertion for an escaped workspace path sends a malformed path and accepts any non-200 status
- where: scripts/smoke-cli-environments.mjs:66, 71
- what: the literal `'C:\\\\Windows\\\\System32'` produces a string with doubled backslashes, not `C:\Windows\System32`. The check is `if (rejected.status === 200) throw`, so a 400, 500 or crash-driven error also passes.
- why: the test does not prove that the real escape path is refused, and it would pass if the Gate started returning 500 for every run.
- fix: use the intended path (`'C:\\Windows\\System32'`) and assert the specific refusal status and code.

#### [LOW][FAILURE] Gate server is never closed when the provider smoke fails midway
- where: scripts/smoke-provider-runtime.mjs:51-58, 60, 70-73
- what: `gate` is closed only on the success path (line 58). The `finally` block closes the upstream server and deletes the temp root but not `gate` or `again`.
- why: a failed listing (line 55-56) or secret-leak assertion leaves the Gate listening, which can keep the Node process alive and block the next run on the same port.
- fix: move both gates into the `try` and close them in `finally`.

#### [LOW][FAILURE] Temp directory leaks when the Gate fails to start
- where: scripts/smoke-cli-environments.mjs:11-16, 18
- what: `mkdtemp` and the directory setup run before the `try`, and `createGate` on line 16 is also outside it, so `finally` (which deletes `root`) is never reached if `createGate` throws.
- why: every failed start leaves a `smoke-cli-*` directory in the OS temp folder.
- fix: move `createGate` inside the `try` (or wrap setup in its own try/catch that removes `root`).

#### [LOW][FAILURE] Spawned `codex app-server` process is leaked if the RPC wrapper fails to construct
- where: scripts/voice-spikes/s1-codex-realtime.mjs:79-81, 103-157
- what: `spawnAppServer` runs before `createStdioJsonRpc`, and both happen before the `try/finally` that calls `killTree(child)`.
- why: a throw from `createStdioJsonRpc` leaves the child process running, which holds the stdio pipes and can keep the spike process alive.
- fix: move the RPC construction inside the `try`, or kill the child in a catch around the spawn/construct sequence.

#### [LOW][FAILURE] Signoff writes the §F evidence matrix in place, so a crash mid-write truncates it
- where: scripts/smoke-signoff.mjs:281-283
- what: `copyFile` writes a backup to the OS temp directory, then `writeFile(MATRIX_PATH, nextContent)` truncates and rewrites the live matrix directly.
- why: an interrupted write (Ctrl+C, power loss) leaves the evidence matrix partially written, and the only other copy is in a temp folder the OS may clear.
- fix: write to a temp file in the same directory and `rename` it over the matrix.

#### [LOW][FAILURE] Unguarded `readFile` in the async request handler can crash the demo server
- where: scripts/serve-web-demo.mjs:118, 129
- what: the `createServer` callback is `async`, and `await readFile(file)` is not inside a try/catch, so any read error rejects an unhandled promise.
- why: a file that is removed or becomes unreadable between `stat` and `readFile` (for example, `export:web` rebuilding `dist/` during a demo) makes Node exit on the unhandled rejection, which kills the whole sign-off demo server.
- fix: wrap the handler body in try/catch and return 500 on error.

#### [LOW][QUALITY] Non-numeric `--port` skips the documented configuration error path
- where: scripts/serve-web-demo.mjs:20, 39
- what: `Number(optValue('--port') ?? 8090)` yields `NaN` for a non-numeric value, and nothing validates it before `server.listen`.
- why: the header promises exit code 2 for configuration errors, but a bad port throws an uncaught `ERR_SOCKET_BAD_PORT` (exit 1) with a stack trace instead.
- fix: validate the port is an integer between 1 and 65535 before binding and exit 2 with a message.

#### [LOW][FAILURE] Reset script reports errors but exits 0, and a failed move leaves the project half-reset
- where: scripts/reset-project.js:50-53, 98-100
- what: any error in `moveDirectories` is caught and printed with `console.error`, and the process exits normally. The moves for `src` and `scripts` run one after another, so an earlier successful rename can leave `example/` and the new `src/app` in a mixed state.
- why: a CI or wrapper script sees success for a half-applied reset, and nothing reports which directories were moved.
- fix: set `process.exitCode = 1` in the catch and report which directories completed.

#### [LOW][FAILURE] Desktop agent has no timeout on the grant request and crashes on a non-JSON answer
- where: scripts/register-desktop-agent.mjs:40-45
- what: `fetch` has no `AbortSignal`, and `response.json()` is awaited at top level without a catch.
- why: a Gate that accepts the connection but never answers hangs the script, and a plain-text error page crashes it with an unhandled SyntaxError instead of printing the HTTP status.
- fix: add `signal: AbortSignal.timeout(...)` and parse with a try/catch that reports `response.status`.

#### [LOW][SECURITY] Each run of the desktop agent mints a new device key and a new operator token, and never revokes the previous one
- where: scripts/register-desktop-agent.mjs:16-20, 58-63
- what: the Ed25519 private key is generated fresh and discarded at the end of each run, so the derived `deviceId` is new every time. The script overwrites `gate/.grok-desktop-device.json` but never revokes the earlier device's token.
- why: repeated runs accumulate live operator-role tokens that nothing in the repo tracks or expires, widening the window for any leaked one.
- fix: persist the private key with the device record and reuse it, or revoke the previous device token before issuing a new one.

#### [LOW][FUNC] Wrapping the stream drops `--runs` silently, so a missing value produces zero samples and a passing `--check`
- where: scripts/voice-spikes/latency-harness.mjs:67, 145-147, 44-45
- what: `args.runs = Number(argv[++i])` yields `NaN` when the value is missing. `Math.max(1, NaN)` is `NaN`, so the loop runs zero times, `percentile([])` returns 0, and `compareToBaseline` reports `ok`.
- why: `--check --runs` (with no number) is reported as a passing latency check with no measurement at all.
- fix: validate `--runs`, `--tolerance` and any numeric option, and fail on empty samples.

#### [LOW][BUG] `--save` replaces the whole baseline document, deleting the other engines' entries
- where: scripts/voice-spikes/latency-harness.mjs:152-160
- what: `document` is rebuilt from scratch with only `engines: { [args.engine]: ... }`, and the existing file is not read first.
- why: saving a baseline for one engine silently deletes the stored baselines for every other engine and resets `status` to `PENDING-DEVICE`.
- fix: read the existing document and merge the new engine entry into `engines`.

#### [LOW][QUALITY] Latency harness timers are never cleared, so each run keeps the process alive for 20 seconds
- where: scripts/voice-spikes/latency-harness.mjs:113, 118-120
- what: the 20-second `setTimeout` for the timeout error is created after the send loop and never cleared when the measurement finishes.
- why: each run's timer keeps the event loop busy, so the script waits up to 20 seconds per run before exiting even after a successful measurement.
- fix: store the timer id and `clearTimeout` it inside `finish`.

#### [LOW][FUNC] Live smoke's direct-invocation check fails silently when the script is reached through a symlink
- where: scripts/live-smoke.mjs:290-291
- what: `invokedDirectly` compares `fileURLToPath(import.meta.url)` (the realpath) with `process.argv[1]` (the path as typed). When they differ, `main()` never runs and the script exits 0 with no output.
- why: a symlinked or junctioned checkout reports nothing and looks like a pass in CI.
- fix: compare `realpathSync(process.argv[1])` with the module path, or always run when not imported.

#### [LOW][BUG] Durable-turn "phone leaves mid-turn" check can trigger on the role-only first frame, before any words arrive
- where: scripts/live-smoke.mjs:177-179
- what: `sawWords` is set when any chunk contains `"content"`, which also matches role-only or empty-content frames that carry no reply text.
- why: the probe can drop the connection before the model has produced output, while the leg still reports that the turn "survived the phone leaving mid-turn".
- fix: test for a non-empty `delta.content` by parsing the frame, as `streamedTurn` already does.

#### [LOW][QUALITY] Smoke-portal header points to a file that does not exist
- where: scripts/smoke-portal.mts:5
- what: the run instruction says `npx tsx scripts/smoke-portal.ts`, but the file is `scripts/smoke-portal.mts`.
- why: copying the command fails with "file not found", which is the first thing a new operator runs.
- fix: change the comment to `scripts/smoke-portal.mts`.

## Burn-down batch 1 (rh run)

Verified against HEAD 732e297 (worktree `rh/20261017-2130-versutus-vs-004-burn-down-the-fir`). The scan was drafted on master @ 51bd074; in the 61 commits since, 53d69ca / e80d1c3 / 07613e9 / e637ab2 / 66a44af already landed fixes with regression tests for 12 of these 14 [MED] entries. No source change was needed; the two still-real entries both need work outside the allowed scope. Every entry in lines 203-440 was opened at its cited file:line.

- #### [MED][BUG] Connection monitor stays suspended after a healthy foreground return — STALE: `attemptConnect`'s success path now calls `monitor.noteConnected()`, `monitor.resume()` and `monitor.start()` (src/lib/gateway/client.ts:284-288), and the healthy foreground branch calls the new `client.resumeMonitoring()` (src/context/gateway-provider.tsx:6042-6045); the manifest/openclaw clients expose it too. Pinned by __tests__/gateway-connect-cancel-safe-test.ts:363-398.
- #### [MED][BUG] connect() joins a stale attempt after disconnect and resolves without connecting — STALE: `disconnect()` now clears `this.connectAttempt = null` alongside the epoch bump (src/lib/gateway/client.ts:291-295), so a post-disconnect connect starts fresh. Pinned by __tests__/gateway-connect-cancel-safe-test.ts.
- #### [MED][FUNC] Bot edit form cannot clear a Bot's description — DEFERRED: still real, but the correct fix belongs in the edit sheet (src/components/chat/new-agent-sheet.tsx:225 folds a blank description to `undefined`, and its copy at :106 promises blank = leave unchanged); that is src/components, out of scope. The Gate only removes the line when it receives `description: ''` (gate/core/cli-environments/hermes-bot-edit.mjs:115-125), and `bots.ts` never sees the blank, so an in-scope `bots.ts` change alone would contradict the sheet's stated contract. Needs a product/UX decision plus a component edit.
- #### [MED][FAILURE] Documented run-cancel fallback does not exist; failed server-side stop is swallowed — DEFERRED: unchanged today — `serverSideCancelForCommand` still discards the rejection (src/lib/gateway/cancel.ts:26-36) and no `requestStop` exists; the two callers in src/context/gateway-provider.tsx (:5008, :6104) still patch the row to `cancelled`. Implementing the documented re-ask or surfacing the refusal is a src/context change and a product decision, both out of scope.
- #### [MED][BUG] Spend-cap parser strips every comma, so "1,5" becomes 15 — STALE: `parseSpendCapInput` now accepts commas only in valid thousands groups and returns `undefined` otherwise (src/lib/gateway/budgets.ts:66-73). Pinned by __tests__/budgets-test.ts:72-81 ("a comma that is not a thousands separator is refused").
- #### [MED][BUG] Number config field silently saves 0 for empty or non-numeric input — STALE: `parseFieldValue` returns `undefined` for empty or non-finite number text (src/lib/gateway/capability-form.ts:56-63), and `numberFieldError` refuses junk and empty-required (src/lib/gateway/capability-form.ts:44-50). Pinned by __tests__/capability-form-test.ts:48-62 and __tests__/capability-number-field-test.tsx.
- #### [MED][FUNC] Editing an environment silently collapses its additional workspace roots — STALE: the patch keeps `existing.workspacePolicy.roots` and swaps only the default via `rootsWithDefault` (src/lib/gateway/environment-client.ts:191-199, :229-243). Pinned by __tests__/environment-client-test.ts.
- #### [MED][BUG] Auth heuristic runs before run-failure classification, so a provider 401/403 is blamed on the gateway token — STALE: `describeRunFailure(message)` is computed first and the auth branch is taken only when `failureView.kind === 'generic'` (src/lib/gateway/error-humanizer.ts:145-160). Pinned by __tests__/error-humanizer-test.ts.
- #### [MED][FAILURE] Imported packet without `excluded` throws during render and breaks the import screen — STALE: `botHandoffFromUnknown` now normalizes every packet field, defaulting `excluded`/`routines`/`skills`/`chrome` to `[]`/`[]`/`[]`/`{}` (src/lib/gateway/handoff.ts:98-120), so `[...packet.excluded]` at handoff-import.ts:112 cannot throw. Pinned by __tests__/handoff-test.ts and __tests__/handoff-import-test.ts.
- #### [MED][BUG] @mentions match email addresses, so an email sends a handoff to a Bot — STALE: `startsMention` requires the `@` to be at the start or preceded by a non-address character (`ADDRESS_LOCAL_CHAR`), in both `extractMentions` and `mentionTokenAtCaret` (src/lib/gateway/mentions.ts:3-10,:21,:56). Pinned by __tests__/mentions-test.ts.
- #### [MED][BUG] Reconciling interrupted bubbles can put the same history turn in the list twice — STALE: a `placed` id set excludes already-matched history turns and each match is added to it (src/lib/gateway/message-reducer.ts:368-386). Pinned by __tests__/message-reducer-test.ts.
- #### [MED][FAILURE] A request sent while the socket is null is silently dropped and hangs for its full timeout — STALE: `request()` now rejects immediately when `this.socket` is null (src/lib/gateway/openclaw-client.ts:277-285), and `resumeReconnect` re-dials a client whose socket dropped while suspended. Pinned by __tests__/openclaw-client-liveness.test.ts.
- #### [MED][BUG] A connect() issued after disconnect() joins a stale attempt and resolves without connecting — STALE: `ManifestClient.disconnect()` now clears `this.connectAttempt` with the epoch bump (src/lib/gateway/manifest-client.ts:307-311). Pinned by __tests__/gateway-connect-cancel-safe-test.ts and __tests__/manifest-client-test.ts.
- #### [MED][BUG] streamChat HTTP refusals lose their status and code, so auth rejections are misclassified — STALE: the non-ok branch now throws `new GatewayHttpError(messageFromHttpErrorBody(...), response.status, errorCodeFromHttpBody(...))` (src/lib/gateway/manifest-client.ts:569-575), matching HttpTransport. Pinned by __tests__/chat-error-envelope-test.ts and __tests__/manifest-client-test.ts.

No [MED] entry in the range needed a code change: 12 were already fixed upstream (each with a regression test), and 2 remain real but require src/components / src/context edits or a product decision, so they are recorded DEFERRED rather than changed.

