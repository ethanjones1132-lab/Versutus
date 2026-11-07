# Hands-free call: the release bar

Written 2026-11-07 against `master` 428593b. This is the bar the hands-free call is held to before it ships as beta and before it is called released. Every claim about the code cites file:line on that commit. **VERIFIED** means there is evidence (a test run, a log, or code that settles the question with no runtime dependency). **FAILING** means the code as written cannot meet the requirement. **UNKNOWN** means nobody has measured it.

Evidence collected for this document (read-only):
- `node --test gate/__tests__/voice-*.test.mjs`: 258 pass, 0 fail (2026-11-07).
- `npm run test:voice-worker`: 85 pass (2026-11-07).
- Live host logs: `%LOCALAPPDATA%\Versutus\Gate\voice\audit.jsonl` (27 calls, the last one on **2026-10-02**) and `logs\gate.log` (the last voice session is e9d87175, 2026-10-02). No call has been placed in five weeks. The device matrix in `docs/plans/2026-09-12-realtime-voice-device-log.md` was never run ("Install (not run)").

---

## 1. What "a natural phone call" means here

You tap once and you are talking to your Bot. It hears you start and stop the way a person on the phone would. It does not jump in while you pause to think, and it does not miss the end of a sentence. Its voice starts about as soon as a person's would, and it stops the moment you talk over it. The screen shows what it heard and what it is saying as it happens, and the conversation lands in the thread like any typed turn. A dropped signal, an incoming phone call or a locked screen never leaves the call in an unclear state. It never acts on your behalf in a way you did not approve. Your voice goes only where the call screen says it goes.

**Non-goals.** None of these are promised, and shipped copy must not imply them:
- Full-duplex, listen-while-speaking audio, or verbal backchannel ("mm-hm" while you talk). That is FUTURE-ITEMS **B4** (FUTURE-ITEMS.md:257-271). The architecture stays half-duplex, with client-side and Gate-side turn-taking.
- Wake word, always-listening, a call started from the background, or a call that resumes on its own (**B5**, FUTURE-ITEMS.md:273-276; plan 2026-09-11 line 87).
- Telecom or CallKit integration. The call never appears as a carrier call (plan line 92).
- Paid realtime voice APIs (Ethan's standing direction, HANDOFF-2026-09-18-grok.md:43-46). Codex realtime stays blocked until the login supports it.
- iOS in the first release, unless Ethan decides otherwise (D1). `startGateMedia` on iOS is a stub that resolves false (modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:236-249).
- Parity with any named product.

**The architecture this bar is judged against.** The 2026-09-11 plan describes phone-side recognition with only text crossing the wire, and a Gate that stays unchanged (plan lines 5, 15). **That is no longer the main path.** On `auto`, a ready PC engine wins (voice-engine-choice.ts:53, 97-108). In that mode:

1. The phone streams raw 16 kHz PCM continuously over a WebSocket (HandsfreeGateMedia.kt:216-242).
2. The Gate worker runs Silero VAD, Smart Turn v3 and Whisper large-v3-turbo (server.py:864-909; models.lock.json).
3. The Gate gathers transcript segments into one utterance and runs the Bot turn (media-socket.mjs:389-505).
4. Kokoro speaks the reply sentence by sentence, and the PCM is streamed back (server.py:388-400).

The phone engine (on-device `SpeechRecognizer`/TTS) is the fallback. The parent design doc for the Gate path, `docs/plans/2026-09-12-realtime-voice-plan.md`, is cited by every `voice-m*.md` milestone doc but **is not in the repo**. This document is the governing bar until it is restored.

---

## 2. The bar

Where each check is run:
- **H**: Gate or host harness (node:test, pytest, or the replay harness in W4). Needs no phone.
- **J**: Jest or Kotlin JVM tests. Needs no phone.
- **A**: fleet over adb on the A54 (VS-046). Needs Ethan to enable wireless debugging once (VS-EO4).
- **E**: Ethan by hand.

Latency is measured on Ethan's host (RTX 4060) with the A54 on the same tailnet. Each reported number is a p50/p90 over at least 30 turns.

### 2.1 Feel

| ID | Requirement | Measurement | Pass threshold | Runs it | Status |
|---|---|---|---|---|---|
| F1 | **Response time.** From the end of the user's speech (EoS: the VAD speech_end of the turn's last segment) to the first reply audio audible on the phone. | Per-turn timestamps (W3): worker EoS, Gate commit, first sentence ready, first PCM sent, phone first PCM written to AudioTrack (new `played` phone frame). Measure against a scripted backend with zero time to first token (TTFT) to isolate voice overhead. On Hermes, report overhead = total − backend TTFT. | Scripted backend: p50 ≤ 1.5 s, p90 ≤ 2.5 s. Hermes: overhead under the same limits, and total reported (no threshold on Hermes TTFT, which is the host's). | H (scripted), A (live) | **FAILING by construction.** After the last final the Gate holds the utterance **1.8 s** (`UTTERANCE_HOLD_MS`, media-socket.mjs:67; voice-session.mjs:144-148), on top of 200 ms of VAD silence (vad.py:31), Smart Turn, a beam-5 Whisper final (stt.py:17; about 580 ms measured, server.py:878-881), and Kokoro synthesising the **whole first sentence** before any audio leaves (server.py:792-800). Floor ≈ 3.2-4 s when Smart Turn is confident. When it is unsure it waits for the 2.8 s force point first (turn.py:19), so ≈ 5.5-6.5 s. No end-to-end number exists. The audit p50s measure only from commit (media-socket.mjs:462-466, 522-536), and every audit line since 2026-09-19 has `p50FirstAudioMs: null`. |
| F2 | **Never silent while waiting.** Within 300 ms of a commit the user gets a non-verbal cue. While the backend has not answered, the banner says so from 10 s. | Gate harness: delay between the `final`/`phase thinking` frame and commit. Jest for the cue and the copy. | Cue ≤ 300 ms after commit on 100% of turns. Slow-turn line at 10 s ± 1 s. | J, H, A | **FAILING (Gate mode).** The send earcon exists only in the phone reducer (handsfree-session.ts:354). The Gate fold path never plays it (provider:606-624). The slow-turn line is VERIFIED by code and test (handsfree-call-copy.ts `HANDSFREE_SLOW_TURN_THRESHOLD_MS = 10_000`; `handsfree-call-banner-timer-test.tsx`). |
| F3 | **Barge-in.** When the user talks over the Bot, its audio stops. Skip does the same. | A: logcat timestamps for Gate `userSpeechStart` → phone playback flushed, and a second-device recording for the audible stop. H: Gate cancel → last stale byte sent. J: JitterBuffer/PlaybackLoop flush tests. | User voice onset → audible stop: p50 ≤ 400 ms, p90 ≤ 600 ms. No speech from the cancelled reply after the stop. | H, J, A | **FAILING (code).** The worker emits one PCM blob per sentence (server.py:792-800, 395-398). The Gate forwards it as one binary message (media-socket.mjs:375-386). The phone queues it as one entry (HandsfreeGateMedia.kt:131-134) and plays it with one blocking `track.write` (PlaybackLoop.kt:20-29; HandsfreeGateMedia.kt:279-285). The Gate never sends `speech start` or `speech cancelled`; only `end` and `gap` are emitted (voice-session.mjs:416, 420; media-socket.mjs:354). So the phone's cancel path (HandsfreeGateMedia.kt:174-177) is dead, and the current sentence keeps playing to its end, possibly seconds after barge-in or Skip. |
| F4 | **No false sends.** A thinking pause mid-thought does not split the turn. | Replay corpus (W4), labelled utterances with pauses of 0.5-3.0 s. | Pause ≤ 1.5 s: 0 splits. Pause 1.5-2.5 s: ≤ 5% split. | H | **UNKNOWN.** Smart Turn now judges with the pause included (turn.py:39-50), rejudges at 800 ms and forces at 2800 ms (turn.py:15-22). The tuning handoff's `force_ms=1600` is **stale** (changed in 2d00318). The 1.8 s hold is the extra safety margin that currently costs F1. No corpus exists. |
| F5 | **No phantom turns.** Coughs, TV, room noise and the Bot's own echo never become a turn or a barge-in. | Replay corpus: 10 min each of TV, kitchen noise, coughs and clicks. A: 20 replies on the A54 loudspeaker with a silent user. | ≤ 1 spurious commit per 10 min of noise. ≤ 1 echo barge-in per 20 replies. | H, A | **UNKNOWN.** Mitigations are in place: 250 ms onset (server.py:30), 400 ms minimum utterance (server.py:32), Whisper no-speech drop (server.py:41-56), adaptive floor and playback gate (vad.py:26-58), and phone AEC/NS (HandsfreeGateMedia.kt:209-214). The last field data showed 33 finals in 2.5 min (tuning handoff:44-46); it predates these. |
| F6 | **No missed ends.** When the user finishes, the turn commits. | Corpus: complete sentences followed by silence. | ≥ 98% commit within 1.2 s of EoS once F1 work lands (≤ 3 s today). | H | **UNKNOWN.** |
| F7 | **Recognition accuracy stays honest** while F1/F4 are tuned. | Corpus WER (read speech plus Ethan's own voice samples). | WER ≤ 10%, and no regression > 2 points from the baseline set when W4 lands. | H | **UNKNOWN.** The only evidence is one loopback sentence, word for word (kimi handoff:75-78). |
| F8 | **Every word of the reply is spoken, in order.** | J: JitterBuffer test with sentence-sized chunks arriving faster than real time. A: a 6-sentence reply heard in full. | 0 dropped sentences. | J, A | **FAILING (code, timing-dependent).** `trimToCap` drops whole queued chunks once more than 300 ms is pending and 2+ chunks are queued (JitterBuffer.kt:89-94). With one chunk per sentence, a sentence waiting behind another is discarded whenever Kokoro gets two sentences ahead of playback. |

### 2.2 Streaming events

**What exists.** `gate/core/voice/protocol.mjs` and `src/lib/voice/voice-stream-protocol.ts` mirror one schema and share a fixture (protocol.mjs:1-5).
- Gate → phone frames: `ready, phase, partial, final, turn, reply, speech, level, approval, error, ended` (protocol.mjs:10-22).
- Phone → Gate frames: `mute, skip, bargein, end` (protocol.mjs:9).
- Transport: one WebSocket per call on the Gate's HTTP server (server.mjs:4866-4892), JSON text frames plus binary PCM.
- Replay: frames and audio queued while no socket is attached are kept in order (1000 frames, 45 s of audio; media-socket.mjs:45-50, 326-363) for a 90 s resume window (media-socket.mjs:39).

Defects in it:
- There is no sequence number, timestamp or call id on any frame (protocol.mjs:102-151).
- **`turnId` is the call's `voiceSessionId`, not a per-turn id** (media-socket.mjs:617, 898, 963 → voice-session.mjs:240). Every turn in a call carries the same id.
- Declared but never emitted by the Gate: `level`, `speech start`, `speech cancelled`, and `turn sent`/`turn replying`. The Gate emits only `done` and `failed` (voice-session.mjs:368, 375, 380, 394, 400).
- The phone never sends `bargein` in Gate mode. No sender exists in GateMedia or the provider.
- Frames written to a socket that has died but not yet closed are lost. The replay log only fills while `ws` is null (media-socket.mjs:365-373).
- There is no backpressure check on `ws.send` (media-socket.mjs:365-386).
- The app folds `reply` deltas into banner state (gate-call.ts:153-154) but **nothing renders them**. The banner shows only the partial (handsfree-call-banner.tsx:133-141). The thread reloads only when a turn is `done` (gate-call.ts:147-148).
- Tool activity is never forwarded to the call. `runTurn` is given no `onToolCall` (media-socket.mjs:624-646).
- Approvals reach the call only on the subscribe-then-send backend path (turn-runner.mjs:559). The Hermes streaming path never calls `onApproval` (turn-runner.mjs:383-453).

**Proposed schema v2** (additive; a v1 phone ignores unknown frames, gate-call.ts:89-93). Every Gate→phone JSON frame carries an envelope:

```
{ v: 2, callId, seq, ts, t, ...payload }
```

- `seq` is a per-call integer that increases by 1 per frame.
- `ts` is Gate monotonic ms since the call opened.
- `turnId` is a per-turn id `t<n>`, minted at commit and stable across merge or cancel.
- PCM stays in binary frames. Each binary frame gets an 8-byte header `[gen:u32][seqOfStartFrame:u32]`, and frames are ≤ 100 ms of audio (fixes F3 and F8).

| Frame | Payload | When |
|---|---|---|
| `call` | `state: opening/ready/ending/ended`, `engine`, `resumeWindowMs`, `reason?` | lifecycle (replaces `ready`/`ended`) |
| `phase` | `phase: listening/thinking/speaking/muted` | every phase change |
| `heard` | `utteranceId`, `text`, `final: bool`, `eosTs?` | partial and final transcript |
| `turn` | `turnId`, `state: committed/accepted/replying/done/failed/cancelled`, `text?` (on committed), `error?` | turn lifecycle |
| `reply` | `turnId`, `delta`, `offset` (char offset, so a duplicate is idempotent) | streaming reply text |
| `speech` | `turnId`, `gen`, `state: start/end/cancelled/gap`, `sentence?` | playback lifecycle; `cancelled` must precede any later `start` |
| `tool` | `turnId`, `callId`, `name`, `status: running/complete/error`, `summary` (≤ 120 chars, no raw input) | tool activity |
| `approval` | `turnId`, `approvalId`, `summary`, `risk`, `state: pending/approved/denied/expired` | approval requests and their outcome |
| `level` | `v` (0-1), ≤ 10/s, droppable | optional; never replayed |
| `error` | `code`, `message`, `fatal`, `turnId?` | |

Phone → Gate frames add `resume { lastSeq }`, `played { gen, ts }` (first PCM written, for F1/F3), `approve { approvalId, decision }`, and `mute` with mic capture actually stopped.

| ID | Requirement | Measurement | Pass threshold | Runs it | Status |
|---|---|---|---|---|---|
| E1 | **One versioned schema, one fixture**, enforced on both sides. Each declared frame is either emitted or deleted. | node:test plus Jest against the shared fixture. A test that greps for emitters of each declared frame type. | 100% of declared types have an emitter and a consumer. | H, J | **VERIFIED** for one shared fixture (`voice-protocol.test.mjs`, `voice-stream-protocol-test.ts`). **FAILING** for declared-but-dead frames (listed above). |
| E2 | **Ordering and identity.** `seq` has no gaps within an attached socket. `turnId` is unique per turn. `reply.offset` makes a duplicate delta a no-op. | Gate harness that drives 3 turns, a barge-in and a merge. | 0 gaps, 0 duplicate turnIds, 0 doubled text. | H | **FAILING** (no `seq`; `turnId` is per call). |
| E3 | **Resume.** A phone reconnecting with `resume{lastSeq}` receives exactly the frames after `lastSeq`, including frames that were in flight to the dead socket. Audio older than the head of the current reply is replaced by `speech gap`. | Gate harness: kill the socket mid-reply, reattach at 5 s and at 85 s. | Exactly-once delivery of control frames. Call ended with `network` at 90 s ± 1 s. | H | **Partly VERIFIED**: in-order replay while detached (`voice-resume.test.mjs`, `voice-call-durability.test.mjs`). **FAILING**: in-flight loss on a half-open socket, and no `lastSeq`. |
| E4 | **The app renders live** from events only: the user's words as they are recognised; their committed turn as a user bubble in the thread at `turn committed`; the reply streaming into an assistant bubble from `reply` deltas; tool and approval cards; phase; and the reason when a turn or call ends. A thread reload at `done` reconciles only. | Jest (mounted) plus A screenshots at each phase. | Committed user bubble ≤ 300 ms after `turn committed`. First reply text ≤ 300 ms after the first `reply` frame. | J, A | **FAILING.** The reply is never rendered, and the thread updates only on reload. |
| E5 | **Backpressure.** The Gate never queues more than 2 s of outbound audio on a live socket. Partials coalesce, and `level` is dropped first. | H: slow-reader socket. | Gate memory stays bounded. Control frames are never dropped. | H | **FAILING** (no `bufferedAmount` check). |
| E6 | **Events reach the right place only.** Call frames go only to the device that owns the session. | Existing ownership checks. | 401/403/404/409 on a wrong token, device or ended session. | H | **VERIFIED** (media-socket.mjs:158-189; `voice-socket.test.mjs`). |

### 2.3 Safety

| ID | Requirement | Measurement | Pass threshold | Runs it | Status |
|---|---|---|---|---|---|
| S1 | **Audio is encrypted in transit off the host.** The media socket is used only over loopback, a tailnet address, or TLS (`wss`). The app refuses to open `ws://` to any other host for a call and says why. | J: `mediaSocketUrl` / start-policy tests. H: the bind classification test. | 0 plaintext non-loopback, non-tailnet call starts. | J, H | **FAILING.** The media socket shares the HTTP listener (server.mjs:4870), so 428593b's bind policy covers it, but only at `gate start` and `service install`. `service run` "never refuses" and starts with the acknowledgement (commit 428593b message). The live service runs `--host 0.0.0.0` (handoff-OizZw4:54). The app rewrites `http:` to `ws:` with no check (gate-media-url.ts:9-13). Whether Ethan's phone reaches the Gate through a tailnet address is **UNKNOWN**. |
| S2 | **Mute means the mic is off.** While muted, no audio leaves the phone. | J (Kotlin): capture stops on mute. A: Gate `audioFrames` stays flat while muted. | 0 audio frames sent while muted. | J, A | **FAILING.** In Gate mode the phone keeps capturing and sending (HandsfreeGateMedia.kt:216-242, which has no mute). Only the worker discards it (server.py:175-176). Notification Mute in Gate mode toggles only the phone recognizer (HandsfreeCallService.kt:929-940). |
| S3 | **No raw audio or transcript at rest by default.** The Gate log and audit carry counts and lengths, never words or PCM. No audio file is written on the phone or the Gate. | grep test over a harness call's log and audit. Code review of the worker. | 0 transcript bytes, 0 PCM files. | H | **VERIFIED by code.** Text is logged by length only (media-socket.mjs:514-521). The audit field list is closed and scalar-only (audit.mjs:10-51). The media socket's header says nothing goes to disk (media-socket.mjs:5); same for the worker (server.py has no file writes). Turn-failure messages are logged verbatim (media-socket.mjs:511, 538) and could carry backend text: **review needed**. Transcripts land in the Bot's thread by design, as typed turns do. |
| S4 | **Identifiers redacted.** Gate log lines name a device only by `deviceTag` hash. The audit and logs rotate with a stated retention. | grep test. | 0 raw device ids. Retention ≤ 30 days (D6). | H | **FAILING.** `voice.capabilities` and `voice.session.stop` log the raw `deviceId` (voice-rpc.mjs:356, 478), against the hash policy at voice-rpc.mjs:283-290 and 392-393. The audit stores the full `deviceId` (audit.mjs:13; live audit.jsonl). Neither file has rotation (audit.mjs:76 appends forever). |
| S5 | **Consent and disclosure are true.** The start sheet says, for the engine in use: where audio goes; that audio streams continuously while the call is unmuted; that speech auto-sends; how to end. No sentence is false on any engine or transport. | Jest pins the copy per engine and transport. Reviewer read-through. | 0 false claims. | J | **FAILING.** "Your voice goes to Versutus on your PC and nowhere else" (voice-engine-copy.ts:20) is not true over a plaintext LAN bind, where the audio can be read on the network. Mute does not stop streaming (S2). The general disclosure (handsfree-call-copy.ts:20-21) does not mention continuous streaming. The phone-engine copy is now honest (VS-050, voice-engine-copy.ts:47). |
| S6 | **Voice cannot cause unapproved side effects.** A voice-originated turn is marked as voice to the backend. Every approval the backend raises during a call reaches the call on every backend path, with Approve and Deny in the banner and a spoken prompt. Unanswered approvals expire and are never auto-approved. The policy follows D3. | H: a fake backend raising an approval on both the streaming and the feed path. J: banner actions. | 100% of approvals surfaced. 0 auto-approvals. | H, J | **FAILING.** The turn reaches the backend as plain `{ text }` with no voice marker (server.mjs:1455). On the Hermes streaming path approvals never reach the call (turn-runner.mjs:383-453). Where they do arrive, the banner shows text with no action (handsfree-call-banner.tsx:126-132). The turn then waits until the 180 s timeout (media-socket.mjs:86). Whether Hermes runs tools without approval is a host setting: **UNKNOWN**. |
| S7 | **Kill switch.** One Gate setting turns calls off for every engine, and the app hides Start within one capabilities refresh. No new build is needed. | H: `voice.json {enabled:false}`. J: offer policy. | Start hidden ≤ 1 refresh. A start attempt is refused. | H, J | **FAILING (partial).** `voice.json` turns Gate engines off (runtime.mjs:178-197), but the app then **falls back to the phone engine** (voice-engine-choice.ts:79-85), so calls stay on. No remote flag exists for the phone engine. |
| S8 | **Android platform policy.** The foreground service types are declared and justified. It starts only from a visible Activity. A visible ongoing notification has End. No background start. Play data-safety answers match S1-S5. | Merged-manifest check (verify:config). Play Console review (E). | Pass review. | J, E | **VERIFIED (config):** permissions in app.json:29-33; FGS type mic\|mediaPlayback (HandsfreeCallService.kt:217-222); start needs `currentActivity` (HandsfreeVoiceModule.kt:82-85); `onTaskRemoved` ends the call (HandsfreeCallService.kt:151-155). **UNKNOWN:** Play declaration and data-safety form (VS-EO2). |

### 2.4 Reliability: the interruption matrix

For every row, the user must hear a short tone or line, and see the banner end or change with a named reason. The call never resumes by itself. Words not yet committed are recovered to the composer. The Gate ends the call within the stated bound.

| ID | Event | Expected behaviour | Runs it | Status |
|---|---|---|---|---|
| R1 | Incoming phone call (listening and speaking) | Call ends ≤ 1 s with reason "phone call". Mic and speaker released. No auto-resume. | A | **FAILING (code).** Focus loss tears down the service (HandsfreeCallService.kt:362-367, 998-1043), but in Gate mode JS listens only to `gate` and `level` (provider:666-686). The `interruption` event is lost, and `HandsfreeGateMedia` (owned by the module, HandsfreeVoiceModule.kt:182-206, 230) **keeps capturing and streaming** with no foreground service. |
| R2 | Notification End while backgrounded | Same as UI End: Gate gets `end`, banner gone on return. | A | **FAILING (code).** Same wiring gap: `endRequested` is not subscribed in Gate mode, and service teardown does not stop GateMedia. |
| R3 | Wired or Bluetooth headset connects or disconnects mid-call | Route follows the device within 1 s and the call continues. If no route is usable, the call ends with a reason. | A | **UNKNOWN; likely FAILING.** The route is chosen once at start (HandsfreeCallService.kt:339-351). There is no `AudioDeviceCallback`. The plan said route loss is fatal (plan line 130); the code does neither. |
| R4 | Network drop under 90 s (Wi-Fi to cellular, tunnel re-handshake) | Call holds, banner says "reconnecting", resumes with no lost frame (E3). A turn already running completes. | H, A | **Contradiction.** The Gate holds 90 s and the app re-attaches (media-socket.mjs:827-834; provider:630-665; `voice-resume.test.mjs` passes). But the provider **ends the call the moment gateway status leaves `connected`** (provider:1140-1144 → handsfree-session.ts:262), which can pre-empt the resume. Live evidence: the last two calls in the audit ended `network`. |
| R5 | Network gone over 90 s | Call ends with `network`. A running turn is parked, finishes, and is pushed to the phone. | H | **VERIFIED** (media-socket.mjs:836-885, 654-666; `voice-call-durability.test.mjs`). |
| R6 | Gateway, Bot or thread switched mid-call | Call ends with "thread changed" before another utterance is sent. | J | **VERIFIED by code** (provider:1126-1136); Jest contract covers the reducer. |
| R7 | App swiped away or process killed | Service and notification removed. Gate ends the call within 30 s (no-audio timeout). Next launch recovers the last unsent words. | A | **VERIFIED by code** (onTaskRemoved; NO_AUDIO_TIMEOUT_MS media-socket.mjs:34; recovery tests). Device **UNKNOWN**. |
| R8 | Screen locked or Doze for 10 min mid-call | Call continues, three full turns work. | A | **UNKNOWN.** Never run (device-log "not run"). |
| R9 | PC worker crashes mid-call | Error named. Call ends or the worker restarts without speaking stale audio. | H | **VERIFIED** (`voice-worker-pool.test.mjs` crash budget; `voice-teardown-safety.test.mjs`). |
| R10 | Backend stalls | "Still waiting" from 10 s. Failure spoken and shown at 180 s. Call continues. | H | **VERIFIED** (TURN_TIMEOUT_MS media-socket.mjs:72-86; FAILED_TURN_LINE voice-session.mjs:52). |
| R11 | Gate restart during a call | Phone told `gate-restart`, ends cleanly. | H | **VERIFIED** (media-socket.mjs:986-989). |
| R12 | Second device calls while one is live | Refused before grant with "Another device is on a call". | H | **VERIFIED** (voice-rpc.mjs:408-413; d1b86fd; `voice-call-capacity.test.mjs`). |

### 2.5 Ease

| ID | Requirement | Measurement | Pass threshold | Runs it | Status |
|---|---|---|---|---|---|
| U1 | **Time to first word.** From tapping Start to "Listening" (meaning the engine can hear). | A: logcat or a timestamp from tap to the `phase listening` frame. | Warm worker: p90 ≤ 3 s. Cold worker: ≤ 30 s, and the banner says it is warming up. | A, H | **UNKNOWN.** A cold worker measured 17.9 s on 2026-10-02 (media-socket.mjs:23-25). A warm pool landed after that (222e72e); unmeasured since. `opening` is honest (media-socket.mjs:805-824). |
| U2 | **Taps.** Chat to talking: first call ≤ 2 taps (Call, then Start on the disclosure). Later calls 1 tap if D5 allows. | Count taps (A, E). | As stated. | A | **FAILING vs target.** The sheet opens on every Start (plan line 179). |
| U3 | **Controls.** Mute, Skip and End in the banner on every route and in the notification, each working in its own phase. | A, J. | Every control works in its phase. | J, A | **Partly VERIFIED** (banner, handsfree-call-banner.tsx:145-177). **FAILING:** notification Mute and End in Gate mode (S2, R2). |
| U4 | **Accessibility.** TalkBack announces phase changes, not partials. Labels are as in the copy file. Usable at 200% font. The barge-in hint is spoken. | A: TalkBack walkthrough. | All controls reachable and labelled. No truncation of phase or End. | A | **VERIFIED in code** (labels, live region, partial hidden from the reader: banner:88-92, 136). **UNKNOWN** on device. |
| U5 | **Live feedback.** The listening indicator moves with your voice. | A. | Indicator animates in both engines. | A | **FAILING (Gate mode).** Nothing emits a level: the Gate never sends `level`, and GateMedia computes none. The indicator is static. |
| U6 | **Speakable replies.** Markdown, code fences and URLs are never read out verbatim. | H: sentence splitter test. | 0 fence or markup tokens spoken. | H | **UNKNOWN.** The Gate splitter does no markdown stripping (sentences.mjs). |

### 2.6 Operability

| ID | Requirement | Measurement | Pass threshold | Runs it | Status |
|---|---|---|---|---|---|
| O1 | **Per-turn latency breakdown** in the Gate log and audit: EoS→commit, decode ms, commit→first delta, first sentence→first PCM sent, phone `played`. p50 and p90 per call. | Harness asserts the fields. | Fields present on 100% of turns. | H | **FAILING.** Only commit→first delta and commit→first audio sent (media-socket.mjs:522-536), as p50 only (media-socket.mjs:111-117). |
| O2 | **Endpointing counters** per call: finals, merged, queued, spurious (dropped no-speech), barge-ins, echo-gated. | Harness. | Present. | H | **Partly VERIFIED.** finals, utterances, queued and continued exist (audit.mjs:20-27). barge-in and drop counts are missing. |
| O3 | **`voice doctor` proves every model loads**: Whisper on CUDA, Silero, Smart Turn (not the degraded "pause is a turn" judge), and Kokoro speaking one sentence. | node:test with a fake probe. | Each is a named check. | H | **FAILING.** Doctor probes imports, the GPU and Whisper only (runtime.mjs:293-396). A Smart Turn model that fails to load silently degrades the judge (server.py:892-897; tuning handoff:61-64). |
| O4 | **A failed call is diagnosable from one Gate log grep plus the phone's reason code**: which stage, which engine, which backend. | Inject each failure in the harness. | Every terminal reason names a stage. | H | **VERIFIED** for start (VS-011, 18d08b0) and turn stages (media-socket.mjs:633-645). The end line lists counts (media-socket.mjs:539-547). |
| O5 | **Regression guards**: `npm run verify` plus `npm run test:voice-worker` green on every commit. The replay harness (W4) runs nightly on the host. | CI or fleet. | Green. | H | **VERIFIED** (gate voice suites 258/258, worker 85/85 on 2026-11-07). Replay harness does not exist. |

---

## 3. Gap analysis: the smallest ordered path to the bar

Sizes: S ≤ ½ day, M 1-3 days, L about a week. "Device" means it cannot be proven without the A54. Every item ships with tests and a green `npm run verify`.

| # | Work item | Closes | Size | Depends on | Device? |
|---|---|---|---|---|---|
| W1 | **Gate-mode native wiring.** Subscribe to `interruption`, `endRequested` and `fatalError` in Gate mode. Service teardown also stops `HandsfreeGateMedia`. Notification Mute and Unmute send the Gate `mute` frame. | R1, R2, U3 | S | none | Build and test without a device. Confirm on device in W10. |
| W2 | **Mute stops capture.** GateMedia pauses `AudioRecord` reads and sends nothing while muted, with a keepalive control frame so the 30 s no-audio watchdog does not fire. | S2 | S | W1 | No (Kotlin JVM test plus Gate test). |
| W3 | **Per-turn timestamps plus the `played` phone frame** (O1). The worker sends `eosMs` and `decodeMs` with each final. Audit gains p50/p90. | F1 measurement, O1 | M | none | No for the Gate side. The phone frame is a Kotlin change. |
| W4 | **Replay harness.** A labelled corpus of 50+ utterances (thinking pauses, coughs, TV, echo at loudspeaker level, Ethan's voice) fed as PCM through the real worker and Gate with a scripted backend. Outputs F4-F7 and the F1 overhead. | F4, F5, F6, F7, F1 (host part) | M | W3 | No phone. Needs Ethan's PC with the models (host). |
| W5 | **Streaming playback.** The worker emits ≤ 100 ms PCM frames as Kokoro produces them (or the Gate splits them). The Gate emits `speech start` and `speech cancelled`. The phone advances gen on `start` and flushes **and stops the AudioTrack** on `cancelled`. JitterBuffer trims only stale gens, never queued current-gen audio. | F3, F8, part of F1 | M | none | Build and JVM-test without a device. Audible stop needs A. |
| W6 | **Endpointing retune, measured.** Make the 1.8 s hold adaptive: commit on a confident Smart Turn `earlyEnd` (the speculative turn already exists, media-socket.mjs:908-911), hold only when the judge was unsure, and keep the merge-and-cancel path for resumed speech. Consider beam 1-2 on finals if WER allows. | F1, F4, F6 | M | W4 | No (W4 corpus). Confirm with E. |
| W7 | **Schema v2** (§2.2): envelope, per-turn ids, `resume{lastSeq}`, `tool` and `approval` frames, emitters for every declared frame, outbound backpressure. Update the fixture and both parsers. | E1, E2, E3, E5 | M | W5 (speech frames) | No. |
| W8 | **Live in-thread rendering** of committed user turns and streaming replies from v2 events. Reload only to reconcile. | E4 | M | W7 | No (Jest mounted). A for screenshots. |
| W9 | **Call survives a gateway status blip.** In Gate mode, end on media-link loss after the resume window, not on the chat connection's `status`. | R4 | S | W7 (lastSeq) | Test without a device. Confirm on A. |
| W10 | **Device matrix (VS-046).** Three turns each foreground, background and locked for 10 min; R1-R4, R7, R8; F3 audible; F5 echo; U1, U4, U5. 60-minute battery and thermal soak: ≤ 15% battery per hour, no thermal throttle notice. | all device rows | L | W1, W2, W5 at minimum. Ethan enables wireless debugging (VS-EO4). | **Yes**, fleet over adb. |
| W11 | **Transport and disclosure honesty.** The app refuses a `ws://` call to a non-loopback, non-tailnet host. Per-engine copy states continuous streaming and transport. Hash device ids in voice-rpc.mjs:356 and 478 and in the audit. 30-day rotation of `audit.jsonl`. | S1, S4, S5 | S | D2, D6 | No. |
| W12 | **Voice approval gating.** Mark voice-originated turns to the backend. Surface approvals from the Hermes streaming path. Approve and Deny in the banner, plus a spoken prompt. Expire to Deny. | S6 | M | W7, D3 | No. Confirm with E. |
| W13 | **True kill switch.** `voice.json {enabled:false}` hides Start for every engine (or a separate `calls:false`). | S7 | S | D7 | No. |
| W14 | **Doctor completeness.** Silero, Smart Turn and Kokoro load probes. | O3 | S | none | No (host). |
| W15 | **Route changes.** An `AudioDeviceCallback` re-routes or ends the call with a reason. | R3 | S | W1 | Yes, to confirm. |
| W16 | **Speakable text.** Strip markdown, fences and URLs before Kokoro. | U6 | S | none | No. |
| W17 | **Gate-mode level and earcon.** The phone computes an RMS level from capture. The commit cue plays locally on `turn committed`. | U5, F2 | S | W7 | No (JVM). Confirm on A. |

Order: W1 → W2 → W3 → W4 → W5 → W6 → W7 → W9 → W8 → W11 → W12 → W13 → W14 → W16 → W17 → W15 → W10. W10 can begin as soon as W1, W2 and W5 land, and repeat after W6.

**Limits of the current architecture.** None of the requirements above needs full duplex.
- F1 at p50 ≤ 1.5 s is reachable half-duplex. The floor is a policy (the fixed hold) plus whole-sentence synthesis, not the architecture.
- F3 is reachable with chunked playback and a stop-able AudioTrack.
- **Not reachable here, and not in the bar:** sub-500 ms gaps that sound conversational, overlapping speech, and backchannel. These need continuous provider-side audio (B4). Not worth it now: it is paid-provider-dependent (against Ethan's no-paid-voice-API direction), loses backend parity, and the half-duplex gap to a natural feel is mostly the fixed hold.
- **Hermes time to first token is outside Versutus.** The 2026-10-02 call waited about 62 s from turn accepted to first reply (gate.log e9d87175, 05:45:00.769 → 05:46:02.663). F1 is therefore stated as voice overhead, and F2 makes the wait honest instead of trying to hide it.

---

## 4. Decisions only Ethan can make

| # | Decision | Recommendation |
|---|---|---|
| D1 | **iOS scope** for the first release. | **Android-only.** Hide Call on iOS. The iOS Gate media is a stub and cannot be built or tested on this host. Revisit with a Mac or EAS path. |
| D2 | **May call audio leave the host's LAN, or cross it unencrypted?** | **Audio only over loopback, a tailnet or TLS.** The app refuses a plaintext non-loopback call, with no override for voice even when the Gate runs `--allow-plaintext`. |
| D3 | **May a voice turn run tools without an explicit approval?** | **No.** A voice-originated turn requires approval for any side-effecting tool, answered by tap in v1. A spoken "yes" only after a read-back, in a later version. Read-only tools may run. |
| D4 | **Snappiness vs. thinking pauses.** Accept that a pause of more than about 1.5 s may occasionally send early (with merge, so the thought still arrives as one turn), in exchange for about 1.5 s replies. | **Yes.** Target F4 (≤ 5% splits for 1.5-2.5 s pauses) and F1 p50 ≤ 1.5 s, tuned on the W4 corpus, not by ear. |
| D5 | **Disclosure every call, or first call only.** | **First call per engine and transport, then one tap.** The banner keeps "speech auto-sends" permanently. Re-show the sheet when the engine or transport changes. |
| D6 | **Retention** of voice audit and voice log lines. | **30 days, rotated.** No transcript ever. |
| D7 | **What the Gate kill switch means.** | **Off means no calls on any engine** from that gateway. The phone engine is not a silent fallback when the operator turned voice off. |
| D8 | **Phone-engine fallback**, whose recognizer may send audio to the platform's servers (voice-engine-copy.ts:47; HandsfreeCallService.kt:1069 `PREFER_ON_DEVICE_RECOGNIZER=false`). | **Keep it as an explicit choice, never an automatic fallback** for a user who picked "This PC". |

---

## 5. Release gate (auditor checklist)

Tick only with the evidence named. "Ran" means the output, a log excerpt, or a screenshot path is attached in `C:\Projects\ops\ship\versutus\handsfree\`.

**Beta** (Ethan and invited testers, Android only, Call offered only where it works):
- [ ] `npm run verify` and `npm run test:voice-worker` green on the release commit.
- [ ] W1 and W2 landed. R1, R2 and S2 pass on the A54 (adb log shows `audioFrames` flat while muted, and the call ends on an incoming call).
- [ ] S1: no plaintext non-loopback call can start (test plus one A run over the tailnet).
- [ ] S3 and S4: harness log and audit contain no transcript, PCM or raw device id.
- [ ] S5: disclosure copy reviewed against the engine in use. S8: merged manifest checked.
- [ ] F3: barge-in audible stop p90 ≤ 600 ms on the A54 (W5).
- [ ] Device matrix: three turns × foreground, background and locked for 10 min, all pass (VS-046 report).
- [ ] F1 measured and **reported** (any value). F4 and F5 measured on the W4 corpus and reported.
- [ ] S6 minimum: approvals reach the banner on the Hermes path, and no auto-approval exists.
- [ ] S7: the kill switch hides Call. iOS hides Call (D1).

**Released** (everything in beta, plus):
- [ ] F1 p50 ≤ 1.5 s and p90 ≤ 2.5 s voice overhead (scripted and Hermes, ≥ 30 turns each).
- [ ] F4 0 splits for pauses ≤ 1.5 s and ≤ 5% for 1.5-2.5 s. F5 ≤ 1 per 10 min and ≤ 1 echo per 20 replies. F6 ≥ 98%. F7 WER ≤ 10%. F8 0 dropped sentences.
- [ ] E1-E5 pass (schema v2, resume, live rendering). U5 and F2 cue in Gate mode.
- [ ] R3, R4 and R8 pass on the A54. 60-minute soak within budget.
- [ ] S6 full: Approve and Deny in the banner, voice-origin marker, expiry to Deny.
- [ ] O1-O3 present. One induced failure per terminal reason diagnosed from the log alone.
- [ ] U1 warm p90 ≤ 3 s. U4 TalkBack walkthrough recorded.
- [ ] Ethan's own pass (VS-M8): one 15-minute real conversation, rated "feels like a call", with no defects filed at severity HIGH.

**What "releasable" means.** Every released box ticked with attached evidence, on the exact commit and APK being shipped, and no requirement in §2 still UNKNOWN. "Beta" means the beta boxes are ticked, the Call control is offered only on Android where the start can succeed (VS-001), and the remaining FAILING and UNKNOWN rows are listed in the release notes. A row that passes only in the foreground does not pass (plan line 93 stands).

---

## 6. Where this overrules the 2026-11-07 first draft (`handoff-OizZw4.md`)

- **Kept:** the device matrix (1), Play policy (3), the failure matrix (5), a measured replay harness instead of by-ear tuning (6), operability (9), accessibility (10), tests (12).
- **Replaced:**
  - (2) "flag unverified": the Gate switch exists but falls back to the phone engine (S7).
  - (4) "the plan promises text-only": audio does go to the Gate by design. The real gaps are plaintext transport, mute that still streams, and redaction (S1, S2, S4).
  - (6) `force_ms=1600` is stale (now 2800/800). The dominant send delay is the 1.8 s utterance hold stacked after Smart Turn.
  - (7) the 2add026 log lines cannot measure end of speech to audible reply. They start at commit and never see the phone.
- **Demoted:** (8) four-backend parity becomes a one-turn smoke per backend at beta. Hermes is the path that must pass the bar.
- **Added:** barge-in (F3), dropped sentences (F8), the event schema (E1-E6), voice approval gating (S6), and the Gate-mode wiring defects (R1, R2, S2), none of which the draft had.
