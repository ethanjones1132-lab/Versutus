# Privacy Policy — Versutus

**Last updated:** 2026-11-02
**App:** Versutus (bundle `com.versutus.app`, version 1.0.0)
**Publisher:** Ethan Jones, sole author.

This policy applies to the Versutus mobile and web client. It is written to be read
alongside `docs/release/PLAY-DATA-SAFETY.md`, which is the matching data-safety
declaration prepared for the Google Play Console. Statements about app behaviour carry
a `file:line` citation. Items that could not be proved from the current tree are marked
`(?) verify` rather than asserted.

> This is release-preparation text, not legal advice or a published policy. No hosted
> URL, account, contact address, or Console submission is created by this document.

## 1. Summary in one paragraph

Versutus is a **client**. The author (Ethan Jones) operates **no server** that receives
your content and does not collect analytics, advertising identifiers, or crash reports
(`package.json:14-63`; `src/lib/diagnostics/failure-log.ts:17`). Your messages, runs,
tool calls, attachments, and approvals go to the gateway you configure (`README.md:3-7`;
`src/context/gateway-provider.tsx:4519-4617`, `:5438`). Voice is **not all on-device**:
push-to-talk and a phone-transport hands-free call ask the phone/OS speech recognizer,
which may use the device or the platform's network service, while a Gate-transport
hands-free call sends **raw microphone PCM** to your own Gate over a WebSocket
(`modules/handsfree-voice/android/src/main/java/com/versutus/handsfreevoice/HandsfreeGateMedia.kt:186-244`,
`:221-235`). When you enable notifications, an Expo push token is obtained from Expo and
registered with your Gate; the Gate later sends notification envelopes to the Expo Push
Service and through it APNs/FCM
(`src/lib/notifications/push-registration.ts:84-92`, `:143-150`;
`gate/core/push-send.mjs:1-2`, `:84-118`). No Versutus cloud exists in any of those paths.

## 2. What Versutus is, and where your data goes

- Versutus speaks directly to the gateway URL saved in a gateway profile. The saved
  profile (name, URL, auth token, kind, agent) lives in SecureStore and is written
  through `src/lib/gateway/storage.ts:8-9`, `:41-43`. Requests carry the token in an
  `Authorization: Bearer` header (`src/lib/gateway/http-transport.ts:126`, `:158`).
- There is no public relay operated by the author, and no author host is compiled into
  the release: `expo.extra.gatewayHosts` ships empty (`app.json:135-140`), so the only
  **gateway** endpoint the app talks to is the one you save or discover on your network.
- True push is delivered by **your own** Versutus Gate (the companion server in `gate/`)
  calling the Expo Push API, not by a Versutus cloud (`README.md:240`). Provider keys are
  read from the Gate's own credential store and are not sent to the phone
  (`README.md:143`).
- Chat text, run prompts, tool calls, approvals, and command output leave the device only
  toward the gateway you configured (`src/context/gateway-provider.tsx:4519-4617`).
- Attaching a photo, camera image, or document reads the picked bytes into memory as
  base64 and includes them in the chat request to that gateway
  (`src/components/chat/chat-screen.tsx:1435-1452`, `:1473-1478`, `:1494-1550`,
  `:1561-1569`). The document picker is asked to keep a cache copy
  (`src/components/chat/chat-screen.tsx:1494-1498`); that OS/app cache copy is not a
  Versutus attachment library.
- The recognised **text** of a spoken turn becomes a normal chat turn. Push-to-talk puts the
  text in the composer for review and does not send it automatically (`README.md:97-100`).
  On a Gate call the Gate's voice engine transcribes and speaks, then the transcript is
  answered by the same backend the thread's typed turns use
  (`gate/core/voice/media-socket.mjs:570-687`;
  `gate/core/voice/voice-backend.mjs:1-20`). That backend is the environment you
  configured on your Gate, and it may in turn call a model provider. Versutus does not
  choose or receive that provider traffic.

### Voice transport, stated precisely

There are two different microphone paths, and they must not be described as one:

1. **Phone / OS recogniser path.** Push-to-talk asks `expo-speech-recognition` to listen
   (`src/lib/voice/speech-recognition.ts:151-178`); the app passes `{}` at the composer
   (`src/components/chat/chat-composer.tsx:233`), so `requiresOnDeviceRecognition` is not
   set (`src/lib/voice/speech-recognition.ts:22-29`). A hands-free call whose resolved
   transport is `phone` uses the native module's platform recogniser instead: Android
   compiles `PREFER_ON_DEVICE_RECOGNIZER = false` and otherwise uses the platform
   recogniser (`modules/handsfree-voice/android/.../HandsfreeCallService.kt:383-391`,
   `:431-439`, `:1069`), and iOS uses `SFSpeechRecognizer` without an on-device requirement
   (`modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:307`, `:312-316`). The OS
   may therefore process audio on the device or send it to Apple/Google; the app code
   does not establish which. `(?) verify` per OS version before claiming on-device only.
2. **Gate media path (Android, and only when the resolved engine is a Gate engine).**
   The app opens `/v1/voice/stream` and a native capture thread reads 16 kHz mono PCM16
   from `AudioRecord` and sends each frame as a binary WebSocket message
   (`src/lib/voice/gate-media-url.ts:7-16`;
   `modules/handsfree-voice/android/.../HandsfreeGateMedia.kt:71-91`, `:186-244`,
   `:221-235`). The Gate receives those frames as raw PCM and pushes them into its voice
   engine (`gate/core/voice/media-socket.mjs:1-6`, `:689-709`); the local engine forwards
   each frame to its Python worker as base64 PCM
   (`gate/core/voice/engines/local-engine.mjs:116-124`). The default voice
   preference is `auto`, which uses a ready Gate engine before the phone
   (`src/lib/settings/app-settings.ts:15-21`;
   `src/lib/voice/voice-engine-choice.ts:53-56`, `:69-95`), so this is not an exotic
   opt-in on an Android phone with Gate voice installed. On iOS the Gate media terminal
   is a stub that resolves `false`, so a Gate call cannot start there; the code selects
   the phone engine instead (`modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:237-249`;
   `src/lib/voice/voice-engine-choice.ts:87-95`). That is an engine-selection result, not
   proof of an automatic fallback after a failed Gate call.

> **Known copy discrepancy (docs-only run; runtime not changed).** The Settings/voice row
> for the phone engine says "On-device recognition and speech. Audio never leaves the
> phone." (`src/lib/voice/voice-engine-copy.ts:45-49`). Current code does not force
> on-device recognition on either platform
> (`src/lib/voice/speech-recognition.ts:22-29`;
> `modules/handsfree-voice/android/.../HandsfreeCallService.kt:1069`;
> `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:307`). Until that is verified or
> the copy is changed on a runtime ticket, the "may process on-device or remotely"
> statement in this policy is the accurate one.

## 3. Data stored on the device

| Data | Where | Notes |
|---|---|---|
| Gateway profiles (name, URL, auth token, kind, agent) | SecureStore (`src/lib/gateway/storage.ts:8-9`, `:41-43`) | production builds refuse the unencrypted fallback (`src/lib/storage/secure-key-value.ts:52-62`) |
| Device identity (ed25519 keypair, device id) | SecureStore, key `versutus:device-identity` (`src/lib/gateway/device-identity.ts:20`, `:47-57`, `:69-116`) | generated locally; the device id is SHA-256 of the public key (`:37-39`); used to sign pairing/auth payloads and to key push rows |
| Expo push token cache | SecureStore, key `versutus:expo-push-token:v1` (`src/lib/notifications/push-registration.ts:27`, `:108-118`) | only the token string |
| Chat history cache, session labels, drafts, offline outbox, command transcripts, hands-free recovery text | AsyncStorage (`src/lib/cache/swr-store.ts:25`, `:39`; `src/lib/gateway/session-persistence.ts:1-10`; `src/lib/gateway/transcript.ts:4`; `src/lib/voice/handsfree-recovery.ts:23-36`) | app-private but **not encrypted at rest**; the outbox holds message text only, never secrets (`src/lib/gateway/session-persistence.ts:1-3`) |
| App settings, lock preference, widget snapshot, local failure log | AsyncStorage (`src/lib/settings/app-settings.ts:3`; `src/lib/settings/app-lock.ts:24`; `src/lib/widget/widget-device.ts:41`; `src/lib/diagnostics/failure-log.ts:17`) | local only; the failure log is not transmitted |
| Picked attachment bytes | in memory as base64; the document picker may also leave a cache copy (`src/components/chat/chat-screen.tsx:1494-1541`) | not stored as a Versutus attachment library |
| Voice audio | **not persisted as an audio file by the app or by the Gate media socket** | the Gate media code streams frames to the socket and writes no audio (`gate/core/voice/media-socket.mjs:1-6`); the phone recogniser's handling is the OS's business `(?) verify` |
| Spoken/recovered transcript text | AsyncStorage (`src/lib/voice/handsfree-recovery.ts:23-36`) | text, not audio; it can surface in the composer after an interrupted call |

SecureStore is `expo-secure-store`, backed on Android by Keystore-encrypted
SharedPreferences and on iOS by the Keychain. Two consequences matter for deletion:
Expo's SDK 57 SecureStore page states that Android data is not preserved on uninstall,
while **iOS Keychain data can persist across app uninstallations and reinstallations with
the same bundle ID**
(<https://docs.expo.dev/versions/v57.0.0/sdk/securestore/>, retrieved 2026-11-02,
page `modificationDate: July 20, 2026`). The web build uses `localStorage` for the same
seam (`src/lib/storage/secure-key-value.ts:130-198`), which is browser storage, not a
keychain.

## 4. Data transmitted off the device

Versutus itself operates no backend. The transmissions observed in current source are:

1. **To the gateway you configured.** Connection handshake, capability reads,
   authenticated HTTP/RPC/SSE/WebSocket traffic, chat messages, attachments, run control,
   approvals, tool output, and (on a Gate call) raw microphone PCM and control frames
   (`src/context/gateway-provider.tsx:4519-4617`, `:5438`;
   `src/lib/voice/handsfree-start-attempt.ts:219-293`;
   `modules/handsfree-voice/android/.../HandsfreeGateMedia.kt:221-235`). This is
   user-directed traffic to infrastructure the user chose. If that infrastructure is
   shared with someone else, that operator receives it too.
2. **To Expo, for the push token.** With notification permission, the app calls
   `Notifications.getExpoPushTokenAsync({ projectId })`
   (`src/lib/notifications/push-registration.ts:84-92`; project id at `:34`), which
   per Expo's SDK 57 notifications page makes requests to Expo's servers
   (<https://docs.expo.dev/versions/v57.0.0/sdk/notifications/>, retrieved 2026-11-02).
   The app code passes only the project id; the full payload Expo's SDK adds is not
   established by this source `(?) verify`.
3. **To your Gate, for push registration.** `registerWithGate` sends `expoPushToken`,
   `platform`, `timezone`, and the app-derived `deviceId` over the already-paired
   connection (`src/lib/notifications/push-registration.ts:143-150`). The Gate stores a
   row keyed by the caller's device identity (`gate/core/push-rpc.mjs:61-86`, `:95-104`).
   **The app does not send the app-derived `deviceId` to Expo**, and the Gate's push
   message builder does not include it: the messages contain the Expo token, a title, an
   optional body, and data ids (`sessionId`, `botId`, `runId`) only
   (`gate/core/push-notifier.mjs:87-212`; `gate/core/push-send.mjs:84-118`). The same
   `deviceId` also accompanies `voice.capabilities` and `voice.session.start` when a Gate
   voice call is offered or started (`src/context/handsfree-voice-provider.tsx:1103-1106`;
   `src/lib/voice/handsfree-start-attempt.ts:219-228`).
4. **To the Expo Push Service, then APNs/FCM.** When the Gate sends a notification, the
   recipient fields are the device's Expo push token plus the notification title/body/data
   (`gate/core/push-notifier.mjs:158-212`). Expo then delivers through the platform push
   service (`README.md:240`). Default payloads are contentless titles; reply bodies are
   empty unless the per-device `richBody` preference is on
   (`gate/core/push-tokens.mjs:10-16`; `gate/core/push-notifier.mjs:158-169`). A title
   can still contain the Bot's name, and data carries session/Bot/run identifiers.
5. **To the OS speech service, when the phone recogniser path is used.** See §2. The app
   sends no audio to any author server; it does hand audio to the platform recogniser,
   which may process it on-device or remotely `(?) verify`.
6. **To the Gate's voice engine, when a Gate call is used.** The Gate's shipping engine is
   `local`: a Python worker on the Gate host running faster-whisper for speech-to-text and
   Kokoro for speech synthesis (`gate/core/voice/engines/local-engine.mjs:1-14`, `:35-46`;
   `gate/voice-worker/versutus_voice/stt.py:1-5`;
   `gate/voice-worker/versutus_voice/tts.py:1-5`). Model files are downloaded during
   `voice install`, not per call (`gate/core/voice/runtime.mjs:137-171`). The `codex`
   engine is reported unavailable and is not wired in this Gate
   (`gate/core/voice/codex-status.mjs:15-16`, `:41-46`), so the app's ChatGPT-via-Codex
   disclosure describes a future state, not a shipping path
   (`src/lib/voice/voice-engine-copy.ts:39-43`). The transcript then goes to the thread's
   configured chat backend, which may call a model provider of the user's choosing.
7. **Network metadata.** Hostnames/IPs, ports, and TLS fingerprints are displayed for
   gateways you enter. Discovery fingerprints are **observed and shown, not pin-verified**
   (`src/lib/gateway/security.ts:25-49`, `:59-96`; `README.md:134`).

No analytics SDK, advertising SDK, or crash reporter is declared in `package.json:14-63`.
Firebase's `google-services.json` is configured only as Expo's Android push transport
(`app.json:26`). The local failure log keeps 50 entries on the phone and is not sent
(`src/lib/diagnostics/failure-log.ts:19`). Expo runtime modules could have their own
diagnostics; that is not established by this source `(?) verify` against the SDK modules
actually linked.

**What this source does not establish.** (1) Whether the phone/OS recogniser processes a
given utterance on-device or sends it to Apple/Google — the code does not force on-device
recognition (`src/lib/voice/speech-recognition.ts:22-29`;
`modules/handsfree-voice/android/.../HandsfreeCallService.kt:1069`;
`modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:307`). (2) What additional
device/app metadata Expo's own token request carries; the app passes only `projectId`
(`src/lib/notifications/push-registration.ts:84-92`). (3) What the Gate host's own logs,
backups, or core dumps retain; only the Gate code read here is cited, and its media socket
writes no audio (`gate/core/voice/media-socket.mjs:1-6`). (4) What the user's chosen chat
backend or model provider retains after the transcript is sent
(`gate/core/voice/voice-backend.mjs:1-20`). (5) What Expo/APNs/FCM retain after delivery.
(6) Whether the iOS Keychain behaviour described by Expo's page applies to this exact
build; the page states it as platform behaviour, not app-specific proof.

## 5. Push notification content policy

The default relayed push payload is **contentless**: a title such as "… finished a reply"
or "Approval required", with ids for routing, and an empty body
(`gate/core/push-tokens.mjs:10-16`; `gate/core/push-notifier.mjs:158-212`). Rich bodies
are a per-device opt-in (`richBody`), truncated to 80 characters when enabled
(`gate/core/push-notifier.mjs:83-85`, `:158-160`). Widget updates are a separate opt-in
and can include a truncated result only when `richBody` is on
(`gate/core/push-notifier.mjs:267-273`).

Local notifications (fired only while the app's connection is alive,
`src/lib/notifications/local.ts:1-4`) can contain run/approval snippets because they never
leave the device.

## 6. Permissions and why each exists

From `app.json:24-34` (Android) and `app.json:12-21` (iOS):

| Permission / usage string | Why |
|---|---|
| `RECORD_AUDIO`, `NSMicrophoneUsageDescription` | push-to-talk dictation, and the hands-free call in either transport (`app.json:19-20`, `:28-34`; `src/lib/voice/speech-recognition.ts`; `modules/handsfree-voice`) |
| `POST_NOTIFICATIONS` | local and relayed push notifications (`app.json:30`; `src/lib/notifications/local.ts`; `src/lib/notifications/push-registration.ts`) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | hands-free call foreground service (`app.json:31-33`; `modules/handsfree-voice/android/.../AndroidManifest.xml`) |
| `expo-image-picker` photo/camera/mic strings | attaching images/files to a message (`app.json:91-98`; `src/components/chat/chat-screen.tsx:1435-1550`) |
| `NSSpeechRecognitionUsageDescription` | speech recognition (`app.json:19`) |
| `NSFaceIDUsageDescription` | optional biometric app lock (`app.json:15`; `src/components/app-lock-gate.tsx`) |
| `UIBackgroundModes: audio` | hands-free call audio while backgrounded (`app.json:16-18`) |
| `usesCleartextTraffic: true` (Android config, not a runtime permission) | trusted-LAN gateway URLs; HTTPS/WSS is recommended and the gateway URL is yours (`app.json:56-63`; `README.md:134`) |

Android notification refusals are remembered for ten minutes rather than re-asked on
every notice (`src/lib/notifications/local.ts:29-62`, `:74-125`). Push registration only
removes the Gate row on a confirmed OS denial (`src/lib/notifications/push-registration.ts:171-173`,
`:208-213`).

## 7. Retention and deletion

- Versutus keeps no account and has no author-side copy of your data. Retention is on your
  devices and on the gateway you control.
- On Android, uninstalling removes the app's local storage, including SecureStore entries.
  On iOS, app-container data is removed but **Keychain items can survive a reinstall**
  (Expo SDK 57 SecureStore page, retrieved 2026-11-02). Clearing the app's storage in the
  OS settings, or deleting the app, is the local control.
- Deleting a **custom** Gateway profile, disconnecting from it, or switching to another
  gateway sends `notifications.deregister`, asking that Gate to drop this device's push
  row (`src/context/gateway-provider.tsx:3079-3083`, `:4419-4425`, `:4477-4479`;
  `src/lib/notifications/push-registration.ts:152-161`). This is a Gate feature, not a
  Google Play "deletion request" mechanism.
- A confirmed notification-permission denial also deregisters
  (`src/lib/notifications/push-registration.ts:208-213`).
- The Gate's media socket writes no audio to disk (`gate/core/voice/media-socket.mjs:1-6`).
  Its voice audit line is a closed field list of counts and identifiers — `deviceId`,
  `botId`, `engine`, frame/turn counts — and text is deliberately not written
  (`gate/core/voice/audit.mjs:1-5`, `:10-33`; `gate/core/voice/media-socket.mjs:480-500`,
  `:513-521`). Ended voice-session records are pruned after ten minutes
  (`gate/core/voice/voice-rpc.mjs:37-46`).
- The Gate's push-token store does persist the token, platform, timezone, and notification
  preferences in its own JSON file (`gate/core/push-tokens.mjs:1-16`;
  `gate/core/push-rpc.mjs:95-104`). Deleting the row through the paths above is the
  demonstrated removal path.
- Content held by your gateway (messages, runs, sessions, provider keys, backend logs) is
  governed by that gateway and its host, not by this policy. What a chosen model backend
  retains is outside this code `(?) verify`.
- **There is no demonstrated in-app or web "request deletion of my data" workflow** for a
  developer-held account, because there is no developer account or server copy. Whether
  Play treats that as "no mechanism needed" or requires a stated path is a form question
  for Ethan, not something this policy can assert. See `PLAY-DATA-SAFETY.md` §A3.

## 8. Sharing

Versutus does **not** sell data, does not run ads, and does not share data for marketing.
The recipients observed in current source are:

- **Your gateway** (and, if you chose a shared gateway, its operator), for the
  app's core function.
- **Expo Push Service, then APNs/FCM**, for notification delivery, when you enable push.
- **The OS speech service**, when the phone recogniser path is used; it may process audio
  on-device or remotely `(?) verify`.
- **Your Gate's local voice worker**, which runs on your own host, when a Gate call is
  used.

Google Play defines "sharing" separately from whether the developer receives the data,
and provides service-provider and user-initiated-action exceptions
(<https://support.google.com/googleplay/android-developer/answer/10787469>, retrieved
2026-11-02>). This policy therefore describes recipients and purposes; it does not label
them "sharing" or "not sharing" in Play's sense. The Console classification is left to
Ethan in `PLAY-DATA-SAFETY.md`.

## 9. Children

Versutus is not directed to children. It contains no child-specific content, collects no
age, and is a tool for adults operating their own agent gateways. Because the app displays
arbitrary text and model output from the user's own gateway, it is not appropriate for a
child audience; the target-age selection remains Ethan's decision.

## 10. Security practices

- Credentials (gateway tokens, device keys, push token) are stored in platform secure
  storage when available; the plain AsyncStorage fallback is refused in a production
  build (`src/lib/storage/secure-key-value.ts:44-62`). Chat content, drafts, caches, and
  the failure log are kept in AsyncStorage, which is app-private but not encrypted
  (`src/lib/storage/key-value.ts:43-55`).
- Connections use HTTPS/WSS when the gateway provides it. Cleartext HTTP/WS is supported
  for trusted local networks, the Android build enables it
  (`app.json:56-63`), and a gateway URL entered without a scheme is normalized to
  `http://` (`src/lib/gateway/url.ts:57-63`). The media socket follows the same scheme
  (`src/lib/voice/gate-media-url.ts:7-16`). Cleartext traffic is therefore a real
  supported path, not a theoretical one; HTTPS/WSS is recommended (`README.md:134`).
- Discovery TLS fingerprints are observed and displayed, not pin-verified; Expo fetch
  does not expose the hook needed to pin them (`README.md:134`;
  `src/lib/gateway/security.ts:59-96`).
- Device identity is an ed25519 keypair generated with `expo-crypto`'s CSPRNG and stored
  locally (`src/lib/gateway/device-identity.ts:41-57`).

## 11. Changes to this policy

Changes are published with the app/repository. The effective date at the top changes with
each revision. A material change affecting data handling will be called out in release
notes.

## 12. Contact

Privacy questions go to the project owner, **Ethan Jones**, via the repository's issue
tracker. The repository remote and a public contact email are **not available from this
worktree** and are not invented here: `(?) verify` both before publishing the listing.

## Companion data-safety declaration

See `docs/release/PLAY-DATA-SAFETY.md`. That file holds the Play Console answers with
`file:line` citations; if it and this policy ever disagree, this policy governs
user-facing claims and the Console file is updated to match.
