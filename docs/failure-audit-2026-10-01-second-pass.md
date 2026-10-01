# Failure audit 2026-10-01 - second pass (scan results and landed fixes, work in progress)

Companion to [failure-audit-2026-09-30.md](failure-audit-2026-09-30.md) (round 1) and its [fix log](failure-audit-2026-09-30-fixes.md) / [final report](failure-audit-2026-09-30-report.md).
Round 2 scanned the areas round 1 had not read: the OpenClaw client, the Gate's provider/OAuth/credential code, the rest of the Gate (CLI-environment backends, supervisor, Bots, voice worker, service),
the hands-free voice module (Android Kotlin, iOS Swift, JS), the Android widget and config plugins, phone notifications, and the non-chat screens.
Each scan was written by a free `opencode` model, then **independently verified by a second model session that re-read the cited code** (it confirmed 123 findings, corrected several and added the ones marked `-V`);
refuted claims are not listed. Fixes were authored by free models behind a harness the authors cannot edit (typecheck, ESLint, related tests, diff guard) and then reviewed by a separate session;
reviews failed several packages (a defect each reviewer reproduced), and each was repaired and re-reviewed before landing.

**Status of this document:** a checkpoint pushed while round 2 is still running. The scan list below is complete for the nine scanned areas (a tenth - Fleet/Council/Compose/Onboarding - and the per-finding
diagnosis-and-fix log are still being written and will be added to this file). The commits listed here are what has landed so far; every one passed its harness gate and an independent review, and the whole branch was
verified together (`verify-config`, `tsc`, ESLint, full jest with coverage and the ratchet, Gate suite) before this push. Nothing here has been run on a phone, and nothing has been deployed: the live Gate keeps running
its old code until it is restarted from a checkout that has these commits.

## Landed so far

| Commit | Package |
|---|---|
| `c474fa6` | fix(gate): Stop kills the Claude Code child, failed app-server handshakes are reaped, bounded session list |
| `7627c4a` | fix(gate): voice session registry pruning, worker frame retention, audio timer leak, per-call backend resolution |
| `1825045` | fix(gate): service supervisor survives spawn errors, installs process guards, bounds stop probes |
| `563c335` | fix(gate): archive prunes by real start time, finished runs release memory and secrets, bounded token replay set |
| `0072f00` | fix(voice): notification Mute/Unmute really toggles the mic, no speech after teardown, involuntary end reaches JS |
| `7f89ea0` | fix(openclaw): auth rejection stops retries, liveness probe + reconnect reload, identity/token hardening, IPv4 fallback |
| `37e3d56` | fix(gate): atomic environment/provider/instance/Bot writes, single-profile Bot lookup |
| `0280cf2` | fix(widget): refused writes retried, write floor fires, ordered writes, push merges into the last snapshot, removed gateway clears the card |
| `4f9d1cf` | fix(widget): redraw worker scheduled regardless of the first write being refused |
| `fae703a` | fix(gate): vault writes atomically, DPAPI helper is bounded and cached, unreadable credentials are named, redaction covers camelCase tokens |
| `f696847` | fix(settings): app lock reacts to its switch, serialised settings writes, bounded voice install and check, failure-proof privacy toggle |
| `2ff377e` | fix(gate): push replies carry the quick-reply category, widget companion is honest about connection and counts runs, probes keep an environment busy |
| `e82654f` | fix(home): restored runs stay in flight, digest window advances on arrival, unreadable stamp surfaces instead of vanishing |
| `360134c` | fix(gate): providers - disable blocks chat, serialised state commits, bounded vendor calls, honest credential state |
| `00073d2` | fix(openclaw): chat turns always settle, read failures are errors, session continuity across reconnects, stale run frames dropped |
| `001fbc9` | fix(voice): iOS call state resets between calls, progressive speech queues, recogniser failure backs off, guards read on the audio queue |
| `4769620` | fix(portal): OpenClaw probe falls back to the tailnet IPv4, access requests report unreachable instead of denied |
| `94407e4` | fix(notifications): quiet-hours edits survive, live permission, optimistic serialised preference writes, honest permission and error states |
| `bc44045` | fix(activity): pause/resume notices correct, serialised approval audit, single-refresh batch decisions, bounded cron and refresh reads |
| `afc3b82` | fix(notifications): single permission gate, atomic routine re-arm, stale run notices retired, resilient push registration, throttled run progress |
| `329962d` | fix(screens): reachability wave recovers from cancellation, connect/remove failures are shown, drawer roster is shared and honest |
| `958a455` | fix(screens): spend fan-out is one per visit and cancellable, budget writes leave updaters, live runtime check is bounded |
| `f0fbdd1` | fix(ui): every haptic goes through the safe wrapper so feedback can never fail an action |
| `1d89c50` | fix(screens): run sheet cancels on close, capability create cannot strand an instance, Pick file works on SDK 57 |
| `e9a7a8b` | fix(settings): notification Bot filters use the shared cached roster read |

## Findings (where / what fails / why)

### Area: OpenClaw client and portal layer

#### R2-OC-1 · S1 · A turn whose `final` event never arrives hangs the composer forever

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-adapter.ts:187-215`, `src/lib/portal/openclaw-adapter.ts:222-254`,
`src/lib/gateway/openclaw-client.ts:202-217`, `src/context/gateway-provider.tsx:3186-3187`
**What fails:** Send a message on an OpenClaw gateway, then lose the path (radio drop, Tailscale
path change, Gate restart) *after* the `chat.send` acknowledgement arrives but before the `final`
chat event. `isSending` never returns to false, the orb spins forever, the composer is locked, and
no error is ever shown — the only escape is Stop. If the gateway did finish the turn, its answer is
lost to this phone and the bubble is never reconciled.
**Why:** `streamChat` resolves only from `handleChatEvent` (`openclaw-adapter.ts:242-248`), which
fires solely from `onChatEvent` frames; nothing else settles the promise — no timer on the pending
chat, no rejection on socket close or status change. The only rejection path is
`openclaw-adapter.ts:209-213`, i.e. the failure of the `chat.send` RPC itself, whose pending entry
was already resolved by the ack, so `flushPending` in `openclaw-client.ts:205` finds an empty map.
The provider's `finally` (`:3186-3187`) is what clears `isSending`, so a turn that never settles
holds the lock for the life of the process.

#### R2-OC-2 · S1 · No `authRejected` on the WS dialect: a refused credential is retried forever and its message is erased each cycle

**Verification:** confirmed
**Where:** `src/lib/gateway/openclaw-client.ts:407-411`, `src/lib/gateway/openclaw-client.ts:437-447`,
`src/lib/gateway/openclaw-client.ts:479-483`, `src/lib/portal/openclaw-adapter.ts:37-93`,
`src/context/gateway-provider.tsx:1933`, `src/context/gateway-provider.tsx:1962`,
`src/context/gateway-provider.tsx:2173`, `src/lib/connection/phase.ts:72-78`
**What fails:** Pair against an OpenClaw gateway whose stored token or setup token is refused
(`AUTH_TOKEN_MISSING`, `AUTH_TOKEN_NOT_CONFIGURED`, or a pairing state the operator has not
approved). "Gateway requires setup token or pairing approval" appears for one auto-retry interval
and then vanishes; the app goes back to hunting for a gateway and repeats this for the rest of the
session, forever, with nothing on screen naming the cause.
**Why:** `handleTerminalFailure` calls `setStatus('disconnected', message)`
(`openclaw-client.ts:443`) and `setStatus` forwards only two arguments
(`:479-483`), so the provider's third parameter `info` is always `undefined`; `authFailureRef` is
therefore never raised (`:1933`) and the `!authFailureRef` branch schedules an auto-retry every
cycle (`:1962`, `phase.ts:76`). The adapter does not expose the optional `authRejected` the
`PortalClient` interface declares (`src/lib/portal/adapters.ts:38`). The next attempt runs
`connectGateway`, whose `setLastError(null)` (`:2173`) erases the message the `onError` callback had
just set. This is LIFE-2's mechanism on the one dialect the `authRejected` fix (commit `a59aeb2`,
`19de6a2`) never reached.

#### R2-OC-3 · S2 · `healthCheck()` fabricates "ok" without touching the socket, and the monitor is never started

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-adapter.ts:103-106`, `src/lib/gateway/openclaw-client.ts:87-92`,
`src/lib/gateway/openclaw-client.ts:145-167`, `src/lib/gateway/openclaw-client.ts:378-380`,
`src/context/gateway-provider.tsx:4323-4330`
**What fails:** The WebSocket goes half-open (Wi-Fi drop, silent Tailscale path change — the phone
never gets a close frame). The status stays `connected` indefinitely, the UI says connected, the
send button stays enabled, and every request then fails on its own 30 s timer ("Request timed out:
…") while nothing ever declares the gateway unreachable.
**Why:** `healthCheck` returns `{ status: 'ok' }` from `inner.connectionStatus` alone
(`openclaw-adapter.ts:104-105`) — it performs no I/O, so the foreground recovery path
(`gateway-provider.tsx:4323-4328`) treats a dead socket as verified and never calls
`healLiveClient`. The `ConnectionMonitor` is constructed with no `probe`
(`openclaw-client.ts:87-92`), and `monitor.start()` is never called anywhere in the file (only
`stop`/`resume`/`suspend`/`noteConnected`/`scheduleReconnect`), so there is no interval, no nudge
path and no escalation; liveness depends entirely on `onclose`
(`openclaw-client.ts:202-217`), which a half-open socket never delivers. `request` does not help
either: with status already `connected` it skips `waitUntilConnected`, registers the pending entry
and calls `socket.send` (`openclaw-client.ts:154-160`), which silently buffers on a dead socket, so
the failure only materialises as the 30 s timeout at `:150-153`. (`openclaw-adapter` also omits the
optional `nudge`/`forceReconnect`.)

#### R2-OC-4 · S2 · `onHealthCheck` is never called on this dialect, so a reconnect reloads nothing

**Verification:** confirmed
**Where:** `src/lib/gateway/openclaw-client.ts:378-383`, `src/lib/gateway/openclaw-client.ts:87-92`,
`src/context/gateway-provider.tsx:2023-2033`, `src/context/gateway-provider.tsx:1958-1969`,
`src/context/gateway-provider.tsx:1685-1693`
**What fails:** Send a message on an OpenClaw gateway, drop the connection, let it recover. The
thread is never re-read from the gateway and the interrupted bubble is never settled: the orb from
the dead turn stays on screen indefinitely and a reply the gateway finished while the phone was
away never appears.
**Why:** `onHealthCheck` is the provider's only reconnect-time trigger for `reloadHistoryFor` and
`reconcileInterrupted` (`gateway-provider.tsx:2023-2033`), and only `client.ts:253` and
`manifest-client.ts:267` invoke it — the OpenClaw client publishes `onHello` at
`openclaw-client.ts:383` and nothing else, and its monitor has no probe to run one. The
`connected` transition deliberately repeats no fan-out (`gateway-provider.tsx:1958-1969`,
`:1685-1693`), and a mid-session drop recovers inside the same client object, so `attachClient` (the
other history path) never runs either.

#### R2-OC-5 · S2 · `chat.send` is given 120 s by the adapter but is bounded at 30 s by the client

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-adapter.ts:200-208`, `src/lib/gateway/openclaw-client.ts:145-167`
**What fails:** An agentic OpenClaw turn whose acknowledgement takes longer than 30 s to come back
(the adapter itself asks the gateway for 120 s): at 30 s the client rejects with "Request timed out:
chat.send", the adapter clears `pendingChat` and rejects the turn, and every delta that arrives
afterwards is discarded because `handleChatEvent` returns early with no pending chat
(`openclaw-adapter.ts:231`). The bubble keeps whatever streamed before the cut and the run is lost
on a gateway that was still working.
**Why:** `timeoutMs: 120000` at `openclaw-adapter.ts:207` is a *wire* param inside the `chat.send`
params, not a client timeout; the RPC itself is issued as `this.inner.request('chat.send', {...})`
with two arguments, so `openclaw-client.ts:145` applies its 30 000 ms default to both the
`waitUntilConnected` wait and the response timer.

#### R2-OC-6 · S2 · The device-identity promise is cached for the client's lifetime, so one failed read poisons every retry

**Verification:** partly confirmed (corrected)
**Where:** `src/lib/gateway/openclaw-client.ts:73`, `src/lib/gateway/openclaw-client.ts:449-452`,
`src/lib/gateway/openclaw-client.ts:268`, `src/lib/gateway/device-identity.ts:59-95`,
`src/lib/storage/secure-key-value.ts:113-128`
**What fails:** A SecureStore read throws twice in a row (Keystore fault, `getRandomBytes` failure).
`loadOrCreateDeviceIdentity` rejects, and the client keeps handing back the *same rejected promise*
for the rest of its life. Every later `connect.challenge` fails in `sendConnect`, the status flaps
`connecting → reconnecting` forever, and the app cannot pair or connect again until the process is
restarted — long after the storage fault cleared.
**Why:** `getIdentity` memoises the promise and only ever assigns it (`openclaw-client.ts:450`):
there is no `.catch` that clears `identityPromise`. `sendConnect` awaits it inside its `try`
(`:268`) and its `catch` schedules another reconnect (`:341-344`), which re-awaits the same
rejection. `runSecureStore` retries once after 150 ms and then throws
(`secure-key-value.ts:120-127`), and `loadOrCreateDeviceIdentity` does not catch storage errors —
only a malformed payload (`device-identity.ts:87-89`). The client survives because
`attachClient` reuses an existing client whose status is `connecting`/`reconnecting`
(`gateway-provider.tsx:1719-1725`), so the poisoned object is reused across retries. A knock-on
effect: if the identity is ever regenerated, every stored token is discarded, because
`parseStore` keys the blob by `deviceId` (`src/lib/gateway/device-auth-token.ts:27`) and the phone
must pair again with nothing saying why.
**Corrected after independent verification:** **S3, not S2.** A transient SecureStore/`getRandomBytes` fault poisons
`identityPromise` for the lifetime of one `OpenClawGatewayClient`: all five handshake rungs of that client fail on
the same cached rejection and the status flaps `connecting → reconnecting`. The provider's auto-retry then builds
a fresh client (the old one is only reused while its status is `connected`/`connecting`/`reconnecting`), so the
app self-heals within ~45 s; no restart is required.

#### R2-OC-7 · S2 · A failed session list reads as an empty list, so every failure opens a new session

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-adapter.ts:127-137`, `src/lib/portal/openclaw-adapter.ts:158-168`,
`src/lib/gateway/session-resume.ts:120-135`
**What fails:** The `sessions.list` RPC times out (30 s over a relayed Tailscale path — the
09-30 audit measured ≈11 s for the equivalent Hermes read on this host). The app opens a brand-new
session, the assistant loses all memory of the thread, and the gateway accumulates one empty
session per failure.
**Why:** `getSessions` swallows every error and returns `[]`
(`openclaw-adapter.ts:133-136`). `resolveResumeSession` only declines to create a session when the
list *throws* — its comment states the invariant exactly ("a failed list is not proof that the
gateway has no app session", `session-resume.ts:123-127`) — so a swallowed failure arrives as
"the gateway has no sessions" and falls through to `createSession` (`:131-135`).
`getSessionMessages` (`:165-167`) has the same shape: a failed history read returns `[]`, which
`reloadHistoryFor` folds as a successfully empty transcript rather than an error.

#### R2-OC-8 · S2 · `source: 'openclaw'` can never match `pickAppSession`, so every connect opens a new session

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-mapping.ts:57`, `src/lib/gateway/messages.ts:4`,
`src/lib/gateway/messages.ts:12-14`, `src/lib/gateway/session-resume.ts:128-135`,
`src/context/gateway-provider.tsx:1290-1325`, `src/lib/gateway/openclaw-client.ts:114-124`
**What fails:** On an OpenClaw gateway the thread never survives a reconnect: every connect (and
every history reload with an empty live slot) lists the sessions, fails to recognise any of them as
this app's, creates a new one, and paints the thread from that empty session — so the conversation
the operator was having disappears from view and a new orphan session is left on the gateway each
time.
**Why:** `normalizeOpenClawSession` stamps every session `source: 'openclaw'`
(`openclaw-mapping.ts:57`), while `pickAppSession` accepts only `APP_SESSION_SOURCE =
'api_server'` (`messages.ts:4,12-14`) — a tag the OpenClaw dialect can never produce, so
`session-resume.ts:128` always misses and falls to `createSession` (`:134`). Nothing then pins the
new id to the profile: `reloadHistoryFor` writes only the live refs
(`gateway-provider.tsx:1322-1325`), and unlike `HermesGatewayClient.disconnect()` (which copies the
session onto the profile, `client.ts:265-267`) the OpenClaw client's `disconnect()`
(`openclaw-client.ts:114-124`) writes nothing back, so `sessionIdRef` is reset from an undefined
`gateway.sessionId` at the next connect (`gateway-provider.tsx:2176`).

#### R2-ID-1 · S2 · The OpenClaw fingerprint is the only probe without the tailnet-IPv4 fallback

**Verification:** confirmed
**Where:** `src/lib/portal/identify.ts:135-142`, `src/lib/portal/identify.ts:145-147`,
`src/lib/portal/identify.ts:250-300`, `src/lib/portal/manifest.ts:267-279`
**What fails:** MagicDNS misses the gateway name on a phone that has the right tailnet IPv4 in hand.
The manifest read retries onto the advertised IPv4 and works, but if it does not answer, the
OpenClaw probe dials the hostname only, fails, and the gateway is identified as `unknown` — after
which the app builds a `HermesGatewayClient` for a WS-only gateway and cannot connect at all,
despite holding an address that works for every other request.
**Why:** steps 2, 3 and 5 all wrap their fetch in `withHostLookupRetry(baseUrl, alternateIpv4, …)`
(`identify.ts:128`, `:135-137`, `:145-147`), but step 4 calls `probeOpenClaw(baseUrl, …)`
(`:141`), and `probeOpenClaw` (`:250-273`) builds the socket URL from the hostname alone — the
`alternateIpv4` argument the caller already holds is not threaded in.

#### R2-OC-9 · S3 · The `runId` correlation in `handleChatEvent` is inert

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-adapter.ts:27-35`, `src/lib/portal/openclaw-adapter.ts:188`,
`src/lib/portal/openclaw-adapter.ts:231-234`
**What fails:** Stop a turn and send another one. The stopped run's late `delta` frames — the
OpenClaw chat payload carries `runId` — are appended to the *new* turn's bubble, so the answer
shown is the previous answer with the new one spliced onto it. Errors from the old run reject the
new turn.
**Why:** The guard at `:234` is `if (payload.runId && pending.runId && payload.runId !== pending.runId) return;`
but `PendingChat.runId` is declared optional (`:31`) and never assigned — the object literal built
at `:188` omits it — so `pending.runId` is always `undefined` and the second conjunct is always
false. The correlation the check exists for cannot fire; `pendingChat` is a single slot
(`:41`, `:189`), so whatever run is in flight receives every frame.

#### R2-OC-10 · S3 · The model the operator picked never reaches the OpenClaw wire

**Verification:** confirmed
**Where:** `src/lib/portal/openclaw-adapter.ts:170-215`, `src/lib/portal/openclaw-adapter.ts:148-156`,
`src/context/gateway-provider.tsx:3016-3030`, `src/lib/gateway/client.ts:614-618`
**What fails:** Pick a model on an OpenClaw gateway and send. The picker shows the choice, the
thread sends with it, and the gateway runs on whatever the session already had — and the app is
never told which model actually served the turn, so a silent substitution is invisible.
**Why:** `streamChat` accepts `options.model` but never reads it: the `chat.send` params are
built from `sessionKey`/`agentId`/`sessionId`/`message`/`idempotencyKey`/`timeoutMs` only
(`openclaw-adapter.ts:201-208`), where the Hermes dialect does send `model: options?.model ??
'hermes-agent'` (`client.ts:614-618`). `onModelReport` is likewise never called, so the
substitution note the provider writes on report (`gateway-provider.tsx:3039-3045`) never appears.
The model can still reach the gateway one way only — a session created fresh carries it
(`openclaw-adapter.ts:148-156`, `openClawCreateSessionParams`), which is why the defect is
invisible on a brand-new thread.

#### R2-ST-1 · S3 · Two fire-and-forget identity/token writes with no `.catch`

**Verification:** confirmed
**Where:** `src/lib/gateway/openclaw-client.ts:382`, `src/lib/gateway/openclaw-client.ts:402-406`,
`src/lib/gateway/openclaw-client.ts:454-464`, `src/lib/gateway/device-auth-token.ts:91-117`
**What fails:** The device token handed back by a successful `connect` is written to SecureStore
unguarded. If that write fails, nothing is reported and the pairing is lost: the next reconnect
presents no device token, the gateway answers `PAIRING_REQUIRED` again, and the operator has to
approve a new pairing request every time. Symmetrically, a failed `clearDeviceAuthToken` after an
`AUTH_DEVICE_TOKEN_MISMATCH` still schedules the retry (it is in a `.finally`) but the rejection
leaves the process as an unhandled rejection.
**Why:** `void this.storeHelloDeviceToken(hello)` (`:382`) has no `.catch`; the function awaits
`saveDeviceAuthToken` (`:458`) which awaits the SecureStore write and throws on failure
(`device-auth-token.ts:115`). At `:404-406` the chain is `.then(…).finally(…)` with no `.catch`, so
either `getIdentity()` or `clearDeviceAuthToken` rejecting escapes unhandled. The installed
global handler (`src/lib/diagnostics/failure-log.ts:263-270`) records the rejection in the local
log and forwards it to React Native's tracker, so nothing crashes — the failure is simply invisible
to the user and the work it represented is gone.

#### R2-AC-1 · S3 · Every transport failure during an access request is reported to the user as "denied"

**Verification:** confirmed
**Where:** `src/lib/portal/access.ts:161-171`, `src/lib/portal/access.ts:143-146`,
`src/lib/portal/access.ts:312-317`, `src/lib/gateway/openclaw-client.ts:202-217`
**What fails:** Requesting access to an OpenClaw gateway that is merely unreachable (PC asleep,
tailnet down, port closed) reports "denied" — a verdict, not a transport fact — and so does a
10–15 s timeout on the HTTP grant path. The operator is told the gateway refused them and goes
looking for a credential problem they do not have.
**Why:** `requestOpenClawAccess` maps the client's `onError` — which the client also fires for
"Could not reach gateway at <host>. It may still be starting" (`openclaw-client.ts:213-215`) —
straight to `{ status: 'denied', reason }` (`access.ts:168-170`). The shared signed POST catches
everything, including `HostLookupError`, `AbortError` and timeouts, and returns the same verdict
(`access.ts:312-317`); the result union has no "unreachable" state, only
`granted | pending-approval | token-required | denied | device-identity`.

#### R2-OC-V1 · S2 · The OpenClaw WebSocket dial ignores the tailnet-IPv4 fallback the profile already carries

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/lib/portal/adapters.ts:231-241` computes `profileWithAlternateIpv4` for **every** kind and
installs it before `new OpenClawAdapterClient(reachable, callbacks)` at `:250-253`, and both HTTP dialects consume
it (`src/lib/gateway/client.ts:125,172` → `HttpTransport`; `src/lib/gateway/manifest-client.ts:82-90,151-159`).
The OpenClaw transport never does: `rg alternateIpv4 src/lib/gateway/openclaw-client.ts src/lib/portal/openclaw-adapter.ts`
returns nothing, and `openSocket` builds the socket from `this.profile.url` alone (`openclaw-client.ts:187`,
also `:211` for the failure text). This is the connect-time twin of ID-1 and is independent of it: even a gateway
that identified correctly cannot be dialled if its MagicDNS name is broken while its tailnet IPv4 works — which
is exactly NET-7's failure mode, and it recurs on every reconnect (`openSocket` is the only dial path).
**What fails:** **S2.** The profile already carries `alternateIpv4` for the OpenClaw dialect and the client
ignores it, so a name that misses DNS but whose advertised IPv4 works makes the WS connect (and every reconnect)
impossible, with the app reporting only "Could not connect to gateway at …". Fix: derive `ws://<ipv4>:<port>/openclaw`
candidates from `profile.alternateIpv4` and dial them on a lookup failure.

#### R2-OC-V2 · S2 · The OpenClaw adapter accepts only a subset of the PortalClient send options, so onSession (and the detachable-turn plumbing) is inert on this dialect

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/lib/portal/adapters.ts:44-69` declares the `streamChat` option surface the provider actually
uses — `onToolCall`, `onReasoning`, `onTelemetryWarning`, `onModelReport`, `onTurnId`, `onSession` — and
`src/context/gateway-provider.tsx:3098-3151` passes all six on every send. The OpenClaw implementation accepts
only `{model?, sessionId?, signal?}` (`src/lib/portal/openclaw-adapter.ts:170-174`) and reads only
`sessionId`/`signal`. Consequences that are visible in the provider's own code: `ownTurnId`/`turnIdRef` are never
set (`:3126-3129`), so `stopStreaming`'s server-side cancel at `:4161-4162` finds no turn id and the detachable-turn
guarantee the fix commits added (`4a9e3cc`, "detachable turns, partial replies survive Stop") is inert on this
dialect; and a session the gateway adopts for a turn is never adopted (`onSession`, `:3130-3150`), so the thread
stays sessionless exactly as SEND-2 describes. TypeScript does not catch it: interface method parameters are
bivariant, so the narrower implementation satisfies `PortalClient`.
**What fails:** **S2.** On OpenClaw the adapter silently drops the entire `streamChat` callback surface, so
tool cards, reasoning, telemetry warnings, model-substitution reporting, the turn id (and therefore server-side
Stop) and gateway-adopted session ids are all unavailable — with no error anywhere, because dropping a callback
is indistinguishable from a gateway that had nothing to report.

#### R2-OC-V3 · S3 · The OpenClaw chat-event type disagrees with the only handler, so a change written against the type compiles and never settles

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/lib/gateway/openclaw-types.ts:40-49` declares
`ChatEventPayload = { sessionId?, deltaText?, text?, state?: 'streaming'|'complete'|'error', error?, command? }`.
The only consumer is the handler at `src/lib/portal/openclaw-adapter.ts:222-254`, which matches
`state === 'delta'` (`:237`), `state === 'final'` (`:242`) and `state === 'error'` (`:249`) and reads
`deltaText` / `message.content` / `errorMessage` — a vocabulary the type does not contain, while the states the
type *does* declare (`streaming`, `complete`) match nothing, and the `text` field the type offers is read by no
branch (`:236` uses `deltaText ?? message.content` only). The frame reaches it through
`as ChatEventPayload` (`openclaw-client.ts:368`), a cast that suppresses the disagreement; `rg ChatEventPayload`
shows these three lines are the type's entire usage. `docs/audit-bugs-architecture.md:59-71` (P1-1) documents
`'delta'|'final'|'error'|'started'` plus `message.content`/`errorMessage` as the **verified** dialect, and records
that the adapter was fixed to read exactly those — so the type file is the stale half of the pair. It is also the
mechanical reason OC-9's guard was never wired: `runId` has no declaration to read from.
**What fails:** **S3 (type-level, but load-bearing).** The wire type and the only handler disagree about the
OpenClaw chat-event vocabulary; any change written against `ChatEventPayload` compiles and silently never settles
(`state: 'complete'` matches nothing → the same permanent hang as OC-1, with no radio drop needed). Align the
type with the handler (add `runId`, `message`, `errorMessage`; `state: 'delta'|'final'|'error'`), or make the cast
at `openclaw-client.ts:368` a typed parse that rejects an unrecognised state instead of passing it on.


### Area: Gate providers, OAuth, credentials, capabilities

#### R2-PROV-1 · S2 · "Disable provider" does not disable anything, and the card keeps saying Ready

**Verification:** confirmed
**Where:** `gate/core/providers/service.mjs:62` (update merges `enabled` into config), `gate/core/providers/service.mjs:60-70` (update returns `existing.state` untouched), `gate/core/providers/service.mjs:84-95` (`check` is the only writer of `readiness`), `gate/core/providers/service.mjs:231-241` (`inspect` is the only place `enabled:false` becomes a `disabled` readiness), `gate/core/providers/service.mjs:224-228` (`chat` never reads `config.enabled`), `gate/core/server.mjs:2455-2466` (`/v1/models` lists a disabled provider's models), `src/components/gateway/providers-section.tsx:202`, `src/lib/gateway/provider-state.ts:20`, `src/lib/gateway/entity-actions.ts:19`.
**What fails:** Operator taps Disable on a provider card (e.g. after a key leak, or to stop a flaky vendor being used). The card still reads "Ready", the primary action is still "Refresh catalog", the manifest still advertises `readiness.state: 'ready'`, `/v1/models` still offers its models — and a chat sent with that provider id is served normally. Only a separate "Check readiness" tap makes the card say Disabled; nothing at all stops the provider from answering.
**Why:** `update()` writes the new config but carries `existing.state` through unchanged (`:62`, `:67`), so the readiness the UI reads is the pre-disable value; `enabled` is consulted in `inspect`/`refreshCatalogNow` only (`:181`, `:231`), and the chat path at `:224-228` goes `require()` → `adapterFor()` → `adapter.chat()` with no enabled check, so a disabled provider keeps proxying turns.

#### R2-PROV-2 · S2 · A provider whose stream dies mid-turn is recorded as successfully ready

**Verification:** confirmed
**Where:** `gate/core/server.mjs:972` (success noted before any byte is relayed), `gate/core/server.mjs:994-1018` (local-interface relay), `gate/core/server.mjs:468-473` and `:410-418` (`relayNormalizedSse` failure → `endProviderStreamWithError`, no `noteChatOutcome`), `gate/core/providers/service.mjs:126-140` (`noteChatOutcomeNow` success branch), `src/lib/gateway/client.ts:617` (the app always sends `stream: true`).
**What fails:** A provider that answers 200 and then drops the SSE stream mid-reply (the common vendor/relay failure on a lossy path) still gets a `ready` readiness written, so the card, the manifest and the model picker keep advertising a provider whose every long turn ends in "Provider stream interrupted". The comment at `server.mjs:958-959` states the intent — "readiness is only as good as its last real turn" — and the streaming path, which is the only one the phone uses, never records a turn that failed.
**Why:** `noteChatOutcome(providerId, null)` is awaited at `:972` immediately after `providerService.chat()` resolves, i.e. at headers; both relay paths then handle a mid-stream error locally (`:1010-1013`, `:472`) and return, so `noteChatOutcome(providerId, error)` — the only call at `:960`, inside the pre-header `catch` — is never reached for a stream that failed after its first byte.

#### R2-PROV-3 · S2 · Three unsynchronised read-modify-write paths on one provider record; the last writer erases the others

**Verification:** confirmed
**Where:** `gate/core/providers/service.mjs:84-95` (`check`: read at `:85`, network probe, `put` at `:93` with no queue), `gate/core/providers/service.mjs:107-124` (per-provider queue for chat outcomes), `gate/core/providers/service.mjs:156-167` (a *separate* queue for catalog refreshes), `gate/core/providers/store.mjs:60-72` (`put` serialises the write, not the read-modify-write).
**What fails:** A chat turn fails with 401 and writes `auth.state: 'needs_reauth'` / `lastError`; a concurrent "Check readiness" (which probes the vendor and succeeds) commits its own stale `record.state` and the needs-reauth flag vanishes. The app then shows "Ready" for a key the vendor is rejecting, and `/model auth` (which reads `auth.state`) shows nothing wrong. Symmetrically a catalog refresh's `put` (`:203-209`) can wipe a chat outcome's `lastError`, and a chat outcome can wipe a just-fetched catalog.
**Why:** `noteChatOutcome`'s own comment (`:108-113`) spells out exactly why the read-modify-write needs ordering — but the ordering queues are per-operation, and `check` has none at all; `store.put` only orders the file writes (`:61`), so each `put` lands a whole record built from a state read that is now stale.

#### R2-PROV-4 · S2 · `requestPolicy.timeoutMs` is validated and stored but never applied to any provider fetch

**Verification:** confirmed
**Where:** `gate/core/providers/schema.mjs:142-146` (required field, "must be a positive integer"), `gate/cli.mjs:104` and `src/lib/gateway/provider-client.ts:84` (both write `120000`), `gate/core/providers/rpc.mjs:57-58` (exposes check and catalog refresh), `gate/core/providers/service.mjs:178-187` (`inspect` then `listModels`, both unbounded), `gate/core/providers/profiles/registry.mjs:50-55` (`fetchImpl(url, { headers })` — no `signal`, no timeout), `gate/core/server.mjs:2746-2751` (the RPC route has no timeout of its own); `grep -rn requestPolicy gate/core` matches only the schema.
**What fails:** A vendor (or a self-hosted OpenAI-compatible endpoint) that accepts the TCP connection and never answers leaves `providers.health.check` / `providers.catalog.refresh` hanging: the phone gives up at its 30 s request timeout, the Gate keeps the socket and the pending request for undici's ~5-minute default, and there is no in-flight cap, so a screen that retries (or two phones) stacks hung fetches. The declared 120 s budget is never honoured.
**Why:** Nothing between the RPC dispatcher and `fetchImpl` reads `config.requestPolicy`, and the only timeout in this subtree is the chat path's `providerUpstreamCall` (`server.mjs:307-319`), which does not wrap `listModels`.

#### R2-PROV-5 · S2 · Two disagreeing definitions of "the credential exists" leave migrated providers reporting missing credentials while chat works

**Verification:** partly confirmed (corrected)
**Where:** `gate/core/providers/service.mjs:281-287` (`credentialPresent` — vault only), `gate/core/providers/factory.mjs:53-63` (`resolveCredential` — vault, then `process.env[legacyApiKeyEnv]`), `gate/core/providers/migrate-v1.mjs:88-95` (v1 → v2 records `credentialRef: provider/<id>/api-key` and `legacyApiKeyEnv`, but writes no credential), `gate/core/providers/service.mjs:249-255` and `:181` (missing auth ⇒ `missing_credentials` and `listModels` skipped), `gate/core/server.mjs:2455-2466` (an empty catalog falls back to the legacy twin, else the provider contributes nothing to `/v1/models`).
**What fails:** After the automatic v1→v2 migration that runs on every Gate start (`server.mjs:606`), a migrated provider whose key lives in the environment (`legacyApiKeyEnv`) or in the legacy `secrets/store.enc.json` reads as `auth: missing` / `readiness: unavailable` / "credential missing", contributes no models to the picker, and never has its catalog fetched — while a chat sent to it works, because the adapter's own resolver accepts the env var.
**Why:** `credentialPresent` consults only `vault.has(ref)` (`:285`, a file-existence check, `vault.mjs:54-61`) while `materialize()` independently falls back to the env var (`factory.mjs:59-61`); the migration records the env name but never copies the secret into the Gate-home vault, and neither `migrateLegacySecrets` (`credentials/vault.mjs:68`) nor `migrateLegacySecretsToVault` (`capabilities/secrets.mjs:72`) is called from any entry point (`grep` shows only `cli.mjs:408` and `server.mjs:606`, both `migrateLegacyProviders`).
**Corrected after independent verification:** *S2.* After the v1→v2 migration, a migrated provider whose key is in
`process.env[legacyApiKeyEnv]` reports `auth: missing` / `readiness: unavailable` /
`missing_credentials` ("Not configured" + "Set key"), never has its catalog fetched
(`service.mjs:181` skips `listModels` on `auth.state === 'missing'`), and contributes only its
v1 bootstrap models to `/v1/models` — while chat against it works via the env fallback. Trigger: any
Gate started over a v1 `registry/` directory whose keys live in the environment.

#### R2-PROV-6 · S2 · Every vault read spawns a PowerShell process that compiles C#, with no timeout

**Verification:** confirmed
**Where:** `gate/core/credentials/windows-dpapi.mjs:53-73` (`runHelper` — `spawn('powershell.exe', …)` per call, no timeout, no kill), `gate/core/credentials/windows-dpapi.mjs:5-51` (`Add-Type -TypeDefinition` re-compiled in every fresh session), `gate/core/credentials/vault.mjs:37-46` (`get` → `unprotect`, no memoisation), `gate/core/providers/factory.mjs:15-16` and `:25-39` (`materialize()` is called once per adapter method), `gate/core/providers/service.mjs:257-260` (`inspect` calls `authenticate()` then `health()`).
**What fails:** One "Check readiness" tap runs `authenticate()` and `health()` separately, so it spawns two `powershell.exe` processes that each JIT-compile a C# type before the vendor is even contacted; a "Refresh catalog" tap runs three (`inspect` ×2 plus `listModels`), and every chat turn runs one. On the operator's Windows PC that is hundreds of ms to ~1 s of process startup plus compilation each time, on top of the request, and if a PowerShell session hangs the promise never settles (`child.on('close')` is the only exit path).
**Why:** The DPAPI helper is a per-call `powershell.exe -Command` with the type definition inline (`:55`), and neither `CredentialVault.get` nor the factory caches anything, so the cost is paid on each credential resolution.

#### R2-OAUTH-1 · S3 · OAuth registration is inert end to end, and the attempt it leaks is never cleaned up

**Verification:** confirmed
**Where:** `gate/core/providers/oauth/profiles.mjs:2` (`releaseOAuthProfiles` is empty) with `gate/core/server.mjs:619`, `gate/core/providers/oauth/pkce-callback.mjs:7-15` (the attempt has no `authorizationUrl` field), `gate/core/providers/rpc.mjs:70-78` (returns `authorizationUrl: attempt.authorizationUrl` ⇒ `undefined`), `src/lib/gateway/provider-oauth.ts:21-24` (no URL ⇒ no link, no attempt id ⇒ no poll), `gate/core/providers/oauth/pkce-callback.mjs:64-67` and `:75` (expiry rejects the callback but never closes the listener or deletes the attempt), `gate/core/providers/oauth/refresh.mjs:66-67` (`discoverIssuer(profile.issuer, …)` with no `allowedHosts`), `gate/core/providers/oauth/discovery.mjs:1-8` (default allow-list is loopback only), `gate/core/providers/service.mjs:283` (presence checked at `oauthProfileId`, tokens live at `oauth/<id>`, `refresh.mjs:51,93`).
**What fails:** A hand-written `mode: 'oauth'` provider record (the only way to get one — no shipped profile or CLI path creates it) cannot be authorized: `beginAuth` returns no URL, the progress sheet shows nothing and never polls, no code ever calls `consumePkceAttempt`, and `getAccess` has no callers — so the provider stays `missing_credentials` forever. Each `begin` also leaves a `http.createServer` listening on 127.0.0.1 plus an entry in the in-memory attempt map for the life of the process, and any refresh that did run would throw "issuer host … is not pinned" for every real issuer.
**Why:** The attempt object built at `pkce-callback.mjs:7-15` never carries an authorization URL and the callback is consumed by nobody; the only cleanup path, `attempt.close()` (`:70-73`), is reached only from `OAuthManager.cancel`, which no RPC method exposes.

#### R2-PROV-7 · S2 · Refresh is a no-op while fresh or backing off, and the backoff is invisible

**Verification:** confirmed
**Where:** `gate/core/providers/service.mjs:169-177` (both early returns need `!force`), `gate/core/providers/rpc.mjs:58` (the RPC never passes `force`), `gate/core/providers/service.mjs:204-208` with `gate/core/providers/catalog.mjs:30-34` (30 s → 15 min), `gate/core/providers/service.mjs:60-70` (`update` carries `existing.state`, so `backoff` survives a fixed base URL), `gate/core/providers/rpc.mjs:96-117` (`sanitizeSnapshot` has no `backoff` field).
**What fails:** After one failed refresh the user taps "Refresh catalog" — the control's whole purpose — and the Gate returns the identical stale snapshot without contacting the vendor, for up to 15 minutes, with no error and nothing on the card to explain it. The same happens within 300 s of a *successful* refresh. Correcting a wrong base URL through "Edit" does not clear the backoff, so the recovery path the user reaches for is the one that silently refuses.
**Why:** `refreshCatalog` defaults `force = false` (`:156`) and `rpc.mjs:58` calls it with no arguments, so both guards at `:172` and `:175` apply to every user-initiated refresh; the resulting snapshot carries `catalog.state: 'stale'` (`catalog.mjs:13-18`) but the backoff that caused the no-op is not projected to the client.

#### R2-STORE-1 · S3 · `atomicWrite` deletes the file before renaming it into place, so a concurrent read sees no provider

**Verification:** confirmed
**Where:** `gate/core/providers/store.mjs:82-87` (`writeFile` → `rm(filePath)` → `rename`), `gate/core/providers/store.mjs:39-58` (`get` swallows every read error as `null`), `gate/core/providers/store.mjs:20-37` (`list` skips ids whose `get` returns `null`), `gate/core/providers/service.mjs:289-297` (`require` turns that `null` into `provider_not_found`), `gate/core/credentials/vault.mjs:30-33` (same rm-then-rename shape).
**What fails:** A phone reading `/v1/providers` or `providers.get` in the microsecond window between the `rm` and the `rename` gets `provider not found` (404 from `server.mjs:1244-1252`, 400 from the RPC route) for a provider that exists, and `list()` silently omits it for that response. Every provider check and chat outcome rewrites both files, so the window is re-entered constantly.
**Why:** The `rm` exists because Windows `rename` refuses an existing destination, so the tmp+rename pair is not actually atomic here; the read path cannot tell "absent" from "mid-replace" because `get` collapses ENOENT and a rename race into the same `catch → null`.

#### R2-CAP-1 · S3 · Capability instance files are written non-atomically, so a crash silently deletes the instance

**Verification:** confirmed
**Where:** `gate/core/capabilities/registry-methods.mjs:25-29` (`writeInstanceFile` — plain `writeFile`, no tmp + rename), `gate/core/capabilities/registry-methods.mjs:81` (update writes it), `gate/core/capabilities/registry.mjs:100-111` (`JSON.parse` failure pushes to `skipped` and is otherwise ignored), `gate/core/capabilities/registry.mjs:113-118` (`unknown kind` likewise skipped), `gate/core/providers/store.mjs:82-87` (the provider store does it correctly, in the same process).
**What fails:** If the Gate is killed (or the PC reboots) while an instance's `registry/<id>.json` is being written, the truncated file fails `JSON.parse` on the next boot: the instance is dropped from `state.instances`, its manifest entry and commands disappear, `buildInstanceHandlers` no longer registers its methods, and the phone's feature list silently shrinks — with the reason visible only in the discarded `skipped` array, which nothing logs. The same truncation loses every field the operator had configured for that instance.
**Why:** `writeFile` to the live path replaces content in place, so a partial write is a permanent parse error, and `loadInstances` treats a parse error as "skip this instance" (`:102-106`) rather than as a failure to report.

#### R2-PROV-8 · S3 · Concurrent manifest reloads can overwrite newer state, hiding a provider or instance that was just created

**Verification:** confirmed
**Where:** `gate/core/server.mjs:887-891` (`state = await computeState()`, no serialisation), `gate/core/providers/rpc.mjs:26-30` (`statusAndReload` → `reload()`), `gate/core/capabilities/registry-methods.mjs:43-48,71,83,93` (its own write queue covers only registry writes), `gate/core/server.mjs:854-885` (`computeState` re-reads the provider and registry directories from disk).
**What fails:** A provider created at the same moment as a capability instance produces two overlapping `reload()`s. The one that read the disk earlier but finishes later assigns last, so the manifest the phone fetches for the next few minutes lacks the just-created entry — the provider card and the instance's commands are absent even though both writes returned `ok`.
**Why:** Each `reload()` builds a complete snapshot from disk and assigns it wholesale (`:889`); the assignment order is completion order, not start order, and nothing serialises `reload` across the two RPC surfaces.

#### R2-CRED-1 · S3 · A credential file that cannot be decrypted reports itself as a present, ready credential

**Verification:** partly confirmed (corrected)
**Where:** `gate/core/credentials/vault.mjs:54-61` (`has` = `access()` only, no decrypt), `gate/core/providers/service.mjs:285` (`credentialPresent` returns `vault.has(ref)` when available), `gate/core/credentials/vault.mjs:44` (`get` propagates `unprotect` failure instead of returning `undefined`), `gate/core/credentials/windows-dpapi.mjs:64-67` (the PowerShell child exits non-zero on a DPAPI failure), `gate/core/providers/errors.mjs:92` (an unclassified error defaults to `transient_network`).
**What fails:** When a `.dpapi` file cannot be decrypted — a truncated write, or the Gate home copied to another Windows account, since DPAPI is per-user — `auth.state` reads `ready` and readiness `ready`, while every actual request fails with a raw `DPAPI unprotect failed: …` PowerShell message classified as `transient_network`, so the card shows "Degraded/stale" for a credential problem and no surface reports "this key cannot be read on this machine".
**Why:** Presence is decided by file existence (`access`), and the decrypt step lives behind the same `has`/`get` split that callers choose between (`service.mjs:285-286`), so nothing ever pairs "present" with "readable".
**Corrected after independent verification:** *S3.* `CredentialVault.has` is a file-existence check, so presence and
readability are decided by different code paths: a `.dpapi` file that cannot be decrypted (truncated
write, or a Gate home copied to another Windows account — DPAPI is per-user) counts as a present
credential, and its failure is classified `transient_network` (`errors.mjs:26`) so the record ends up
`auth: ready` + `readiness: degraded` and no surface ever says "this key cannot be read on this
machine". Trigger: a vault file that exists but fails `CryptUnprotectData`.

#### R2-CRED-2 · S3 · The Gate's only redaction helper misses the token field spellings its own code uses

**Verification:** confirmed
**Where:** `gate/core/credentials/redaction.mjs:1-13` (`access_token`/`refresh_token`/`id_token`, no camelCase entries; `authorization` is listed but `bearer`/`x-api-key` are not), `gate/core/providers/rpc.mjs:16` (the single call site, applied to `{ message, code }`, whose keys are not sensitive, so it is a no-op), `gate/core/providers/oauth/refresh.mjs:87-92` (the token object the Gate persists is spelled `accessToken`/`refreshToken`).
**What fails:** Any future or incidental redaction of a token envelope passes `accessToken`, `refreshToken` and `idToken` through verbatim, and the one place it is used today only ever forwards an error `message` string — so a vendor error that quotes the credential reaches the phone unredacted. The helper reads as a safety net and provides none.
**Why:** Matching is exact on the lower-cased key (`:24`) against a set written in one spelling convention, while the module that writes tokens uses the other (`:87-92`); and the call site passes a two-key object, which the key set never matches.

#### R2-PROV-V1 · S2 · "Refresh catalog" on a disabled provider silently erases its model list

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `service.mjs:178-187` — for `enabled:false`, `inspect` returns `{ auth, readiness }` with
**no** `error` key (`:231-241`), `listModels` is skipped because `record.config.enabled` is falsy, so
`models` stays `undefined` **and** `catalogError` stays `undefined`. `applyCatalogResult` therefore
takes its success branch (`catalog.mjs:1-9`): `{ source: 'live', state: 'fresh',
generation: previous+1, observedAt: now, models: [] }`. `service.mjs:203-209` commits that and *deletes*
the backoff. The card then shows "0 models · live" (`provider-card.tsx:44-48`), the manifest advertises
`models: []` / `catalog.count: 0` (`manifest.mjs:19-37`), `/v1/models` contributes nothing
(`server.mjs:2457-2471`), and because the catalog is now `fresh` with an `observedAt`, the next 300 s
of refreshes early-return (`service.mjs:172`).
**What fails:** *S2.* A catalog refresh on a disabled provider replaces a good catalog with an
empty catalog labelled live/fresh, losing the model list from the card, the manifest and `/v1/models`
until the provider is re-enabled and successfully re-checked. Trigger: tap "Refresh catalog" (always
offered, `provider-actions-sheet.tsx:79`) more than `ttlSeconds` after the last successful fetch, or
after a backoff window.

#### R2-PROV-V2 · S2 · A missing API key is sent to the vendor as `Bearer undefined` and then reported as "Sign in again"

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `service.chat` (`service.mjs:224-228`) never consults `credentialPresent` and never calls
`adapter.authenticate()` (that call lives only in `inspect`, `:257-260`), so `factory.mjs:39`
`resolveCredential` may return `undefined` and the profile still builds a header —
`profiles/openai.mjs` / `xai.mjs` `authHeaders(credential)` is
``{ Authorization: `Bearer ${credential}` } ``, so the literal string `Bearer undefined` goes upstream.
The vendor answers 401, `server.mjs:960` folds it in, and `errors.mjs:18` + `:31` turn 401 into
`invalid_credentials` → `authStateForCode` → **`needs_reauth`** (`service.mjs:150`), overwriting the
correct `missing` a check had stored. The app then offers the wrong remedy: `entity-actions.ts:11-15`
would have said "Set key" for `auth.state === 'missing'`, but `:16-18` now says "Sign in again" →
`providers.auth.begin` (inert, per OAUTH-1, and it leaks a listener). The stored record is also
self-contradictory: `auth.state: 'needs_reauth'` alongside `readiness.code: 'missing_credentials'`,
which no client can render coherently (`provider-state.ts:17-27` falls through to the raw
`'unavailable'`).
**Executed** with the real factory and a stubbed 401 `fetch`: `check()` first reported
`missing / unavailable missing_credentials`; `chat()` then sent `Authorization: Bearer undefined`, and
the record ended `auth {state:'needs_reauth'}`.
**What fails:** *S2.* Any v2 provider whose credential is absent (freshly registered but not yet
keyed, or a vault entry deleted) has a turn dispatched to the vendor with the literal header
`Authorization: Bearer undefined`; the resulting 401 is recorded as `needs_reauth`, so an `api_key`
provider's primary action flips from "Set key" to "Sign in again", which cannot work for that mode.
Trigger: any turn sent before a key is set.

#### R2-PROV-V3 · S2 · A health check or catalog refresh never rebuilds the manifest

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** only `statusAndReload` (`rpc.mjs:26-30`) refreshes derived state, and it wraps just
`providers.create/update/delete` (`:54-56`). `providers.health.check` (`:57`) and
`providers.catalog.refresh` (`:58`) — the two calls that actually change `auth`, `readiness` and
`catalog` — return `sanitizeSnapshot` and return early, so `state` (and with it the manifest built at
`server.mjs:870-883` from `providerEntryFromSnapshot`, `manifest.mjs:19-37`) is never rebuilt. The
client-visible consumer is real: `src/context/gateway-provider.tsx:1020` passes
`activeManifest?.providers` into `buildCapabilitySnapshot`, and `dashboard.ts:958,1013-1021` renders
the app's "N of M ready" providers row from `manifest.providers[].readiness.state`.
**What fails:** *S2.* The manifest's provider entries are only rebuilt on create/update/delete, so
after any readiness change made by a check, a failed turn, or a catalog refresh, the manifest keeps the
old `readiness`/`auth`/`models`/`catalog` until an unrelated registration edit happens — a freshly
connected phone (and the app's "N of M ready" row) is told a dead provider is ready and still offers
its models. Trigger: any check/chat outcome/catalog refresh with no concurrent create/update/delete.


### Area: Gate CLI-environment backends, supervisor, Bots, voice worker, service

#### R2-CLAUDE-1 · S1 · Stop never kills the Claude Code turn — the agent keeps working in the workspace

**Verification:** confirmed
**Where:** `gate/core/cli-environments/backends/claude-code.mjs:275` (spawn), `:368-371`
(await `close`), `:382-384` (`abort()` is an empty stub), `gate/core/cli-environments/adapters/claude-code.mjs:19`
(`server: { transport: 'per-turn' }`), `gate/core/cli-environments/backend-manager.mjs:147-153`
(the per-turn branch builds a backend with no job object), `gate/core/voice/turn-runner.mjs:613-615`
(the send, raced by abort at `:374-376`), `gate/core/server.mjs:2706` (the only cancel path — `turn.controller.abort()`).
**What fails:** Send a message to the Claude Code environment and press Stop while the agent is
working. The phone shows "stopped" within a frame, but the `claude --print` process keeps running to
completion — still reading the workspace, still calling the Anthropic API, still able to write files.
The operator then sends the next message and a second agent starts in the same directory. Nothing on
the Gate ever tells the CLI to stop: `backend.abort()` is not called from anywhere in `gate/` (grep:
`abort` in `server.mjs` yields only AbortController uses), and Claude Code is the one backend that
cannot be stopped by dropping an HTTP request, because its turn *is* the process.
**Why:** `createClaudeCodeBackend.sendMessage` spawns the child itself and parks on
`new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })`; the
`signal` the runner hands down is not a parameter of `sendMessage` (`claude-code.mjs:261` takes
`onEvent` third), so aborting the runner's controller resolves the `raceStop` in `turn-runner.mjs:374`
but leaves the promise — and the process — running. `abort()` at `:382` documents "cancellation is
handled by the job that owns it", but no job exists: `backend-manager.mjs:150` calls
`adapter.createBackend({ record })` for a `per-turn` transport, and `createWindowsJob` is only used by
`native-server.mjs:22` / `stdio-server.mjs:20` / `CliEnvironmentService.execute` (`supervisor.mjs:307`).

#### R2-RUN-1 · S2 · The run archive prunes by a field it never writes, so it deletes the wrong runs

**Verification:** confirmed
**Where:** `gate/core/cli-environments/run-archive.mjs:109` (`runs.sort((a, b) => a.meta.startedAtMs - b.meta.startedAtMs)`),
`:110-113` (the prune), `gate/core/cli-environments/supervisor.mjs:295-302` (`record()` writes
`startedAt`, an ISO string — there is no `startedAtMs` anywhere in the writer).
**What fails:** Once an environment has run more than 100 tasks, the archive starts deleting runs at
every Gate start — and which 100 survive is decided by the random hex in the file name, not by age.
The newest run can be the one deleted, and "Recent runs" (the documented acceptance evidence for a
finished task) silently loses arbitrary history.
**Why:** `load()` reads each meta line back verbatim (`run-archive.mjs:125`) and sorts on
`meta.startedAtMs`, which is `undefined` for every file the Gate writes, so the comparator returns
`NaN` for every pair. V8's sort treats `NaN` as "not greater", leaving the array in the order
`readdir(...).sort()` produced it (`:98`) — i.e. lexicographic on `run-<12 hex>.json`. The suite does
not catch it because `gate/__tests__/run-archive.test.mjs:232-241` names its fixtures `run-1`,
`run-2`, `run-3`, which sort chronologically by accident. (The earlier audit listed this file only as a
contrast case for GATE-6, "tmp-file + rename"; the `startedAtMs` key is a new defect in it.)

#### R2-RUN-2 · S2 · Every run ever started is retained forever, with its output log and its decrypted credentials

**Verification:** confirmed
**Where:** `gate/core/cli-environments/supervisor.mjs:151` (`this.runs = new Map()`), `:328` (`set`),
`:241` / `:644` (each start and each finish spreads the whole map), `:563-587` (`listRuns` slices to 50
*after* copying everything), `:308` / `:316-327` (`childEnv` — the resolved vault values — stored on the
run), `:634-661` (`finish` clears only the watchdog timer), `gate/core/cli-environments/run-protocol.mjs:30`
(`events.push` with no cap).
**What fails:** A Gate left running for weeks grows without bound. Each finished task keeps its entire
event log in memory (`run.output` frames are up to `MAX_OUTPUT_CHARS = 16_000`, `supervisor.mjs:20`, and
a chatty CLI emits hundreds), plus its `childEnv` — the decrypted provider keys — plus its
`ChildProcess` and `windowsJob` references. Nothing is ever removed, so every start and every finish
also costs an O(total-runs-ever) scan.
**Why:** There is no `runs.delete` anywhere in `gate/` (grep) and no cap analogous to
`run-archive.mjs:10` (`DEFAULT_MAX_RUNS_PER_ENVIRONMENT = 100`), which only bounds what is reloaded
from disk at startup (`supervisor.mjs:171-209`). `finish()` never nulls `childEnv`, `child`, `job` or
the log's `events`, so secrets resolved from the vault for a run that finished last month are still
resident in the heap. `run-archive`'s own comment about bounded growth therefore does not hold for the
in-memory map.

#### R2-ENV-1 · S2 · Writing an environment record deletes the live file before the replacement exists

**Verification:** confirmed
**Where:** `gate/core/cli-environments/store.mjs:50-53` (`writeFile(tmp)` → `rm(dest, {force:true})` →
`rename(tmp, dest)`), read path `store.mjs:34-40` (`get` returns `null` for a missing file), consumers
`gate/core/cli-environments/backend-manager.mjs:138-142` and `gate/core/cli-environments/supervisor.mjs:674-682`.
**What fails:** Save an environment from the phone (or let `environments.update` write). Between the
`rm` and the `rename` the record does not exist on disk. If the Gate is killed, rebooted or loses
power in that window, the record is gone for good and the `<id>.json.tmp` orphan is invisible
(`store.list()` at `:27` keeps only names ending `.json`) — `gate doctor` then reports the environment
simply as not registered. The same window makes any concurrent read answer "environment not found",
so a chat turn routed at that moment fails with a refusal the operator cannot explain.
**Why:** The `rm` is unnecessary: Node's `fs.rename` on Windows is `MoveFileEx` with
`MOVEFILE_REPLACE_EXISTING`, which replaces the destination, and the sibling store in the same package
proves it — `bot-groups.mjs:154-159` does `writeFile(tmp)` + `rename(tmp, file)` with no unlink and its
comment states the invariant ("never a truncated middle"). `providers/store.mjs:83-86` carries the
same `rm`, so the defect is duplicated there.

#### R2-CLI-1 · S2 · A Codex app-server that fails its handshake is never killed, and every retry spawns another

**Verification:** confirmed
**Where:** `gate/core/cli-environments/stdio-server.mjs:55-61` (spawn + `job.add`), `:95-106`
(`await Promise.race([ready, failed])` then `throw spawnFailure ?? error` — no cleanup),
`:35-42` (`ensureRunning` respawns whenever `handle` is null), `gate/core/cli-environments/backend-manager.mjs:178-187`
(`unavailable` backoff, then a fresh `ensureRunning`), `gate/core/cli-environments/adapters/codex.mjs:21-24`
(`handshake: initialize`, 30 s bound at `stdio-server.mjs:96`).
**What fails:** Install the Codex CLI where `codex app-server` starts but never answers `initialize`
— a first-run login prompt, a hung binary, an incompatible build. Each attempt costs 30 s, then the
process is abandoned while still running. The manager's backoff makes it *more* frequent, not less: 5 s,
15 s, 60 s, 300 s. After an hour the host has a dozen live `codex app-server` processes, each holding
its own stdio pipe and memory, none reachable and none reaped.
**Why:** The throw at `:105` propagates out of `start()` without touching `child` or calling
`job.terminate()`, and `child` stays non-null so `isOwned()` still reports true — but `handle` is never
assigned, so the very next `ensureRunning()` (`:36` `if (handle) return handle` fails) runs `start()`
again. Contrast `native-server.mjs:151` and `:161`, which both `await stop()` on their refusal and
timeout paths. `stopAll()` would eventually reap them, but it only runs at Gate shutdown
(`server.mjs` `gateObj.close()`), and nothing else can reach these children.

#### R2-SESS-1 · S2 · The Claude Code session list reads and parses every transcript in the project, then discards most of them

**Verification:** confirmed
**Where:** `gate/core/cli-environments/backends/claude-code.mjs:156-205` — `:159-170` is the loop:
for every `*.jsonl` in `~/.claude/projects/<flattened-cwd>/` it `stat`s the file and then
`readTranscript(id)` reads and `JSON.parse`s the whole file to build an 80-character preview;
`:133-140` `transcripts()`, `:142-151` `readTranscript()`. The caller's limit never reaches it:
`listSessions()` takes no parameter (`gate/core/server.mjs:2211` passes one) and the Gate slices
*afterwards* at `server.mjs:2218`.
**What fails:** `GET /v1/sessions` against a Claude Code environment on a project with a few hundred
transcripts (they grow by one file per conversation, never pruned) reads every one of them, serially,
to produce previews for rows that are then thrown away. The phone is on an 8 s budget for this read
(NET-3 in the earlier audit) while the Gate does hundreds of sequential full-file reads. The same
route is re-run on every reconnect and every Roster visit.
**Why:** `for (const file of files) { … await stat(…); … await readTranscript(id) … }` is an `await`
inside a `for…of` (`claude-code.mjs:159-170`), so the I/O is fully serialised, and `readTranscript`
materialises the entire `.jsonl` as one string plus a parsed array of every entry
(`:146-150`) — Claude transcripts are routinely hundreds of KB. No limit, no sort-before-read, no
cache; `reserved` (`:131`) is folded in afterwards at `:200-203`.

#### R2-HERMES-1 · S2 · Creating a Bot writes its listen key non-atomically, and the generated key exists nowhere else

**Verification:** confirmed
**Where:** `gate/core/cli-environments/backends/hermes.mjs:691-692` (`ensureDistinctListenKey` then a
bare `writeFile` of `<profile>/.env`), `:684-690` (read-modify of the same file),
`gate/core/cli-environments/hermes-profiles.mjs:22-40` (`hermes-bot-create.mjs:26-42` generates it —
`randomBytes(32)`), and the atomic pattern this same package uses elsewhere:
`hermes-profiles.mjs:286-288` (tmp sibling + `rename`).
**What fails:** Create a Bot, then kill the Gate (or lose power) during the write. The profile's
`.env` is truncated or half-written: `parseListenKey` returns `null`, so the roster reports
`routingIssue: 'listen_key_missing'` (`hermes-profiles.mjs:152`) and every `forBot` call throws
`bot_not_routable` (`hermes.mjs:614-619`). The Bot exists on disk but is permanently unaddressable.
Worse, the key `ensureDistinctListenKey` minted is only ever returned to the caller
(`hermes-bot-create.mjs:41`) and written to that one file, so there is nothing to restore from — a
retry mints a *different* key.
**Why:** `:692` is `await writeFile(join(botHome, '.env'), ensured.envText, 'utf8')`, a truncating
write of a file that also carries inherited provider keys (`createBotArgs({inheritKeys})`,
`hermes-bot-create.mjs:19-22`). The module that owns Bot writes already knows the invariant —
`hermes-profiles.mjs:260-264` states "written to a temp sibling and renamed, so a reader never sees a
half-written file" and does exactly that at `:286-288`. `updateBot`'s `SOUL.md` / `profile.yaml` /
`config.yaml` writes (`hermes.mjs:769`, `:775`, `:786`) have the same shape; the rollback wrapper
(`hermes-bot-edit.mjs:18-53`) covers a *thrown* edit, not a process death.

#### R2-VOICE-1 · S3 · The voice-session registry is append-only for the life of the Gate

**Verification:** confirmed
**Where:** `gate/core/voice/voice-rpc.mjs:45-56` (`create` → `this.sessions.set`), `:130-145`
(`end` only sets `ended`/`endedReason` and fans out), `:102-117` (`liveForDevice` iterates every
session ever created, and only skips the ended ones), `gate/core/voice/media-socket.mjs:519`
(the call is deleted from the *call* map, never from the registry).
**What fails:** A Gate left up over a long day accumulates one registry record per `voice.session.start`
— every call, every failed start, every grant that never attached. Each `voice.session.start` then
walks the whole history to answer "does this device have a live call", and `liveForDevice`'s expiry
scan pays a `for` loop over months of dead entries on the call path.
**Why:** `VoiceSessionRegistry.sessions` has exactly one writer, `create` (`:54`), and no `delete`
anywhere (grep). `end()` deliberately keeps the record because a late socket upgrade must still see it
as ended (`media-socket.mjs:116-120`) — the memory is the price and it is never paid back. Each record
also holds the whole `thread` object the phone sent (`voice-rpc.mjs:293`).

#### R2-VOICE-2 · S3 · The voice worker appends every frame it writes to a list that is never cleared

**Verification:** confirmed
**Where:** `gate/voice-worker/versutus_voice/server.py:276` (`self.written = []`), `:282-288`
(`_write` appends the serialised line *unconditionally*, before checking whether `self._out` is set),
`gate/core/voice/engines/local-engine.mjs:99` (`_ensureWorker` per call), `:84-95` (`close` kills the
child), `gate/core/voice/media-socket.mjs:134` (`createEngine` per call).
**What fails:** Every line the worker emits — including each `voice.speechAudio` frame, ~960 bytes of
PCM base64'd to ~1.3 KB, produced 50 times a second while the Bot speaks — is also retained in
`written`. A ten-minute reply holds on the order of a hundred megabytes of duplicated audio for the
life of the worker process, and it is copied again on every restart the engine's backoff performs
(`local-engine.mjs:171-177`).
**Why:** `self.written` exists for the tests (`RpcServer(pipeline, out=...)` is how the suite asserts
frames) but the production construction `RpcServer(pipeline, out=sys.stdout)` (`server.py:610`) never
disables it, and there is no clear or cap. Everything else in this worker is carefully bounded
(`VAD_WINDOW_SAMPLES`, `PREROLL_MS`, `_PARTIAL_WINDOW_MS`), which is what makes this the odd one out.

#### R2-VOICE-3 · S3 · Re-attaching a call leaks a no-audio timer that nothing ever clears

**Verification:** confirmed
**Where:** `gate/core/voice/media-socket.mjs:456-461` (`attach` calls `clearResumeTimer()` then
`startAudioTimer()` — never `clearAudioTimer()`), `:197-202` (`startAudioTimer` assigns
`audioTimer = setInterval(...)`), `:466-471` (the old socket's `close`/`error` handlers only detach
`if (ws === newWs)`), `:482-489` (`detach` — the only other `clearAudioTimer`), `:491-521` (`end`
clears whichever handle is currently in `audioTimer`).
**What fails:** The phone's socket goes half-open (the exact Tailscale case the 20 s resume window
exists for) and a second socket arrives for the same `voiceSessionId` before the first emits `close`.
`createCall`'s `attach(ws, {first:false})` arms a second 1 Hz interval while the first is still armed
and overwrites the `audioTimer` handle. When the stale socket finally closes, its handler sees
`ws !== newWs` and does nothing, so the first interval is unreachable forever; `end()` clears only the
second. Repeat reconnects and the call accumulates one live interval each.
**Why:** `audioTimer` is a single variable holding only the most recent handle
(`startAudioTimer`, `:197-202`), and the code relies on `detach()` being the mirror of
`startAudioTimer()` — which holds for the close-then-reconnect sequence but not for an overlapping
attach, the one case a lossy, relayed link produces. The intervals are `unref`'d (`:201`) so they do
not hold the process open; the cost is retained closures and duplicate `ws.close(1001,'idle')` work.

#### R2-TOKEN-1 · S3 · Every spawned CLI is handed a chat endpoint with no port and a token nothing verifies

**Verification:** partly confirmed (corrected)
**Where:** `gate/core/cli-environments/supervisor.mjs:313` (`endpoints` defaults to
`http://127.0.0.1/v1/chat/completions` — no port), `:308-315` (the value reaches the child through
`buildCliEnvironment`), `gate/core/cli-environments/process-environment.mjs:39-40` (emits
`VERSUTUS_CLI_INVOCATION_TOKEN` and `VERSUTUS_GATE_CHAT`), `:3-18` (`ALLOWED` has no
`VERSUTUS_GATE_PORT`, so the real port is never inherited), `gate/core/cli-environments/invocation-tokens.mjs:3`
(the signing secret is a fresh `randomBytes` per process when `VERSUTUS_CLI_TOKEN_SECRET` is unset) and
`:37` (`verifyInvocationToken`, which no production code calls — grep finds it only in tests).
**What fails:** A CLI-environment run that tries to route its model call back through the Gate, which
is what the invocation token exists for, cannot: the URL it is given points at port 80 rather than the
Gate's `VERSUTUS_GATE_PORT`/8760/random port, and nothing in `gate/` accepts an invocation token —
`/v1/chat/completions` is behind the device-token check. The supervisor's own comment
(`supervisor.mjs:331-333`) says model routing "can ride invocation tokens", so the failure mode reads
as a routing bug somewhere else entirely.
**Why:** `buildCliEnvironment` copies a fixed allow-list (`:3-18`) that omits every `VERSUTUS_GATE_*`
variable except the two it sets itself, and `endpoints.chat` is a constant with no port. Even a
correctly-ported URL would fail: `verifyInvocationToken` has no caller, and with
`VERSUTUS_CLI_TOKEN_SECRET` unset (the documented default, nothing prints it) the secret changes on
every Gate restart, so any token a CLI still holds is unverifiable afterwards. `invocation-tokens.mjs:53`
also grows `seen` — the replay set — with no pruning.
**Corrected after independent verification:** `supervisor.startRun`'s fallback `endpoints.chat` (`supervisor.mjs:313`) is `http://127.0.0.1/v1/chat/completions`
with no port, so a CLI-environment run that tries to route its model call back through the Gate cannot reach it
(port 80 instead of `VERSUTUS_GATE_PORT`/8760/ephemeral). Independently and more broadly, the invocation-token feature
is inert: `verifyInvocationToken` (`invocation-tokens.mjs:37`) has no production caller, its `seen` replay set
(`:53`) is never pruned, and with `VERSUTUS_CLI_TOKEN_SECRET` unset (the default; nothing prints it) the signing
secret is regenerated on every Gate restart, so any token a still-running CLI holds is unverifiable afterwards.
Severity: S3 as claimed. Note the backend-server path (`server.mjs:701`) is unaffected — the portless default is
confined to `startRun`.

#### R2-CLI-2 · S3 · `service run` — the process whose job is to survive crashes — has no guards and an unlistened child

**Verification:** confirmed
**Where:** `gate/cli.mjs:569-580` (`spawnGate`: `stdout`/`stderr` listeners only, no `'error'`),
`:560-628` (`serviceRun`, which never calls `installProcessGuards` — `:405` is the only call site,
inside `handleStart`), `:605-619` (the 2 s control-file poll), `:636-673` (`serviceStop` calls
`probeLocalGate(GATE_MANIFEST)` with the default `fetch`), `gate/core/service/diagnostics.mjs:191-200`
(`probeLocalGate` has no timeout), `gate/core/service/windows-task.mjs` `RestartOnFailure`
(`PT1M`/999).
**What fails:** If the Gate child cannot be spawned at all (node moved, `SERVICE_CODE_ROOT` stale —
the constant `'C:\\Projects\\Versutus'` at `cli.mjs:517` is not the audit worktree), the ChildProcess
emits `'error'` with no listener, Node throws, and the supervisor exits. Because no
`installProcessGuards()` is installed here, there is no handler that would have survived it. The
Scheduled Task's `RestartOnFailure` brings it back a minute later, so the symptom is "the Gate is down
for a minute and the log has a raw stack", and every phone stream drops with it.
**Why:** `spawn()` at `cli.mjs:570` attaches no `'error'` handler — the same defect shape GATE-1 fixed
in `native-server.mjs:141`, `stdio-server.mjs:70` and `local-engine.mjs:117`, none of which is this
call site. `installProcessGuards` (`gate/core/process-guards.mjs:47`) is imported at `cli.mjs:20` but
invoked only in `handleStart` (`:405`). Separately, `serviceStop`'s two `probeLocalGate` calls
(`:652`, `:670`) use the uninstrumented default fetch: a listener that accepts and then never answers
headers hangs the command forever, so the `taskkill` at `:659` and the final "service stopped" never
happen.

#### R2-HERMES-2 · S3 · Resolving a Bot re-reads every Hermes profile, once per speaker

**Verification:** confirmed
**Where:** `gate/core/cli-environments/backends/hermes.mjs:600-644` — `:607`
(`getHermesBot(profilesHome, botId)`), `:623` (a second `getHermesBot(profilesHome, 'default')`),
`:636-643` (a fresh backend per call, so `hostMultiplexEnabled`'s cache at `:178-188` is thrown away
each time); `gate/core/cli-environments/hermes-profiles.mjs:291-299` (`:297` falls back to
`listHermesBots`), `:204-221` (`:218` — one `await botAt(...)` per profile, serial), `:190-202` (three
sequential `readFile`s per profile: `.env`, `profile.yaml`, `config.yaml`);
`gate/core/cli-environments/backends/hermes.mjs:565-581` (`:568` — `forBot` is called once per planned
group step).
**What fails:** Send one message to a room. For each speaker the Gate re-enumerates every profile on
the host and reads three files from each — three times over for the default profile. The adapter's own
comment records the fleet size this was written for ("A 14-bot fleet silently became one this way
(2026-08-25)", `adapters/hermes.mjs:9-22`), which makes a single group send roughly 135 serial file
reads, all of them on the Windows path that also has to re-read `config.yaml` for the multiplex
verdict. The same walk backs every `getBot`/`getBotMemory`/`setBotMemory` call (`hermes.mjs:511`,
`:533`, `:551`).
**Why:** `getHermesBot` has a fast path for `'default'` (3 reads, `hermes-profiles.mjs:293-296`) but
falls through to `listHermesBots` for every named id (`:297`), and `listHermesBots` is a serial
`for…of` of `await botAt(...)` over `readdir` (`:214-219`) with no memo. `forBot` then needs the
default key a *second* time (`:623`) because the first lookup already had it in hand inside
`listHermesBots`' result.

#### R2-VOICE-4 · S2 · A spoken turn resolves its backend from scratch on every turn, not once per call

**Verification:** confirmed
**Where:** `gate/core/voice/voice-backend.mjs:11-24` (the `list()` + `get()` walk for a Bot-scoped
thread), `:27-31` (the same walk for an unscoped one), `gate/core/server.mjs:2817` (`runTurn` →
`resolveVoiceTurnBackend` per turn), `gate/core/cli-environments/backend-manager.mjs:137-205`
(each `get()` re-reads the record with `store.get` — an uncached JSON read, `:138` — re-resolves the
credential bindings through the vault at `:160`, and for HTTP transports re-validates health with a
live fetch, `native-server.mjs:49`).
**What fails:** A call that takes six turns resolves the backend six times, each time walking the whole
environment list, each step doing a disk read and a DPAPI decrypt per candidate. The phone is
streaming audio through all of it, so the added latency lands directly in the time-to-first-token of
every reply. The first walk after a Gate restart is the expensive one: `get()` ends in
`ensureRunning()`, so any environment ahead of the one that answers is cold-started
(`native-server.mjs:148-162` polls to 30 s; `stdio-server.mjs:96` handshakes for 30 s).
**Why:** The resolution result is thrown away when the turn ends — nothing memoises
`(thread → backend)` on the session, and `voice-rpc.mjs:291-297` stores the thread but not a backend on
the session record. This is the one walk the SPD-7 fix deliberately did not reach: `server.mjs`'s six
walks now gate on `backendManager.methodsOf` (`server.mjs:719`, `backend-manager.mjs:90-105`), while
this file still asks `backendManager.get()` and only then checks `typeof candidate.forBot ===
'function'` (`voice-backend.mjs:19`) — the fix log records that omission as a residual of SPD-7, so I
count only the per-turn repetition as new here.

#### R2-GO-V1 · S3 · The run archive prunes by `startedAtMs` and its own hydrate path disagrees with the prune

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `gate/core/cli-environments/run-archive.mjs:109` sorts on `meta.startedAtMs`, which
`supervisor.mjs:293-306` never writes — that is RUN-1's mechanism, so this is not new on its own. What is new is the
*second* consumer of the same missing field: `gate/core/cli-environments/supervisor.mjs:194-207` rehydrates each
archived run with
`startedAtMs: Number.isFinite(Date.parse(meta.startedAt)) ? Date.parse(meta.startedAt) : 0`,
and `supervisor.mjs:566` sorts the in-memory list on that. So the archive's on-disk order is lexicographic while the
Gate's in-memory order is chronological, and they disagree about which run is newest. `run-archive.mjs:114` returns
`runs.slice(-maxRunsPerEnvironment)` — the tail of the *lexicographic* order — which `hydrateArchive` then inserts
with chronological timestamps. The two orderings are never reconciled, so the set of runs that survives pruning and the
order the phone sees them in are produced by different keys.
**What fails:** Beyond pruning the wrong runs, the archive's sort key and the supervisor's are different fields
derived from different sources, so what survives the cap and how it is subsequently ordered are decided independently.

#### R2-GO-V2 · S3 · `stdio-server` leaks its Job Object membership across respawns, so a later `terminate()` reaps children it no longer owns

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `gate/core/cli-environments/stdio-server.mjs:18` — `job = createWindowsJob()` is created **once** per
server instance (a default parameter), and `:61` `job.add(spawned)` appends on every `start()`. There is no reset of
`job.children` anywhere in `stdio-server.mjs`; `stop()` at `:112-123` calls `job.terminate()` (which kills every
accumulated pid via `taskkill /T /F`, `windows-job.mjs:31-51`) and then nulls `child`, but leaves the job's `children`
array intact and `terminated` latched `true` (`windows-job.mjs:32`). So after one stop/start cycle the same job object
carries the dead generation's pids, and the next `terminate()` issues `taskkill` against every one of them. Windows
recirculates pids; a recycled pid belonging to an unrelated process is a real hazard of `taskkill /F` against a stale
list. `native-server.mjs:22` has the identical shape (`job = createWindowsJob()` once, `job.add(child)` at `:119`,
`stop()` at `:166-178` calls `job.terminate()`), so both server supervisors share it — this is distinct from CLI-1,
which is about a *failed* start never being reaped at all.
**What fails:** The per-server Job handle accumulates every generation's child and is never reset, so a
`terminate()` after a stop/start cycle `taskkill /T /F`s a list of stale pids that Windows may have recycled.
Severity S3 (needs a pid recycle plus a stop/start cycle).

#### R2-GO-V3 · S3 · A voice call's registry entry keeps the whole `thread` payload, and `liveForDevice` walks every one of them on the start path

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `gate/core/voice/voice-rpc.mjs:291-297` — `registry.create({ voiceSessionId, deviceId, engine: choice.engine, thread: params.thread, startedAt: now() })`.
`thread` is the caller's own object, stored by reference with no projection or size bound.
`voice-rpc.mjs:102-117` — `liveForDevice` iterates `this.sessions.values()` and is called at `:274` on the
`voice.session.start` path, i.e. before every new call. Combined with the never-deleting map (VOICE-1), every start
walks every session ever created, holding an unbounded caller-supplied `thread` each.
This is distinct from VOICE-1's claim (which is about record count) in that the per-record payload is caller-controlled
and unprojected.
**What fails:** Each registry record retains the phone-supplied `thread` object verbatim, and every
`voice.session.start` walks the full, never-pruned map — so per-start cost grows with total lifetime sessions, holding
unbounded caller-supplied payloads. Severity S3.


### Area: Hands-free voice (Android/iOS native + JS)

#### R2-VOICEANDROID-1 · S1 · The notification's Mute/Unmute action can never change the mute state

**Verification:** confirmed
**Where:** `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallNotification.kt:62-66`, `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:224-225`, `:242`, `:126-129`, `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallState.kt:39-43`; the mapping is pinned by `modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/HandsfreeCallNotificationTest.kt:87-88`
**What fails:** A call is live. The user pulls down the ongoing notification and taps **Mute** to stop the microphone. Nothing happens: the recognizer keeps running, the body line still reads "Listening", and the label still reads "Mute". Tapping **Unmute** on an already-muted call is equally inert. The user believes the microphone is off when it is live — and the JS banner never learns anything, so the in-app state stays whatever it was.
**Why:** The notification attaches the *opposite* intent from the label: `buildNotification` sets the action to `if (state.muted) ACTION_UNMUTE else ACTION_MUTE` (`HandsfreeCallService.kt:225`) and the label to `muteActionLabelFor(state.muted)`, so an unmuted call ships a "Mute" button carrying `ACTION_MUTE`. The handler at `HandsfreeCallService.kt:126-129` maps that intent through `HandsfreeCallNotification.mutedForAction`, whose table is inverted: `ACTION_MUTE -> false`, `ACTION_UNMUTE -> true` (`HandsfreeCallNotification.kt:63-65`). `setMuted(value)` assigns that value straight onto the state (`HandsfreeCallState.kt:39-43`, `HandsfreeCallService.kt:859-873`), so "Mute" writes `false` over `false` and "Unmute" writes `true` over `true` — both are no-ops in every state. The JVM test asserts the inverted table directly (`:87-88`) and then, at `:103-111`, asserts the *opposite* value is applied by the caller, so the suite passes while the wiring does nothing.

#### R2-VOICE-6 · S2 · A call that ended while muted poisons the next one: it dies in 1.2 s with "recognition-failed"

**Verification:** confirmed
**Where:** `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:33`, `:141`, `:167-177`, `:582-601`, `:348`; `src/context/handsfree-voice-provider.tsx:597-606`, `:1016-1018`; `src/lib/voice/handsfree-session.ts:213-218`
**What fails:** On iOS, mute a call (banner Mute, or the notification), end it, then start a new call on the same thread. The new call opens the microphone, shows "Listening", and then dies about 1.2 s later with the sheet reopening on *"The call ended because speech recognition stopped working on this phone."* The recognizer is fine; the next call is dead until the app is restarted.
**Why:** `isMuted` is module state written only by `setMuted` (`:170`) and never cleared by `endLocked` — the teardown at `:582-601` clears `startAttemptId`, `sessionActive`, the engine and the synthesizer but leaves `isMuted` at its last value (`:33`). `startSession` (`:97-138`) does not reset it either, and the provider's start path emits no `set-muted` effect (`handsfree-voice-provider.tsx:1016-1018`; the reducer's `started` case, `handsfree-session.ts:213-218`, asks only for `start-listening`). So `startListening` hits `guard self.sessionActive, !self.isMuted else { return false }` (`:141`), `beginRecognition` would bail for the same reason (`:348`), and `startListeningWithRetry` burns all 8 attempts at 150 ms before dispatching `fatalError` (`handsfree-voice-provider.tsx:597-606`). Android is immune because the service is a fresh instance per call and `HandsfreeCallState.start()` resets `muted = false` (`HandsfreeCallState.kt:34`), which is why only the iOS half of the seam carries the bug.

#### R2-VOICE-7 · S2 · iOS progressive speech cuts the reply off mid-word; Android queues the same input correctly

**Verification:** confirmed
**Where:** `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:437-456` (`:450`, `:453`), `:458-478`; `src/context/handsfree-voice-provider.tsx:527-549`, `:685`; `src/lib/voice/handsfree-reply.ts:140-150`; contrast `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:622-627`
**What fails:** On iOS, a streaming reply is read aloud with every sentence truncated where the next one begins — "The build passed on the fir|st. The second thing to check is…". Whole clauses are never spoken, and the banner shows the full reply text the operator cannot hear. The same reply on Android is read complete.
**Why:** `streamReplyText` is driven by an effect that re-runs on every streamed delta (`handsfree-voice-provider.tsx:657-686`, `:685`), and `planHandsfreeSpeech` emits only the *newly completed sentence* each time (`handsfree-reply.ts:140-150`; with iOS's `Double.greatestFiniteMagnitude` bound, one chunk per call). iOS's `speakLocked` treats each of those calls as a *new utterance*: it overwrites the queue (`pendingChunks = chunks`, `:450`) and hard-stops the synthesizer mid-word (`synthesizer.stopSpeaking(at: .immediate)`, `:453`). Progressive speech only works if the next sentence joins the one being spoken — which is exactly what the Android service does and documents (`speakInternal` appends to `queuedSpeech`, `HandsfreeCallService.kt:622-627`). The JS side compounds it: `spokenRef.current = plan.spoken` is committed *before* the native call (`:545-548`), so the truncated text is recorded as spoken and is never re-offered.

#### R2-VOICE-8 · S2 · A native-side end that emits nothing leaves the call "live" forever

**Verification:** partly confirmed (corrected)
**Where:** `src/context/handsfree-voice-provider.tsx:345-353`, `:514-525`, `:564`; `src/lib/voice/handsfree-session.ts:203-209`; `src/lib/voice/handsfree-call-copy.ts:124-125`; `src/lib/voice/speech.ts:48-52`; `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeCallService.kt:139-143`, `:145-149`, `:902-941`
**What fails:** Swipe Versutus away from Recents mid-call (or let the OS reclaim the service), then reopen it. The banner is still there: "Listening · running 6m", with a live-looking amplitude dot, a running elapsed timer, and Mute / Skip / End that do nothing. Mute flips the label to "Muted" and nothing is muted. Nothing ever ends the call except pressing End, and the ordinary spoken-replies toggle stays dead for the rest of the app session.
**Why:** Only two native events can end a call from the platform side — `interruption` and `endRequested` (`handsfree-voice-provider.tsx:345-350`) — and the Android paths that end a call *without the user asking* emit neither: `onTaskRemoved` and `onDestroy` both call `end("app-killed")` (`HandsfreeCallService.kt:139-149`) and `teardown()` emits nothing at all (`:902-941`); only `ACTION_END` emits first (`:114-120`). On the JS side there is no liveness check to compensate: the only timer in the call is the reply watchdog, and it is armed exclusively inside `performSend` (`:564`), so a call that is merely *listening* has no timeout, no probe and no poll. `reduceHandsfreeSession` confirms the gap — its terminal set is `end`/`endRequested`/`disconnect`/`thread-changed`/`interruption`/`fatalError` (`handsfree-session.ts:203-209`), so `'app-killed'` is an **unreachable** reason, and the copy branch that would explain it (`handsfree-call-copy.ts:124-125`) is dead. `endHandsfreeCall()` is likewise never reached, so `callOwnsAudio` (`speech.ts:48-52`) stays `true` and the transcript's speaker toggle answers `false` forever.
**Corrected after independent verification:** S3, not S2. `app-killed` is an unreachable terminal reason and `handsfree-call-copy.ts:124-125`
is dead code, and the call has no liveness probe — but the orphan requires the *foreground service* to be destroyed
under a live JS runtime (or an equivalent native-only death), not a Recents swipe, which restarts JS and returns the
session to idle.

#### R2-GATEVOICE-1 · S2 · The media-socket reconnect spends the whole 20 s Gate window asleep and never takes its last shot

**Verification:** confirmed
**Where:** `src/lib/voice/gate-reconnect.ts:20-34`, `:68-70`; `src/context/handsfree-voice-provider.tsx:398-413`; `gate/core/voice/media-socket.mjs:26`
**What fails:** A Gate call's media socket drops once and the link recovers 2 s later. The phone still sits silent for the full 20 s resume window and then ends the call, because the attempt that would have re-attached is never issued.
**Why:** The Gate holds the call for exactly `RESUME_TIMEOUT_MS = 20_000` (`media-socket.mjs:26`). `gateReconnectDelays` builds `[500, 1000, 2000, 4000, 8000]` (= 15 500 ms) and then, per its own comment "Always leave one shot for the last moment of the window", appends `windowMs - spent` = 4 500 ms (`gate-reconnect.ts:31-33`) — so the schedule sums to *exactly* the deadline. The loop sleeps first and checks afterwards (`await sleep(delay)` then `if (input.isAborted() || now() >= deadline) return false`, `:69-70`), so the final attempt always fires at `t ≥ 20 000` and is always refused. The last delay is 4.5 s of dead air and the last attempt is unreachable code; `attemptReconnect` then folds the original fatal frame and the call ends (`handsfree-voice-provider.tsx:411-412`).

#### R2-HANDSFREE-1 · S2 · A sentence the platform refused is marked spoken and never retried, and the call parks in "Speaking"

**Verification:** confirmed
**Where:** `src/context/handsfree-voice-provider.tsx:545-548`; `modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeVoiceModule.kt:141-147`; `src/lib/voice/handsfree-session.ts:332-338`
**What fails:** The Android service is momentarily gone (it was killed, or `HandsfreeCallService.current` is null during a service restart) while a reply is streaming. The banner reads "Speaking" forever, no further sentence is ever audible, and the text the Bot wrote and the text the operator heard diverge permanently — with no error anywhere.
**Why:** `streamReplyText` commits `spokenRef.current = plan.spoken` and *then* fires the call (`:545-548`), discarding the boolean the module answers with. Android answers `HandsfreeCallService.current?.speak(...) ?: false` (`HandsfreeVoiceModule.kt:146`) — a plain `false`, not a rejection — so a refused chunk is silently marked as delivered and `planHandsfreeSpeech` will never re-offer it (`handsfree-reply.ts:141-148`). The call also cannot leave `speaking`: the only exits are `speechFinished`, `bargeIn`, `skipReply` and `reply-failed` (`handsfree-session.ts:332-346`), and a dead service emits none of them, so no watchdog is armed either (it is armed only in `performSend`, `handsfree-voice-provider.tsx:564`).

#### R2-HANDSFREE-2 · S3 · The banner's Mute button is inert while a turn is sending or waiting

**Verification:** confirmed
**Where:** `src/lib/voice/handsfree-session.ts:293-309`, `:311-330`; `src/components/voice/handsfree-call-banner.tsx:127-135`; `src/context/handsfree-voice-provider.tsx:1033`
**What fails:** Over the lossy Tailscale path a turn sits in "Sending" or "Waiting for reply" for tens of seconds — long enough that the banner itself grows a "Still waiting on the PC… 40s" line. The user taps Mute. The label does not change, the microphone stays live, and no message says the control is unavailable.
**Why:** The banner draws Mute unconditionally, with no phase gate (`handsfree-call-banner.tsx:127-135`), and `mute()` dispatches `{ type: 'mute' }` (`handsfree-voice-provider.tsx:1033`). The reducer handles `mute` only from `listening` (`handsfree-session.ts:248-252`), `confirming` (`:278-289`), `speaking` (`:347-352`) and `muted` (`:360-370`); the `sending` and `waiting` cases fall through to `return stay(state)` (`:308`, `:329`), which changes nothing and asks for nothing. So the tap is a silent no-op in exactly the phases where a user is most likely to reach for it.

#### R2-GATEVOICE-2 · S3 · A Gate start is bounded by three separate 45 s budgets, not the "one-shot budget" the code names

**Verification:** partly confirmed (corrected)
**Where:** `src/context/handsfree-voice-provider.tsx:804-813`, `:834`, `:836-854`, `:969-975`; `src/lib/voice/handsfree-start-attempt.ts:174`; `src/lib/voice/start-deadline.ts:25`, `:51-59`
**What fails:** With a Gate that accepts the connection but never answers `voice.session.start`, the Call sheet sits on "Starting" for up to 90 s before it names a timeout, twice the budget every constant in the file advertises.
**Why:** `startDeadline()` mints an independent one-shot timer per call, defaulting to `HANDSFREE_START_TIMEOUT_MS = 45_000` (`start-deadline.ts:25`, `:51-59`), and nothing is shared between instances. `startGateCall` creates one for the device identity (`handsfree-voice-provider.tsx:810-813`, disposed at `:834`), then `openGateVoiceSession` creates a *second* for the grant/prompt/media chain (`handsfree-start-attempt.ts:174`), and the phone path creates a third for the microphone prompt (`handsfree-voice-provider.tsx:969-975`). The comment at `:804-809` — "It runs under the same one-shot budget" — describes an intent the code does not implement, so the worst case is 45 + 45 s rather than 45 s.
**Corrected after independent verification:** A Gate start is bounded by **two** independent 45 s budgets (device identity, then the
grant/prompt/media/release chain) → up to 90 s, twice the advertised `HANDSFREE_START_TIMEOUT_MS`. The phone-engine
path has exactly one 45 s budget. The comment at `handsfree-voice-provider.tsx:804-809` is wrong either way.
Severity S3 stands.

#### R2-VOICE-9 · S3 · An iOS recognition task that errors immediately loops `noSpeech` → restart with no backoff

**Verification:** confirmed
**Where:** `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:390-402`, `:405-423`, `:347-369`; `src/lib/voice/handsfree-session.ts:245-247`
**What fails:** On iOS, if the recognizer starts failing the instant it is created (microphone access revoked mid-call, server-side recognition with no network, a wedged `SFSpeechRecognizer`), the module spins: a fresh `recognitionTask` is created and torn down as fast as the framework can answer, one `noSpeech` event per iteration crosses into JS, and the banner's `noSpeech` fold plus `setSession` run on every pass with the 10 s no-speech guard never given a chance to fire. The phone burns CPU and the transcript flickers for as long as the fault lasts.
**Why:** `handleRecognition` treats any mid-turn error as silence — `if isListening { finishTurn(text: "") }` (`:390-394`) — rather than as a failure. `finishTurn` emits `noSpeech` and then unconditionally restarts recognition when nothing is speaking (`:405-423`), and `beginRecognition` creates a new request and task (`:347-369`). The loop has no counter, no delay and no escalation, and `endpointing.begin(at:)` (`:359`) resets the turn clock each pass so `noSpeechTimedOut` (10 s) can never trip. This is the iOS twin of the Kotlin `AudioRecord.read` spin recorded as VOICE-5, in a file VOICE-5 does not name.

#### R2-GATEVOICE-3 · S3 · Gate-mode Mute/Unmute fold the banner optimistically and never roll back

**Verification:** partly confirmed (corrected)
**Where:** `src/context/handsfree-voice-provider.tsx:1025-1044`, `:416-424`; `src/lib/voice/gate-call.ts:139-146`; `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:205-207`
**What fails:** In a Gate-powered call, tap Mute on a dead or stalled media socket. The banner immediately reads "Muted" while the Gate is still capturing and can still run a turn — the phone is charging the operator for minutes of a call it says is muted. Nothing ever corrects the label.
**Why:** In gate mode `mute()`/`unmute()` write the phase straight into `gateBannerRef` and `setGateBanner` and fire-and-forget the control frame (`:1027-1031`, `:1037-1041`), discarding the module's boolean — and on iOS `sendGateControl` unconditionally answers `false` (`HandsfreeVoiceModule.swift:205-207`). The fold only leaves `muted` when a `fatal` `error` frame arrives (`gate-call.ts:139-146`), so a socket that is merely unresponsive leaves the invented state standing. The phone-engine path does not have this: there the reducer is the only writer (`handsfree-voice-provider.tsx:1033`, `:1043`).
**Corrected after independent verification:** S3. Gate-mode mute/unmute is folded optimistically with no rollback on a refused or stalled
control frame; when the Gate is mid-turn the refusal is silent and the banner reads "Muted" while the Gate keeps
capturing, until the Gate's next `phase` frame corrects it. It does not persist for the length of the call, and no
microphone is left open on the phone side (the phone service's recognizer is idle in gate mode — its barge-in tap
is only started from `speakInternal`, `HandsfreeCallService.kt:632`, which gate mode never reaches).

#### R2-VOICE-10 · S3 · iOS declares a `stateLock` it never uses, and three entry points read module state off the audio queue

**Verification:** confirmed
**Where:** `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:17`, `:141`, `:156`, `:127-128`, `:170`, `:588`
**What fails:** Undefined behaviour in the strict sense and a torn read in practice: `startListening` and `speak` evaluate their guards on the module's own queue while `audioQueue` is the only writer of `sessionActive` and `isMuted`. A `startListening` issued immediately after `startSession` resolved can read the pre-start value and answer `false`, which the JS retry ladder absorbs — so today the visible damage is nil, but any future reader of those fields inherits an unsynchronised access that a `stateLock` was clearly meant to guard.
**Why:** `stateLock` is declared at `:17` and referenced nowhere in the file (`grep` finds one hit). All mutation is funnelled through `audioQueue` (`:127-128`, `:170`, `:588`), but `AsyncFunction("startListening")` reads `self.sessionActive, self.isMuted` directly on the calling thread (`:141`) and `AsyncFunction("speak")` reads `self.sessionActive` the same way (`:156`) — the same pattern `beginRecognition` avoids by doing its read inside the queue block (`:348`).

#### R2-HANDSFREE-3 · S3 · Every streamed delta rescans the whole reply, making progressive speech O(n²) on the JS thread

**Verification:** confirmed
**Where:** `src/context/handsfree-voice-provider.tsx:657-686`, `:527-549`; `src/lib/voice/handsfree-reply.ts:53-55`, `:70-105`
**What fails:** During a call, a long reply (a code block, a long explanation — several thousand characters) makes the Hermes JS thread progressively busier as the reply grows, because the per-delta cost is proportional to the *whole* reply rather than to the new text. The visible effect is banner and indicator jank on the same thread that is dispatching the native `level` events.
**Why:** The effect's dependency list includes `messages` (`handsfree-voice-provider.tsx:686`), and `messages` gets a new identity on every streamed delta, so the effect — and `streamReplyText` (`:685`) — runs once per delta. Each run calls `planHandsfreeSpeech`, which does `replyPrefixIntact(spoken, fullText)` (a `startsWith` over the whole spoken prefix, `handsfree-reply.ts:53-55`) and `completedSentenceText(fullText)` (a full scan from index 0, `:70-105`). Only the last few characters differ per delta, so the total work is quadratic in the reply length; nothing memoises the boundary or resumes the scan where the previous one stopped.

#### R2-NV-V1 · S2 · Android speakInternal runs unguarded after teardown, resurrecting TTS and the barge-in microphone capture

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** 
**What fails:** S2 — a privacy-relevant leak, not a cosmetic one. Tapping End while a reply is speaking (or
within the same handler frame of any `speak`) can leave the microphone held open by the barge-in detector and speak
the remainder of the reply after the call has ended, until the process dies. Fix: give `speakInternal` the guard
`startListeningInternal` already has (`if (destroyed || !state.isActive) return` as its first line), and make
`teardown()` idempotent-clean rather than early-returning.


### Area: Android widget, config plugins, widget JS

#### R2-WIDGET-1 · S2 · The write gate records the write before the write happens, so a refused write is charged as accepted

**Verification:** confirmed
**Where:** `src/context/gateway-provider.tsx:4968-4971`, `src/lib/widget/widget-write-gate.ts:74-89`,
`src/lib/widget/widget-device.ts:60-79`, `modules/versutus-widget/android/src/main/java/com/versutus/widget/VersutusWidgetModule.kt:19-26`
**What fails:** Cold start with a placed widget. The very first snapshot always takes the
`accepted === null` branch and is written. If that write fails (native module not yet resolvable, a
throw inside `setPayload`, or `parse` refusing the payload — the module answers `false` and the seam
throws that answer away), the card stays on "Open Versutus to connect". Nothing is left to retry: the
new signature is already stored, so every later identical snapshot is refused for five minutes, and
if no run/roster/status change ever arrives the card shows nothing at all for the whole session —
while the app is connected and perfectly able to write.
**Why:** `:4970` assigns `widgetWriteRef.current = decision.last` before `writeWidgetSnapshot` is
awaited, and the seam resolves the write's outcome with a bare `try { … } catch {}` (`widget-device.ts:69,77`)
and ignores the `false` the module returns (`VersutusWidgetModule.kt:21,25`) — the gate's own comment
("A refused write updates nothing … is retried on the next change") is not what the call site does.

#### R2-WIDGET-2 · S2 · Nothing ever re-evaluates the gate, so the five-minute floor that is supposed to refresh a frozen card never fires

**Verification:** confirmed
**Where:** `src/lib/widget/widget-write-gate.ts:24-25,82-88`, `src/context/gateway-provider.tsx:4960-4972`
**What fails:** Open the app, stay connected, start no runs, change no routines. `widgetWriteGate` is
called only from the effect at `:4960`, whose dependency list is the facts themselves, so
`now - accepted.writtenAt >= WIDGET_WRITE_FLOOR_MS` is never evaluated against a clock that has moved.
The card is written once ("Connected / No runs in flight / Written Today 09:12") and never again for as
long as nothing changes: the stamp never ages, so the Android card's 12-hour `isStale` threshold
(`WidgetStamp.kt:20-25`) is reached with the app open and the gate declining to write, not with the app
closed.
**Why:** the floor is a pure function of `now`, and no timer, interval or AppState listener feeds a
later `now` into it — the only re-trigger in the whole path is the six-hourly native redraw worker
(`WidgetRefreshWorker.kt:31-35`), which redraws without re-reading and so cannot refresh the facts.

#### R2-WIDGET-3 · S2 · A push companion is a whole-payload write, so every delivered push wipes the Bot rows, the roster and the privacy flag

**Verification:** confirmed
**Where:** `gate/core/push-notifier.mjs:214-236`, `src/lib/widget/widget-push-task.ts:25-40`,
`modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetPayload.kt:59-66`,
`src/lib/widget/android-widget-payload.ts:22-25`
**What fails:** Widget pushed to the home screen, one Bot pinned, then any routine/approval notice
arrives while the app is closed. The card keeps its status and work line but loses every quick-launch
row, the complete roster and the pinned Bot's name, and a widget pinned to a Bot flips to "Bot
unavailable — Open Versutus". In-flight run rows are lost the same way. Nothing restores them until the
app is next opened and the write gate happens to fire.
**Why:** the Gate's companion writes `setPayload`, which replaces the single stored payload
(`VersutusWidgetModule.kt:19-25`), and that JSON is a `v: 2` with only `status/connected/work/
approvalsPending/writtenAt` (`push-notifier.mjs:223-231`) — absent keys parse as *empty*, not *unchanged*
(`WidgetPayload.kt:59-65`, `configBots` falls back to the empty `bots`). The JS seam forwards the push
JSON verbatim (`widget-push-task.ts:34`) and never merges it into the snapshot the app last wrote.

#### R2-WIDGET-4 · S2 · "Hide result text on the widget" is a device-local switch, so a push with rich bodies puts the text back on the card

**Verification:** confirmed
**Where:** `src/lib/settings/widget-privacy.ts:30-49`, `src/app/gateway/settings.tsx:248-251`,
`gate/core/push-notifier.mjs:221-231`, `src/lib/widget/widget-push-task.ts:29-35`
**What fails:** The operator turns on Settings → "Hide result text on the widget" (and the card
correctly stops showing the result and the Bot names). Later a routine finishes, the Gate's
`richBody` for this device is on and `widgetUpdates` is on, and the data-only companion carries
`result: truncateText(event.text)` — which the headless task writes to the locked home screen. The
privacy switch is only ever read by the app's own fold; it is never sent to the Gate and the Gate never
learns it.
**Why:** the Gate decides redaction from `row.richBody` (`push-notifier.mjs:228`), a separate
notifications preference the widget screen never touches; `handleWidgetPush` (`widget-push-task.ts:29`)
writes whatever string it is handed, and the companion's own `redact` is absent, so `WidgetPayload.parse`
defaults it to `false` (`WidgetPayload.kt:66`).

#### R2-WIDGET-5 · S2 · `clearPayload` is never called: the last gateway's names and last result stay on the home screen after it is deleted

**Verification:** partly confirmed (corrected)
**Where:** `modules/versutus-widget/src/VersutusWidgetModule.ts:9`,
`modules/versutus-widget/android/src/main/java/com/versutus/widget/VersutusWidgetModule.kt:28-32`,
`src/context/gateway-provider.tsx:4960-4972`
**What fails:** Delete the only gateway (or revoke its token). The app forgets it, but the Glance card
keeps drawing the deleted gateway's status word, Bot roster, the last result text and its stamp,
because the only write point in the app (`gateway-provider.tsx:4960-4972`) has no delete branch and the
one native function built for it has no caller anywhere in `src/` (`rg clearPayload`: the declaration,
the Kotlin body, tests and a plan document only).
**Why:** the card's storage is app-private and outlives every session (`WidgetPayloadStore.kt:8-20`),
so "the widget shows what the app last told it" becomes "the widget shows what the app told it before
the operator removed the thing it describes".
**Corrected after independent verification:** deleting (or being disconnected from) the only gateway does not leave the card
frozen — the disconnect settles the status word, the result line and the run rows, because
`status` and `activeGateway?.id` are effect dependencies. The real defect is narrower: the app's
`widgetBots` roster is never cleared, so the removed gateway's Bot names, quick-launch rows and
Bot deep links survive on the card, and the one native function built for this
(`clearPayload`, `VersutusWidgetModule.kt:28-32`) still has no caller. Severity S3, not S2; trigger
is any gateway removal or switch with `redact` off.

#### R2-WIDGET-6 · S2 · The Gate's widget snapshot hard-codes `connected: true`, so a push-written card reads "Connected" whenever the Gate can reach Expo

**Verification:** confirmed
**Where:** `gate/core/push-notifier.mjs:205-217,244-252`, `gate/core/server.mjs:767-771`
**What fails:** The phone is on cellular, Tailscale is down and the app has been saying
"Reconnecting" for an hour. A routine finishes; the companion arrives and rewrites the card as
"Connected / No runs in flight / Written 14:02" — freshly stamped, so the card looks live and
contradicts the app in the one line the whole feature exists to get right. The app's own fold never
says this: `android-widget-payload.ts:20` derives it from the observed status.
**Why:** `widgetSnapshot` takes `connected = true` as a default and `server.mjs:770` calls it with
only `busyRuns` and `approvalsPending`, so `resolveSnapshot`'s `snap?.connected !== false`
(`push-notifier.mjs:217`) is unconditionally true — the Gate has no reading of the *phone's* link to
report and never had.

#### R2-WIDGET-7 · S2 · A backend probe erases an environment's `busy` state, so a push-written card says "No runs in flight" during a run

**Verification:** confirmed
**Where:** `gate/core/cli-environments/supervisor.mjs:212-219,324-329,641-645`,
`gate/core/cli-environments/rpc.mjs:51`, `gate/core/server.mjs:765-771`
**What fails:** A run is in flight on environment X. Anything that probes X (`environments.check` from
the phone, `start()` for a second run) overwrites X's state with the probe's, dropping `busy`. The next
push companion then computes `busyRuns = 0` and the card is rewritten "No runs in flight" with a
current stamp, while the run is still going — and it stays that way until some later call happens to
re-derive `busy`.
**Why:** `check()` does `this.environmentState.set(id, { state, probe })` unconditionally
(`:219`), replacing rather than merging the coarse state; only the run's own start (`:329`) and its
settle (`:645`) write `busy`, so a probe in between wins.

#### R2-WIDGET-8 · S3 · The pushed work line counts busy *environments* and words them as runs

**Verification:** confirmed
**Where:** `gate/core/server.mjs:764-771`, `gate/core/push-notifier.mjs:244-252`,
`modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetPayloadStore.kt:8-14`
**What fails:** Three concurrent runs on one environment: the pushed card reads "1 run in flight"
where the app's Activity tab and the card the app itself writes read "3 runs in flight"
(`snapshot.ts:136-137`). Two environments with one run each read "2 runs". The two paths use the same
words for different units.
**Why:** `states.filter((entry) => entry?.state === 'busy').length` counts entries of a Map keyed by
environment id (`supervisor.mjs:152,219,329`), which is per environment, and the payload stores that
number as `busyRuns`; nothing re-reads the run rows it would need to count runs.

#### R2-NW-V1 · S3 · The pushed approvalsPending is host-global while the app's own count is per-gateway

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `gate/core/server.mjs:768-770` counts
`environmentService.approvals.list().length`, and `gate/core/cli-environments/approvals.mjs:46-56`
returns **every** pending approval on the host, carrying its own `environmentId` in each row — it is
never filtered. The app's count is the opposite scope: `src/lib/widget/snapshot.ts:165-168` counts
`approvalsPending` only from `facts.runs`, and `gateway-provider.tsx:4963-4964` hands it
`activityRunsForActiveGateway` (scoped by `runsForGateway`, `src/lib/gateway/runs.ts:95-98`) and the
active gateway's routines. `push-notifier.mjs:218-220, 229` puts the host-global number straight into
the payload, and `VersutusStatusWidget.kt:147-150, 235-244` draws a "Decide in Versutus" row whenever
it is non-zero. A pending approval on environment B therefore puts an approval call to action on the
home-screen card of a phone watching environment A, and the same whole-payload write (WIDGET-3) drops
whatever the app's own per-gateway count was.
**What fails:** The pushed `approvalsPending` is host-global while the app's is per-gateway

#### R2-NW-V2 · S3 · Widget writes are fire-and-forget with no ordering guard, so a slow write can land after a newer one

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/context/gateway-provider.tsx:4971` — `void writeWidgetSnapshot(snapshot);` — and
`src/lib/widget/widget-device.ts:60-79`, where each call independently awaits
`loadAndroidWidgetModule()` (a dynamic `import`, `:46`) and then the native `setPayload`, with no
queue, no generation counter and no cancellation. Two fact changes inside one import window produce
two overlapping native writes, and nothing in the JS or the Kotlin
(`VersutusWidgetModule.kt:19-26` → `WidgetPayloadStore.write`, a whole-value `putString`) imposes an
order, so the card can be left showing the **older** snapshot with the newer facts' stamp discarded.
This is a hardening gap rather than a demonstrated failure — the native `AsyncFunction` hop makes
completion order non-guaranteed, not provably reversed — and it is independent of WIDGET-1.
**What fails:** Widget writes are fire-and-forget with no ordering guard, so a slow write can land after a newer one

#### R2-NW-V3 · S3 · A refused first widget write also means the six-hourly redraw worker is never scheduled

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `modules/versutus-widget/android/.../VersutusWidgetModule.kt:19-26` — the only
`WidgetRefreshPolicy.enqueue(context)` call is at `:23`, *after* both refusal guards at `:20` and
`:21`, and `rg WidgetRefreshPolicy` finds no other caller. So when the first write of the session is
refused (no react context, or `parse` refusing the JSON), the periodic worker is never enqueued and
the card's stamp never rolls "Today" → "Yesterday" on its own — the operator has to open the app and
get an accepted write for the date to move. It is the same refusal as WIDGET-1 but a distinct,
native-side consequence with its own lines, and it is unreported in the scan.
**What fails:** A refused first write also means the six-hourly redraw worker is never scheduled


### Area: Phone notifications

#### R2-NOTIF-01 · S2 · The push relay never sends a category, so no relayed notice has Approve/Deny

**Verification:** partly confirmed (corrected)
**Where:** `src/lib/notifications/categories.ts:32,42-58,106-113`, `src/lib/notifications/local.ts:156-162`,
`src/lib/notifications/approval-action.ts:36-53`, `gate/core/push-notifier.mjs:174-184`, `gate/core/push-rpc.mjs:136-143`
**What fails:** A run that needs an approval while the phone has no usable connection to the Gate — the only case push
exists for — arrives as a bare "Approval required" tray notice with **no buttons**. The operator must open the app to
decide; the Approve/Deny affordance the app registers, and the whole decision path in `approval-action.ts` +
`_layout.tsx:296-339`, never runs for that notice. Same for the bot-message Reply action on a push reply.
**Why:** Android attaches actions only when the notification content carries a category
(`ExpoNotificationBuilder.kt`: `notificationContent.categoryId?.let { addActionsToBuilder(builder, it) }`), and for a
push that content field comes from the FCM data key `categoryId` (`NotificationData.kt:58-59`). The Gate's approval
message (`push-notifier.mjs:174-184`) carries `title/body/data/channelId/sound/priority` and no `categoryId`;
`rg categoryIdentifier|categoryId gate/` returns nothing, and `push-rpc.mjs:136-143` (the test notice) is the same.
The only poster that supplies `categoryIdentifier` is the *local* one, `local.ts:156-162` — i.e. the one that cannot
post at all once the phone is off the network.
**Corrected after independent verification:** S3, not S2, for approvals — the buttons cannot exist usefully on a relayed approval, because
only a run *this* app initiated can be approved and only while `connected`. The real capability lost is the
bot-message **Reply** action on a relayed reply (see V-1: that action is dead on *every* notice today). Fix is the
same one field, so the finding stays open — just re-scoped: add `categoryId: 'approval'` only if the local-driver
constraint is relaxed, and `categoryId: 'botmessage'` on the `kind:'reply'` message for the real win.

#### R2-NOTIF-02 · S2 · Typing a quiet-hours change and touching any other switch silently discards it

**Verification:** confirmed
**Where:** `src/components/gateway/notifications-section.tsx:66-72` (and the card layout at `:162-239`),
`src/hooks/use-notification-preferences.ts:126`
**What fails:** With quiet hours already set (say 22:00–07:00), edit the "From" field to 23:30, then flip *any other
control on the same screen* — "Rich message text", "Home-screen widget updates", a Bot-filter switch, or "Approvals
pierce quiet hours", which sits inside the same card. The From field snaps back to 22:00 a beat later and the edit is
gone; "Save quiet hours" then saves the old window.
**Why:** The section seeds the two fields from `prefs.quietHours` in an effect whose only dependency is that object's
identity (`notifications-section.tsx:66-72`). `normalize()` in the hook builds a **fresh object** for every read and
every write (`use-notification-preferences.ts:126`, `:126` inside `setPatch`), so *any* preference write changes the
identity and re-runs the seed, overwriting whatever the operator has typed. There is no "dirty field" guard and no
separation between "the Gate's saved value" and "the text on screen".

#### R2-NOTIF-03 · S2 · The routine-notice module re-requests notification permission on every routine, every sync

**Verification:** partly confirmed (corrected)
**Where:** `src/lib/notifications/routine-sync.ts:22,35-44,119,169-172`, callers: `src/context/gateway-provider.tsx:4807-4832`,
`src/components/chat/chat-screen.tsx:1705-1731`
**What fails:** With three routines, each connected transition and each visit to a Bot Chat fires three concurrent
`Notifications.requestPermissionsAsync()` calls — including from the background, where Android 13+ cannot show the
dialog — and repeats them on every reconnect and every re-read for as long as permission is not granted. Routines whose
cron is beyond the two repeating shapes never get their notice scheduled, and the phone is asked for permission over
and over.
**Why:** This module keeps its own copy of the gate (`permissionGranted`, `:22`) and, unlike `local.ts`, asks rather
than reads (`:36-40`). `rearmRoutineNotifications` fans out over all live jobs with `Promise.all` (`:171`), so every
job's call is issued in the same tick **before** any of them has resolved and set the cache — N requests, not one.
The earlier audit's NOTIF-1 fixed precisely this shape in `local.ts:25-97` (read first, remember a denial with a TTL,
ask only while foregrounded); the sibling was left with the old code.
**Corrected after independent verification:** S3 (not S2) — `src/lib/notifications/routine-sync.ts:35-44` re-requests the OS permission on
every routine sync and every Bot Chat routine read while permission is not granted: N concurrent
`requestPermissionsAsync()` calls per re-arm (`:171`), from the background where Android 13+ cannot show the
dialog, with no denial memory — the same shape already fixed in `local.ts:25-97`. Trigger: any device that has not
granted (or has denied) notifications, on every reconnect and every Chat open. The "beyond-the-two-shapes never
scheduled" sentence is withdrawn (`routine-schedule.ts:119-125`).

#### R2-NOTIF-04 · S2 · Re-arming a routine's notice is not atomic, so collisions leak duplicate notices

**Verification:** confirmed
**Where:** `src/lib/notifications/routine-sync.ts:51-66,118-138,169-172`; two independent re-arm callers,
`src/context/gateway-provider.tsx:4807-4832` and `src/components/chat/chat-screen.tsx:1719`
**What fails:** Two re-arms overlapping (open a Bot Chat while the 1.5 s connected re-arm is in flight — routine over
Tailscale reconnects often) each schedule a new OS notification for the same job, both then cancel the *old* id and
both write a new id. Two identical "Routine X is due" notices are now queued, only one id is persisted, and each
later collision leaks one more. The tray eventually fires duplicate notices at the scheduled time and the orphans are
never retired — the OS queue grows without bound.
**Why:** `syncRoutineNotification` is schedule → `cancelKnownNotice` (read id, cancel, delete key) → `setItem` in
that order (`:120-138`), with no lock, no generation check and no atomic swap. The persisted id (`:138`) is written
*after* the cancellation, so whichever call finishes last owns the key while the other's scheduled notification is
already orphaned in `SharedPreferencesNotificationsStore` + `AlarmManager`. Nothing anywhere enumerates scheduled
notifications to reconcile them; only the single persisted id is ever cancelled.

#### R2-NOTIF-05 · S2 · A run-progress notice left by a killed process is never retired — the tray keeps claiming a finished run is running

**Verification:** confirmed
**Where:** `src/context/gateway-provider.tsx:1134-1157` (esp. `:1147-1149`, `:1153-1155`), `:2493` (runs restored),
`src/lib/notifications/local.ts:409-420,427-433`
**What fails:** Start a long run, let Android kill the app (screen off — the normal state for a run this app notifies
about). The tray keeps "Run in progress / Elapsed 4:12 / Last update 23:41". Reopen the app: the restored row is
reconciled to `complete`, but the notice is not dismissed. If the operator is looking at the app, the settle notice is
suppressed as well, so the tray is left asserting that a finished run is still in progress until it is swiped away.
**Why:** Both retirement paths are gated on `runProgressNoticeIdsRef`, an in-process `Set` (`:1135`, `:1147`, `:1153`)
that starts empty in a new process, and `dismissRunProgress` is only ever called with an identifier read from it. A
notice posted by the previous process has the right identifier (`run-progress:<runId>`, deterministic —
`run-progress.ts:57-59`) but nothing ever asks the OS to retire it; only `dismissGatewayDown` scans the tray
(`local.ts:266-290`), and run-progress notices do not. `present()` also refuses while foregrounded (`local.ts:123`),
so nothing replaces the stale copy either.

#### R2-NOTIF-06 · S3 · Approve/Deny on a posted approval notice is dropped, with no fail-closed notice, if the process was killed

**Verification:** confirmed
**Where:** `src/lib/notifications/categories.ts:47-58` (`opensAppToForeground: false`), `src/app/_layout.tsx:296-339`
(the only decision path), `src/lib/notifications/local.ts:192-211` (the copy that would tell the operator)
**What fails:** An approval notice posted while the app was alive is still in the tray; Android then kills the process.
The operator taps **Approve**. Nothing happens at all — no decision, no notice, no navigation — and the run stays
blocked. Worse, Android's auto-dismiss defaults to true, so the notice the operator was reading is gone.
**Why:** `handleNotificationResponse` (expo-notifications `ExpoHandlingDelegate.kt`) only starts the app when the
action *does* open it to foreground, and then says so in its own comment: "the listeners are not set up when the app
is killed … this code is a noop in that case" — the response goes into an in-process static list that dies with the
process. `categories.ts:14-18` documents exactly this bound and hands the fail-closed path to "the action handling",
but the action handling is the JS listener, which is what never runs. The only other thing expo runs for a custom
action on a killed app is a headless TaskManager task, and the app's only such task is the widget one
(`src/lib/widget/widget-push-task.ts`), which ignores an approval payload.

#### R2-NOTIF-07 · S3 · A failed local write of the push token silently kills the Gate registration

**Verification:** confirmed
**Where:** `src/lib/notifications/push-registration.ts:80-93` (esp. `:87-88`), `:157-169`, `:41-47`
**What fails:** One Keystore hiccup while writing the Expo token to SecureStore, and the phone stops registering push
with the Gate for the rest of the session — no token row, no push, and nothing on screen or in the Settings section
saying why. Push quietly stops arriving.
**Why:** `obtainGrantedExpoPushToken` persists the token *before* returning it (`:88`), and its `catch` turns any
throw into `return null` (`:90-92`). `secureKeyValueStorage.setItem` retries once and then throws
(`src/lib/storage/secure-key-value.ts:113-128,160-178`). The caller reads null as "no token" and returns before
`registerWithGate` (`:164-166`), and the outer `catch` (`:167-169`) keeps the whole thing silent. The module's own
header states the token is persisted *only* so a rotation is noticed — a cache write that can veto the registration.

#### R2-NOTIF-08 · S3 · Push re-registration runs on every reconnect, including the monitor's silent self-heal

**Verification:** confirmed
**Where:** `src/context/gateway-provider.tsx:2040-2049`, `src/lib/notifications/push-registration.ts:145-170`
**What fails:** On a flapping Tailscale link, every `connected` transition — including the ones the health monitor
earns back without any user action — re-runs `registerWidgetPushTask()`, `getPermissionsAsync()`,
`getExpoPushTokenAsync()` and an authenticated `notifications.register` RPC. That is two native round trips plus one
request to the single-threaded Gate for a token that has not changed, roughly every 30–70 s.
**Why:** The registration at `:2048-2049` is *not* behind the `noteConnectedFanOut` guard the comment four lines above
describes ("A `connected` the monitor earned back on its own repeats no fan-out"). `syncPushRegistration` has no
"unchanged token" short-circuit either: it re-reads the permission, re-fetches the token and re-POSTs it every time,
and it is `void`-ed so it overlaps whatever else the same transition starts.

#### R2-NOTIF-09 · S3 · The Settings screen's notification permission is read once at mount, so it can claim push is on when the OS has switched it off

**Verification:** confirmed
**Where:** `src/hooks/use-notification-preferences.ts:57,68-80,138-156`, `src/components/gateway/notifications-section.tsx:127-142`
**What fails:** The operator revokes notifications for Versutus in Android Settings and returns to the app.
Settings → Notifications still shows the relay toggle on, no denial caption, and every `preferences.set` write still
succeeds — the screen asserts a state the phone has already contradicted, and the operator waits for pushes that can
never arrive.
**Why:** `permission` is state seeded by a mount-only effect with `[]` deps (`:68-80`); nothing re-reads it on
foreground, on tab return, or after a write, and the caption that would warn is driven by that same cached value
(`notifications-section.tsx:141`). The sibling weekly-report module solved exactly this and says so —
`readWeeklyReportOptIn` is documented as safe to call "on every mount, every return to its tab and every return to the
foreground — the read answers the device that is there now, never a cached first answer"
(`src/lib/notifications/weekly-report.ts:43-64`). The toggle's own copy promises "Permission is asked here … never at
launch", which is true of asking and false of reporting.

#### R2-NOTIF-10 · S3 · Preference writes are neither optimistic nor serialized: a switch can look dead for 30 s and the screen can repaint stale state

**Verification:** partly confirmed (corrected)
**Where:** `src/hooks/use-notification-preferences.ts:113-135`, `src/components/gateway/notifications-section.tsx:165-233,247-268`,
`src/lib/gateway/http-transport.ts:6`
**What fails:** Toggle "Widget updates" then "Rich message text" within a second on a slow link. The switches do not
move at all until a reply arrives (up to the 30 s request timeout), and whichever response lands last repaints the
whole card from that reply's row — so the screen can show `widgetUpdates: false` after it was turned on, with the
Gate holding `true`. Two quick taps on two Bot-filter switches are worse: the second patch is computed from the
pre-first-response row, so the first Bot's id is dropped from the allowlist the Gate stores.
**Why:** `setPatch` never touches `prefs` optimistically and holds no request sequence number or queue; each call
independently does `setPrefs(normalize(raw))` (`:126`) with the whole row the Gate returned at that moment, and
`saving` is cleared by whichever call finishes first (`:131`), re-enabling switches while another write is in flight.
`prefs` is also the only input to `filterRows` / `toggleBotFilter` (`notifications-section.tsx:62,96-103,247-268`), so
a not-yet-reflected write is invisible to the next patch. No ordering is enforced between the two requests.
**Corrected after independent verification:** S4 — `setPatch` (`use-notification-preferences.ts:113-135`) is neither optimistic nor
serialized: a switch does not move until the reply lands (up to the 30 s timeout at `http-transport.ts:6`), and
because `load()` re-runs on every `connected`/`gatewayRequest` change (`:104`, effect `:106-111`) a `preferences.get`
that started before an in-flight `notifications.preferences.set` can land after it and repaint the whole card with
the pre-write row (`:95` vs `:126`). `saving` is cleared by the first caller to finish (`:131`), re-enabling the
switches mid-write. The two-Bot-switch lost-allowlist-update scenario is **withdrawn** — `disabled={saving ||
!synced}` blocks the second tap.

#### R2-NOTIF-11 · S3 · Every run event re-posts the run-progress notice (and the Live Activity) with no throttle

**Verification:** confirmed
**Where:** `src/context/gateway-provider.tsx:1134-1157` (`:1137`, `:1146`), driven by `:3481-3489`,
`src/lib/notifications/local.ts:409-420`
**What fails:** With the phone in a pocket and a long agent run streaming tool output, the app wakes the notification
pipeline once per run event — a broadcast, a rebuild and a `NotificationManager.notify` for each — for as many events
as the run emits. The tray copy is identical each time; the cost is battery and CPU on a locked phone. On iOS the same
pass hands ActivityKit an update per event, which the system throttles and eventually stops refreshing.
**Why:** The effect's dependency is `activityRuns`, which `patchActivityRuns` replaces on every event
(`:3460`, `:3481-3489`, `:3594-3616`), so each event re-runs the whole pass; inside it `notifyRunProgress` is called
for every in-flight run with no time- or content-based throttle and no "unchanged since last post" check (the fold's
own text includes a `Last update <clock>` line, so even identical state re-posts different bytes). The re-post is at
least idempotent in the tray (expo notifies with the identifier as the tag, `ExpoPresentationDelegate.kt:108-112`), so
this is cost, not duplication — but it is unbounded in the event rate.

#### R2-NN-V1 · S2 · No producer sets the bot-message category, so the built Reply quick-action is dead for every notice

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** The bot-message **Reply** action is unreachable from every notice that exists — not only from
relayed pushes, as NOTIF-01 says.
`src/lib/notifications/categories.ts:68` defines `BOT_MESSAGE_CATEGORY_ID = 'botmessage'` and `:77-95` defines the
action with `opensAppToForeground: true` and a `textInput`; `:109` registers the category at mount.
But `grep -rn "categoryIdentifier\|CATEGORY_ID" src` (excluding tests) returns exactly one *use*:
`src/lib/notifications/local.ts:161` passes `APPROVAL_CATEGORY_ID`. No poster anywhere passes
`BOT_MESSAGE_CATEGORY_ID` — the only other `scheduleNotificationAsync` callers are
`src/lib/notifications/routine-sync.ts:120` and `src/lib/notifications/weekly-report.ts:188`, neither of which
sets a category. Since `ExpoNotificationBuilder.kt:113` is the only thing that attaches action rows, no notice can
ever carry the Reply button, so the handler at `src/app/_layout.tsx:345-355` and
`src/lib/notifications/bot-reply.ts:38-48` (`botReplyFromResponse`) can never fire, along with
`deliverBotReply` (`:129-154`) and its two follow-up notices.
The module's own header understates the gap: `bot-reply.ts:9-13` says "**No producer writes it yet**". That is no
longer true of the payload: `gate/core/push-notifier.mjs:102-110` emits
`data: { kind: 'reply', sessionId, botId }` — exactly the `{botId, sessionId}` contract `botReplyFromResponse`
requires — so the producer exists and only the one field that attaches the button is missing.
**What fails:** S2 — the §6 quick-reply feature is fully built (category, action, payload reader, send path,
two failure notices) and dead in the one line that would light it up: no producer, local or relayed, sets
`categoryId: 'botmessage'`, so no Android notice ever shows a Reply button. Fixing NOTIF-01's relay payload
(`categoryId` on `kind:'reply'`) is what makes this reachable; doing only that leaves any future *local*
bot-message notice button-less too.

#### R2-NN-V2 · S3 · The two reply-failure notices can never be seen because notices are refused while the app is foregrounded

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** Three "fail-closed" notices are structurally suppressed by the very gate they are posted behind.
`src/lib/notifications/local.ts:115-123` — `present()` returns `null` immediately when
`AppState.currentState === 'active'` unless `allowForeground` is passed; `notifyBotReplyNotSent`
(`:220-222`) and `notifySessionOpenFailed` (`:233-235`) both call `present(title, body)` with **no**
`allowForeground`. Their only call sites are all on the notification-response path:
`src/app/_layout.tsx:144` and `:153` (inside `deliverBotReply`, reached from the listener at `:345-355`) and
`:242` (`notifySessionOpenFailed`, inside `replySessionRef` which runs at `:376`/`:412`, i.e. after
`router.navigate(destination)` at `:410`). The bot-message Reply action is `opensAppToForeground: true`
(`categories.ts:87`), so tapping it *is* what brings the app to the foreground — and on a cold start the response
is drained from expo's pending list only after boot (`ExpoHandlingDelegate.kt:49-53`), by which time
`AppState` is `active`. The operator therefore types a reply, the send fails, and the app is silent — the exact
case `bot-reply.ts:59-68` ("Nothing was sent", "Open Versutus to reply") and
`local.ts:226-232` were written to prevent.
Contrast the one that works: `notifyApprovalDecided` / `notifyApprovalRefused` are posted from the Approve/Deny
action, which does **not** foreground (`categories.ts:51,56`), so `present()` sees a backgrounded app.
**What fails:** S3 — `notifyBotReplyNotSent` and `notifySessionOpenFailed` can never be seen, because
`local.ts:123` refuses to draw anything while the app is foregrounded and both are only ever posted on a path the
operator's own tap has just foregrounded. Fix: pass `allowForeground = true` for these two (their whole purpose is
to be read by the person holding the phone), or route them through an in-app banner.

#### R2-NN-V3 · S3 · A fresh install opens Settings -> Notifications claiming the OS reports notifications as denied

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** The permission caption can state a denial that never happened, on the most common first-run path.
`src/hooks/use-notification-preferences.ts:70-72`:
`Notifications.getPermissionsAsync().then((result) => setPermission(result.granted ? 'granted' : 'denied'))` —
every non-granted status collapses to `'denied'`, including expo's `'undetermined'`. That status is real and is
what a phone that has never been asked reports:
`expo-notifications/android/.../permissions/NotificationPermissionsModule.kt:63-70` resolves
`PermissionsStatus.UNDETERMINED.status` with `GRANTED_KEY = areAllGranted` (false) when neither all-granted nor
all-denied and notifications are enabled — i.e. first launch on Android 13+, and every first launch on iOS.
`src/components/gateway/notifications-section.tsx:141` then prints "The OS currently reports notifications as
denied", two lines below copy that says "Permission is asked here — turning this on — never at launch"
(`:138-140`). The two statements contradict each other on the screen that exists to be honest about permissions,
and the app's own gate for "no denial" is available and unused: `weekly-report.ts:135-141` distinguishes a
refusal from a never-asked state.
**What fails:** S3 — a fresh install (or any device where permission has never been requested) opens
Settings → Notifications asserting the OS reports notifications as denied, because
`use-notification-preferences.ts:72` maps `'undetermined'` to `'denied'`. Fix: carry the real status through
(`'undetermined'`) and show the denial caption only for a true denial; the state is also the correct input for
`setEnabled`, which today reports "Notifications are off for Versutus in the system settings" (`:149`) for a
permission that was never asked.

#### R2-NN-V4 · S3 · The notifications error card promises locked switches that a failed write does not lock

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/components/gateway/notifications-section.tsx:107-114` renders one `ErrorCard` for **any**
`error` from the hook with the fixed instruction
"Retry — the switches below stay locked until the Gate's own settings are read." That is true only for a failed
*load*. In `src/hooks/use-notification-preferences.ts` a failed `setPatch` (`:128-130`) sets `error` and leaves
`synced` at its previous `true` (set only on success at `:96` and `:127`), and every switch is gated on
`saving || !synced` (`notifications-section.tsx:170,185,222,230,263`) — so after a rejected write the card
asserts the switches are locked while they are live, and the operator's next tap re-issues the same failing write.
**What fails:** S4 (cosmetic, operator-facing honesty) — the error card's copy promises the switches stay
locked "until the Gate's own settings are read", but a failed *write* leaves them enabled
(`use-notification-preferences.ts:128-130` never clears `synced`); only a failed initial read locks them.


### Area: Home and Activity screens

#### R2-ACT-1 · S2 · Pause and Resume do the opposite of what they say: pausing a routine schedules its "due" notice, resuming cancels it

**Verification:** partly confirmed (corrected)
**Where:** `src/components/activity/cron-job-sheet.tsx:120-135`, `src/lib/notifications/routine-sync.ts:93-99,149-151`
**What fails:** Activity → Cron → open a scheduled job → tap **Pause**. The host pauses the job, but the
phone *schedules* the local "due" notification for it (`cron-job-sheet.tsx:126-132`), so the tray announces
a routine that will never run. Tap **Resume** and the phone *cancels* the notice (`:134`), so a genuinely
resumed routine goes silent until the next connected re-arm, which reads only Bot routines
(`gateway-provider.tsx:4829-4897`), not gateway-level cron.
**Why:** `paused` at `:121` is the state *before* the toggle, and the branches are inverted against the
comment that states the intent (`:122-125`, "retire the held notice on a pause … rebuild it on a resume").
`if (!paused)` is true exactly when we have just *paused*, yet it calls `syncRoutineNotification` — and that
function's own pause branch (`routine-sync.ts:96-99`) is unreachable here because the object passed at
`cron-job-sheet.tsx:127-132` carries no `paused` field, so `job.paused` is `undefined` and it schedules
(`routine-sync.ts:110-138`).
**Corrected after independent verification:** S3. `cron-job-sheet.tsx:126-135` branches on the pre-toggle `paused` value, so
Pause calls `syncRoutineNotification` and Resume calls `cancelRoutineNotification`. For a Bot-owned
cron routine opened in Activity's Cron sheet, pausing schedules the local "due" notice for a routine
that will not run and resuming retires a live notice (silent until the next connected re-arm, which
reads `botJobs.list()` / `cron.list()` at `gateway-provider.tsx:4807-4832`). For a gateway-level job
(created by Activity's unprefixed form) the sync hits `routine-sync.ts:106-109` and cancels instead, so
both branches cancel and no wrong notice appears. The two call sites disagree: the Bot Chat pane gets
it right (`src/components/chat/chat-screen.tsx:1685` `if (paused) void cancelRoutineNotification(jobId)`,
with `paused` the post-toggle argument).

#### R2-ACT-2 · S2 · Runs that were still going when the app closed are reported on Home as failed / ended without a result

**Verification:** confirmed
**Where:** `src/lib/gateway/session-persistence.ts:211-223` (called from `:239`), `src/lib/home/briefing.ts:36-43,62-77,119-120`, `src/lib/activity/glance.ts:27-30`
**What fails:** Start a run, lock the phone, kill the app. Reopen it. The Gate keeps the run going (audit
BG-1), but the restore stamps the run `finishedAt: Date.now()` and rewrites its status to `cancelled`/
`unresolved` (`session-persistence.ts:213-219`). Home's digest then counts it as *news that finished while
you were away* and prints "1 failed" or "1 ended without a result" for work that is still executing on the
PC. Activity's figures do not count it as working either (`glance.ts:28` counts only `status === 'running'`),
while the day ribbon draws it as a dim settled bead (`glance.ts:78`). Nothing on either screen says the run
is still in flight.
**Why:** `buildHomeBriefing` treats any run with `finishedAt > lastSeenAt` as settled news
(`briefing.ts:63-64,75-76`) and folds `cancelled` into `failed` (`briefing.ts:42`). The restore is what
supplies that `finishedAt`: it is a *load* timestamp, not a finish (`session-persistence.ts:217`). This is
the exact inversion the module's own header rule forbids — "A run that never reached a terminal state is
'still going' from the operator's point of view, never a finished run" (`briefing.ts:10-12`). The fake stamp
is then made permanent by the next `saveActivityRuns`.

#### R2-ACT-3 · S2 · Two approvals decided at once race an unserialized audit write, and one decision is lost

**Verification:** confirmed
**Where:** `src/lib/gateway/approval-policy.ts:234-244`, `src/context/gateway-provider.tsx:3347-3356`, `src/components/activity/approval-inbox.tsx:157,163`
**What fails:** Approve row A and Deny row B within the same second on Activity's "Needs you" inbox. Both
`decideApproval` calls reach `recordApprovalDecision`, which does `loadApprovalAudit()` → build a new array
→ `setItem` with no queue. Whichever write lands second was computed from a snapshot that did not contain
the first decision, so one decision vanishes from the durable audit Activity renders under "Your decisions"
— the only record the device keeps of what the operator answered.
**Why:** `recordApprovalDecision` is a read-modify-write with no serialization (`approval-policy.ts:236-240`),
unlike the two writes the prior audit credited as correctly serialized (`storage.ts:31-40` and
`session-persistence.ts:253-264`). Nothing serializes this one because each inbox row's buttons are disabled
only against *its own* id (`approval-inbox.tsx:157,163` — `approvalBusy === row.approvalId`), so two
different rows are decided concurrently by design.

#### R2-ACT-4 · S2 · "Approve/Deny all" is 3N serial round-trips that blank the inbox on every one of them

**Verification:** partly confirmed (corrected)
**Where:** `src/components/activity/approval-inbox.tsx:76-86`, `src/context/gateway-provider.tsx:3339-3362,3325-3337`
**What fails:** With 8 pending approvals, "Deny all" issues 8 approvals plus 8 approval-list re-reads, one
after another, with no timeout of its own beyond the transport's 30 s each. On the lossy relayed tailnet this
path is minutes long; the operator sees `batchBusy` and a spinner and no progress, and if approval 5 fails
the loop aborts, leaving 3 rows undecided behind one error named "This approval decision".
**Why:** The `for … await decideApproval(id)` loop (`approval-inbox.tsx:79`) is serial, and each
`decideApproval` performs three sequential operations: the RPC, the audit storage write, then
`await refreshPendingApprovals()` (`gateway-provider.tsx:3343-3358`). `refreshPendingApprovals` sets
`pendingApprovalsState` to `'loading'` on entry (`gateway-provider.tsx:3326`), and the inbox renders a
skeleton for `loading` and nothing for non-`ready` (`approval-inbox.tsx:99-104,115`), so the list flickers to
a skeleton 8 times during one tap.
**Corrected after independent verification:** S3. "Deny all"/"Approve N read-only" is N strictly serial
`decideApproval` calls (`approval-inbox.tsx:79`), each = 1 Gate RPC + 1 local audit write + 1
`approvals.pending` re-read (`gateway-provider.tsx:3343-3357`). Each re-read flips
`pendingApprovalsState` to `loading` (`:3326`), which the inbox renders as a skeleton and nothing else
(`approval-inbox.tsx:99-104,115`), so one tap on 8 rows blanks the list 8 times with no progress
indicator; a refusal at row 5 aborts the loop and leaves rows 6-8 undecided behind a single
"This approval decision" error.

#### R2-ACT-5 · S2 · The "while you were away" window never advances, so news from the visit in progress is labelled as news from your absence

**Verification:** partly confirmed (corrected)
**Where:** `src/app/(tabs)/home.tsx:32-45`, `src/components/home-briefing-card.tsx:25,30-46,48-54`
**What fails:** The stamp is written only when the operator *leaves* — app background (`home.tsx:40-45`) or
Home unmount (`:37-39`) — and is read on arrival (`home-briefing-card.tsx:39-41`). Nothing writes it on
arrival. So while Home stays focused the card's window is still the *previous* leave's, and a run that
finishes at 14:05 in front of the operator joins a window that opened at 09:00 and is printed under "While
you were away" (`home-briefing-card.tsx:64-66`) for the rest of the visit, and again on the next focus,
because the stamp only moves when the app backgrounds. The reverse also holds: nothing marks the news as
consumed, so the same lines repeat on every return to Home until the app is backgrounded.
**Why:** The write edges (background, unmount) and the read edge (`useFocusEffect` focus) are different
edges of one visit and no "arrived" write exists. `lastSeenAt` is component state held for the focus
(`home-briefing-card.tsx:25,40-41`) and the memo recomputes only when the stamp or the run list changes
(`:48-51`).
**Corrected after independent verification:** S3. The digest window is written only on app-background (`home.tsx:40-45`) — never
on arrival, and not on navigation either, since the drawer keeps Home mounted — so while Home is
focused the window stays the last background's, in-visit completions are labelled "While you were away"
(`home-briefing-card.tsx:64-66`), and returning to Home re-prints the same lines
(`:30-46,48-51`) until the app is backgrounded.

#### R2-ACT-6 · S2 · The digest disappears entirely when one storage read fails, with no error and no retry

**Verification:** confirmed
**Where:** `src/lib/home/last-seen.ts:47-56`, `src/components/home-briefing-card.tsx:30-46,54`, `src/lib/home/briefing.ts:56`
**What fails:** On Android a bare `AsyncStorage.getItem` (`src/lib/storage/key-value.ts:41-44`, no timeout)
can reject. `loadLastSeen` catches it and returns `null` (`last-seen.ts:53-55`); `buildHomeBriefing` returns
`null` on a null stamp (`briefing.ts:56`); `HomeBriefingCard` returns `null` (`home-briefing-card.tsx:54`).
The card renders nothing — no news, no error, no empty state, no retry — an absence indistinguishable from
"nothing happened", which is the one claim the module's header rule forbids (`briefing.ts:8-9`).
**Why:** `null` is overloaded — it means both "never stamped" and "could not be read"
(`last-seen.ts:53-55`). The read runs once per focus with no retry path (`home-briefing-card.tsx:30-46`),
so the digest stays gone for the rest of the visit and re-appears only if a later focus happens to succeed.

#### R2-ACT-7 · S2 · Activity's pull-to-refresh fans out four Gate reads plus a fifth from the focus edge

**Verification:** partly confirmed (corrected)
**Where:** `src/app/(tabs)/activity.tsx:121-136,149-156`, `src/components/activity/cron-section.tsx:76-79,84-88`
**What fails:** Every pull fires `refreshCapabilities()`, `refreshGateways()` and
`refreshPendingApprovals()` in one `Promise.all` (`activity.tsx:125`), then `readAudit()` (`:130`), then
`setCronReloadSignal` (`:131`) which re-runs `CronSection`'s mount effect (`:76-79`) — a fourth read — while
`CronSection`'s `useFocusEffect` (`:84-88`) has already fired a fifth `cron.list()` on the same focus event.
The Gate answers one request at a time (`gateway-provider.tsx:3374`), so the spinner reflects the *sum*, not
the max: on the host the repo measured (one 200-row session read ≈ 11 s, audit NET-3/SPD-3) recovery is the
slowest thing on the tab.
**Why:** `Promise.all` is a fan-out (`activity.tsx:125`) against a serialising backend, and `cronReloadSignal`
(`:65,131`) adds an independent read rather than reusing the one `CronSection` already issues on focus.
**Corrected after independent verification:** S3. One pull-to-refresh on Activity issues, in one `Promise.all`,
`refreshCapabilities()` (an awaited health check, an un-awaited capabilities read and a manifest fetch
against the gateway), a purely local `refreshGateways()`, and one `approvals.pending` RPC
(`activity.tsx:125`); it then awaits a local audit read (`:130`) and bumps `cronReloadSignal` (`:131`),
which makes `CronSection`'s mount effect issue an extra `cron.list()` (`cron-section.tsx:76-79`) that
duplicates the read focus already issued. There is no client-side request queue, so against the
host the repo documents as single-threaded the spinner waits on the sum of a concurrent fan-out.

#### R2-ACT-8 · S3 · `CronSection` reads its list twice on mount and never guards against overlapping loads

**Verification:** confirmed
**Where:** `src/components/activity/cron-section.tsx:61-79,84-88`
**What fails:** On first visit to Activity two `cron.list()` calls are issued in the same tick (the mount
effect at `:76-79` and the focus effect at `:84-88`, both on mount). Thereafter every return to the tab fires
a fresh `load()` with no in-flight guard, so on a slow path two reads overlap and the older one can resolve
last and overwrite the newer list — the section paints stale rows for a routine that was just paused, run or
removed. `load()` has no request-generation guard, unlike `reloadHistoryFor` (`gateway-provider.tsx:1306,
1448`) and unlike `CronRunSheet`'s `cancelled` flag (`cron-run-sheet.tsx:40,45`).
**Why:** `load` is a plain `useCallback` that writes `setJobs(await cron.list())` unconditionally
(`cron-section.tsx:61-74`); nothing records which read owns the current rows.

#### R2-ACT-9 · S3 · The cron transcript sheet polls every 3 s forever, with no backoff after a failure and no abort on close

**Verification:** confirmed
**Where:** `src/components/activity/cron-run-sheet.tsx:36-50,56-71`, `src/context/gateway-provider.tsx:4849-4852`
**What fails:** Open a cron run transcript on a tailnet link that has gone bad. `setInterval(poll, 3000)`
(`:63`) keeps firing every 3 s for as long as the sheet is open; each poll is an RPC with the transport's
30 s default ceiling (`http-transport.ts:6,124`), so up to 10 reads pile up in flight against the Gate that
serves them one at a time. Closing the sheet clears the interval but does not cancel the reads in flight
(`:66-70` clears a timer, never a request — `poll` takes no `AbortSignal`), so those queued reads keep
occupying the Gate after the operator has gone.
**Why:** No in-flight guard, no error backoff (a refused poll is retried in 3 s like a healthy one), and the
`cron` seam's `transcript` has no way to cancel (`gateway-provider.tsx:4849-4852` → `rpcRequest`, which
accepts no signal).

#### R2-SH-V1 · S2 · recordApprovalDecision reads the audit leniently, so one failed read rewrites the key and erases the whole decision history

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** Found while verifying ACT-3. `src/lib/gateway/approval-policy.ts:211-217` is the lenient
wrapper — `try { return await loadApprovalAuditStrict(); } catch { return []; }` — and
`loadApprovalAuditStrict` (`:204-208`) throws on both a storage refusal *and* a `JSON.parse` failure.
`recordApprovalDecision` (`:234-244`) reads through that lenient wrapper and then writes the whole
array back at `:237-239`. So any single transient read failure — a corrupt or half-written value under
`APPROVAL_AUDIT_STORAGE_KEY` (`:152`), or one rejected `AsyncStorage.getItem` — makes the function
append to `[]` and `setItem` an array holding only the newest entry, silently discarding the operator's
entire on-device decision history. The strict loader exists precisely to keep those two facts apart
(`:198-203`: "so a UI can tell 'failed' from 'genuinely empty'"), and both read surfaces use it
(`src/app/(tabs)/activity.tsx:95`), but the only writer does not — so the one code path that can
destroy the log is the one that cannot tell it failed. `src/app/gateway/settings.tsx:197` reads
leniently too, which is a lesser version of the same smell: a storage failure there prints
`approvalAuditSummaryCopy(0)` — "No approval decisions recorded on this device yet."
(`src/lib/gateway/approval-policy.ts:229`) as if the log were genuinely empty.
**What fails:** S2. `recordApprovalDecision` reads the audit through the lenient
`loadApprovalAudit()` (`approval-policy.ts:236`), which folds a corrupt value or a storage refusal
into `[]` (`:211-217`), then overwrites the key with just the new entry (`:237-239`) — one bad read
permanently erases the whole on-device approval-decision history, which is the only durable record of
what the operator answered. The strict loader that distinguishes the two (`:204-208`) is used by both
read surfaces but not by the writer.

#### R2-SH-V2 · S3 · The Activity 'New scheduled job' form calls a routine-notice sync that can never schedule anything for a gateway-level job

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** Found while verifying ACT-1. `src/components/activity/cron-section.tsx:109-119` calls
`void syncRoutineNotification({ id: jobId, name: created?.name, schedule: submitted.schedule })`
after a confirmed create, under the comment "the create landed: schedule the phone-side notice under
the id the gateway returned". But the name it passes is the raw draft title, and this form's whole
point is that the title is unprefixed so the job files as gateway-level rather than as a Bot's Routine
(`src/lib/gateway/cron-create.ts:14-16`, `:28-29`, `:31-37`). `syncRoutineNotification` then parses
that name (`src/lib/notifications/routine-sync.ts:101`) and, finding no `botId`, takes the
"withhold and retire" branch at `:106-109` and returns without scheduling anything. So the phone-side
"due" notice for every job created from Activity's own form is never created — the comment at
`cron-section.tsx:109-111` describes a behaviour the code cannot perform, and the same withholding also
means the connected re-arm can never build one (`gateway-provider.tsx:4817` → `rearmRoutineNotifications`
→ the same `:106-109`). This is the same `!botId` guard that makes ACT-1's gateway-level pause
accidentally correct, seen from the other side.
**What fails:** S3. The Activity "New scheduled job" form calls `syncRoutineNotification`
(`cron-section.tsx:114-118`) with the deliberately unprefixed title (`cron-create.ts:31-37`), so
`parseRoutineName` yields no `botId` and `routine-sync.ts:106-109` retires and returns — the "due"
notice is never scheduled for any job created on this screen, and no connected re-arm will build it
either (`gateway-provider.tsx:4817`). The comment claiming the notice is scheduled is wrong.


### Area: Runs, Fleet, Council, Compose, Onboarding screens

#### R2-HAPTIC-1 · S2 · Haptics rejection escapes the gate in three screens

**Verification:** partly confirmed (corrected)
**Where:** `src/app/runs.tsx:146` (`await Haptics.impactAsync(...)` before `setStarting(true)`/`try`), `src/components/onboarding/onboarding-screen.tsx:50` (`await Haptics.impactAsync` before `setError(null); setWorking(true); try`), `src/app/runs.tsx:400` (`onPress={() => void startRun()}`)
**What fails:** On an Android device with no vibrator, or with the expo-haptics native module unavailable (Expo Go on an unsupported config, a dev-client rebuild that dropped the module), `Haptics.impactAsync` throws `UnavailabilityError` / a native `ReactContextLost` / `VibratorManager` cast failure. In Runs, "Run task" appears dead: the rejection escapes `startRun` before `setStarting(true)`, and because the button calls `void startRun()` the throw becomes an unhandled rejection with nothing on screen — no run, no error, no haptic. In Onboarding the same throw happens before `setWorking(true)`, so the Connect button silently does nothing and `setError` never runs.
**Why:** `expo-haptics` `impactAsync` is `async` and throws `UnavailabilityError('Haptic','impactAsync')` when the native module is absent (`node_modules/expo-haptics/src/Haptics.ts:38-44`); the Kotlin `vibrator` getter throws `Exceptions.ReactContextLost()` when the react context is gone and `(context.getSystemService(...) as VibratorManager)` throws `ClassCastException` on a device whose OEM service is not a `VibratorManager` (`HapticsModule.kt:19-25`). Both awaits sit outside the `try`, and neither call site attaches a `.catch` (`runs.tsx:146`, `onboarding-screen.tsx:50`).
**Corrected after independent verification:** S2. An unguarded `await Haptics.impactAsync(...)` before the `try`/`catch` turns
a missing/unavailable native haptics module (`UnavailabilityError('Haptic','impactAsync')`,
`Haptics.ts:37`; `ReactContextLost`/`ClassCastException`, `HapticsModule.kt:19-25`) into an unhandled
rejection. On **Onboarding** (`onboarding-screen.tsx:50`) the Connect button silently does nothing —
no error, no navigation. On **Runs** (`runs.tsx:146`, after `setStarting(true)` at `:145`) the card
wedges: the `finally` at `:154-156` never runs, so `starting` stays true and "Run task" is permanently
replaced by a disabled, busy "Starting…" with the prompt field non-editable until the screen remounts —
which is worse than the "appears dead" the scan described, and is *not* cleared by the haptic guard.
Scope correction: the scan says "three screens" but names two files. The same unguarded-await-
before-the-action shape exists at ~25 further sites (`rg "await Haptics\.(impact|notification|selection)Async"`
across `src/`), including four on the Home dashboard that gate navigation into two of the screens this
scan covers — see V-2.

#### R2-RUNS-1 · S2 · The Runs scorecards fan out N+2 gateway reads on every focus and every pull-to-refresh

**Verification:** partly confirmed (corrected)
**Where:** `src/app/runs.tsx:238` (`useFocusEffect(loadBotSpend)`), `src/app/runs.tsx:240-258` (a *second* effect that calls `loadBotSpend` again on `runsReloadSignal`), `src/app/runs.tsx:222-236` (`loadBotSpend` → `readBotSpend`), `src/lib/gateway/spend-report.ts:258-264`, `:229-256` (`readRosterByConcurrency`, `SESSION_SPEND_LIST_LIMIT = 200`), `src/app/runs.tsx:193-214` (same double-edge for `cron.list()`), `src/app/runs.tsx:240-251` (a third `listBots()`)
**What fails:** Open the Runs screen with 10 Bots on the Gate. The per-Bot spend read fires **twice** on the mount/focus (once from `useFocusEffect`, once from the `runsReloadSignal` effect) and **again** on every pull-to-refresh. Each run is `listBots()` + one `sessions.list`-per-Bot at `limit=200`. That is 22 large catalogue reads for one screen open, plus 3 roster reads and 2 `cron.list()` reads — against a Gate this repo documents as single-threaded and `state.db`-bound, over a lossy relayed Tailscale path. On the host the repo measures, one 200-row read is ~11 s (`docs/failure-audit-2026-09-30.md`, NET-3), so the spend fold cannot land for minutes and the scorecards stay empty long after the screen opened. Pull-to-refresh multiplies all of it again.
**Why:** `useFocusEffect(loadBotSpend)` (`:238`) and the `useEffect(..., [loadBotSpend, runsReloadSignal])` (`:240-258`) are two independent triggers for the same read, and `runsReloadSignal` starts at 0 so the second one also fires on mount. `loadRoutineJobs` has the identical shape: `useFocusEffect(loadRoutineJobs)` at `:207` plus the `runsReloadSignal` effect at `:209-214`. Nothing aborts a read that is already in flight when the second trigger fires — `live` only stops the `setState`, so the requests are duplicated, not deduplicated. The provider already folded the routine list once per connected transition (`gateway-provider.tsx:4868-4897`) and the roster into `widgetBots` (`:4908-4924`), so this screen is re-reading facts the provider is already holding.
**Corrected after independent verification:** S2. `src/app/runs.tsx` wires every screen-level fold to two independent triggers:
`useFocusEffect(loadBotSpend)` (`:238`) and `useEffect(…, [loadBotSpend, runsReloadSignal])` (`:253-258`),
with the signal starting at `0` (`:69`) — so mounting the screen issues the whole per-Bot spend fold
twice. `loadRoutineJobs` is doubled identically (`:207` + `:209-214`). On a 10-Bot Gate that is 25
gateway requests for one screen open (20 `limit=200` per-Bot catalogue reads, 3 roster reads, 2
`cron.list()`), each catalogue read given a 30 s bulk budget against a `state.db`-bound Gate, with
nothing deduplicating or aborting an in-flight read; the provider already folded the routine list
(`gateway-provider.tsx:4884-4913`) and the roster (`:4932-4948`), staggered 900/1200 ms, so the scorecards
stay empty for a minute or more after the screen appears. Each pull-to-refresh repeats 11 of those
reads; each return to the screen repeats 12. A focus *return* is one edge, not two — the doubling is
specific to mount.

#### R2-RUNS-2 · S3 · A run started from Runs reports no outcome on the Runs screen

**Verification:** partly confirmed (corrected)
**Where:** `src/app/runs.tsx:142-157` (`startRun`: `const outcome = await sendChatInput(...)`, `if (outcome === 'complete') setRunPrompt('')`, no other branch), `src/context/gateway-provider.tsx:3733-3739` (the pre-flight guard returns `'queued'`), `:3925` (`'complete'`), `:3943` (`'cancelled'`), `:3950` (`'error'`)
**What fails:** Press "Run task" and have the connection die between the render that enabled the button and the press itself (the status flip needs only one tick on a Tailscale path change). `sendChatInput`'s pre-flight guard then routes the text to the offline outbox and answers `'queued'`; the card's `finally` clears `starting`, the button returns to "Run task", nothing on the Runs screen says anything happened — and `/run <prompt>` sits in the outbox to be sent later, so a run starts that the operator did not see start. The same is true for `'error'` and `'cancelled'`: the verdict exists only as a bubble in the Chat tab.
**Why:** `startRun` inspects the outcome for exactly one value (`runs.tsx:153`) and has no other consumer of it; the `finally` at `:154-156` unconditionally resets `starting`, so every outcome renders as the idle card. The screen keeps a dedicated error surface for its refresh (`:65`, `:368-376`) but has none for a start, even though the union it is handed (`gateway-provider.tsx:248-256`, documented at `:242-247`) already distinguishes all of these.
**Corrected after independent verification:** S3. `startRun` (`runs.tsx:152-156`) inspects `SendChatInputOutcome` for exactly one
value and the `finally` resets `starting` unconditionally, so a run started from Runs never reports an
outcome on the Runs screen. For `'error'` and `'cancelled'` this is *by design and test-locked*
(`activity-refused-run-keeps-prompt-test.ts`, `activity-refused-run-settles-test.ts:66-70`): the draft
is kept so the operator can fix and resend, and `'error'` additionally sets the context-wide
`lastError`, which the Chat tab and the Home dashboard both render. The real hole is the `'queued'`
outcome (`gateway-provider.tsx:3735-3746`): the text goes to the offline outbox, `queueOfflineInput`
clears `lastError` at `:2864`, the Runs card returns to idle with the prompt still there — identical to
the "refused" presentation — and a later queue flush starts the run with nothing having said so. The
screen distinguishes "refused" (draft kept) from "queued for later" (draft kept) not at all, and cannot,
because both are `'complete' !== true`.

#### R2-RUNS-3 · S3 · A failed refresh reports success: every gateway-side read is swallowed

**Verification:** confirmed
**Where:** `src/app/runs.tsx:174-188`, `src/context/gateway-provider.tsx:4548-4603` (`refreshCapabilities`, whole body in `try { … } catch { /* ignore */ }` and an early `return` when `!activeGateway`), `src/context/gateway-provider.tsx:2469-2475` (`refreshGateways`)
**What fails:** Pull to refresh with no active gateway (or after `activeGateway` was cleared). `refreshCapabilities` returns immediately, `refreshGateways` resolves, the spinner ends — that path is fine. The real hole is the reverse: `refreshCapabilities` swallows **every** error, so `Promise.all` at `:178` only rejects when `refreshGateways` (a storage read) throws. A failed `/health`, a failed capability read, a failed manifest fetch and a failed child-profile sync all report as a *successful* refresh: `setRefreshError(null)` at `:179` clears whatever was there, the spinner ends cleanly, and the operator is told the data is fresh when none of it was re-read. That is the opposite of the comment at `:63-65`.
**Why:** `refreshCapabilities` wraps everything in `catch { // ignore }` (`gateway-provider.tsx:4600-4602`) and does not rethrow, and `onRefresh`'s `catch` at `:180-182` therefore cannot see a gateway-side failure. Nothing in the screen distinguishes "refreshed" from "refresh attempted"; `setRefreshError(null)` runs unconditionally on the resolved path.

#### R2-SR-V1 · S3 · retryRun discards its outcome and has no pending or error state

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** Found while verifying RUNS-2. The same outcome-discarding shape as `startRun`, on the
*other* start affordance on the same screen, and with no guard of any kind. `src/app/runs.tsx:165-172`:
`const retryRun = useCallback((run: ActivityRun) => { const prompt = run.prompt.trim(); if (!prompt)
return; void sendChatInput(`/run ${prompt}`); }, [sendChatInput])`. It reads the prompt, discards the
resolved `SendChatInputOutcome` entirely, keeps no pending flag, and surfaces nothing. The button that
calls it (`src/components/activity/run-card.tsx:198-215`) is rendered for every non-live card with
`run.status !== 'complete'` and a non-empty prompt, has no `busy`/`disabled` prop and no local state —
`onPress={async () => { await haptics.selection(); onRetry(run.prompt); }}` (note: this one *does* use
the safe haptic helper, unlike `runs.tsx:146`). So on the Runs screen a retried run that refuses,
queues, or collides with `isCommandRunning` (`gateway-provider.tsx:3752-3758` returns `'busy'` with a
chat-only note) produces zero feedback here, and repeated taps fire repeated `/run` sends with nothing
to stop them — unlike the Start card, which at least has the `starting` guard at `runs.tsx:144`.
**What fails:** S3. `retryRun` (`runs.tsx:165-172`) discards the `SendChatInputOutcome` and has no
pending or error state, so the "Retry run" button on a failed/cancelled run card reports nothing on the
Runs screen and is not guarded against repeat taps; a refusal, a queue, or a `busy` collision is
visible only as a Chat-tab bubble.

#### R2-SR-V2 · S2 · About 25 call sites await raw expo-haptics before the action they decorate (the four Home dashboard buttons are the only route into Fleet and Council)

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** Found while verifying HAPTIC-1, and it is the wider blast radius of the same unguarded
haptic await — on the screen that is the way *into* two of the surfaces this scan covers.
`src/components/gateway/gateway-home-dashboard.tsx` calls the raw library, not the repo's safe helper,
in six places, and four of them gate a navigation or a retry behind the await with no `try`:
`:290-291` `await Haptics.impactAsync(Light); void retryAutoConnect();`,
`:302-303` `await …; router.push('/fleet');`, `:313-314` `await …; router.push('/council');`,
`:329-330` `await …; router.push('/chat');`, `:364-365` `await …; router.push('/activity');`,
`:427-428` `await …; void refreshCapabilities();`. `PressableScale` forwards `onPress` straight to
`Pressable` with no rejection handling (`src/components/ui/PressableScale.tsx:17-28`) and `Button`
passes it through unchanged (`src/components/ui/Button.tsx:38-40`), so a rejected promise becomes an
unhandled rejection and the navigation simply never happens. The whole primary-action row is therefore
dead on a device where `ExpoHaptics` is unavailable — "Open fleet map", "Compare Bots" and the
Channels row all no-op with nothing on screen, while the log records an `unhandled-rejection`
(`src/app/_layout.tsx:78` → `failure-log.ts:263-269`). The same shape exists at
`src/components/chat/chat-composer.tsx:318-320` (`await Haptics.selectionAsync(); setMenuOpen(false);
onAttach();` — a throw leaves the attach menu open and the attach never happens), `:336-338`,
`:353-355`, `:372-374`, `src/components/chat/message-bubble.tsx:70-71` (long-press menu never opens),
`:211-212`, `:271-273`, `src/components/chat/confirmation-sheet.tsx:104-105` (Cancel never cancels),
`src/components/pairing-panel.tsx:29-30, :58-60`, `src/components/gateway/provider-card.tsx:79-80`,
`src/components/gateway/environment-card.tsx:75-76`, `src/app/gateway/settings.tsx:439-441`.
**What fails:** S2. Roughly 25 call sites `await` the raw `expo-haptics` API before the action
they are decorating — navigation, a state write, or a handler call — with no `.catch` and no `try`,
while the repo already ships `src/lib/haptics.ts` whose stated contract is that "interaction feedback
must never make an action fail". When the native module is unavailable (`UnavailabilityError`,
`Haptics.ts:37`; or `ReactContextLost`/`ClassCastException`, `HapticsModule.kt:19-25`), every one of
those actions silently does nothing. The worst offenders are the four Home-dashboard buttons
(`gateway-home-dashboard.tsx:290, :302, :313, :329, :364, :427`), which are the only route to the Fleet
and Council screens.

#### R2-SR-V3 · S3 · Council shows loading skeletons forever when opened while disconnected

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** Found while verifying RUNS-1 by contrast with `fleet.tsx`. `src/app/council.tsx:37`
initialises `const [rosterState, setRosterState] = useState<'loading' | 'ready' | 'failed'>('loading')`,
and the only writer is `loadRoster` (`:45-62`), reached from exactly one effect — `:66-76`:
`useEffect(() => { if (status !== 'connected') return undefined; … }, [status, loadRoster])`. When the
connection is not `connected` that effect returns before touching state, so `rosterState` can never
leave `'loading'` on that path: there is no `disconnected` phase, no early `setRosterState`, and no
`useFocusEffect` re-read. The render at `:172-202` then shows `rosterState === 'loading'` →
`<Skeleton …/>` chips with `accessibilityLabel="Loading bots"` **indefinitely**, and never reaches the
`'ready'` EmptyState or the `'failed'` `ErrorCard`. The screen is reachable while disconnected only by
a route the dashboard disables (`gateway-home-dashboard.tsx:315` `disabled={!connected}`), but the
disconnect is asynchronous: press "Compare Bots" while connected, and the Tailscale path drops during
the navigation — the failure mode RUNS-2 describes for a status flip one tick wide — and the operator
lands on a Council screen that claims to be loading a Bot list it has never asked for, with no error,
no retry and no offline wording. Every sibling screen in this scan handles the same case honestly:
`fleet.tsx:49` `UNREPORTED_ROSTER` + `fleetRosterRead` (`:73-75`), `council`'s own `status === 'connected'`
gate is the only thing standing in for one, and `runs.tsx:426-456` spells out `!activeGateway` /
`status !== 'connected'` copy.
**What fails:** S3. `council.tsx:37` starts `rosterState` at `'loading'` and the only effect that
can move it (`:66-76`) returns early when `status !== 'connected'`, so a Council screen opened while
disconnected (or opened connected and then dropped) renders the loading skeleton chips forever — no
error, no retry, no offline message — and never shows the `rosterState === 'ready'` empty state.


### Area: Gateway management screens, settings, shared hooks/layout

#### R2-LOCK-1 · S1 · The App-lock switch does nothing until the app is cold-started

**Verification:** confirmed
**Where:** `src/components/app-lock-gate.tsx:96-108` (mount-only read), `:101` (`lockableRef.current = lockable`), `:115-120` (the only re-lock edge, gated on `lockableRef.current`), `src/app/gateway/settings.tsx:140-143` (`handleAppLock` → `saveAppLock`), `src/lib/settings/app-lock.ts:113-119`
**What fails:** Turn the App lock ON in Settings, press Home, come back: no cover, ever. Turn it OFF, press Home, come back: still locked. The switch renders and writes, and the lock it names is inert for the rest of the process lifetime — a security control the operator believes is holding and is not, in both directions.
**Why:** `AppLockGate` answers `deviceAppLockState()` exactly once, in an effect with `[]` deps (`:96-108`), and stores the verdict in `lockableRef` (`:101`). The only other place that verdict is used is the `AppState` listener (`:117`), which reads the ref and never re-asks. `saveAppLock` (app-lock.ts:113-119) has no notification channel, and `app-lock.ts` has no `subscribe*` at all — unlike `widget-privacy.ts:20-28`, which does exactly that. `grep -rn "deviceAppLockState|loadAppLock|saveAppLock" src/` shows only these two call sites, so nothing observes the write.

#### R2-IMPORT-1 · S2 · "Pick file" always throws on SDK 57, and the attempt wipes a pasted packet

**Verification:** confirmed
**Where:** `src/app/gateway/import.tsx:36-37` (`await import('expo-file-system')` then `FileSystem.readAsStringAsync`), `:83` (`setText(picked.content)`), `node_modules/expo-file-system/src/index.ts:45` (`export * from './legacyWarnings'`), `node_modules/expo-file-system/src/legacyWarnings.ts:34-39` (`readAsStringAsync` → `throw errorOnLegacyMethodUse(...)`), contrast `src/lib/gateway/handoff-share.ts:7` and `src/lib/gateway/transcript-share.ts:11` (both use the new `File`/`Paths` API)
**What fails:** Open the Bot handoff import screen, paste a packet, then tap "Pick file" and choose any `.json`: the file is never read. The TextField is cleared and the ErrorCard reads "The picked file could not be read." The whole file-pick path is dead on the shipping runtime, and the paste you already had is gone.
**Why:** `expo-file-system@57.0.6` re-exports the root module from `legacyWarnings`, whose `readAsStringAsync` unconditionally throws ("deprecated … will throw in runtime") — the working copy lives at `expo-file-system/legacy`. The `.d.ts` still declares it, so `tsc` is green, and `__tests__/handoff-import-test.ts:115,189` only asserts on the screen's source text, so jest is green too. `pickHandoffFile` catches the throw and returns `content: ''` (`:40`), and `pickFile` writes that empty string into the field at `:83` *before* it inspects `picked.error` at `:85`.

#### R2-SRUN-1 · S2 · Closing the run sheet leaves the CLI stream and `running` flag alive; the next run bleeds into it

**Verification:** confirmed
**Where:** `src/components/gateway/environment-run-launcher.tsx:139-167` (`follow`, controller created at `:143-144`), `:198-205` (`cancel` only aborts `abortRef.current`), `:332-343` (Close button, `onPress={onClose}` with no abort), `src/components/gateway/environments-section.tsx:184-189` (the launcher is rendered unconditionally, `visible={runTarget !== null}`)
**What fails:** Start a CLI run in the run sheet, press Close while it is still streaming, then open the run sheet for a *different* environment: the sheet shows "Cancel run", "Start run" is unreachable, and the old environment's output keeps appending into the new run's reply bubble. Closing the sheet never stops the run or the socket; only a stream that ends on its own clears it.
**Why:** `EnvironmentsSection` keeps one `EnvironmentRunLauncher` mounted for every environment, so `onClose` merely sets `runTarget` to null — the component holding `events`, `running` and `abortRef` survives (`environments-section.tsx:184-189`). Nothing aborts on close or on an environment change: the only abort is `cancel()`'s `abortRef.current?.abort()` (`:199`), and `start()` (`:176-181`) overwrites `abortRef.current` with the new run's controller, so after a second start the first stream is no longer reachable by any control. `follow`'s callback keeps doing `setEvents((current) => [...current, event])` (`:151`) with no cap, and its `finally` (`:162-166`) still sets `running` false and calls `refreshRuns()` against whatever `environment` is current.

#### R2-REACH-1 · S2 · A cancelled probe wave strands saved gateways on "Checking" with nothing to re-probe

**Verification:** confirmed
**Where:** `src/hooks/use-gateway-reachability.ts:74-93` (the debounce ledger is stamped for the whole wave at `:85-88`, the wave is marked `checking` at `:93`), `:98-102` (`if (cancelled) return` before *and* after the probe), `:132-135` (cleanup sets `cancelled`; the effect has no timer), `src/lib/gateway/reachability-wave.ts:22-38,50-70`, `src/components/gateway/compact-gateway-list.tsx:129,164-166` (the `checking` state renders the literal word "Checking")
**What fails:** Open Home (or Gate setup → Manage) while a connect is settling, with at least one non-active saved gateway. The reachability wave starts, the status transition to `connected` cancels it mid-probe, and that gateway's pill reads "Checking" for the rest of the session — the debounce ledger says it was just probed, so no new wave claims it, and nothing re-runs the effect until a dependency changes again.
**Why:** The wave stamps `lastProbeAtRef` for every due gateway *before* any probe returns (`:85-88`) and marks them all `checking` (`:93`). If a dependency of the effect (`:135` — `activeGateway?.id`, the `gateways` array identity, `signature`, `status`) changes while a probe is in flight, cleanup sets `cancelled` and the in-flight worker returns at `:102` without writing a verdict. The replacement run's `planProbeWave` (reachability-wave.ts:65-69) then excludes those gateways because `now - last < MIN_PROBE_INTERVAL_MS` (8 s), `due` comes back empty, and `withWaveChecking(previous, [])` (`:22-38`) returns the previous record — `state: 'checking'`. Because the effect is driven only by those four dependencies and there is no `setInterval`, the row never resolves. The render-time adjustment at `:39-64` preserves the stale record (`previous[gateway.id] ?? {state:'unknown'}`), so nothing recovers it. Any churn of the `gateways` array restarts the cycle — `persistGateway` runs on the connect path (`gateway-provider.tsx:2128,2177`) — and the audit records `status` flipping on every monitor self-heal.

#### R2-CAPS-1 · S2 · The capability create is not atomic: a refused secret leaves an instance the form can never finish

**Verification:** confirmed
**Where:** `src/components/gateway/capabilities-section.tsx:130-140` (the pre-flight check), `:141-157` (`registry.instances.create` / `.update` awaited first, `registry.secrets.set` awaited second), `gate/core/capabilities/registry-methods.mjs:65-67` (`instance "${id}" already exists`), `:108-129` (`registry.secrets.set`), `:114-118` (it refuses a `provider/…` ref), `src/lib/gateway/credential-shape.ts:11-17` (`looksLikeCredential` does not catch that case)
**What fails:** Create a capability whose secret ref is `provider/my-provider/api-key` (a shape the CLI-environment form teaches at `environment-registration-form.tsx:254`). The instance is created, the secret write is refused, the error names the refusal — and the retry says `instance "x" already exists`, so the draft can never complete from the phone. The Gate keeps an instance whose config points at a secret that was never set.
**Why:** The phone pre-validates only the *shape* of the ref (`:134`, `looksLikeCredential`), and that helper (credential-shape.ts:11-17) passes any ref containing `/`, `-`, `_` or `.` — so `provider/my-provider/api-key` sails through to the create at `:142`. The Gate's `registry.secrets.set` refuses that namespace (`registry-methods.mjs:114-118`) and the instance is already on disk. The catch at `:161-162` keeps `draft` open in `create` mode, so the operator's only retry re-enters `registry.instances.create` with the same id and hits the duplicate at `registry-methods.mjs:65-67`. The comment at `:131-133` claims the pre-check prevents "a refused save leav[ing] an instance behind"; it only covers one of the three ways `secrets.set` can refuse.

#### R2-SETTINGS-1 · S2 · `saveAppSettings` is an unserialized read-modify-write with two independent writers

**Verification:** confirmed
**Where:** `src/lib/settings/app-settings.ts:46-51` (`loadAppSettings()` → merge → `setItem`, no queue), `src/app/gateway/settings.tsx:209` (`void saveAppSettings({ voiceEngine: next })`), `src/context/gateway-provider.tsx:2459,4267` (`saveAppSettings({ lastSuccessfulUrl })` on the connect/probe path), `:2564` (`onboardingCompletionForAddedGateway` patch), `:4496` (`autoConnect`)
**What fails:** Change the voice engine in Settings while a connect attempt writes `lastSuccessfulUrl`. Whichever `setItem` lands last wins with the merge base it read, so one field is silently lost — usually `lastSuccessfulUrl`, the value that masks the compiled-in fallback host list, or `onboardingComplete`, which bounces the user back through `AppBootstrap`'s redirect.
**Why:** `saveAppSettings` reads the whole blob, merges the patch and writes it back with nothing serializing the pair (`app-settings.ts:47-50`). Contrast the two writers that got this right in the same repo: `src/lib/gateway/storage.ts:21-30` and `src/lib/diagnostics/failure-log.ts:153-164`. The two call sites live in different trees but share the same key and can overlap: the Settings screen's write is `void`-ed (no ordering against anything), while the provider's `lastSuccessfulUrl` write happens inside the auto-connect ladder, which fires on a timer and on every foreground. `loadAppSettings` (`:31-44`) has the same unguarded `keyValueStorage.getItem`, so a slow read widens the window.

#### R2-SVOICE-1 · S2 · The voice-install poll is a 30-minute timer chain that outlives the screen

**Verification:** confirmed
**Where:** `src/app/gateway/settings.tsx:224-234` (`for (let attempt = 0; attempt < 900; attempt++)` with a 2 s sleep and an RPC per iteration), `:244` (`setInstalling(false)` only at the end of the chain), `:447-455` (the "Installing on this PC…" block)
**What fails:** Tap "Install on this PC" and leave Settings. For up to 30 minutes the phone keeps issuing a `voice.install.status` RPC every 2 s plus a `pushDeviceParams()` read against a Gate on a relayed, lossy path, with nothing on screen. If the Gate reports `installing` for the whole window the chain runs all 900 iterations.
**Why:** `handleVoiceInstall` (`:214-245`) owns no cancellation: there is no `AbortController`, no `cancelled` flag, and no cleanup registered anywhere, so the `await` chain keeps running after the route unmounts and calls `setInstallNote` (`:232`) on a component that is gone. `setInstalling(false)` sits after the loop (`:244`), so the only exit is the loop's own `break` — a throw from `gatewayRequest` (`:230`) or a `state !== 'installing'` answer (`:233`). 900 × 2 s is the whole budget, and nothing bounds it by the screen's life, the app's foreground state, or the operator's patience.

#### R2-SPEND-1 · S2 · The per-Bot spend fan-out re-fires on every status transition and the previous wave is never aborted

**Verification:** confirmed
**Where:** `src/app/gateway/spend.tsx:164-186` (deps `[status, canReadBotSessions, listBots, readBotSessions]`; only a `cancelled` flag, no abort), `src/lib/gateway/spend-report.ts:222` (`READ_BOT_SPEND_CONCURRENCY = 2`), `:229-256` (`readRosterByConcurrency` — one `sessions.list` at `SESSION_SPEND_LIST_LIMIT` per Bot), `src/lib/gateway/get-sessions-retry.ts:21,24` (30 s per attempt above `limit=50`, 2 retries)
**What fails:** Leave the Spend screen open across a health blip. Each transition back to `connected` restarts the whole fan-out — `listBots()` plus one 200-row catalogue read per Bot, two at a time, each up to 3 × 30 s — while the previous wave is still running on the Gate. Navigate away mid-read and the requests keep going; only the result is discarded.
**Why:** The effect's only changing dependency is `status` (`:186`), which the audit records flipping on every monitor self-heal as well as every real connect. The cleanup (`:183-185`) sets a boolean and passes no `AbortSignal`; `readBotSpend` → `readRosterByConcurrency` (spend-report.ts:240-242) awaits `read(bot.id, 200)` with nothing to cancel it, and `listBotSessionCatalogue` retries internally (get-sessions-retry.ts:21,24) so one Bot can occupy a lane for ~90 s. Ten Bots at concurrency 2 is five such rounds against the Gate the repo documents as single-threaded and `state.db`-bound. The screen's own doc comment (`:57-62`) claims the per-Bot section is "a second, additional read" — it is one per status transition, not one per visit.

#### R2-DIAG-1 · S2 · The live runtime check has no timeout anywhere, so a silent Gate wedges the screen

**Verification:** confirmed
**Where:** `src/lib/runtime-environment.ts:99-129` (`await streamingFetch(healthUrl)` at `:106`, `await reader.read()` at `:116`, no `AbortController` and no timer), `src/lib/net/streaming-fetch.ts:104-110` (no signal is passed into the fetch), `src/app/gateway/diagnostics.tsx:58-66` (`setRunning(true)` … `finally setRunning(false)`), `:112-118` (the button is `disabled={!healthUrl || running}`)
**What fails:** A gateway whose `/health` accepts the connection and then never finishes answering — the shape a half-open Tailscale/DERP path produces — leaves the "Run live check" button spinning on "Checking…" for the rest of the session, disabled, with the operator unable to retry. The whole point of this screen is to be the one loop that works on a device, and it is the one with no bound.
**Why:** `probeStreamingFetch` awaits two operations with no deadline: the headers (`:106`) and the first body chunk (`:116`). `streamingFetch` forwards `init` untouched and this call site passes none, so there is no signal to abort. The `finally` at diagnostics.tsx:63-65 only runs once the promise settles, so `running` stays true and the control stays disabled. This is the same class NET-1 closed for `http-transport.ts` — the fix was not applied to this path, and the surrounding code even argues the opposite way ("the globals above cannot answer it").

#### R2-SVOICE-2 · S2 · Settings' voice check runs once and never re-runs after the connection comes up

**Verification:** confirmed
**Where:** `src/app/gateway/settings.tsx:145-159` (`readVoiceCapabilities`, deps `[gatewayRequest]`), `:182-193` (the effect's deps are `[readVoiceCapabilities, applyVoiceRead]`), `src/context/gateway-provider.tsx:2574-2581` (`gatewayRequest` throws `'Gateway not connected'` unless `statusRef.current === 'connected'`, and is itself `useCallback([])`)
**What fails:** Open Settings while the phone is offline or mid-reconnect. The rows settle on "Couldn't check this PC: Gateway not connected" and an ErrorCard, and they keep saying it after the Gate connects — the readiness lines and the "Today" usage figure are stale until the operator taps Retry by hand.
**Why:** The effect's dependencies are both `useCallback`s over `gatewayRequest`, which is a `useCallback` with `[]` deps (gateway-provider.tsx:2574-2581) and therefore stable for the provider's lifetime. Nothing in the chain observes `status`, so the one-shot read at mount is the only one that will ever run: the `ok: false` from `:157` is folded into `voiceCheckState = 'failed'` (`:169-170`) and `voiceCheckError`, and `voiceReadiness` (`:71-75`) prefers the refusal over every capability the Gate could report. The same staleness runs the other way: a read that succeeds and then loses the connection keeps printing "ready" rows, because nothing re-reads on the way down either.

#### R2-LINK-1 · S3 · `void connectGateway(...)` / `void deleteGateway(...)` leave rejected promises unhandled and a delete sheet that lies

**Verification:** confirmed
**Where:** `src/components/gateway/gateway-home-dashboard.tsx:411` (`onSelect={(gateway) => void connectGateway(gateway)}`), `src/hooks/use-gateway-settings-screen.ts:31` (`await connectGateway(gateway)` inside an `async` callback), `:43` (`void deleteGateway(deleteCandidateId)`), `src/components/gateway/gateway-management-section.tsx:115` (`onSelect={() => void handleConnect(gateway.id)}`), `src/context/gateway-provider.tsx:2152-2157` (`connectGateway` rethrows an auth rejection), `:2895` (`removeGateway` can reject — STORE-2's SecureStore refusal)
**What fails:** Tap Connect on a gateway whose token the Gate has rotated: the rejection escapes into an unhandled rejection (recorded by the new global tracker, invisible otherwise) and the dashboard neither navigates nor explains. Tap Remove and confirm: the sheet closes as if it worked, and if the storage write fails the gateway is still listed with no message anywhere.
**Why:** `void` discards the promise without attaching a handler, and there is no `.catch` at any of the four call sites. `attachClient` deliberately rethrows auth failures (gateway-provider.tsx:2152-2157), so this path is reachable on the exact scenario GATE-6 creates; the only feedback is the status line the client wrote before throwing. `confirmDelete` (`:41-46`) sets the candidate to null immediately after firing the delete, so the ConfirmSheet's dismissal is unconditional on the write's outcome.

#### R2-PRIV-1 · S3 · `saveWidgetResultHidden` can reject into a `void`-ed write

**Verification:** confirmed
**Where:** `src/lib/settings/widget-privacy.ts:40-48` (`try { await keyValueStorage.setItem(...) } finally { notify }` — no `catch`), `src/app/gateway/settings.tsx:247-250` (`void saveWidgetResultHidden(next)`), `src/lib/storage/key-value.ts:49-55` (`AsyncStorage.setItem`, which rejects on a full/corrupt DB)
**What fails:** Toggle "Hide result text on the widget" while AsyncStorage is unhappy: the write rejects, `void` lets it escape as an unhandled rejection, and the Switch is already flipped to the new value — the UI claims a preference that was never stored, and it reverts on the next launch.
**Why:** Every sibling writer in this area is deliberately failure-proof: `saveAppLock` (app-lock.ts:113-119), `saveBudgets` (budgets.ts:173-179) and `recordApprovalDecision` (approval-policy.ts:234-244) all wrap the write in `try/catch` and swallow. This one has a `finally` instead, which notifies subscribers on the way out but lets the rejection through — and the only caller does not catch.

#### R2-BUDGET-1 · S3 · A storage write runs inside a `setState` updater

**Verification:** partly confirmed (corrected)
**Where:** `src/app/gateway/spend.tsx:111-119` (`setBudgets((previous) => { …; void saveBudgets(next); return next; })`)
**What fails:** Set a cap and immediately leave Spend: the AsyncStorage write for that cap is issued from inside the updater, so it fires from the render pass rather than from an effect. React may re-invoke an updater (a discarded or replayed render) and the write goes out for a value that never committed.
**Why:** The updater is not pure — `void saveBudgets(next)` at `:116` is a side effect, and `next` is derived from the `previous` argument React supplies. React's contract is that updaters may be called more than once and their results discarded, so a write performed here is not tied to a committed state. Nothing else in this screen writes from an updater: the budget read sits in a plain effect (`:101-109`) and `saveBudgets` is best-effort by design (budgets.ts:173-179). The visible symptom is narrow — a cap that survives a session it was cleared in, or a lost cap when two rows are edited in one tick.
**Corrected after independent verification:** The defect is a React-contract violation, not a data-loss
bug: `spend.tsx:114-118` performs a side effect inside a state updater, so a
discarded/replayed render can emit a write for a state that never committed.
Severity is code-hygiene (S4), not S3 — `saveBudgets` is idempotent
(full-map write) and swallows its own errors, so no operator-visible loss is
reachable. Fix is to move the write into a `useEffect` keyed on `budgets`.

#### R2-DRAWER-1 · S3 · The app-wide drawer keeps its own uncached `/v1/bots` read and swallows every failure

**Verification:** confirmed
**Where:** `src/components/nav/side-drawer-content.tsx:206-217` (deps `[listBots, status]`, `.catch(() => undefined)`), `:229-233` (`openTeammate`'s `openBot` rejection also discarded), `src/context/gateway-provider.tsx:4731-4739` (`listBots` → `client.listBots()`)
**What fails:** Every `status` transition while the app is open fires another roster read from the drawer — so each reconnect, and each monitor self-heal, adds a `/v1/bots` on top of the chat screen's own. When it fails the drawer's team list silently keeps whatever it last had, or stays empty, and a tap on a stale Bot closes the drawer and navigates to a chat that never opened.
**Why:** The effect is keyed on `status` (`:217`) and the drawer content is mounted beside every screen, so a roster the audit already counts once per roster visit (SPD-6) is read again from a second place on every status flip, with no cache. The catch at `:213` is bare, so a refusal leaves `team` as-is and the operator sees an empty "Your team" section with no error — the same failure mode UI-1 was raised for, in a file the earlier audit did not cover. `openTeammate` (`:229-233`) closes the drawer and pushes `/chat` *before* awaiting `openBot`, so its `.catch(() => undefined)` produces a chat screen on the previous Bot with nothing said.

#### R2-SG-V1 · S3 · saveAppSettings can reject into a void-ed write and the voice-engine row claims a preference that was never stored

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/lib/settings/app-settings.ts:46-51` has **no** `try/catch`
around `await keyValueStorage.setItem` (`:50`), unlike every sibling writer in
this area (`app-lock.ts:113-119`, `budgets.ts:173-179`), and
`src/lib/storage/key-value.ts:49-55` rejects when AsyncStorage is unhappy. The
only user-facing caller, `src/app/gateway/settings.tsx:207-210`, does
`setVoiceEngine(next)` **then** `void saveAppSettings({ voiceEngine: next })` — no
handler, so a failed write becomes an unhandled rejection (captured by the
tracker at `src/lib/diagnostics/failure-log.ts:248-258`) while the radio row
stays selected and reverts on next launch. This is the rejection twin of
SETTINGS-1's lost-update twin; the scan covered only the race.
**What fails:** `saveAppSettings` can reject into a `void`-ed write, and the voice-engine row claims a preference that was never stored - CONFIRMED

#### R2-SG-V2 · S3 · A storage-read rejection in the Settings voice effect wedges the screen on 'Checking this PC...' forever

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/app/gateway/settings.tsx:182-193` awaits
`loadAppSettings()` at `:185` with **no** `try/catch` before the
`readVoiceCapabilities()` call at `:187`. `loadAppSettings`
(`src/lib/settings/app-settings.ts:31-32`) reads through an unguarded
`keyValueStorage.getItem` (`src/lib/storage/key-value.ts:44-47`) — its own
`try/catch` at `:34` only wraps `JSON.parse`. If the read rejects, the
`void`-ed async IIFE rejects (`:184`), `readVoiceCapabilities` never runs, and
`voiceCheckState` stays `'checking'` (`:103`) — so `voiceReadiness` returns
`'Checking this PC…'` (`:77`) for the rest of the session and the `ErrorCard` at
`:378-385` never renders, which means there is no Retry either. This is the
one wedge VOICE-2's fix (adding `status` to the deps) would not close.
**What fails:** A storage-read rejection in the Settings voice effect wedges the screen on "Checking this PC…" forever - CONFIRMED

#### R2-SG-V3 · S3 · A fourth uncached /v1/bots read on the Settings screen, keyed on connected

**Verification:** found during independent verification (not in the first scan), read and confirmed there
**Evidence:** `src/components/gateway/notifications-section.tsx:47-60` calls
`listBots()` in its own effect with deps `[connected, listBots]` (`:60`) and no
cache, storing only `{id, displayName}` (`:52`). `listBots`
(`src/context/gateway-provider.tsx:4731-4739`) is an uncached
`client.listBots()`. So a single connect settles three independent roster reads
for the same gateway — Chat's own, the drawer's (`side-drawer-content.tsx:206-217`)
and this one — and every reconnect repeats all three. The failure handling here
is better than the drawer's (it clears to `[]` at `:55` and the comment at `:43-44`
says so), which is why it is a duplicate-read finding rather than a silent-empty
one.
**What fails:** A fourth uncached `/v1/bots` read on the Settings screen, keyed on `connected` - CONFIRMED


