# Play Data Safety — Versutus

**Status:** DRAFT prepared from current source on 2026-11-02. Not submitted to Play
Console. This is a factual answer sheet, not a legal certification and not Ethan's
decision on product or legal policy.

Companion to `docs/release/PRIVACY.md` and step 5.2 of `docs/release/RELEASE-PLAN.md`.
Every substantive answer below carries a `path:line` citation from the tree read for this
draft. Items that could not be proved, or that are Play-form classification choices, are
marked **unresolved** and must not be pasted as a settled answer.

## 0. The Play definitions this draft uses

From Google Play Help, "Provide information for Google Play's Data safety section"
(<https://support.google.com/googleplay/android-developer/answer/10787469>, retrieved
2026-11-02):

- **Collect** means transmitting data off the user's device, including transmission by a
  library or SDK, **whether or not it goes to the developer**.
- **On-device processing** that is not sent off-device does not need to be declared.
- **Ephemeral processing** still belongs in the form response, but is not displayed in the
  store listing if it is only held in memory for the request.
- **Sharing** means transferring user data to a third party. It is defined separately from
  whether the developer receives the data. Transfers to a **service provider** acting on
  the developer's instructions, and transfers based on a **specific user-initiated action**
  (or prominent disclosure and consent), are listed as exceptions that do not need to be
  declared as sharing.
- **Encryption in transit** may be declared only where it applies to **all** user data the
  app collects.

Those definitions are why this file describes recipients first and does not answer
"Shared: No" merely because the author operates no backend.

## A. Top-level questions

| # | Play question | Draft answer | Basis |
|---|---|---|---|
| A1 | Does your app collect or share any of the required user data types? | **Yes.** Messages and attachments are transmitted off the phone when the user sends them; a Gate-transport voice call sends microphone PCM to the user's Gate; device identifiers are transmitted when notifications are enabled. The phone/OS recogniser may instead process audio locally or remotely, which is why voice is not described as always off-device. | `src/context/gateway-provider.tsx:4519-4617`, `:5438`; `src/components/chat/chat-screen.tsx:1561-1569`; `modules/handsfree-voice/android/.../HandsfreeGateMedia.kt:221-235`; `src/lib/notifications/push-registration.ts:84-92`, `:143-150`; `src/lib/voice/speech-recognition.ts:22-29` |
| A2 | Is all of the user data collected by your app encrypted in transit? | **No — not all.** HTTPS/WSS is used when the gateway provides it, and Expo push delivery uses HTTPS, but the Android build supports cleartext HTTP/WS to a gateway, and a URL entered without a scheme is normalized to `http://`. Play permits a "yes" only if encryption covers all collected data. | `app.json:56-63`; `src/lib/gateway/url.ts:57-63`; `src/lib/voice/gate-media-url.ts:7-16`; `src/lib/gateway/security.ts:43-49`; `gate/core/push-send.mjs:1-2` |
| A3 | Do you provide a way for users to request that their data is deleted? | **Unresolved — do not paste "Yes".** The app can clear local data by uninstall/app-data clear (with the iOS Keychain caveat), and a custom Gate profile delete/disconnect/switch asks the Gate to drop its push row. Neither is a demonstrated Play "deletion request" mechanism for developer-held data, because the author holds none. Ethan must choose the form answer and any free-text explanation. | `src/context/gateway-provider.tsx:3079-3083`, `:4419-4425`, `:4477-4479`; `src/lib/notifications/push-registration.ts:152-161`; Expo SDK 57 SecureStore page (retrieved 2026-11-02) for the iOS Keychain caveat |
| A4 | Privacy policy URL | **Unresolved.** `docs/release/PRIVACY.md` is the source text, but no hosted HTTPS URL exists in this repo or worktree. Do not invent one. | `docs/release/RELEASE-PLAN.md:31-42`; `docs/release/PRIVACY.md:1-8` |

### A2 note — why the answer is not a conditional "yes"

Play's definition does not allow a conditional "yes" for only some data: its help page
says the declaration applies only if encryption covers all collected data. The app can
carry gateway traffic over `http://`/`ws://` (`src/lib/gateway/url.ts:57-63`;
`src/lib/voice/gate-media-url.ts:7-16`), and the Android config enables cleartext
(`app.json:56-63`). A truthful draft therefore answers **No** and explains in the free
text that encrypted transport is available and recommended, while cleartext remains
supported for trusted LAN gateways (`README.md:134`).

### A3 note — two different deletion facts

| Feature | What it actually does | What it does not establish |
|---|---|---|
| Uninstall / clear app data | Removes the app's local Android data; on iOS the Keychain may survive reinstall | Not a request mechanism for data held by a developer server (there is none) |
| Delete custom Gateway profile / disconnect / switch gateway | Sends `notifications.deregister`, asking that Gate to remove the push row (`src/context/gateway-provider.tsx:3079-3083`, `:4419-4425`, `:4477-4479`; `src/lib/notifications/push-registration.ts:152-161`) | Does not delete chat history, backend records, or model-provider data; does not prove Play's form is satisfied |
| Confirmed notification denial | Deregisters the push row (`src/lib/notifications/push-registration.ts:208-213`) | Same as above |

## B. Data types collected or transmitted

Columns: **Collected** = transmitted off the phone (Play definition); **Optional** = the
user can use the app without it; **Observed recipients** = where source shows it going;
**Sharing classification** = Play-form classification, left unresolved where the
definitions do not settle it.

### B.1 Personal information

| Type | Collected | Optional | Observed recipients | Notes / citation |
|---|---|---|---|---|
| Name, email address, user ID, address, phone number, race/ethnicity, political/religious beliefs, sexual orientation, other personal info | **No dedicated field.** No account, profile, or contact form exists. Free text can of course contain any of these. | — | — | No account model in the app; `package.json:14-63` has no identity/account SDK. Text typed into chat is covered under B.2. |
| Health and fitness info | **No dedicated field.** | — | — | Not modelled by the app; typed content is covered under B.2. |

### B.2 Messages

| Type | Collected | Optional | Observed recipients | Notes / citation |
|---|---|---|---|---|
| Emails | No | — | — | No email client integration. |
| SMS/MMS | No | — | — | No SMS permission or API. |
| Other in-app messages | **Yes** — chat text, prompts, command output, and reply text sent to the configured gateway | No (core feature) | The gateway the user configured; if that gateway is shared, its operator | `src/context/gateway-provider.tsx:4519-4617`, `:5438`; `src/lib/cache/swr-store.ts:25`, `:39` (local cache) |
| Sharing classification | **Unresolved.** The author receives none, but Play's "sharing" test is not "does the developer receive it". The gateway is chosen by the user, so a user-initiated-action exception may apply; do not assume it without Ethan's confirmation. | | | `https://support.google.com/googleplay/android-developer/answer/10787469` (retrieved 2026-11-02) |

### B.3 Photos, videos, files and docs

| Type | Collected | Optional | Observed recipients | Notes / citation |
|---|---|---|---|---|
| Photos | **Yes, only when attached** (library or camera) | Yes | The gateway the user configured | Picker and camera paths at `src/components/chat/chat-screen.tsx:1435-1452`, `:1473-1478`; images are sent as part of the chat request at `:1561-1569` |
| Videos | No | — | — | Image picker is restricted to `mediaTypes: ['images']` (`src/components/chat/chat-screen.tsx:1435-1436`); no video capture path. |
| Files and docs | **Yes, only when attached** (PDF/JSON/text/markdown/CSV/XML) | Yes | The gateway the user configured | `src/components/chat/chat-screen.tsx:1494-1550`; bytes are read as base64 (`:1529`) and sent with the turn (`:1561-1569`) |
| Sharing classification | **Unresolved** for the same user-chosen-recipient reason as B.2. | | | |

The document picker asks for a cache copy (`src/components/chat/chat-screen.tsx:1494-1498`),
so an OS/app cache copy can remain after the send. Attachments are not parked in the
offline outbox; a failed send returns them to the composer
(`src/components/chat/chat-screen.tsx:1561-1573`).

### B.4 Audio

| Type | Collected | Optional | Observed recipients | Notes / citation |
|---|---|---|---|---|
| Voice or sound recordings | **Yes, when the user uses voice.** Two paths: (a) phone/OS recogniser receives audio; (b) Gate call sends raw PCM to the user's Gate. | Yes (microphone permission; the app works without voice) | OS speech service and/or the user's Gate | Phone path: `src/lib/voice/speech-recognition.ts:151-178`; `src/components/chat/chat-composer.tsx:233`; `modules/handsfree-voice/android/.../HandsfreeCallService.kt:383-391`, `:1069`; `modules/handsfree-voice/ios/HandsfreeVoiceModule.swift:307`, `:312-316`. Gate path: `modules/handsfree-voice/android/.../HandsfreeGateMedia.kt:186-244`, `:221-235`; `gate/core/voice/media-socket.mjs:1-6`, `:689-709`. |
| Music files / other audio files | No | — | — | No music/file audio picker or playback upload path. |
| Ephemeral status | **Gate media audio appears ephemeral in the code read**: frames are pushed into the engine and the socket writes no audio to disk (`gate/core/voice/media-socket.mjs:1-6`). Phone-OS recognition is not established; the OS may retain or transmit it under its own terms. | | | If Play treats the Gate stream as ephemeral, it still must be included in the form response but is not displayed. That classification is unresolved. |
| Sharing classification | **Unresolved.** Play's sharing definition includes on-device transfer to another app, which could describe handing audio to the OS recogniser; service-provider or user-initiated exceptions may apply. Do not assert "Shared: No" or "Shared: Yes". | | | `https://support.google.com/googleplay/android-developer/answer/10787469` (retrieved 2026-11-02) |

### B.5 Device or other IDs

| Type | Collected | Optional | Observed recipients | Notes / citation |
|---|---|---|---|---|
| Device or other IDs | **Yes, when notifications are enabled**: an Expo push token, plus a locally generated `deviceId` sent to the Gate | Yes (notification permission; the app works without push) | Expo's token service receives a token request with the project id; the user's Gate receives the token, platform, timezone, and `deviceId`; the Expo Push Service / APNs / FCM receive the token and notification envelope | Token request: `src/lib/notifications/push-registration.ts:34`, `:84-92`. Gate registration: `:143-150`; `gate/core/push-rpc.mjs:61-86`, `:95-104`. Device id derivation: `src/lib/gateway/device-identity.ts:20`, `:37-39`, `:47-57`, `:69-116`. Push send: `gate/core/push-send.mjs:1-2`, `:84-118`; `gate/core/push-notifier.mjs:158-212`. |
| Does the app-derived `deviceId` reach Expo? | **No evidence in current code.** The app passes only `projectId` to `getExpoPushTokenAsync`; the Gate stores the `deviceId` as its row key; the Gate's push message builder contains the token, title, optional body, and `sessionId`/`botId`/`runId`, not `deviceId`. | | | `src/lib/notifications/push-registration.ts:84-92`; `gate/core/push-notifier.mjs:87-212`; `gate/core/push-send.mjs:84-118` |
| Advertising ID / IMEI / MAC | No | — | — | No advertising or device-identifier SDK in `package.json:14-63`; no such permission in `app.json:24-39`. |
| Sharing classification | **Unresolved.** Expo is a third party; the Gate is the user's own infrastructure. Service-provider and user-initiated exceptions are possible but are Ethan's form choice. | | | |

The same app-derived `deviceId` also accompanies `voice.capabilities` and
`voice.session.start` when a Gate voice call is offered or started
(`src/context/handsfree-voice-provider.tsx:1103-1106`;
`src/lib/voice/handsfree-start-attempt.ts:219-228`), so it reaches the Gate for voice even
when push is disabled.

### B.6 App info and performance

| Type | Collected | Optional | Observed recipients | Notes / citation |
|---|---|---|---|---|
| Crash logs | No | — | — | No crash reporter in `package.json:14-63`; the app keeps a local failure log only (`src/lib/diagnostics/failure-log.ts:17`) |
| Diagnostics | No | — | — | Not transmitted by app code read |
| Other app performance data | No | — | — | In-process session analytics reads local history; not transmitted (`src/lib/gateway/session-analytics.ts:1-20`) |

### B.7 Location

| Type | Collected | Optional | Observed recipients | Notes |
|---|---|---|---|---|
| Approximate / precise location | No | — | — | No location permission requested (`app.json:24-39`); discovery uses LAN/Tailscale beacons and manually entered hosts (`src/lib/gateway/candidates.ts:67-117`) |

### B.8 Other data types

| Type | Collected | Notes |
|---|---|---|
| Web browsing history | No | Links open in an `expo-web-browser` sheet, not a browser tab with an address bar (`src/components/external-link.tsx:2`, `:18`; `src/components/chat/markdown/markdown-text.tsx:1`, `:34`), and model-supplied links are restricted to `http:`/`https:` (`src/components/chat/markdown/markdown-text.tsx:29-34`). OAuth authorization pages also open through that sheet (`src/components/gateway/oauth-progress-sheet.tsx:1`, `:31`). The app does not read browser history. |
| App interactions / in-app search history / installed apps / contacts / calendar / financial info | No | No SDK or code path transmits these (`package.json:14-63`; no such permission in `app.json:24-39`). |
| User-generated content other than messages, photos, files, audio | No separate type observed | Chat text is declared under B.2; attachments under B.3; voice under B.4. |

## C. Security practices

- **Encryption in transit: No, not for all collected data.** HTTPS/WSS works when the
  gateway provides it, and Expo push uses HTTPS (`gate/core/push-send.mjs:1-2`), but the
  Android build accepts cleartext HTTP/WS as a gateway transport (`app.json:56-63`;
  `src/lib/gateway/url.ts:57-63`; `src/lib/voice/gate-media-url.ts:7-16`;
  `src/lib/gateway/security.ts:43-49`). Do not paste a blanket "Yes".
- **Encryption at rest: Yes for secrets, No for local content and caches.** Gateway
  profiles, the device identity, and the Expo push token use SecureStore, and a
  production build refuses the insecure fallback
  (`src/lib/storage/secure-key-value.ts:44-62`; `src/lib/gateway/storage.ts:41-43`;
  `src/lib/gateway/device-identity.ts:114`;
  `src/lib/notifications/push-registration.ts:108-118`). Chat caches, drafts, the offline
  outbox, command transcripts, hands-free recovery text, settings, and the failure log are
  AsyncStorage, which is app-private but not encrypted
  (`src/lib/storage/key-value.ts:43-55`; `src/lib/cache/swr-store.ts:25`, `:39`;
  `src/lib/gateway/session-persistence.ts:1-10`; `src/lib/voice/handsfree-recovery.ts:23-36`).
  On iOS, Keychain items can survive uninstall (Expo SDK 57 SecureStore page, retrieved
  2026-11-02).
- **Data deletion support: unresolved** — see A3. Local clearing and Gate row removal are
  not the same as Play's deletion-request mechanism.
- **Families policy: no commitment recorded in this draft.** The app is not child-directed
  and collects no age; whether to commit to the Families policy and which target age group
  to select is Ethan's decision, not a source fact (`app.json:24-39`;
  <https://support.google.com/googleplay/android-developer/answer/9867159>, retrieved
  2026-11-02).

## D. Copy-paste answers that are supported by source

**Q: Does your app share user data with third parties?**
A: The app sends chat text and attachments only to the gateway URL the user configured.
Microphone audio goes either to the phone/OS speech recogniser or to the user's Gate,
depending on the voice transport. When the user enables notifications, the user's own Gate
sends the device's Expo push token plus a notification title, optional body, and routing
ids to the Expo Push Service, which delivers through APNs/FCM. No analytics, advertising,
or crash-reporting SDK is included. Play's "sharing" classification for the gateway and
Expo transfers is not asserted here; it is an open form decision.

**Q: Is data sold?**
A: No. No sale, ad, or data-broker path exists in `package.json:14-63` or the source read.

**Q: Is data used for advertising?**
A: No. No advertising SDK or ad code is present.

**Q: Does the developer receive user messages?**
A: The app's author operates no server that receives them. They go to the gateway the user
chose (`src/context/gateway-provider.tsx:4519-4617`). If the user points at a gateway
operated by someone else, that operator receives them, and that is the user's choice.

**Q: Is voice processed only on the device?**
A: No. Push-to-talk and phone-transport hands-free calls use the OS recogniser without
forcing on-device recognition (`src/lib/voice/speech-recognition.ts:22-29`, `:151-178`;
`src/components/chat/chat-composer.tsx:233`;
`modules/handsfree-voice/android/.../HandsfreeCallService.kt:1069`). An Android
Gate-transport call sends raw PCM to the user's Gate
(`modules/handsfree-voice/android/.../HandsfreeGateMedia.kt:221-235`), whose local engine
transcribes and speaks on the Gate host (`gate/core/voice/engines/local-engine.mjs:1-14`,
`:35-46`; `gate/voice-worker/versutus_voice/stt.py:1-5`;
`gate/voice-worker/versutus_voice/tts.py:1-5`). The transcript then goes to the user's
configured chat backend.

**Q: Is all traffic encrypted?**
A: No. HTTPS/WSS is available and recommended, but the Android build supports cleartext
HTTP/WS, and a scheme-less gateway URL becomes `http://` (`app.json:56-63`;
`src/lib/gateway/url.ts:57-63`).

## E. Items to verify before pressing submit

1. **Privacy-policy URL (A4)** — host the policy and paste the real HTTPS URL; do not
   invent one (`docs/release/RELEASE-PLAN.md:31-42`).
2. **Deletion-request answer (A3)** — decide whether Play accepts "no developer-held
   data / no request mechanism" or requires a stated path; the local and Gate controls are
   not a demonstrated request mechanism.
3. **Sharing classification** — decide how Play's service-provider and user-initiated
   exceptions apply to (a) the user's gateway and (b) Expo/APNs/FCM. The source proves
   recipients, not the form label (`https://support.google.com/googleplay/android-developer/answer/10787469`,
   retrieved 2026-11-02).
4. **OS speech recognition** — verify for each shipped OS version whether audio is
   processed on-device or sent to Apple/Google; the app does not force on-device
   (`src/lib/voice/speech-recognition.ts:22-29`;
   `modules/handsfree-voice/android/.../HandsfreeCallService.kt:1069`). The in-app phone
   row currently claims audio never leaves the phone (`src/lib/voice/voice-engine-copy.ts:45-49`),
   which the code does not guarantee; treat that as a runtime copy fix or a verified
   platform fact, not as a data-safety answer.
5. **Expo's token request payload** — the app passes only `projectId`, but Expo's SDK may
   add device/app metadata; verify against the Expo SDK 57 notifications implementation
   for the shipped build (`src/lib/notifications/push-registration.ts:84-92`;
   <https://docs.expo.dev/versions/v57.0.0/sdk/notifications/> (retrieved 2026-11-02).
6. **Gate-side retention** — the code read writes no audio but does persist a push row and
   a counts-only voice audit (`gate/core/voice/audit.mjs:1-33`;
   `gate/core/push-tokens.mjs:1-16`). Verify host logs, backups, and the chosen chat
   backend's retention, which are outside this tree.
7. **`google-services.json` / FCM in the uploaded build** — this config points Android push
   at that file; confirm the uploaded build carries working FCM credentials (`app.json:26`).
8. **Content rating and target audience** — separate from data safety; see
   `docs/release/CONTENT-RATING.md`. Ethan owns those answers.

## F. Corrections this draft makes to the previous answer set

| Old claim | New evidence / correction |
|---|---|
| "Push-to-talk audio is handed to the OS recogniser and not kept; no audio goes to the Gate." | Android Gate calls send raw PCM to the Gate over `/v1/voice/stream` (`HandsfreeGateMedia.kt:221-235`; `media-socket.mjs:689-709`). Voice is not all on-device and not only OS-delivered. |
| "Shared: No (the developer does not receive it)." | Play defines sharing separately from developer receipt and lists service-provider and user-initiated exceptions. The form label is unresolved; recipients are described instead. |
| "Encryption in transit: Yes." | Cleartext HTTP/WS is supported and a scheme-less URL defaults to `http://`; the Play answer must be No for "all data" (`app.json:56-63`; `url.ts:57-63`). |
| "Deletion: Yes — uninstall and `deregisterWithGate`." | These are local/Gate features, not a demonstrated Play deletion-request mechanism. A3 stays unresolved. |
| "Uninstall removes SecureStore entries." | True on Android; iOS Keychain can survive reinstall (Expo SDK 57 SecureStore page, retrieved 2026-11-02). |
| "The app device id is registered with Expo." | The app id goes to the Gate as its row key; the Gate's push payload to Expo carries token/title/body/data ids, not the app `deviceId` (`push-registration.ts:143-150`; `push-notifier.mjs:87-212`). |
