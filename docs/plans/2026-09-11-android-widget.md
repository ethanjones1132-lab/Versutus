# Android home-screen widget — implementation plan

2026-09-11 · branch `sprint/features-functions-ui` · FUTURE-ITEMS.md §4 /
"Android home-screen widget — APPROACH APPROVED (Recommendation A)".

Approved approach, restated: a sibling platform view
`glanceable-widget.android.tsx` against `@expo/ui/jetpack-compose`, reusing the
pure `glanceableWidgetLines` fold unchanged, plus the two config fixes. This
plan adds one enabling step the FUTURE-ITEMS diagnosis predates: an
`expo-widgets` version bump, because the installed Android runtime cannot
render anything (evidence below).

## Ground truth established while planning (read before touching anything)

The three stacked root causes from FUTURE-ITEMS are settled: `enableAndroid`
defaults false (`expo-widgets/plugin/build/withWidgets.js:11`), the widget
entry has no `android` block, and the existing view is SwiftUI. Verified again
against `app.json` and the plugin sources — all three stand.

**Fourth finding, new: the installed runtime is a stub.** In
`expo-widgets@57.0.18` (and in `57.0.19`, published 2026-09-11 — checked the
published tarball), the entire Android runtime is three files:
`ExpoWidgetsGlanceWidget.kt` renders `Text(widgetName)` — literally the string
"VersutusStatus", never the React view; `WidgetsModule.kt` registers only
`Name("ExpoWidgets")`; and on Android the JS side resolves to
`build/ExpoWidgets.js`, a no-op stub, so `updateSnapshot` writes go nowhere.
The v57 docs describe the library as iOS-only. Config + sibling view alone
would put the widget in the picker but leave it showing its own name forever.

**The real Android runtime shipped in `expo-widgets@58.0.0`** (published
2026-09-10, one day before this plan): `WidgetsJSRuntime.kt` (Hermes
evaluation of the bundled widget view), `WidgetObject.kt`,
`WidgetsStorage.kt`, `WidgetsUpdater.kt`, JNI runtime, a real
`build/ExpoWidgets.native.js` binding (`requireNativeModule('ExpoWidgets')`),
and `android/src/main/res/layout/expo_widgets_initial_layout.xml`. Its
`peerDependencies` are `expo: *`, so it installs against this repo's SDK 57
(`expo ~57.0.7`). Its config plugin is schema-compatible: same `enableAndroid`
flag, same `android` block fields (`minWidth`, `minHeight`, `targetCellWidth`,
`targetCellHeight`, `resizeMode`, plus a new optional `initialLayout` we do
not need), same generated provider/receiver/resource naming.

**One known risk, with a planned fallback (step 8).** `expo-widgets@58.0.0`
depends on `@expo/ui ~58.0.0`, which npm nests under `expo-widgets`; the app
keeps `@expo/ui ~57.0.10` at the root, and the widget view's
`@expo/ui/jetpack-compose` import resolves to the 57 copy (Metro resolves from
the importing file). If the layout tree @expo/ui 57 emits is not what the 58
runtime interprets, the widget renders blank — the fallback is bumping the
root `@expo/ui` to `~58.0.0`, which is contained: every app import of
`@expo/ui` is in an `.ios.tsx` file or a widget target (verified by grep), so
Android app UI cannot be affected.

## Steps

### 1. Bump `expo-widgets` to 58 — `package.json`

Change `"expo-widgets": "~57.0.18"` to `"expo-widgets": "~58.0.0"`, run
`npm install`.

Verify: `npm ls expo-widgets` prints `58.0.0`;
`ls node_modules/expo-widgets/android/src/main/java/expo/modules/widgets/`
now lists `WidgetsJSRuntime.kt`, `WidgetObject.kt`, `WidgetsStorage.kt`,
`WidgetsUpdater.kt`; `node_modules/expo-widgets/build/ExpoWidgets.native.js`
contains `requireNativeModule('ExpoWidgets')`. The repo keeps `@expo/ui
~57.0.10` at the root (`npm ls @expo/ui` shows it, with the 58 copy nested
under `expo-widgets`).

### 2. Widget config — `app.json`

In the `expo-widgets` plugin entry (currently `app.json:66-80`):

- Add `"enableAndroid": true` to the plugin props.
- Add to the `VersutusStatus` widget entry:

```json
"android": {
  "minWidth": 180,
  "minHeight": 110,
  "targetCellWidth": 4,
  "targetCellHeight": 2,
  "resizeMode": "horizontal"
}
```

Rationale: 4x2 is the `systemMedium` equivalent — the iOS medium family is the
one that has room for all four lines the fold emits, and the approved text
says to mirror that rule rather than invent an Android-specific content rule.
`horizontal` resize lets the work line ("2 runs waiting on your approval · 2
runs in flight") breathe; vertical resize is off so the stamp line cannot be
squashed out. The values are written explicitly, not left to the plugin
defaults (which happen to be the same numbers), so the Jest pin in step 5
catches a silent upstream default change.

Verify: `npm run verify:config`; the Jest pins from step 5.

### 3. The sibling view — `src/components/widget/glanceable-widget.android.tsx` (new)

Mirror `glanceable-widget.tsx`'s structure and header comment (item 4 of
FUTURE-ITEMS §4, the seam rules, the stubbed-bundle import discipline).
Imports: `Column`, `Text` from `@expo/ui/jetpack-compose`; `createWidget` from
`expo-widgets`; `GlanceableSnapshot` from `@/lib/widget/snapshot`;
`glanceableWidgetLines`, `WIDGET_NAME` from `@/lib/widget/widget-target`.
Nothing from `react`, `react-native`, or `react-native-reanimated` (the widget
bundle stubs them), and no `@expo/ui/swift-ui` import.

Body: `(props: GlanceableSnapshot)` with the `'widget';` directive;
`const lines = glanceableWidgetLines(props);` then a
`<Column horizontalAlignment="start">` of four `Text`s:

- `lines.status` — `fontSize={15} fontWeight="600" maxLines={1}`
- `lines.work` — `fontSize={13} maxLines={1}`
- `lines.result` — rendered only when the fold emits it,
  `fontSize={13} maxLines={2}` (no environment gate: `widgetFamily` is iOS
  vocabulary, and the 4x2 cell target from step 2 is exactly the family that
  has room)
- `lines.written` — `fontSize={11} maxLines={1}`

**No `color` prop anywhere.** The constraint is system foreground styling, not
app-palette hex; omitting `color` leaves the system/Glance theme foreground in
place, and the stamp line is de-emphasized by size alone. Close with
`export default createWidget(WIDGET_NAME, GlanceableWidget);` — the shared
name, never a literal.

Verify: `tsc --noEmit` (the file is typechecked via the tsconfig glob;
`expo/tsconfig.base` sets no `moduleSuffixes`, so the seam's base-path import
still types against the iOS file — both must export the same
`createWidget(...)` default shape, which they do); the source pins from
step 5.

### 4. Open the seam to Android — `src/lib/widget/widget-device.ts`

One logic change: in `loadWidgetTarget` (line 42),
`if (Platform.OS !== 'ios') return null;` becomes
`if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;`.

Everything else stays: the lazy `import('@/components/widget/glanceable-widget')`
specifier is unchanged — Metro platform resolution selects
`glanceable-widget.android.tsx` on Android. The seam discipline is intact: no
static import, the first snapshot write is the only caller, a load that throws
is answered `null`. (Under 58 the Android import no longer throws where the
native side exists; where it doesn't — an old build — it still throws and is
still swallowed.)

Rewrite the stale header claim (lines 16-19: "no build name but iOS has a
widget target for this to hand back") to state the new rule: iOS and Android
carry a target, every other platform is answered `null` before anything is
imported. This is the comment sweep the change is owed.

Verify: the updated seam tests from step 5.

### 5. Tests — `__tests__/widget-target-test.ts`

Extend, don't relax. Concretely:

- Extend `WidgetEntryProps` (line 37) with `enableAndroid?: boolean` and an
  `android?: { minWidth: number; minHeight: number; targetCellWidth: number;
  targetCellHeight: number; resizeMode: string }` on the widget type. Add a
  test pinning `props.enableAndroid === true` and
  `widget.android` `toEqual` the exact block from step 2.
- The two tests that use `jest.replaceProperty(Platform, 'OS', 'android')` to
  pin the no-target answer (lines 169-175 and 203-212) now pin the wrong
  platform: switch them to `'web'` and keep every other assertion. Add one new
  test: on `Platform.OS === 'android'` the seam DOES call `load` and hands the
  loaded target back / writes through — the proof the gate opened.
- A new `describe` for the sibling, pinning as source the way the iOS
  component is pinned: `glanceable-widget.android.tsx` contains `'widget';`,
  `createWidget(WIDGET_NAME,`, `glanceableWidgetLines`, and
  `@expo/ui/jetpack-compose`; and does NOT match `react-native`,
  `@expo/ui/swift-ui`, `foregroundStyle(`, or a hex color literal — the
  system-foreground rule made testable.

The existing fold tests are untouched — the fold is unchanged.

Verify: `npx jest __tests__/widget-target-test.ts` green.

### 6. Repo gate — `npm run verify`

Full run: `verify:config`, `tsc --noEmit`, lint, Jest with the coverage
ratchet, gate tests. The coverage ratchet counts only `src/lib/gateway/**`,
which this change never touches; no new Jest-covered module is added (the new
view is pinned as source, the established pattern for widget code). Verify:
the command exits 0.

### 7. Regenerate the native project — `npx expo prebuild --platform android`

The repo commits `android/`, so prebuild re-runs against it. The receiver,
resources, and provider class are generated — nothing is hand-written or
hand-edited.

Verify all four artifacts exist and say the right thing:

- `grep -c "APPWIDGET_UPDATE" android/app/src/main/AndroidManifest.xml` is at
  least 1, and the manifest carries a receiver `.VersutusStatusProvider` with
  meta-data `expo.modules.widgets.NAME` = `VersutusStatus` and
  `android.appwidget.provider` → `@xml/versutus_status_info`.
- `android/app/src/main/res/xml/versutus_status_info.xml` exists and contains
  `minWidth="180dp"`, `targetCellWidth="4"`, `resizeMode="horizontal"`,
  `initialLayout="@layout/expo_widgets_initial_layout"`.
- `android/app/src/main/res/values/expo_widgets.xml` contains
  `versutus_status_display_name` ("Status") and
  `versutus_status_description`.
- `android/app/src/main/java/com/versutus/app/VersutusStatusProvider.kt`
  exists: `class VersutusStatusProvider : ExpoWidgetsAppWidgetProvider("VersutusStatus")`.

### 8. Build and verify on a device

`cd android && ./gradlew assembleDebug` (debug for iteration speed; the
FUTURE-ITEMS-verified `assembleRelease` at ~13 min is the final gate).
Install on a device or emulator, then:

1. The picker: long-press the home screen → widgets → "Status" (description
   from step 2) is listed. This is the FUTURE-ITEMS problem statement itself.
2. Place it: it renders the fold's lines — status word, work line, stamp —
   not the raw text "VersutusStatus" (the stub signature) and not blank.
3. Update: open the app so the provider's `writeWidgetSnapshot` effect fires
   (it is driven by `[activityRuns, routineJobs, status]`), then change run
   state; the widget's lines and stamp move.
4. Blank-or-broken fallback: if (2) shows blank or a render error, the
   suspected cause is the @expo/ui 57-emits / 58-interprets skew from the
   planning notes. Bump the root `@expo/ui` to `~58.0.0`, rebuild, retest —
   then smoke the iOS widget and the `.ios.tsx` `@expo/ui` surfaces on an iOS
   build before calling the bump good, since `text-field-ios.ts` pins
   SDK-57 behavior in its comments.

### 9. Close the loop — `FUTURE-ITEMS.md`

Once the device checklist passes, update item 4: drop the "ANDROID HALF
OUTSTANDING" marker and record the shipped evidence (the sibling view path
and the expo-widgets 58 bump), matching the document's own ledger convention.

## Final verification

- `npm run verify` exits 0 (config check, tsc, lint, Jest + coverage ratchet,
  gate tests).
- `git diff --stat` shows exactly: `package.json`, `package-lock.json`,
  `app.json`, `src/lib/widget/widget-device.ts`,
  `__tests__/widget-target-test.ts`, the new
  `src/components/widget/glanceable-widget.android.tsx`, regenerated `android/`
  output, and `FUTURE-ITEMS.md`. No other source file moves.
- The step-7 artifact greps all pass against the regenerated `android/`.
- Device checklist from step 8: picker listing, correct content, live update.
- Seam invariants re-confirmed: `glanceable-widget.tsx` is byte-identical
  (iOS unchanged); nothing imports either view statically
  (`grep -rn "components/widget/glanceable-widget" src` shows only the lazy
  imports inside `widget-device.ts`); web still returns `null` before any
  import (the `'web'` pins from step 5).
