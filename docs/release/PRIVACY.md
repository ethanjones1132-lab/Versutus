# Privacy Policy — Versutus

**Last updated:** 2026-10-16
**App:** Versutus (bundle `com.versutus.app`, version 1.0.0)
**Publisher:** Ethan Jones, sole author.

This policy applies to the Versutus mobile and web client. It is written to be read
alongside `docs/release/PLAY-DATA-SAFETY.md`, which is the matching data-safety
declaration prepared for the Google Play Console.

## 1. Summary in one paragraph

Versutus is a **client**. It has **no author-run backend**: your messages, runs,
tools, and approvals are sent only to the gateway you point the app at — a Hermes
agent, a Versutus Gate, or an OpenClaw gateway on a machine you own or control.
The author (Ethan Jones) does not operate a server that receives your content, does
not hold your model credentials, and does not collect analytics, advertising
identifiers, or crash reports. The only data that leaves your device for a third
party is the data needed to deliver **push notifications** through the Expo Push
Service (and underneath it APNs/FCM), and only when you enable notifications.

## 2. What Versutus is, and where your data goes

- Versutus speaks directly to the gateway URL saved in a gateway profile
  (name, URL, auth token, kind, agent) — `src/context/gateway-provider.tsx` drives
  connect, reconnect, and capability reads.
- There is no public relay operated by the author. True push is delivered by **your
  own** Versutus Gate (the companion server in `gate/`) calling the Expo Push
  API, not by any Versutus cloud (`README.md` "Scope limits"; `FUTURE-ITEMS.md`
  Solution A). Model credentials and provider keys stay in the gateway/Bot
  profile and never reach the phone as a stored secret beyond the token you
  entered.
- Your chat text, run prompts, tool calls, attachments, and command output leave
  the device only toward the gateway you configured. Choosing to send an image,
  PDF, or other file through the composer (`src/components/chat/chat-screen.tsx:1374-1420`)
  puts that file's contents into the request body to that gateway.

## 3. Data stored on the device

| Data | Where | Notes |
|---|---|---|
| Gateway profiles (name, URL, auth token) | SecureStore when available; AsyncStorage fallback in dev runtimes only (`src/lib/storage/secure-key-value.ts`) | production builds refuse the unencrypted fallback |
| Device identity (ed25519 keypair, device id) | SecureStore (`src/lib/gateway/device-identity.ts`, key `versutus:device-identity`) | generated locally; used to sign pairing/auth payloads |
| Expo push token cache | SecureStore (`src/lib/notifications/push-registration.ts`, `STORE_KEY`) | only the token string |
| Offline message outbox, session labels, command transcripts, caches | AsyncStorage (`src/lib/storage/key-value.ts`) | local only |
| App settings, lock preference, widget snapshot | AsyncStorage / native widget store | local only |
| Push-to-talk recordings | not stored | audio is handed to the on-device / OS speech recognizer and is not kept as a file by Versutus |

SecureStore is `expo-secure-store`, backed by the Android Keystore / iOS Keychain
(`src/lib/storage/secure-key-value.ts:52-62` explains the production refusal of
the insecure fallback).

## 4. Data transmitted off the device (author-run side: none)

Versutus itself operates no backend. The only transmissions are:

1. **To the gateway you configured** — connection handshake, capability reads,
   authenticated RPC/HTTP/SSE/WebSocket traffic, chat messages, run control,
   approvals, tool output, and attachments. This is user-directed traffic to
   infrastructure the user controls.
2. **To the Expo Push Service (and through it APNs/FCM)** — when notifications are
   enabled, the device obtains an Expo push token (`Notifications.getExpoPushTokenAsync`,
   `src/lib/notifications/push-registration.ts:73-96`) and the user's own Gate
   registers it with that token's project (`registerWithGate`, `:143-150`). The
   registration carries the token, platform (`Platform.OS`), a timezone, and a
   locally generated device id. Push notification envelopes then travel
   Expo Push Service → APNs/FCM → device.
3. **To the OS speech service** — when push-to-talk or the hands-free call uses
   speech recognition. Versutus requests speech recognition from
   `expo-speech-recognition`; audio is handled by the platform (Apple/Google) speech
   service. By default `requiresOnDeviceRecognition` is not forced
   (`src/lib/voice/speech-recognition.ts:27`), so recognition may run on the
   device's OS service. **(?) verify** platform-specific on-device/network
   behaviour for a given OS version; Versutus itself stores no audio and sends no
   audio to any Versutus server.
4. **Network metadata** — hostnames/IPs, ports, TLS fingerprints displayed
   ("fingerprint seen", observed rather than pinned) for gateways you enter.

No analytics SDK, advertising SDK, crash reporter, or remote-config client is
included in the app (`grep` for Sentry/Crashlytics/Bugsnag in `src/` returns none;
Firebase's `google-services.json` is used only so Expo can obtain FCM credentials
for push delivery, not for Analytics in app code). `(?) verify` the exact FCM
delivery path against the Expo v57 notification docs for the build you ship.

## 5. Push notification content policy

Per `FUTURE-ITEMS.md` Solution A6, the default relayed push payload is
**contentless**: titles such as "Approval required" / "… finished a run" with ids
only — no prompt text and no reply bodies. Rich bodies are a per-device opt-in
in notification preferences. Local notifications (fired only while the connection
is live, `src/lib/notifications/local.ts`) contain run/approval snippets because
they never leave the device.

## 6. Permissions and why each exists

From `app.json:25-31` (Android) and `app.json:12-19` (iOS):

| Permission / usage string | Why |
|---|---|
| `RECORD_AUDIO`, `NSMicrophoneUsageDescription` | push-to-talk dictation and the hands-free call (`src/lib/voice/speech-recognition.ts`, `modules/handsfree-voice`) |
| `POST_NOTIFICATIONS` | local and relayed push notifications (`src/lib/notifications/local.ts`, `push-registration.ts`) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | hands-free call foreground service (`modules/handsfree-voice/.../AndroidManifest.xml`, verified by `scripts/verify-config.mts`) |
| `expo-image-picker` photo/camera/mic strings | attaching images/files to a message (`src/components/chat/chat-screen.tsx:1374-1420`) |
| `NSSpeechRecognitionUsageDescription` | speech recognition |
| `NSFaceIDUsageDescription` | optional biometric app lock (`src/components/app-lock-gate.tsx`) |
| `UIBackgroundModes: audio` | hands-free call audio while backgrounded |
| `usesCleartextTraffic: true` (Android) | trusted-LAN gateway URLs; HTTPS/WSS is recommended and the gateway URL is yours |

Android `RECORD_AUDIO`/notification permission flows are exercised in-app; a
refusal is remembered rather than re-asked endlessly (`src/lib/notifications/local.ts`).

## 7. Retention and deletion

- Versutus keeps no account and has no server-side copy of your data. Retention is
  on your devices and on the gateway you control.
- Uninstalling the app removes its local storage on that device (SecureStore entries
  are removed by the OS with the app).
- Removing a gateway profile or a paired device triggers `deregisterWithGate`,
  which asks your Gate to drop its push token row
  (`src/lib/notifications/push-registration.ts:152-161`).
- Push-token cache and device identity can be cleared by uninstalling or by
  clearing app storage.
- Content held by your gateway (messages, runs, sessions, provider keys) is
  governed by that gateway and its host, not by this policy.
- Notifications permission revoked = no further push registration; a confirmed
  denial deregisters with the Gate (`syncPushRegistration`, `:176-228`).

## 8. Sharing

Versutus does **not** sell data, does not run ads, and does not share data with
any third party for marketing. The only third-party recipients are the ones named
above and only for the purposes named there: Expo Push Service / APNs / FCM for
notification delivery; and, indirectly, the OS speech service when you use voice.
Your gateway is infrastructure you chose and operate; traffic to it is not
"sharing" with a third party from Versutus's side, but those operators' own
policies govern that host.

## 9. Children

Versutus is not directed to children. It contains no child-specific content and
collects no age. It is a tool for adults operating their own agent gateways.

## 10. Security practices

- Credentials (gateway tokens, device keys) are stored in platform secure storage
  whenever available; the dev-only AsyncStorage fallback is refused in production
  (`src/lib/storage/secure-key-value.ts:44-62`).
- Connections use HTTPS/WSS where the gateway provides it. Cleartext is supported
  for trusted local networks because gateway hosts are often on a LAN/Tailscale
  address you control; that is a trade-off, not a default, and HTTPS/WSS is
  recommended (`README.md` "Quick start").
- Discovery TLS fingerprints are **observed and displayed, not pin-verified**;
  Expo's fetch does not expose the hook needed to pin them (`README.md` "Scope
  limits"). The UI says "fingerprint seen" rather than implying a guarantee.
- Device identity is an ed25519 keypair generated with `expo-crypto`'s CSPRNG and
  stored locally (`src/lib/gateway/device-identity.ts:41-46`).

## 11. Changes to this policy

Changes are published with the app/repository. The effective date at the top
changes with each revision. A material change affecting data handling will be
called out in release notes.

## 12. Contact

Privacy questions go to the project owner, **Ethan Jones**, via the repository's
issue tracker (repository URL `(?) verify` — the worktree used to prepare this
release does not expose a remote URL). *(?) verify* a public contact email before
publishing if you want one on the listing.

## Companion data-safety declaration

See `docs/release/PLAY-DATA-SAFETY.md`. That file holds the Play Console answers
with `file:line` citations; if it and this policy ever disagree, this policy
governs user-facing claims and the Console file is updated to match.