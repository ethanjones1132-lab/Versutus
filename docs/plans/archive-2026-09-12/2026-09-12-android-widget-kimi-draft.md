# Android home-screen widget - Kimi draft (PARTIAL: Kimi quota exhausted)

> Kimi Code (`kimi-code/k3-256k`) ran 2026-09-12 21:42-21:50 in read-only prompt mode against
> `PLAN-BRIEF-android-widget-kimi.md` and stopped with `403 You have reached your 5-hour usage limit`
> before writing a plan. Two of its four read-only investigations completed and are preserved
> verbatim below; the other two were cut off by the same quota error. The finished, audited plan
> that builds on them is `docs/plans/2026-09-12-android-widget-plan.md`.

## Kimi orchestration note



Tool calls issued: Read

## Kimi orchestration note

I'll read the brief (done), then fan out read-only investigations. Launching parallel exploration of the widget code, the installed `expo-widgets` native sources, the generated `android/` project, and the history docs, while I inspect the screenshot and research the ecosystem.

Tool calls issued: Agent, Agent, Agent, Agent, ReadMediaFile

## Kimi subagent report

agent_id: agent-0
actual_subagent_type: explore
status: completed

[summary]
# Widget codebase report — Versutus (branch `sprint/features-functions-ui`)

## Package versions (package.json)

- `"expo": "~57.0.7"` — package.json:13
- `"@expo/ui": "~57.0.10"` — package.json:8
- `"expo-widgets": "57.0.19"` — package.json:37 (pinned, exact version; commit `8a83907` reverted a bump to `58.0.0` because its Kotlin did not compile against SDK 57's expo-modules-core)

Note: the installed `node_modules/expo-widgets` depends on its own nested `@expo/ui` (package-lock.json:8143 shows `node_modules/expo-widgets/node_modules/@expo/ui`).

---

## 1. `src/lib/widget/snapshot.ts` — the glanceable snapshot fold (132 lines)

Pure fold, no gateway call, no storage. Three honesty rules (header comment, lines 7–12): `writtenAt` is always present so a frozen snapshot can say when it was written; the result line is always a fact the device recorded (a run's own summary or the gateway's own cron verdict), never composed here; an empty read produces no result line rather than "0 runs".

Key contents:

- `IN_FLIGHT_RUN_STATUSES` (lines 28–31): `Set(['running', 'waiting-approval'])` — deliberately NOT `isTerminalRunStatus`, because that regex reads gateway status strings and answers false for `unresolved`.
- `GlanceableSnapshot` (lines 39–50):
  ```ts
  export type GlanceableSnapshot = {
    status: ConnectionStatus;
    runsInFlight: number;
    approvalsPending: number;
    lastResult?: string;
    writtenAt: number;
  };
  ```
- `GlanceableFacts` (lines 53–57): `{ status, runs: readonly ActivityRun[], routines: readonly CronJob[] }`.
- `runResult(run)` (lines 65–70): prefers `run.summary?.trim()`, falls back to the newest event `preview`.
- `routineVerdict(job)` (lines 79–85): uses `describeCronHealth(job)`; returns null for tone `'off'` or `'unknown'`, or when `lastRunAt` doesn't parse; otherwise `{ at, text: health.label }`.
- `glanceableSnapshot(facts, now = Date.now())` (lines 96–132): loops runs — in-flight ones bump `runsInFlight` (and `approvalsPending` when `waiting-approval`); terminal ones (`isTerminalRunStatus`) contribute `lastResult` candidates keyed on `finishedAt ?? startedAt`. Then loops routines and lets a newer verdict win. Returns the snapshot with `lastResult` spread in only when present, and `writtenAt: now`. There is no serialization here — the object is handed to the widget as-is (plain JSON-shaped record).

## 2. `src/lib/widget/widget-target.ts` — name and lines (110 lines)

Deliberately free of `expo-widgets` / `@expo/ui` / react-native imports (the widget extension bundle stubs those out — expo-widgets/metro.config.js).

- `WIDGET_NAME` (line 28): `export const WIDGET_NAME = 'VersutusStatus';` — must agree with the `name` in the app.json plugin entry and the name handed to `createWidget`.
- `STATUS_WORDS` (lines 37–43): a hand-copy of the table in `connection-badge.tsx:18-24` (copied because that module imports reanimated):
  ```ts
  const STATUS_WORDS: Record<ConnectionStatus, string> = {
    connected: 'Connected',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    pairing: 'Needs approval',
    disconnected: 'Disconnected',
  };
  ```
- `NO_WORK = 'No runs in flight'` (line 46); `NO_STAMP = 'Written at an unreadable time'` (line 49).
- `GlanceableWidgetLines` (lines 56–65): `{ status: string; work: string; result?: string; written: string }`.
- `writtenLine(at, now)` (lines 76–79): `` `Written ${formatDayDivider(at, now)} ${formatClockTime(at)}` ``, or `NO_STAMP` for non-finite.
- `glanceableWidgetLines(snapshot, now = Date.now())` (lines 90–109): approvals first — `stillGoing = runsInFlight - approvalsPending`; pushes `"N run(s) waiting on your approval"` then `"N run(s) in flight"`, joined with ` · `, else `NO_WORK`. `result` is spread in only when `snapshot.lastResult` exists. `status` comes from `STATUS_WORDS`.

## 3. `src/lib/widget/widget-device.ts` — the lazy platform seam (82 lines, full key contents)

Header rationale (lines 5–22): importing the component module constructs the widget immediately — `createWidget` returns `new Widget(name, layout)` whose constructor reaches the native side (`requireNativeModule('ExpoWidgets')` on iOS), which THROWS where the native module is absent (Expo Go, older builds). So the import is lazy, first-call only; a failed load answers null, never a rejection. "iOS and Android carry a widget target, and every other platform is answered null before anything is imported. The plugin's Android half is opt-in (expo-widgets/plugin/build/withWidgets.js:11) and this repo's entry enables it… Metro's platform resolution picks `glanceable-widget.android.tsx` where the iOS file would otherwise be bundled."

```ts
// lines 24-26
import { Platform } from 'react-native';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

// line 32
export type WidgetTarget = typeof import('@/components/widget/glanceable-widget');

// lines 42-51
export async function loadWidgetTarget(
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
): Promise<WidgetTarget | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

// lines 72-82
export async function writeWidgetSnapshot(
  snapshot: GlanceableSnapshot,
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
): Promise<void> {
  const target = await loadWidgetTarget(load);
  try {
    target?.default.updateSnapshot(snapshot);
  } catch {
    // The widget keeps the snapshot it already holds.
  }
}
```

On Android specifically: the platform gate passes (line 45), Metro resolves the dynamic import to `glanceable-widget.android.tsx`, and `target.default.updateSnapshot(snapshot)` is called — per the comment (lines 57–60) that is the `Widget` instance method from `expo-widgets/build/Widgets.js:28-29`, which creates one timeline entry stamped `Date.now()`. A throwing write is swallowed (lines 77–81). There is no error reporting anywhere on this path — a no-op native side is indistinguishable from success.

## 4. The widget components

### `src/components/widget/glanceable-widget.tsx` (iOS, 55 lines)

Imports (lines 17–22): `Text, VStack` from `@expo/ui/swift-ui`; `font, foregroundStyle, lineLimit` from `@expo/ui/swift-ui/modifiers`; `createWidget, type WidgetEnvironment` from `expo-widgets`; the snapshot type and `glanceableWidgetLines, WIDGET_NAME`.

`STAMP_STYLE = { type: 'hierarchical', style: 'secondary' } as const` (line 25). Body (lines 35–53):

```tsx
const GlanceableWidget = (props: GlanceableSnapshot, environment: WidgetEnvironment) => {
  'widget';

  const lines = glanceableWidgetLines(props);
  const hasRoomForResult = environment.widgetFamily !== 'systemSmall';

  return (
    <VStack alignment="leading" spacing={4}>
      <Text modifiers={[font({ weight: 'semibold', size: 15 }), lineLimit(1)]}>{lines.status}</Text>
      <Text modifiers={[font({ size: 13 }), lineLimit(1)]}>{lines.work}</Text>
      {lines.result && hasRoomForResult ? (
        <Text modifiers={[font({ size: 13 }), lineLimit(2)]}>{lines.result}</Text>
      ) : null}
      <Text modifiers={[font({ size: 11 }), foregroundStyle(STAMP_STYLE), lineLimit(1)]}>
        {lines.written}
      </Text>
    </VStack>
  );
};

export default createWidget(WIDGET_NAME, GlanceableWidget);
```

No tap handling anywhere — no deep link, no button, no URL.

### `src/components/widget/glanceable-widget.android.tsx` (Compose, 61 lines)

Imports (lines 23–27): `Column, Text` from `@expo/ui/jetpack-compose`; `createWidget` from `expo-widgets`; snapshot type and `glanceableWidgetLines, WIDGET_NAME`. Header (lines 18–21) states colours are the system's own — nothing hands a `color` to a `Text`; stamp de-emphasized by size alone. Body (lines 36–59):

```tsx
const GlanceableWidget = (props: GlanceableSnapshot) => {
  'widget';

  const lines = glanceableWidgetLines(props);

  return (
    <Column horizontalAlignment="start">
      <Text style={{ fontSize: 15, fontWeight: '600' }} maxLines={1}>
        {lines.status}
      </Text>
      <Text style={{ fontSize: 13 }} maxLines={1}>
        {lines.work}
      </Text>
      {lines.result ? (
        <Text style={{ fontSize: 13 }} maxLines={2}>
          {lines.result}
        </Text>
      ) : null}
      <Text style={{ fontSize: 11 }} maxLines={1}>
        {lines.written}
      </Text>
    </Column>
  );
};

export default createWidget(WIDGET_NAME, GlanceableWidget);
```

No environment/family gate on Android; no container styling (no background, no padding) — the `Column` is bare, which matters for the "fully transparent" symptom: nothing in this component paints a background, so transparency depends entirely on the native host's default container. And no tap/click handling.

## 5. `src/components/widget/run-live-activity.tsx` (79 lines, brief)

iOS-only Live Activity target (no `.android.tsx` sibling). Imports `createLiveActivity` from `expo-widgets` (line 19) and `RUN_ACTIVITY_NAME, RunActivityProps` from `@/lib/notifications/run-activity`. The body (lines 45–77) returns an object with `banner` (VStack: status / elapsed / step / updated stamp), `compactTrailing` (elapsed only), and `expandedBottom` (step + stamp). Registered via `export default createLiveActivity(RUN_ACTIVITY_NAME, RunLiveActivity)` (line 79). Same `'widget'` directive and stubbed-bundle discipline.

## 6. `src/context/gateway-provider.tsx` — the snapshot write path

Imports (lines 186–187):

```ts
import { glanceableSnapshot } from '@/lib/widget/snapshot';
import { writeWidgetSnapshot } from '@/lib/widget/widget-device';
```

The write effect (lines 3448–3462) — doc comment then effect:

```ts
  /**
   * Item 4a's fold, handed to item 4b's seam. The snapshot is composed here
   * from the facts above and written once per change to one of them: a start, an
   * approval wait, a decision, a settle and the disconnect settle each move
   * `activityRuns`, `routineJobs` or `status`, and each is the write's own
   * trigger — there is no poller of ours, and nothing here reads back. The
   * approval count is not a fourth input because item 4a folds it from the run
   * rows, which this effect already watches. A device with no widget target
   * writes nothing at all.
   */
  useEffect(() => {
    void writeWidgetSnapshot(
      glanceableSnapshot({ status, runs: activityRuns, routines: routineJobs }),
    );
  }, [activityRuns, routineJobs, status]);
```

Facts feeding it: `status` (state, line 687), `activityRuns` (state, line 830, patched via `patchActivityRuns` which also persists), `routineJobs` (populated by the cron-list effect at lines 3435–3446: `if (status !== 'connected' || !cron.available) return; … if (live) setRoutineJobs(jobs)`). No platform API is called in the provider — everything goes through the `writeWidgetSnapshot` seam, which is the only widget touchpoint (the test pins that the provider never imports `expo-widgets` or calls `updateSnapshot` directly).

## 7. `app.json` — the expo-widgets plugin entry (lines 74–96)

```json
[
  "expo-widgets",
  {
    "bundleIdentifier": "com.versutus.app.widgets",
    "groupIdentifier": "group.com.versutus.app",
    "enableAndroid": true,
    "widgets": [
      {
        "name": "VersutusStatus",
        "displayName": "Status",
        "description": "What Versutus last knew: its connection, the runs in flight and the newest result, stamped with when it wrote them.",
        "supportedFamilies": ["systemSmall", "systemMedium"],
        "android": {
          "minWidth": 180,
          "minHeight": 110,
          "targetCellWidth": 4,
          "targetCellHeight": 2,
          "resizeMode": "horizontal"
        }
      }
    ]
  }
]
```

It's the 8th plugin entry, inserted before `expo-share-intent` (which must stay last per the share-intent test). No `enablePushNotifications`. Note: `"supportedFamilies"` is iOS vocabulary; the Android sizing comes from the `android` block. There is no app-level `ios.bundleIdentifier` in app.json (the `ios` block at lines 10–16 has only icon + infoPlist), which is why the widget entry carries its own `bundleIdentifier`/`groupIdentifier`.

## 8. Tests

### `__tests__/widget-snapshot-test.ts` (214 lines)

12 cases against `glanceableSnapshot`: in-flight counting (`running` + `waiting-approval` → 2 in flight, 1 pending); settled runs (`complete`/`failed`/`cancelled`) never in flight; `unresolved` runs are over and contribute no result; newest judged run's summary wins; event-preview fallback when no summary; in-flight runs never contribute a result; cron verdict label used when no judged run (`'Failing — 2 in a row'`); paused/never-run routines produce no result; newest routine verdict wins (`'Ran, delivery failed'`); across runs+routines the newest wins; empty read yields exactly `{ status, runsInFlight: 0, approvalsPending: 0, writtenAt }` with no `lastResult`; `writtenAt` is the handed `now`.

### `__tests__/widget-target-test.ts` (426 lines)

- app.json entry (lines 82–150): exactly one `expo-widgets` entry naming exactly `[WIDGET_NAME]`; `bundleIdentifier`/`groupIdentifier` pinned (with the note that `withIosWidgets` no-ops without one, lines 98–108); displayName/families pinned; `enableAndroid === true` and the exact `android` dimensions pinned (lines 118–134, citing `withWidgets.js:11` that enableAndroid defaults false); plugin ordering — expo-widgets before expo-share-intent, share-intent last (136–149).
- iOS component source pins (152–184): contains `'widget';` and `createWidget(WIDGET_NAME,` with no literal name; takes `GlanceableSnapshot`, no gateway client/fetch; imports nothing from `react`/`react-native`/`react-native-reanimated` and never imports `widget-device`; the seam source contains `import('@/components/widget/glanceable-widget')`.
- Android component source pins (189–218): same directive/factory pins; uses `glanceableWidgetLines` and `@expo/ui/jetpack-compose`; must not match `react-native` or `@expo/ui/swift-ui`; must not contain `foregroundStyle(` or any hex color — "leaves colour to the system" (lines 210–217).
- `loadWidgetTarget` (220–251): returns target when loadable; null on load throw; null on `web` without calling load; hands the widget back on Android (gate opened at `Platform.OS` check).
- `writeWidgetSnapshot` (253–311): calls `updateSnapshot(snap)` once; load failure resolves undefined and writes nothing; web writes nothing without importing; Android writes through; a throwing `updateSnapshot` is swallowed.
- Provider source pins (316–367): the write effect regex-matches `void writeWidgetSnapshot(glanceableSnapshot({ status, runs: activityRuns, routines: routineJobs }))` with deps `[activityRuns, routineJobs, status]` and no `setInterval|setTimeout`; provider never imports `expo-widgets`, never references `updateSnapshot`, never imports from `@/components/widget/`; cron read effect and `patchActivityRuns` persistence pinned.
- `glanceableWidgetLines` (369–425): status words pinned against `connection-badge.tsx` source for all five statuses; approval-first work lines ('2 runs waiting on your approval', '1 run waiting on your approval · 2 runs in flight', '1 run in flight'); empty work → 'No runs in flight'; result passthrough/absence; stamp naming ('Written Yesterday …' / 'Written Today …'); NaN stamp → 'Written at an unreadable time'.

## 9. All other references to `expo-widgets` / `WidgetSnapshot` / `updateWidgetSnapshot` / `reloadTimelines` / `setSnapshot`

In `src/` (the only code references — no `updateWidgetSnapshot`, `reloadTimelines`, or `setSnapshot` exist anywhere in `src/`):

- `src/lib/widget/widget-target.ts:4,6,34` — comments only (no import).
- `src/lib/widget/widget-device.ts:6,18,58` — comments only; the real touchpoint is `target?.default.updateSnapshot(snapshot)` at line 78.
- `src/context/gateway-provider.tsx:187` — imports `writeWidgetSnapshot`; `:3459` — the write call. (Grep confirms no other widget references in the file.)
- `src/components/widget/run-live-activity.tsx:10,11,19` — comment + `import { createLiveActivity } from 'expo-widgets'`.
- `src/components/widget/glanceable-widget.tsx:10,11,19` — comment + `import { createWidget, type WidgetEnvironment } from 'expo-widgets'`.
- `src/components/widget/glanceable-widget.android.tsx:11,12,24` — comment + `import { createWidget } from 'expo-widgets'`.
- `src/lib/notifications/run-activity-device.ts:7` (comment), `:22` — `import type { LiveActivity } from 'expo-widgets'` (type-only).

Tests: `__tests__/widget-target-test.ts` (extensively, listed above) and `__tests__/run-live-activity-test.ts:8,363-364,382,443` (source-discipline pins).

Config/docs: `app.json:75`, `package.json:37`, `package-lock.json:45,8128-8384`, `FUTURE-ITEMS.md:418,450,458`, plus the plan docs under `docs/plans/` (`2026-09-11-android-widget.md`, `PLAN-BRIEF-android-widget-kimi.md`, and the `.exec-widget.log`/`.plan-widget-kimi.log` records).

## Diagnosis-relevant observations

- Nothing in either widget component paints a background or handles taps. On Android the `Column` from `@expo/ui/jetpack-compose` has no container styling; whether the widget body is opaque depends entirely on the native host (`ExpoWidgetsAppWidgetProvider` / Glance scaffold in expo-widgets 57.0.19).
- The literal text "VersutusStatus" on the widget is the strong signal that the Compose layout never rendered: `WIDGET_NAME` appears in the code only as the registration name and in the app.json entry — it is never drawn as a line. A placeholder/fallback native view rendering the widget's registered name is the likely source, meaning the JS widget bundle either was never built into the APK or failed to load/execute natively.
- The entire write path (`writeWidgetSnapshot`) swallows every failure silently (widget-device.ts:77–81), so a missing/broken native side produces no log, no error, and no visible difference app-side.
- Version context from the repo's own records: `expo-widgets@58.0.0` was tried (commit `f4bf7f0`) and reverted to `57.0.19` (commit `8a83907`) because 58's Kotlin fails against SDK 57's expo-modules-core; `docs/plans/2026-09-11-android-widget.md` claims 57.0.18/57.0.19 lack a real Android runtime and that it only shipped in 58.0.0 — directly contradicting the revert commit message. That contradiction is the crux to resolve before rewriting.

## Kimi subagent report

agent_id: agent-2
actual_subagent_type: explore
status: completed

[summary]
# Investigation report: VersutusStatus Android widget

## Bottom line up front

The three symptoms (transparent background, literal "VersutusStatus" text, dead tap) are all explained by one fact: **the published `expo-widgets@57.0.19` Android native side is a stub**. Its Glance widget renders `Text(widgetName)` — literally the widget's name — and its JS-facing native module on Android is a no-op shim. The generated project itself is wired correctly; the library never renders your `GlanceableWidget` component or the snapshot timeline on Android.

## 1. Manifest receiver — `android/app/src/main/AndroidManifest.xml:52-59`

```xml
<receiver android:name=".VersutusStatusProvider" android:exported="true" android:label="@string/versutus_status_display_name">
  <intent-filter>
    <action android:name="android.appwidget.action.APPWIDGET_UPDATE"/>
    <action android:name="expo.modules.widgets.ACTION_WIDGET_INTERACTION"/>
  </intent-filter>
  <meta-data android:name="android.appwidget.provider" android:resource="@xml/versutus_status_info"/>
  <meta-data android:name="expo.modules.widgets.NAME" android:value="VersutusStatus"/>
</receiver>
```

The merged release manifest (`android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml:158-173`) carries the identical receiver, so it made it into the built APK. Glance infrastructure is also merged in correctly: `ActionTrampolineActivity`, `InvisibleActionTrampolineActivity`, `ActionCallbackBroadcastReceiver`, `UnmanagedSessionReceiver`, `MyPackageReplacedReceiver`, `GlanceRemoteViewsService` (lines 326-361).

## 2. AppWidget-provider XML — `android/app/src/main/res/xml/versutus_status_info.xml` (only file in `res/xml/`)

```xml
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="180dp"
  android:minHeight="110dp"
  android:targetCellWidth="4"
  android:targetCellHeight="2"
  android:updatePeriodMillis="0"
  android:initialLayout="@layout/glance_default_loading_layout"
  android:description="@string/versutus_status_description"
  android:resizeMode="horizontal"
  android:widgetCategory="home_screen" />
```

Matches the `app.json:80-93` plugin entry (`minWidth: 180, minHeight: 110, targetCell 4x2, resizeMode: "horizontal"`). No `previewImage`/`previewLayout` — that's why the widget picker preview is blank, and the default Glance loading layout is visually empty/transparent until `provideGlance` runs.

## 3. Layouts — none in the app

`android/app/src/main/res/layout/` **does not exist**. `initialLayout` points at `@layout/glance_default_loading_layout`, which is supplied by the `androidx.glance:glance-appwidget` AAR (expo-widgets has no `android/src/main/res/` either — Glob returned nothing). This is normal for Glance; the transparency is because Glance's `provideContent` here draws only one `Text` with no background modifier (see §4).

## 4. Provider class — generated stub in the app, real logic in the library

- `android/app/src/main/java/com/versutus/app/VersutusStatusProvider.kt` (entire file):

```kotlin
package com.versutus.app
import expo.modules.widgets.ExpoWidgetsAppWidgetProvider
class VersutusStatusProvider : ExpoWidgetsAppWidgetProvider("VersutusStatus")
```

- The superclass comes from the expo-widgets module (autolinked, not an AAR): `node_modules/expo-widgets/android/src/main/java/expo/modules/widgets/ExpoWidgetsAppWidgetProvider.kt`:

```kotlin
open class ExpoWidgetsAppWidgetProvider(private val widgetName: String) : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = ExpoWidgetsGlanceWidget(widgetName)
}
```

- And `ExpoWidgetsGlanceWidget.kt` — **the whole rendering implementation**:

```kotlin
internal class ExpoWidgetsGlanceWidget(private val widgetName: String) : GlanceAppWidget() {
  override suspend fun provideGlance(context: Context, id: GlanceId) {
    provideContent {
      Text(widgetName)   // ← renders the literal string "VersutusStatus"
    }
  }
}
```

- `WidgetsModule.kt` is empty beyond `Name("ExpoWidgets")` — no `Widget`, `updateTimeline`, listeners, or interaction handling on Android.
- On the JS side, `node_modules/expo-widgets/build/ExpoWidgets.js` (the non-iOS resolution; there's a separate `ExpoWidgets.ios.js`) is a pure stub: `WidgetStub.reload(){}`, `updateTimeline(){}`, `addListener` returns a noop subscription. So `createWidget(...)` in `src/components/widget/glanceable-widget.android.tsx:61` and any `updateSnapshot`/`reload` calls are no-ops on Android, and `addUserInteractionListener` never fires — hence "tap does nothing."

## 5. Build config

- `android/app/build.gradle`: `namespace 'com.versutus.app'`, `applicationId 'com.versutus.app'`, `compileSdk rootProject.ext.compileSdkVersion`, `targetSdkVersion rootProject.ext.targetSdkVersion` (values come from the Expo Gradle plugin; build intermediates show `targetSdkVersion="36.0"`). No explicit `expo-widgets` or glance dependency in the app module — it arrives via `expoAutolinking.useExpoModules()` in `android/settings.gradle:32`.
- `node_modules/expo-widgets/android/build.gradle` (lines 29-38):

```groovy
buildFeatures { prefab true; compose true }
dependencies {
  api 'androidx.glance:glance:1.2.0-rc01'
  api 'androidx.glance:glance-appwidget:1.2.0-rc01'
}
```

- `android/gradle.properties`: `newArchEnabled=true`, `hermesEnabled=true`; no widget-related flags.

## 6. Build artifacts

- `android/app/build/outputs/apk/release/app-release.apk` **exists** (exact path confirmed via Glob; size unavailable without shell, per instructions).
- Merged manifest found at `android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml` — receiver present, quoted above. Also present: `packaged_manifests/release/...` and `merged_manifest/release/processReleaseMainManifest/...` copies.
- The expo-widgets module itself was compiled (`node_modules/expo-widgets/android/build/intermediates/...` exists), so the stub provider really is what's shipping in the APK.

## 7. Widget resources — `android/app/src/main/res/values/expo_widgets.xml`

```xml
<resources>
  <string name="versutus_status_display_name">Status</string>
  <string name="versutus_status_description">What Versutus last knew: its connection, the runs in flight and the newest result, stamped with when it wrote them.</string>
</resources>
```

No widget-specific colors exist (`values/colors.xml` has only `splashscreen_background`, `iconBackground`, `colorPrimary`). The widget component deliberately sets no colors (`glanceable-widget.android.tsx:18-21`), but that's moot — the component is never rendered on Android.

## Implication

Nothing in the generated project is misconfigured. The JS widget code (`glanceable-widget.android.tsx`) and timeline plumbing are iOS-only in effect: on Android, expo-widgets 57.0.19 neither bundles/runs the widget JS nor exposes any native update path. Fixing the widget requires either a newer expo-widgets release with a real Android implementation (check upstream — recent commit `8a83907` pinned to this version for SDK-57 compatibility), or bypassing the library with a hand-written Glance provider reading shared state.
