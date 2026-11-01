# Versutus Android release readiness audit — 2026-10-31

Scope: release-readiness review of the current `master` tree for the first Android
release, plus the fixes applied in this pass. Method: source review across the app,
Gate, native modules and release config; `npm run verify`; `npx expo-doctor`;
`npm ci`; Android prebuild and native compile; Android and web exports; a web tour
of every primary screen in showcase mode; and a Lighthouse pass.

**Verdict:** the runtime and test foundation are strong, but the tree was not
store-ready. The visual identity assets, the Play Console surface, and several
Android-specific defects were blockers. The code blockers listed under "Fixed"
are addressed in this pass. The store/ops blockers under "Still open" remain
Ethan's to complete.

---

## Fixed in this pass

| Area | What was wrong | Evidence / fix |
|---|---|---|
| Launcher icon | Adaptive `foregroundImage` and `monochromeImage` were the same opaque, full-colour 1024px icon (white corners); themed icons rendered as a solid block. `backgroundImage` was a design template with dashed safe-zone guides. | Alpha scan: 0% transparent foreground, corner alpha 255. Rebuilt `icon.png`, adaptive foreground/monochrome, background, splash and favicon from the in-app Versutus mark; `scripts/generate-brand-assets.ps1` makes them reproducible. Background is now `#08080A`, no template image. |
| Notification icon | No status-bar icon configured, so Android would use the full-colour launcher icon as the small icon. | Added `assets/images/notification-icon.png` (96px, white alpha glyph) and `expo-notifications` plugin `icon`/`color`. Prebuild writes `notification_icon` and `notification_icon_color`. |
| App config | `android.navigationBar` is not a valid Expo SDK 57 field; `expo-doctor` failed schema validation. No root background colour; `allowBackup` defaulted true; Expo's manifest template added `SYSTEM_ALERT_WINDOW` and legacy storage permissions. | Removed the ignored key, added `backgroundColor`/`primaryColor`, `allowBackup: false`, and `blockedPermissions` for `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`. Prebuild manifest now shows `tools:node="remove"` for all three and `allowBackup="false"`. |
| Settings crash | `gateway/settings.tsx` read `voiceCapabilities?.engines.local` and `capabilities.engines[id]`; a Gate that returned a partial record (or the showcase provider's `{}`) crashed the whole Settings screen with "Cannot read properties of undefined (reading 'local')". | Optional chaining on both reads; demo provider now returns a complete voice-capabilities record. |
| Android hardware back | Chat's Bot/room/configurable surfaces are screen state, not routes. System back left the app instead of returning to the roster. | Added an Android `BackHandler` in `chat-screen.tsx` that returns to the roster before the app may close. Sheets and the keyboard still consume back first. |
| Hands-free start teardown | Ending a call while a Gate start was still opening could leave the native microphone session and media socket live: teardown had already looked for them, and the later torn-down branch only cleared refs and stopped the Gate session. | `startGateCall` now mints the attempt id, passes it to `openGateVoiceSession`, and calls `cancelNativeSession(module, startId)` on timeout and on `call-torn-down-while-starting` before clearing refs. |
| Accessibility: connection toast | The toast is always mounted with `opacity: 0`, so screen readers always saw "Gateway online" even while disconnected. | Marked hidden when not visible (`accessibilityElementsHidden`, `importantForAccessibility`, live region only while visible). |
| Accessibility: primary buttons | White-ish `#F5F7FA` on `accentDeep` measured 4.43:1, below WCAG AA for 15px text. Lighthouse flagged it. | Primary button labels now use pure white (4.76:1). Lighthouse on the exported web build now scores 100 accessibility. |
| Accessibility: Home settings | The gear is icon-only with no role or label. | `ScreenHeader` trailing control now exposes role `button` and label "Open settings". |
| Fleet / Council headers | Both screens draw their own serif title, but the root Stack also showed a native header with the same title, producing a duplicate heading and a hard background seam. | `headerShown: false` for both; screens now use `PageTitle` with an explicit back control, matching Runs/Spend. |
| Fleet constellation | Six bots were packed into one row; "Running" and "1 failed" badges overlapped neighbouring labels on a phone. | Bot label budget widened 96 → 120 design units and spacing 104 → 128, so rows wrap at five; badges are width-capped to the node. |
| Markdown links | A model-supplied `[label](javascript:…)`, `file:` or `intent:` URL was handed to `WebBrowser.openBrowserAsync`. | Only `http:`/`https:` links leave the app; other schemes are inert. |
| Module cycle | Metro warned `routines.ts → cron.ts → routines.ts`. | `routineName`/`parseRoutineName` moved to `routine-name.ts`; `routines.ts` re-exports them, so callers and tests keep their public surface. |
| Call deep link | `ts=` with an empty value became `Number('') === 0`, which passed the finite check and looked like a signed link. | Timestamp must be a non-empty digits-only positive epoch. |
| Signed call auto-start | Android Keystore HMAC key generation omitted `setDigests(SHA256)`, which can throw on some devices and was swallowed by `verifyLaunch`. | Added `.setDigests(KeyProperties.DIGEST_SHA256)`. |
| Web metadata | Statically rendered pages had an empty `<title>` and no description; Lighthouse SEO was 0.5. | Added `expo-router/head` metadata in the root layout; `dist/chat.html` now contains `<title>Versutus</title>` and the description. Lighthouse SEO is 100. |
| SDK patch drift | 30 Expo/RN packages were behind the SDK 57 patch line; `@expo/ui` was duplicated; `expo-doctor` failed 3 checks. | Upgraded to Expo 57.0.31 / RN 0.86.3 / matching Expo modules, added `@react-native/jest-preset`, regenerated the lockfile. `expo-doctor` is now 21/21; `npm ci` is clean. |
| Documentation | `README.md` claimed 135 test files, 928 cases, 44.77% coverage and 13 ADRs, all long stale. | Updated to the current 1,032 test files / 10,357 cases / coverage split / 16 ADRs, and linked this audit from the release plan. |

---

## Still open — release blockers (store/ops, not code)

1. **Privacy-policy URL is not published.** `docs/release/PRIVACY.md` is the source,
   but `docs/release/RELEASE-PLAN.md` still marks the URL `(?) verify`. Play requires
   a public HTTPS URL.
2. **Data Safety answer A4 is open.** `docs/release/PLAY-DATA-SAFETY.md` still has
   `(?) verify` for the privacy-policy URL; paste the final hosted URL and complete
   the Console form.
3. **Store listing assets are not in the repo.** No 512×512 icon export, phone/
   tablet screenshots, feature graphic, short/full description, or content-rating
   answers. The showcase mode is dev-web only, so screenshots need a dev build or
   a connected device.
4. **Signing path.** EAS production with remote credentials is configured and is
   the supported path. A local `./gradlew bundleRelease` currently uses the debug
   signing config; do not upload that artifact to Play. Either use EAS or add a real
   keystore outside the repo before a local release bundle.
5. **Device-held acceptance.** Still required on a physical Android 13+ device:
   widget placement/update, hands-free three-turn soak in foreground/background/
   locked, camera/photo/document attachments, and notification tap/action paths.
6. **Pre-launch report.** Run the Play pre-launch report against the internal-track
   build before promoting; the current CI verifies JS and Gate tests, not a packaged
   Android artifact.

---

## Still open — P1 engineering / UX

1. **Cleartext traffic is global.** `usesCleartextTraffic: true` permits HTTP to any
   host. The app discloses this in the manual-add/settings transport card, but a
   gateway token can still cross a LAN in clear text. Prefer HTTPS-only defaults
   with an explicit per-profile "allow cleartext on trusted LAN" opt-in, or a
   network-security-config restricted to private ranges.
2. **TLS fingerprints are discovery records, not pinning.** This is documented in
   the README and the transport card, but the code cannot observe the certificate
   through Expo fetch. Enterprise buyers will read this as "no pinning"; keep the
   wording, and consider a native pinning path later.
3. **Closed drawer remains in the accessibility tree.** On web, `document.body.innerText`
   starts with "New chat / Chats / Activity / Tools / Settings" before the roster,
   even when the drawer is closed. `useDrawerStatus` + `importantForAccessibility`
   would hide it; the existing drawer tests render the component without a drawer
   context, so this needs a small test seam.
4. **One screen's render error takes the whole app.** The Settings crash surfaced
   the root `ErrorFallback`; Try again re-renders the same failing screen. Add a
   per-route error boundary or a "Back to Chats" recovery action.
5. **App lock's initial pending window.** `AppLockGate` starts in `phase: 'pending'`
   with no cover until the storage/biometric probe resolves. The native splash
   covers the usual case, but a slow Keystore read can briefly show content on a
   cold start. Consider holding the boot cover until the lock verdict lands.
6. **No crash/error telemetry.** The app keeps 50 failures locally
   (`lib/diagnostics/failure-log.ts`); there is no opt-in crash reporter. For a
   public release this makes field diagnosis slow. Decide explicitly whether the
   privacy stance forbids it or add a consent-gated reporter.
7. **Android build is not in CI.** `.github/workflows/ci.yml` runs typecheck, lint,
   Jest, Gate tests and portal smoke only. Add an EAS/prebuild + `assembleRelease`
   job (or a weekly build) so native-module and manifest regressions are caught
   before store upload.
8. **Dependency audit is not clean.** `npm audit --omit=dev` reports 31 advisories
   (1 critical `shell-quote`, 9 high), mostly transitive build tooling
   (`@expo/cli`, Metro, `js-yaml`, `zod`) plus `expo-router`/`query-string`.
   Triage whether any reach the runtime; pin overrides or document the accepted
   build-time set.
9. **Android predictive back is disabled.** `predictiveBackGestureEnabled: false`
   maps to `enableOnBackInvokedCallback="false"`. Acceptable for 1.0, but it is a
   modern-Android UX downgrade and should be revisited after Chat's back handling.
10. **Deprecation warnings.** RN 0.86 warns on `shadow*`/`textShadow*` props in
    `connected-toast` and `bot-figure`; migrate to `boxShadow`/`textShadow`.
11. **Web is a demo, not the product.** It keeps secrets in browser storage, has no
    app lock or device push, and needs the Gate's CORS origin. The README says this;
    store copy must not imply the web build is equivalent to the Android app.

---

## Verification evidence

| Check | Result |
|---|---|
| `npm run verify` | 814 Jest suites / 8,244 cases passed; 2,113 Gate tests (2,112 pass, 1 skipped, 0 fail); coverage 89.74% statements, 82.17% branches, 91.36% functions, 92.37% lines; coverage ratchet recorded a new high-water mark. |
| `npx expo-doctor` | 21/21 checks passed. |
| `npm ci` | Clean reinstall from the lockfile. |
| `npx expo prebuild --platform android --clean --no-install` | Finished; manifest verified: `allowBackup=false`, `SYSTEM_ALERT_WINDOW`/storage permissions removed, notification icon/color resources present, adaptive background is `@color/iconBackground`. |
| `gradlew :app:compileReleaseKotlin :app:processReleaseResources` | BUILD SUCCESSFUL (native Kotlin modules, icons and release resources compile). |
| `npx expo export --platform android` | Hermes bundle produced (7.7 MB). |
| `npx expo export --platform web` | 25 static routes exported; `<title>Versutus</title>` and description present. |
| Lighthouse on exported `/chat` | Accessibility 100, Best Practices 100, SEO 100 (previously 0.9 / 1 / 0.5). |

Note: the local Gradle release path still uses the debug signing config by design
in the generated project. That build was used only for native compile validation;
the Play artifact must come from EAS (or from a properly configured local keystore).

---

## Recommended release sequence

1. Finish the Console blockers: host the privacy policy, complete Data Safety,
   create the store listing and content-rating answers.
2. Build the EAS `production` AAB and upload it to the **internal** track first.
3. Run the Play pre-launch report and the physical-device acceptance list.
4. Fix any pre-launch findings, rebuild, and only then promote to open testing.
5. Tag `v1.0.0` after the soak, with the verified commit and artifact hash.

The runtime surface is in good shape: 8,244 app tests, a 2,113-test Gate suite,
a clean `expo-doctor`, a successful native release compile, and a 100/100/100
Lighthouse result on the exported web build. The remaining work is mostly the
store/ops gate and the P1 items above, not a rewrite.
