# PLAN BRIEF — Versutus Android home-screen widget (Kimi)

Date: 2026-09-12. This run delivers a **diagnosis plus an executable
implementation plan** — no code. Another agent will audit your plan hard
afterwards, so every claim needs evidence: file:line, command output, package
version, APK contents, or a cited URL.

## The operator's report

Ethan (the operator) installed the Android build from this worktree
(`android/app/build/outputs/apk/release/app-release.apk`, built 2026-09-12
08:46) on his Samsung phone (One UI Home). He says: *"widget now appears as an
option to place on my home, but its completely clear and does nothing."* His
direction: diagnose it, then **fix and improve it drastically**.

Screenshot: `docs/plans/.phone-widget-2026-09-12.jpg`. The widget is placed on
the home screen in edit mode, launcher label "Versutus", spanning the screen
width. Its body is **fully transparent**. The only content is the literal text
**`VersutusStatus`**, small and dark, centred and unreadable against the
wallpaper. Tapping it does nothing.

## Facts already on the record — verify them, do not trust them

- **The version swing.** `f4bf7f0` bumped `expo-widgets` to `58.0.0` for its
  Android runtime. `8a83907` (08:50, four minutes *after* the APK was built)
  pinned it back to `57.0.19`: 58.0.0's Kotlin does not compile against SDK
  57's `expo-modules-core` (`ConverterContext`, `getMaterialColorTokens`,
  `Record` visibility). Its message claims 57.0.19 *"ships real Android widget
  support (ExpoWidgetsAppWidgetProvider.kt, a working AppWidget provider)"*.
- **The contradicting finding.** `docs/plans/2026-09-11-android-widget.md`
  ("Fourth finding") says the opposite: in `expo-widgets` 57.0.18 and 57.0.19
  the Android runtime is a stub. `ExpoWidgetsGlanceWidget.kt` renders
  `Text(widgetName)` — the literal `VersutusStatus`. `WidgetsModule.kt`
  registers only a name. On Android the JS side resolves to a no-op
  `build/ExpoWidgets.js`, so snapshot writes go nowhere.
- **What is installed today.** `node_modules/expo-widgets` is `57.0.19`, with
  Android sources `ExpoWidgetsAppWidgetProvider.kt`,
  `ExpoWidgetsGlanceWidget.kt` and `WidgetsModule.kt`. `@expo/ui` is `57.0.10`.
- **SDK 58.** Per `8a83907`, Expo SDK 58 has no stable release. A migration
  spike lives read-only at
  `C:\Users\ethan\.codex\worktrees\sdk58-spike\Versutus`.

The screenshot matches the stub signature exactly. Confirm or refute this from
the installed Kotlin sources **and** from what is compiled into the APK.

## Where everything is

- **Your cwd:** `C:\Users\ethan\.codex\worktrees\bee6\Versutus`, branch
  `sprint/features-functions-ui`, HEAD `8a83907`.
- **Widget code:**
  - `src/lib/widget/snapshot.ts` — the glanceable snapshot fold.
  - `src/lib/widget/widget-target.ts` — `glanceableWidgetLines`, `WIDGET_NAME`.
  - `src/lib/widget/widget-device.ts` — the lazy platform seam.
  - `src/components/widget/glanceable-widget.tsx` — iOS SwiftUI.
  - `src/components/widget/glanceable-widget.android.tsx` — Compose via
    `@expo/ui/jetpack-compose`.
  - `src/components/widget/run-live-activity.tsx` — iOS Live Activity.
  - The snapshot writers in `src/context/gateway-provider.tsx` (grep
    `WidgetSnapshot`), the `expo-widgets` plugin entry in `app.json`, and the
    tests `__tests__/widget-snapshot-test.ts` and
    `__tests__/widget-target-test.ts`.
- **Generated native project** (git-ignored, produced by prebuild):
  `android/`. Read-only: the manifest receiver, `res/xml` widget info,
  `res/layout`, the generated provider class, and build intermediates under
  `android/app/build/`.
- **History:** `docs/plans/2026-09-11-android-widget.md`,
  `docs/plans/EXEC-BRIEF-android-widget.md`, `docs/plans/.exec-widget.log`,
  `FUTURE-ITEMS.md` §4, and commits `40b0b29`, `f077844`, `42fcc4b`,
  `f4bf7f0` and `8a83907`.
- **Infrastructure you can build on:**
  - The Gate's push-notification relay (`f4bf7f0`: `gate/core/push*`, and the
    app-side push registration — find it).
  - Run / approval / routine / connection state held in `gateway-provider.tsx`.
  - Deep links via `expo-linking` (see commit `c0207f2`'s compose links and
    the share-intent work).
  - Local Expo modules under `modules/` (see `modules/handsfree-voice` for
    the pattern: Kotlin + Swift + TS contract, autolinked).
- **Expo docs rule** (`AGENTS.md`): read the exact versioned docs at
  https://docs.expo.dev/versions/v57.0.0/ — and the v58 docs if you propose
  moving.
- **Parallel work.** Another agent is planning enterprise hands-free voice in
  this worktree (its file: `docs/plans/2026-09-12-realtime-voice-grok-draft.md`).
  **It owns the "start a voice call" entry-point contract.** Your widget
  should offer a Start voice call action. Reference the call as a dependency
  using a clearly marked placeholder such as
  `versutus://voice/call?bot=<id>`, and flag it for reconciliation. Do not
  design the voice feature.

## Phase 1 — Diagnose, with evidence

- **(a) Transparent, name-only, never updates.** Prove what actually renders
  on Android:
  - The Kotlin of the installed version.
  - What is compiled into the APK. Unzip it into `%TEMP%` and inspect the dex
    or class names with whatever tools exist on this machine (e.g.
    `apkanalyzer`, `aapt2`, `dexdump`, or string search).
  - Whether `glanceable-widget.android.tsx` is ever evaluated at all.
  - Whether a JS snapshot write reaches native storage on Android.
  - Whether any update path exists: APPWIDGET_UPDATE handling,
    `updatePeriodMillis`, WorkManager, `GlanceAppWidget.update` calls.
- **(b) Tap does nothing.** Is there any click action, PendingIntent or deep
  link?
- **(c) Transparency.** The background, theming and `initialLayout` in play.
- **(d) The verification gap.** Assess `8a83907`'s claim. Was it ever verified
  on a device? Why did `npm run verify` and `assembleRelease` passing say
  nothing about whether the widget renders?
- **(e) Samsung One UI.** What matters there: cell sizing, corner radius,
  transparency handling, update throttling, battery optimisation.

Rank the root causes. Mark anything that needs the phone as **UNVERIFIED** and
give the exact check (`adb shell dumpsys appwidget`, logcat tags, what to tap).

## Phase 2 — Design a drastically better widget

No restrictions. Design widgets an operator keeps on the home screen because
they are useful:

- **Content and actions.**
  - Gateway connection and health at a glance.
  - Runs in flight and approvals waiting, with one-tap **Approve / Deny**.
    Design the safety model: biometric or app-lock confirmation, never a
    blind approve from the lock screen.
  - The last reply preview.
  - Bot quick-launch that opens a chat with that Bot.
  - **Start voice call** (via the voice contract above).
  - Scheduled-job status.
- **Sizes.** A family: 1x1 status/launch, 2x2, 4x2, and a resizable 4x4 list.
- **Look.** Material You dynamic colour, light/dark, readable on any
  wallpaper (a real background and contrast), responsive layouts, and
  rounded corners that match the launcher.
- **Setup.** A configuration activity to pick the gateway and Bot, plus
  per-widget instances.
- **Freshness.** Update when the app is foregrounded, when the app is **not
  running** (FCM data message through the Gate push relay → widget update;
  WorkManager with constraints), and on a tap to refresh. State the battery
  budget. Stale-data honesty: an "as of" stamp, a disconnected state, never a
  confident stale number.
- **Safety and access.** Lock-screen privacy (what a glance may reveal) and
  TalkBack accessibility.
- **iOS.** Parity notes (the iOS widget and Live Activity already exist) and
  what happens to them under your choice.

Evaluate the implementation options honestly, with evidence of **native
compile compatibility on SDK 57** — that is exactly what broke last time:

- **(A)** Migrate to SDK 58 and `expo-widgets` 58 (when? what is at risk?).
- **(B)** `expo-widgets` 58 on SDK 57 (proven not to compile — is any patch
  route sane?).
- **(C)** Native Jetpack Glance widgets in a local Expo module under
  `modules/`, fed by a JS→native snapshot store (DataStore or
  SharedPreferences) through the module, with Glance composables in Kotlin —
  full control of layout, colour, actions and updates.
- **(D)** Third-party libraries such as `react-native-android-widget`. Check
  current maintenance and compatibility with RN 0.86 and the New
  Architecture.

Recommend one, with a fallback.

## Phase 3 — The implementation plan

Task by task. For each task: exact files to create/modify, the change, tests
(Jest for the TS fold/contract; Kotlin unit tests; Glance/Robolectric or
screenshot tests where feasible), config/prebuild verification greps, and
acceptance criteria. Then:

- **Phase 0:** the fastest path to a widget that renders real data on an
  opaque, readable background and opens the app on tap.
- **Milestones** for the drastic improvements, each shippable on its own.
- **A device checklist** for Samsung One UI and Pixel, including a native
  build step — `npm run verify` does not compile Kotlin.
- **Also:** rollout, risks, and **open decisions for Ethan** with your
  recommendation.

Repo conventions:

- `npm run verify` is the gate.
- Frame work as FEATURE / FIX / OPT by user-visible outcome.
- Commit messages state how the world now behaves.
- Testable logic goes in `src/lib`.

## Hard rules for this run — violations get reverted

1. **Plan only.** The ONLY file you may create or modify is
   `docs/plans/2026-09-12-android-widget-kimi-draft.md`. Create it within your
   first few minutes with a skeleton of the sections above, keep filling it as
   you go, and leave it complete when you finish.
2. **No other file changes**, in this worktree or anywhere else. Temporary
   extraction directories under `%TEMP%` are fine.
   - Git: no commands that change state (add, commit, checkout, switch,
     reset, restore, stash, clean, branch, worktree, merge, rebase, push,
     pull, fetch). Read-only git (log, show, diff, grep, blame, ls-files) is
     fine.
   - No `npm install` / `npx expo install`, no `expo prebuild`, no Gradle,
     no EAS, and do not run the test suite.
   - If you need package sources that are not in `node_modules` (e.g.
     `expo-widgets@58`), use `npm view` or `npm pack` into a directory under
     `%TEMP%`, never into this worktree.
3. **Live systems are off-limits.** Do not start, stop or restart the Versutus
   Gate, Hermes or any service. Do not call the operator's live gateway. No
   `adb` against devices.
4. **Do not touch** `docs/plans/2026-09-12-realtime-voice-grok-draft.md`.
5. **When you are done**, print exactly one final line:
   `PLAN COMPLETE: docs/plans/2026-09-12-android-widget-kimi-draft.md`
