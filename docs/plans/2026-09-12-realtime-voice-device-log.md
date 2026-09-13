# Hands-free call — physical-device gate (Samsung)

Plan: `docs/plans/2026-09-12-realtime-voice-plan.md` · Task 0.10.
Branch `sprint/voice-2026-09-13`. Recorded by the remaining-work sprint on 2026-09-13.

No phone was connected to this worktree, so no row was run. The APK was built and
every row below is **PENDING-DEVICE**. Phase 0 is not considered done until
P0-1…P0-9 pass on Ethan's Samsung; until then `FUTURE-ITEMS.md` B4 is untouched.

## Build

- `npm run verify` — EXIT 0 (log `.long-verify12.log`).
- `.\gradlew :handsfree-voice:testDebugUnitTest assembleRelease` — `BUILD SUCCESSFUL`
  (16m 24s). JVM tests `HandsfreeCallStateTest`, `HandsfreeEndpointingTest`,
  `HandsfreeRecognizerErrorsTest` pass.
- APK: `android\app\build\outputs\apk\release\app-release.apk` (160,452,358 bytes),
  built from HEAD `67f6e8d` plus the device-log commit.

## Install (not run)

- `adb install -r android\app\build\outputs\apk\release\app-release.apk` — PENDING-DEVICE.
- Logcat:
  `adb logcat -s HandsfreeCallService:V SpeechRecognizer:V TextToSpeech:V ActivityManager:I AndroidRuntime:E ExpoModulesCore:W ReactNativeJS:V` — PENDING-DEVICE.

## Matrix

| Row | Script | Pass when | Result |
|---|---|---|---|
| P0-1 | Fresh process, connect, open a Bot Chat | Call is visible before any message is sent | PENDING-DEVICE |
| P0-2 | Send a long prompt | Call stays visible during the stream; tapping it shows "Wait for this reply to finish…" | PENDING-DEVICE |
| P0-3 | Start call, grant microphone, deny notifications | The call starts anyway; logcat shows `recognizer bound` | PENDING-DEVICE |
| P0-4 | Three turns in the foreground | Each turn appears once in chat, the reply is spoken, and the mic reopens | PENDING-DEVICE |
| P0-5 | The same three turns backgrounded, then with the screen locked for 10 minutes | Same as P0-4; the notification sits in the shade, not in the silent section | PENDING-DEVICE |
| P0-6 | End from the notification while backgrounded, reopen the app | Banner gone; Call offered again; Start works without killing the app | PENDING-DEVICE |
| P0-7 | Receive a phone call while listening, then while speaking | Versutus ends, releases audio, does not resume; the sheet reopens with the interruption reason | PENDING-DEVICE |
| P0-8 | Toggle airplane mode for 5 s while listening | The call rides out the blip (retry), or ends with the recognition reason after 3 failures | PENDING-DEVICE |
| P0-9 | Hold to talk | Still drafts into the composer and never sends | PENDING-DEVICE |

## Contingency (not run)

- If P0-4 fails with repeated `recognizer error 5/8/11` on this phone, set
  `PREFER_ON_DEVICE_RECOGNIZER = true` in `HandsfreeCallService.kt`, rebuild,
  reinstall, and rerun P0-3…P0-5; record which recognizer passed. — PENDING-DEVICE.

## Unverified code-level assumptions

- Task 0.7: whether One UI treats the 250 ms post-permission-dialog foreground
  start as foreground-eligible (`adb logcat … HandsfreeCallService:W ActivityManager:I`).
- Task 0.8: whether Samsung's default recognizer needs the on-device preference.
