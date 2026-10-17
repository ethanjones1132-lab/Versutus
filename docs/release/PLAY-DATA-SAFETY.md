# Play Data Safety — Versutus

Companion to `docs/release/PRIVACY.md` and step 5.2 of
`docs/release/RELEASE-PLAN.md`. This is the answer set Ethan pastes into the
Google Play Console "Data safety" form for the open-testing (and later production)
release of Versutus 1.0.0.

All answers are based only on code actually read in this repository; every answer
carries a citation in the form `path:line`. Items that could not be proven from
the tree are marked `(?) verify` and must be confirmed by Ethan before submission.

## A. Top-level questions

| # | Play question | Answer | Basis |
|---|---|---|---|
| A1 | Does your app collect or share any of the required user data types? | **Yes — but only "Device IDs" shared with the Expo Push Service for notification delivery, plus user-directed traffic to a gateway the user themselves configures.** The author operates no backend and receives no user data. | `app.json:25-31` permissions; `src/lib/notifications/push-registration.ts:73-150` |
| A2 | Is all of the user data collected by your app encrypted in transit? | **Yes for gateway traffic when the gateway uses HTTPS/WSS; cleartext is permitted for trusted-LAN gateways (a trade-off the operator opts into).** Push token registration rides the paired gateway channel. | `README.md` "Quick start" (HTTPS/WSS recommended); `app.json:54-58` `usesCleartextTraffic: true` |
| A3 | Do you provide a way for users to request that their data is deleted? | **Yes** — uninstall clears local storage; gateway-profile removal / paired-device revoke triggers `deregisterWithGate` (`src/lib/notifications/push-registration.ts:152-161`); content held by the user's gateway is governed by that gateway. See Privacy policy §7. | `src/lib/notifications/push-registration.ts:152-161` |
| A4 | Privacy policy URL | `(?) verify` — publish `docs/release/PRIVACY.md` and paste the hosted URL (RELEASE-PLAN.md §2). | `docs/release/PRIVACY.md` |

## B. Data types collected or shared by the app

Columns: **Collected** = transmitted off device; **Shared** = given to a third party;
**Optional** = gated by a permission/pref; **Ephemeral** = not persisted.

### B.1 Personal information

| Type | Collected | Shared | Optional | Notes / citation |
|---|---|---|---|---|
| Name, email, user ID, address, phone number, race/ethnicity, political/religious beliefs, sexual orientation, other personal info | No | No | — | No accounts and no author backend (`README.md` "Versutus is a client"). Messages may *contain* such text but are sent only to the user's own gateway. |
| Health info | No | No | — | not modelled by the app. |

### B.2 Messages

| Type | Collected | Shared | Optional | Notes / citation |
|---|---|---|---|---|
| Emails | No | No | — | — |
| SMS/MMS | No | No | — | — |
| Other in-app messages | **User-directed only** | To the user's configured gateway (never to the author) | No (core feature) | Chat/session/run content is an HTTP/SSE/WebSocket body to the saved gateway URL. The author receives none. `src/context/gateway-provider.tsx` (connect/RPC); `src/components/chat/chat-screen.tsx` |

Conservative form answer if Play's wording does not allow "user-directed only": mark **Collected: Yes; Shared: No (developer does not receive); Purpose: App functionality** and explain in the free-text box that the recipient is infrastructure chosen and operated by the user, citing `README.md` and `src/context/gateway-provider.tsx`.

### B.3 Photos and videos / Files and docs

| Type | Collected | Shared | Optional | Notes / citation |
|---|---|---|---|---|
| Photos | **No** by Versutus itself; only if user attaches one | To the user's gateway when an attached image is sent | Yes — permission-gated, model-gated | Picker is launched only when the selected model advertises image input (`src/components/chat/chat-screen.tsx:1374-1406`); image bytes become part of the chat request to the user's gateway. Permission strings at `app.json:82-89`. |
| Videos | No | No | — | no capture/transmit of video |
| Files and docs | **No** by Versutus itself; only if user attaches one | To the user's gateway when sent | Yes | `DocumentPicker.getDocumentAsync` at `src/components/chat/chat-screen.tsx:1420`; `src/app/gateway/import.tsx:31` reads a handoff file into the app. Attachment gating follows declared model input support (`FUTURE-ITEMS.md` §P1). |

### B.4 Audio

| Type | Collected | Shared | Optional | Notes / citation |
|---|---|---|---|---|
| Voice / sound recordings | **No** stored or transmitted by Versutus | **Possibly** to the OS speech service (Apple/Google) | Yes — mic permission | Push-to-talk and the hands-free call use `expo-speech-recognition` (`src/lib/voice/speech-recognition.ts`); audio is streamed to the platform recognizer, not to Versutus. `requiresOnDeviceRecognition` is optional and defaults unset (`src/lib/voice/speech-recognition.ts:27`), so audio may leave the device for the OS service. **(?) verify** on-device vs. network recognition for each target OS before claiming on-device only. App stores no audio (`FUTURE-ITEMS.md` B5 rejects always-listening). |

### B.5 Device IDs

| Type | Collected | Shared | Optional | Notes / citation |
|---|---|---|---|---|
| Device or other IDs | **Yes** (Expo push token + locally generated device id) | **Yes — with Expo Push Service (and transitively APNs/FCM)** | Yes — notification permission | • `Notifications.getExpoPushTokenAsync({ projectId })` — `src/lib/notifications/push-registration.ts:84-92` (project id `52545800-…`, `:34`).<br>• `registerWithGate` sends `expoPushToken`, `platform`, `timezone`, and `deviceId` — `:143-150`.<br>• `deviceId` is SHA-256 of a locally generated public key, stored in SecureStore — `src/lib/gateway/device-identity.ts:20,37-39,69-116`.<br>• Confirmed permission denial deregisters — `src/lib/notifications/push-registration.ts:209-213`. |

### B.6 App info and performance / Other app performance data

| Type | Collected | Shared | Optional | Notes / citation |
|---|---|---|---|---|
| Crash logs | No | No | — | no crash reporter in `src/` (failure-audit note: `grep` for sentry/crashlytics/bugsnag: none) |
| Diagnostics | No | No | — | — |
| Other app performance | No | No | — | in-process session-spend analytics reads only local session history (`src/lib/gateway/session-analytics.ts`); not transmitted |

### B.7 Location

| Type | Collected | Shared | Optional | Notes |
|---|---|---|---|---|
| Approximate / precise location | No | No | — | no location permission requested (`app.json:25-31`); discovery uses LAN/Tailscale beacons and manually entered hosts, not GPS |

### B.8 Third-party or library data (not app-collected, but check during review)

| Source | Role | Citation |
|---|---|---|
| Expo Notifications / Expo Push Service | delivers push using the device token | `src/lib/notifications/push-registration.ts`; `app.json:73` plugin |
| FCM (Android service account via `google-services.json`) | transport for Android push | `app.json:24` |
| APNs (EAS-managed) | transport for iOS push | `FUTURE-ITEMS.md` A1 |
| OS speech recognizer | speech recognition | `src/lib/voice/speech-recognition-native.ts:1-29` |
| Expo SecureStore/AsyncStorage | on-device storage | `src/lib/storage/secure-key-value.ts`, `key-value.ts` |

## C. Security practices (paste as stated)

- Data encrypted in transit: **Yes** where the gateway uses HTTPS/WSS; the app supports a cleartext fallback for trusted local networks, disclosed and documented (`README.md` "Quick start"; `app.json:54-58`).
- Data encrypted at rest: **Yes** for secrets via SecureStore/Keystore/Keychain; plain AsyncStorage fallback is dev-only and refused in production (`src/lib/storage/secure-key-value.ts:52-62`).
- Data deletion support: **Yes** (see A3).
- App complies with Google Play Families Policy: **No / N/A** (not child-directed) — see Privacy policy §9.

## D. Answers that are frequently asked (copy-paste)

**Q: Does your app share user data with third parties?**
A: Only the device's push token and a locally generated device id, with the Expo Push Service (and through it APNs/FCM), for notification delivery when notifications are enabled. No analytics, advertising, or crash-reporting SDK is included. All chat/run/tool content is sent only to the gateway URL the user configures.

**Q: Is data sold?**
A: No.

**Q: Is data used for advertising?**
A: No.

**Q: Does the developer receive user messages?**
A: No. Versutus is a client; the author runs no backend (`README.md`: "Versutus is a client. … Your agent stays where you put it.").

## E. Items to verify before pressing submit (`(?) verify`)

1. Public privacy-policy URL after hosting `docs/release/PRIVACY.md` (A4) — `(?) verify`.
2. Whether OS speech recognition for the shipped target OS versions runs on-device or sends audio to Apple/Google (B.4) — `(?) verify`.
3. Whether `google-services.json`/FCM is configured in the actual release build you upload (B.8) — `(?) verify` per build; push cannot register without it (`FUTURE-ITEMS.md` A1).
4. Whether any identifier beyond those listed is transmitted by Expo runtime SDKs themselves (diagnostics, expo-updates) — not exercised in code review; `(?) verify` against the Expo v57 docs for the SDK modules actually linked.
5. Content rating / target audience answers are separate from data safety and remain Ethan's call (RELEASE-PLAN.md §3).