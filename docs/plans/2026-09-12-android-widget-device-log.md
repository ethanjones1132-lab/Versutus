# Android widget — device checklist

No phone is connected to the executor (the brief forbids `adb`), so the install step
and every on-device check below are recorded as `PENDING-DEVICE`. Everything that can
run without a device has run and is recorded first.

## Ran without a device

- [x] **Prebuild from clean (Task 0.5 Step 1).** `npx expo prebuild --platform android --clean` — `FINISHED prebuild EXIT=0`.
  The stale `android/app/src/main/java/com/versutus/app/VersutusStatusProvider.kt` (which extended
  a class from `expo-widgets`) no longer exists.
- [x] **Build (Task 0.5 Step 2).** `.\gradlew.bat :versutus-widget:testDebugUnitTest :handsfree-voice:testDebugUnitTest assembleRelease` — `BUILD SUCCESSFUL` in 11m 13s, `FINISHED gradle-assemble EXIT=0`.
- [x] **Merged manifest (Task 0.5 Step 3).** `Select-String` over the release merged manifest returns exactly one match,
  `com.versutus.widget.VersutusStatusReceiver`, and nothing for `VersutusStatusProvider` or `expo.modules.widgets`.
- [x] **Gate.** `npm run verify` — `FINISHED verify EXIT=0`.

## Device checklist (Samsung; a Pixel too if available)

- [ ] 1. Remove the old transparent widget. Its provider class is gone, so One UI shows it as unavailable. — PENDING-DEVICE
- [ ] 2. Long-press → Widgets → Versutus: the picker preview is an opaque card reading "Connected / 1 run waiting on your approval". — PENDING-DEVICE
- [ ] 3. Place it at 4x2: an opaque rounded card, readable on a dark wallpaper and then a light one, with status, work line, result and "Written Today HH:MM". — PENDING-DEVICE
- [ ] 4. Resize to 2x2: the result line drops, and status, work and stamp remain. — PENDING-DEVICE
- [ ] 5. Tap: Versutus opens on the Chat tab. — PENDING-DEVICE
- [ ] 6. Start a run from the app: within seconds the work line reads "1 run in flight"; when it settles, the result line updates. — PENDING-DEVICE
- [ ] 7. Trigger an approval: the work line leads with "1 run waiting on your approval" plus "Tap to decide in Versutus"; tapping opens Chat with the approval sheet showing. — PENDING-DEVICE
- [ ] 8. Force-stop Versutus: the widget keeps its last data and the stamp does not change. — PENDING-DEVICE
- [ ] 9. Reboot the phone: the widget redraws from the stored payload with the same stamp. — PENDING-DEVICE
- [ ] 10. `adb shell dumpsys appwidget | findstr versutus` lists `com.versutus.app/com.versutus.widget.VersutusStatusReceiver`. — PENDING-DEVICE

`FUTURE-ITEMS.md` §4 is left unchanged until every item above passes on a device
(the brief forbids changing it while only the device steps remain).
