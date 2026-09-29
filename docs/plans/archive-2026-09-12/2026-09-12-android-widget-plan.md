# Versutus Android Home-Screen Widget — Audited Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In one to two days, ship an Android widget that sits on an opaque, readable card on any wallpaper, shows what Versutus last knew, says honestly when that was, and opens the app when tapped (Phase 0). Then grow it into a widget family with Bot quick-launch, approval and voice entry points, and freshness while the app is closed (Milestones 1–4).

**Architecture:** Replace `expo-widgets`' Android stub with a local Expo module, `modules/versutus-widget`, that implements a Jetpack Glance widget in Kotlin.
- **JS side:** keeps owning the content rules. It still folds `glanceableSnapshot` and `glanceableWidgetLines`, then hands the module a small versioned JSON payload.
- **Native side:** the module stores the payload in app-private `SharedPreferences` and calls `updateAll`. The Glance widget renders it with `GlanceTheme`, responsive sizes and deep-link click actions through the existing `versutus://` router.
- **iOS:** keeps `expo-widgets` exactly as it is.

**Tech Stack:** Expo SDK 57 / React Native 0.86.2, Expo Modules API (Kotlin), `androidx.glance:glance-appwidget:1.2.0` and `androidx.glance:glance-material3:1.2.0` (stable, released 2026-08-26), the Kotlin Compose compiler plugin wired the way `node_modules/expo-widgets/android/build.gradle:1-13` wires it, JUnit 4 with `org.json:json` for JVM tests, Jest.

**Where this sits:** branch `sprint/features-functions-ui` (worktree `C:\Users\ethan\.codex\worktrees\bee6\Versutus`, HEAD `8a83907`), the build on Ethan's phone.

**Provenance:** Kimi Code (`kimi-code/k3-256k`) was dispatched with `docs/plans/PLAN-BRIEF-android-widget-kimi.md`. It finished two read-only investigations, then stopped on `403 You've reached your 5-hour usage limit` before designing or planning. Its findings are preserved verbatim in `docs/plans/2026-09-12-android-widget-kimi-draft.md`. Claude verified them against the installed sources and the built APK, then wrote the design and plan below.

---

## 0. Diagnosis (verified)

| # | Finding | Evidence |
|---|---|---|
| D1 | **Nothing but the name is ever drawn.** The installed Android runtime is a stub: its Glance widget renders the literal widget name, `VersutusStatus`, which is exactly what is on the phone. | `node_modules/expo-widgets/android/src/main/java/expo/modules/widgets/ExpoWidgetsGlanceWidget.kt:12-16` `provideContent { Text(widgetName) }`; `WidgetsModule.kt:6-9` registers only `Name("ExpoWidgets")` |
| D2 | **Snapshot writes on Android go nowhere.** The JS side there is a no-op stub; `expo-widgets@57.0.19` ships no `.android.js` or `.native.js` build, and the seam swallows every failure. | `node_modules/expo-widgets/build/ExpoWidgets.js:2-10` (`WidgetStub.updateTimeline(_entries) { }`); `src/lib/widget/widget-device.ts:72-82` |
| D3 | **The card is transparent.** The stub paints no background, and the provider info uses Glance's default loading layout with no preview. | `android/app/src/main/res/xml/versutus_status_info.xml:2-10` (`initialLayout="@layout/glance_default_loading_layout"`, `updatePeriodMillis="0"`, no `previewLayout`) |
| D4 | **Tapping does nothing.** No click action exists on either side. | D1's stub; `src/components/widget/glanceable-widget.android.tsx:36-59` has none |
| D5 | **`8a83907` shipped green and wrong.** Its message says `57.0.19` "ships real Android widget support". It compiled only because the stub is trivial. `npm run verify` never compiles Kotlin, and no device check ran. | commit `8a83907` message; `docs/plans/2026-09-11-android-widget.md` "Fourth finding" had already recorded the stub |
| D6 | **The generated project is wired correctly.** Receiver, provider class and the release merged manifest all carry the widget. The fault is the runtime, not the config. | `android/app/src/main/AndroidManifest.xml:52-59`; `android/app/src/main/java/com/versutus/app/VersutusStatusProvider.kt:5`; Kimi report agent-2 §1 |

**Audit of Kimi's partial draft.**
- **Accurate:** both completed investigations match the source line for line.
- **Superseded:** agent-0 suggests the widget JS bundle "was never built into the APK or failed to load". D1–D2 replace that: on Android there is no runtime to load it into at all.
- **Missing (cut off by quota):** the design, the option comparison, and the plan. They are supplied here.

---

## 1. Decision

| Option | Verdict | Why |
|---|---|---|
| A. Move to SDK 58 with `expo-widgets@58` | Not now | SDK 58 has no stable release (`8a83907` records only canaries and `58.0.0-preview.0`). It would move the whole app onto a preview SDK to fix one widget. Revisit when SDK 58 is stable: one library for both platforms is attractive then. |
| B. `expo-widgets@58` on SDK 57 | Rejected | Proven not to compile: its Kotlin references `ConverterContext`, `getMaterialColorTokens` and changed `Record` visibility (`8a83907`). A patched fork of a vendored native module is a maintenance trap. |
| C. Native Glance widget in a local Expo module | **Recommended** | Full control of layout, theme, actions and updates. It compiles against the Glance and Compose toolchain the current build already compiles: `expo-widgets@57.0.19` pulls `glance-appwidget:1.2.0-rc01` and the Compose plugin (`node_modules/expo-widgets/android/build.gradle:1-38`), and `assembleRelease` succeeds with it. Content rules stay in the tested JS fold. Follows the repo's own local-module pattern (`modules/handsfree-voice`). |
| D. `react-native-android-widget` | Rejected | Re-renders React Native views headlessly for every update. It adds a second JS-render path whose compatibility with RN 0.86 and the New Architecture is unproven here, while C reaches the same result with less risk. |

**Fallback:** if Glance 1.2.0 fails to resolve or compile in Task 0.1, pin the module to `1.2.0-rc01`, the exact version already compiling in this build via `expo-widgets`.

**Product rules the design keeps (non-negotiable):**
- **Honest staleness.** Every render states when the data was true (`writtenAt`), using the same words the app uses (`src/lib/widget/widget-target.ts:76-79`). A disconnected or never-written widget says so.
- **No blind approvals.** Only the live app process can apply a decision to a run it drives (`src/lib/notifications/approval-action.ts:42-66`, ADR 0001). A widget approval opens the app on the Chat tab, where `ApprovalSheet` is already shown for the pending run (`src/components/chat/chat-screen.tsx:2122-2128`). The widget never approves by itself.
- **No microphone from a link.** A "Start voice call" button uses the signed launch contract in the voice plan (`docs/plans/2026-09-12-realtime-voice-plan.md` §4.4). An unsigned `versutus://call` link always stops at the in-app confirmation.
- **Private by default where it matters.** A privacy toggle hides the result text; counts and the stamp stay visible (Milestone 2).

---

## 2. File structure

**Create — module `modules/versutus-widget/`:**
- `expo-module.config.json` — Android-only module registration.
- `index.ts` — barrel.
- `src/VersutusWidgetModule.ts` — `requireNativeModule('VersutusWidget')`.
- `src/VersutusWidget.types.ts` — the payload contract.
- `android/build.gradle` — library, Expo module plugin, Compose plugin, Glance, test dependencies.
- `android/src/main/AndroidManifest.xml` — the widget receiver.
- `android/src/main/res/xml/versutus_status_widget_info.xml` — sizes, preview, resize.
- `android/src/main/res/layout/versutus_status_widget_preview.xml` — static picker preview.
- `android/src/main/res/values/strings.xml` — name and description.
- `android/src/main/java/com/versutus/widget/WidgetPayload.kt` — pure parse and validation.
- `android/src/main/java/com/versutus/widget/WidgetStamp.kt` — pure "Written Today 14:03" formatting.
- `android/src/main/java/com/versutus/widget/WidgetPayloadStore.kt` — `SharedPreferences` read/write.
- `android/src/main/java/com/versutus/widget/VersutusStatusWidget.kt` — the `GlanceAppWidget`.
- `android/src/main/java/com/versutus/widget/VersutusStatusReceiver.kt` — the `GlanceAppWidgetReceiver`.
- `android/src/main/java/com/versutus/widget/VersutusWidgetModule.kt` — `setPayload` / `clearPayload`.
- `android/src/test/java/com/versutus/widget/WidgetPayloadTest.kt` and `android/src/test/java/com/versutus/widget/WidgetStampTest.kt`.

**Create — app:**
- `src/lib/widget/android-widget-payload.ts` — pure payload builder.
- `__tests__/android-widget-payload-test.ts`.

**Modify:**
- `src/lib/widget/widget-device.ts` — Android writes through the new module; iOS path unchanged.
- `app.json` — `expo-widgets` gets `"enableAndroid": false` and loses the Android block.
- `package.json` — `expo.autolinking.android.exclude: ["expo-widgets"]`, the Android-only exclude documented at [Expo autolinking](https://docs.expo.dev/modules/autolinking/).
- `__tests__/widget-target-test.ts` — the pins that asserted the stub path.

**Delete:**
- `src/components/widget/glanceable-widget.android.tsx` — it can never render, because nothing on Android evaluates it.

---

## 3. Phase 0 — a readable, live, tappable widget

Rules for every Phase 0 task:
- Run `npm run verify` before each commit; it must exit 0.
- `npm run verify` compiles no Kotlin, so every native task also runs its Gradle command.
- `android/` is generated by prebuild and git-ignored. Nothing is hand-edited there; Task 0.5 regenerates it.

### Task 0.1: The widget module exists, builds, and registers a receiver

**Files:**
- Create: `modules/versutus-widget/expo-module.config.json`
- Create: `modules/versutus-widget/index.ts`
- Create: `modules/versutus-widget/src/VersutusWidget.types.ts`
- Create: `modules/versutus-widget/src/VersutusWidgetModule.ts`
- Create: `modules/versutus-widget/android/build.gradle`
- Create: `modules/versutus-widget/android/src/main/AndroidManifest.xml`
- Create: `modules/versutus-widget/android/src/main/res/xml/versutus_status_widget_info.xml`
- Create: `modules/versutus-widget/android/src/main/res/layout/versutus_status_widget_preview.xml`
- Create: `modules/versutus-widget/android/src/main/res/values/strings.xml`
- Test: `__tests__/versutus-widget-module-contract-test.ts`

- [ ] **Step 1: Write the failing contract test.** Create `__tests__/versutus-widget-module-contract-test.ts`:

```ts
declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
};

function path(...parts: string[]): string {
  return [__dirname, '..', ...parts].join(SEP);
}

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync(path(...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('the Android widget module', () => {
  test('registers an Android-only Expo module named VersutusWidget', () => {
    const config = JSON.parse(readSource('modules', 'versutus-widget', 'expo-module.config.json'));
    expect(config.platforms).toEqual(['android']);
    expect(config.android.modules).toEqual(['com.versutus.widget.VersutusWidgetModule']);
    expect(readSource('modules', 'versutus-widget', 'src', 'VersutusWidgetModule.ts')).toContain(
      "requireNativeModule<VersutusWidgetNativeModule>('VersutusWidget')",
    );
  });

  test('declares a non-exported-by-default Glance receiver with its provider info', () => {
    const manifest = readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'AndroidManifest.xml');
    expect(manifest).toContain('android:name="com.versutus.widget.VersutusStatusReceiver"');
    expect(manifest).toContain('android.appwidget.action.APPWIDGET_UPDATE');
    expect(manifest).toContain('android:resource="@xml/versutus_status_widget_info"');
  });

  test('the provider info paints a preview and resizes both ways', () => {
    const info = readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'res', 'xml', 'versutus_status_widget_info.xml');
    expect(info).toContain('android:previewLayout="@layout/versutus_status_widget_preview"');
    expect(info).toContain('android:resizeMode="horizontal|vertical"');
    expect(info).toContain('android:targetCellWidth="4"');
  });

  test('uses the stable Glance release the plan pins', () => {
    const gradle = readSource('modules', 'versutus-widget', 'android', 'build.gradle');
    expect(gradle).toContain("androidx.glance:glance-appwidget:1.2.0'");
    expect(gradle).toContain("androidx.glance:glance-material3:1.2.0'");
    expect(gradle).toContain("apply plugin: 'org.jetbrains.kotlin.plugin.compose'");
  });
});
```

- [ ] **Step 2: Run to confirm it fails.**
Run: `npx jest __tests__/versutus-widget-module-contract-test.ts`
Expected: FAIL with `ENOENT` for `expo-module.config.json`.

- [ ] **Step 3: Create the JS contract files.** `modules/versutus-widget/expo-module.config.json`:

```json
{
  "platforms": ["android"],
  "android": {
    "modules": ["com.versutus.widget.VersutusWidgetModule"]
  }
}
```

`modules/versutus-widget/src/VersutusWidget.types.ts`:

```ts
/**
 * What the Android widget renders, folded in JS by `androidWidgetPayload` from
 * the same snapshot and lines the iOS widget uses. Versioned so a native side
 * that meets a newer shape draws its "update Versutus" state instead of garbage.
 */
export type VersutusWidgetPayload = {
  v: 1;
  /** The connection word the app shows, e.g. "Connected". */
  status: string;
  /** Whether that word means connected — drives the status dot colour. */
  connected: boolean;
  /** Approvals first, then runs in flight, e.g. "1 run waiting on your approval". */
  work: string;
  /** Present only when a judged outcome exists. */
  result?: string;
  /** How many runs wait on the operator; > 0 shows the approval call to action. */
  approvalsPending: number;
  /** Epoch milliseconds the snapshot was true at. The widget formats the stamp itself. */
  writtenAt: number;
};
```

`modules/versutus-widget/src/VersutusWidgetModule.ts`:

```ts
import { NativeModule, requireNativeModule } from 'expo';

import type { VersutusWidgetPayload } from './VersutusWidget.types';

export declare class VersutusWidgetNativeModule extends NativeModule {
  /** Store the payload and redraw every placed widget. Answers false if the JSON was refused. */
  setPayload(json: string): Promise<boolean>;
  /** Forget the payload (e.g. the gateway was removed) and redraw the empty state. */
  clearPayload(): Promise<void>;
}

export type { VersutusWidgetPayload };

export default requireNativeModule<VersutusWidgetNativeModule>('VersutusWidget');
```

`modules/versutus-widget/index.ts`:

```ts
export { default } from './src/VersutusWidgetModule';
export * from './src/VersutusWidget.types';
```

- [ ] **Step 4: Create the Gradle build.** `modules/versutus-widget/android/build.gradle` mirrors `node_modules/expo-widgets/android/build.gradle:1-33`, which already compiles in this project:

```groovy
buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath("org.jetbrains.kotlin.plugin.compose:org.jetbrains.kotlin.plugin.compose.gradle.plugin:${kotlinVersion}")
  }
}

apply plugin: 'com.android.library'
apply plugin: 'expo-module-gradle-plugin'
apply plugin: 'org.jetbrains.kotlin.plugin.compose'

group = 'com.versutus.widget'
version = '0.1.0'

android {
  namespace "com.versutus.widget"
  defaultConfig {
    versionCode 1
    versionName "0.1.0"
  }
  buildFeatures {
    compose true
  }
  lintOptions {
    abortOnError false
  }
}

dependencies {
  implementation 'androidx.glance:glance-appwidget:1.2.0'
  implementation 'androidx.glance:glance-material3:1.2.0'
  testImplementation 'junit:junit:4.13.2'
  testImplementation 'org.json:json:20240303'
}
```

- [ ] **Step 5: Create the manifest and resources.** `modules/versutus-widget/android/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <!-- Exported because the launcher host must deliver APPWIDGET_UPDATE; the
         receiver only redraws from the app's own private store. -->
    <receiver
      android:name="com.versutus.widget.VersutusStatusReceiver"
      android:exported="true"
      android:label="@string/versutus_widget_name">
      <intent-filter>
        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
      </intent-filter>
      <meta-data
        android:name="android.appwidget.provider"
        android:resource="@xml/versutus_status_widget_info" />
    </receiver>
  </application>
</manifest>
```

`modules/versutus-widget/android/src/main/res/xml/versutus_status_widget_info.xml`:

```xml
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="110dp"
  android:minHeight="110dp"
  android:minResizeWidth="110dp"
  android:minResizeHeight="50dp"
  android:targetCellWidth="4"
  android:targetCellHeight="2"
  android:resizeMode="horizontal|vertical"
  android:updatePeriodMillis="0"
  android:initialLayout="@layout/glance_default_loading_layout"
  android:previewLayout="@layout/versutus_status_widget_preview"
  android:description="@string/versutus_widget_description"
  android:widgetCategory="home_screen" />
```

`modules/versutus-widget/android/src/main/res/layout/versutus_status_widget_preview.xml` (a static, opaque picture of the widget for the picker):

```xml
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:layout_width="match_parent"
  android:layout_height="match_parent"
  android:background="@android:drawable/dialog_holo_dark_frame"
  android:orientation="vertical"
  android:padding="16dp">
  <TextView
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:text="@string/versutus_widget_preview_status"
    android:textColor="@android:color/white"
    android:textSize="15sp"
    android:textStyle="bold" />
  <TextView
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:text="@string/versutus_widget_preview_work"
    android:textColor="@android:color/white"
    android:textSize="13sp" />
</LinearLayout>
```

`modules/versutus-widget/android/src/main/res/values/strings.xml`:

```xml
<resources>
  <string name="versutus_widget_name">Versutus Status</string>
  <string name="versutus_widget_description">Your gateway connection, runs waiting on you, and the newest result — with when Versutus last knew it.</string>
  <string name="versutus_widget_preview_status">Connected</string>
  <string name="versutus_widget_preview_work">1 run waiting on your approval</string>
</resources>
```

- [ ] **Step 6: Run the contract test.**
Run: `npx jest __tests__/versutus-widget-module-contract-test.ts`
Expected: PASS. The Kotlin classes named in the manifest arrive in Tasks 0.2–0.3; Gradle is not run until they exist.

- [ ] **Step 7: Commit.**

```bash
git add modules/versutus-widget __tests__/versutus-widget-module-contract-test.ts
git commit -m "feat(widget): an Android widget module with an opaque picker preview is registered beside the app"
```

### Task 0.2: The widget reads its payload strictly and stamps it honestly (pure Kotlin, JVM-tested)

**Files:**
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetPayload.kt`
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetStamp.kt`
- Test: `modules/versutus-widget/android/src/test/java/com/versutus/widget/WidgetPayloadTest.kt`
- Test: `modules/versutus-widget/android/src/test/java/com/versutus/widget/WidgetStampTest.kt`

- [ ] **Step 1: Write the failing tests.** `WidgetPayloadTest.kt`:

```kotlin
package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetPayloadTest {
  @Test fun `a well-formed v1 payload parses`() {
    val parsed = WidgetPayload.parse(
      """{"v":1,"status":"Connected","connected":true,"work":"1 run in flight","result":"Deployed","approvalsPending":0,"writtenAt":1757700000000}""",
    )
    assertEquals(WidgetPayload.Parsed.Ok(WidgetPayload("Connected", true, "1 run in flight", "Deployed", 0, 1757700000000L)), parsed)
  }

  @Test fun `an absent result stays absent, never an empty line`() {
    val parsed = WidgetPayload.parse(
      """{"v":1,"status":"Disconnected","connected":false,"work":"No runs in flight","approvalsPending":0,"writtenAt":1}""",
    ) as WidgetPayload.Parsed.Ok
    assertNull(parsed.payload.result)
  }

  @Test fun `a newer version asks for an app update instead of guessing`() {
    assertEquals(WidgetPayload.Parsed.NeedsUpdate, WidgetPayload.parse("""{"v":2,"anything":true}"""))
  }

  @Test fun `junk, missing fields and a non-finite stamp are refused`() {
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("not json"))
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":1,"status":"Connected"}"""))
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":1,"status":"C","connected":true,"work":"w","approvalsPending":-1,"writtenAt":5}"""))
  }
}
```

`WidgetStampTest.kt` mirrors `writtenLine` in `src/lib/widget/widget-target.ts:76-79` and `formatDayDivider` in `src/lib/format.ts:45-58`:

```kotlin
package com.versutus.widget

import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetStampTest {
  private val zone = ZoneId.of("America/New_York")
  private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int) =
    LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

  @Test fun `same day reads Today with the clock time`() {
    assertEquals("Written Today 14:03", WidgetStamp.line(at(2026, 9, 12, 14, 3), at(2026, 9, 12, 21, 0), zone, Locale.UK))
  }

  @Test fun `the previous calendar day reads Yesterday`() {
    assertEquals("Written Yesterday 23:59", WidgetStamp.line(at(2026, 9, 11, 23, 59), at(2026, 9, 12, 0, 5), zone, Locale.UK))
  }

  @Test fun `within the week reads the weekday, older reads the date`() {
    assertEquals("Written Wednesday 09:00", WidgetStamp.line(at(2026, 9, 9, 9, 0), at(2026, 9, 12, 9, 0), zone, Locale.UK))
    assertEquals("Written 1 Sept 09:00", WidgetStamp.line(at(2026, 9, 1, 9, 0), at(2026, 9, 12, 9, 0), zone, Locale.UK))
  }

  @Test fun `an unreadable stamp says so`() {
    assertEquals("Written at an unreadable time", WidgetStamp.line(Long.MIN_VALUE, 0L, zone, Locale.UK))
  }
}
```

- [ ] **Step 2: Run to confirm they fail.**
Run: `cd android; .\gradlew :versutus-widget:testDebugUnitTest`
Expected: FAIL. `WidgetPayload` and `WidgetStamp` are unresolved.

- [ ] **Step 3: Implement.** `WidgetPayload.kt`:

```kotlin
package com.versutus.widget

import org.json.JSONObject

/** The v1 payload the JS side writes; see VersutusWidget.types.ts. */
data class WidgetPayload(
  val status: String,
  val connected: Boolean,
  val work: String,
  val result: String?,
  val approvalsPending: Int,
  val writtenAt: Long,
) {
  sealed interface Parsed {
    data class Ok(val payload: WidgetPayload) : Parsed
    data object NeedsUpdate : Parsed
    data object Invalid : Parsed
  }

  companion object {
    fun parse(json: String?): Parsed {
      if (json.isNullOrBlank()) return Parsed.Invalid
      return try {
        val o = JSONObject(json)
        when (o.optInt("v", -1)) {
          1 -> Unit
          -1 -> return Parsed.Invalid
          else -> return Parsed.NeedsUpdate
        }
        val status = o.optString("status", "")
        val work = o.optString("work", "")
        val approvals = o.optInt("approvalsPending", -1)
        val writtenAt = o.optLong("writtenAt", Long.MIN_VALUE)
        if (status.isBlank() || work.isBlank() || approvals < 0 || writtenAt <= 0 || !o.has("connected")) {
          return Parsed.Invalid
        }
        val result = o.optString("result", "").takeIf { it.isNotBlank() }
        Parsed.Ok(WidgetPayload(status, o.getBoolean("connected"), work, result, approvals, writtenAt))
      } catch (_: Exception) {
        Parsed.Invalid
      }
    }
  }
}
```

`WidgetStamp.kt`:

```kotlin
package com.versutus.widget

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** "Written <day> <time>", the same words the app's widget-target fold uses. */
object WidgetStamp {
  private const val UNREADABLE = "Written at an unreadable time"

  fun line(writtenAt: Long, now: Long, zone: ZoneId, locale: Locale): String {
    if (writtenAt <= 0) return UNREADABLE
    val written = Instant.ofEpochMilli(writtenAt).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(written.toLocalDate(), today)
    val day = when {
      days <= 0 -> "Today"
      days == 1L -> "Yesterday"
      days < 7 -> written.dayOfWeek.getDisplayName(TextStyle.FULL, locale)
      written.year != Instant.ofEpochMilli(now).atZone(zone).year ->
        written.format(DateTimeFormatter.ofPattern("d MMM yyyy", locale))
      else -> written.format(DateTimeFormatter.ofPattern("d MMM", locale))
    }
    val time = written.format(DateTimeFormatter.ofPattern("HH:mm", locale))
    return "Written $day $time"
  }
}
```

The JS side formats with the device locale's short month (`toLocaleDateString`), so the exact month spelling may differ by locale. The Kotlin test pins `Locale.UK` for determinism; the rule under test is the day-bucket logic, not the spelling.

- [ ] **Step 4: Run to confirm they pass.**
Run: `cd android; .\gradlew :versutus-widget:testDebugUnitTest`
Expected: `BUILD SUCCESSFUL`, 8 tests passed.

Autolinking picks up `modules/versutus-widget` the same way it picks up `modules/handsfree-voice`. If Gradle reports `project ':versutus-widget' not found`, the generated `android/` predates the module: run Task 0.5 Step 1 (`npx expo prebuild --platform android --clean`) first, then rerun.

- [ ] **Step 5: Commit.**

```bash
git add modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetPayload.kt modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetStamp.kt modules/versutus-widget/android/src/test
git commit -m "feat(widget): the Android widget refuses a malformed payload and stamps when its data was true"
```

### Task 0.3: The widget draws an opaque, themed card from the stored payload and opens the app on tap

**Files:**
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetLayout.kt`
- Create: `modules/versutus-widget/android/src/test/java/com/versutus/widget/WidgetLayoutTest.kt`
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/WidgetPayloadStore.kt`
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/VersutusStatusWidget.kt`
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/VersutusStatusReceiver.kt`
- Create: `modules/versutus-widget/android/src/main/java/com/versutus/widget/VersutusWidgetModule.kt`
- Test: `__tests__/versutus-widget-module-contract-test.ts`

- [ ] **Step 1: Write the failing tests.** `WidgetLayoutTest.kt`:

```kotlin
package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetLayoutTest {
  @Test fun `a 2x2 square is the small layout`() {
    assertEquals(WidgetVariant.SMALL, WidgetLayout.variantFor(110f, 110f))
  }

  @Test fun `a wide short cell is the medium layout`() {
    assertEquals(WidgetVariant.MEDIUM, WidgetLayout.variantFor(250f, 110f))
  }

  @Test fun `a wide tall cell is the large layout`() {
    assertEquals(WidgetVariant.LARGE, WidgetLayout.variantFor(250f, 250f))
  }
}
```

Append to `__tests__/versutus-widget-module-contract-test.ts`:

```ts
describe('the Android widget renders and updates honestly', () => {
  const kotlin = (file: string) =>
    readSource('modules', 'versutus-widget', 'android', 'src', 'main', 'java', 'com', 'versutus', 'widget', file);

  test('the card paints a themed background with launcher corners and opens the app', () => {
    const widget = kotlin('VersutusStatusWidget.kt');
    expect(widget).toContain('.background(GlanceTheme.colors.widgetBackground)');
    expect(widget).toContain('.cornerRadius(android.R.dimen.system_app_widget_background_radius)');
    expect(widget).toContain('actionStartActivity(openAppIntent(context, "versutus://chat"))');
    expect(widget).toContain('SizeMode.Responsive(');
  });

  test('a payload is validated before it is stored, and every placed widget is redrawn', () => {
    const module = kotlin('VersutusWidgetModule.kt');
    expect(module).toContain('Name("VersutusWidget")');
    const parseAt = module.indexOf('WidgetPayload.parse(json)');
    const writeAt = module.indexOf('WidgetPayloadStore.write(context, json)');
    expect(parseAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(parseAt);
    expect(module).toContain('VersutusStatusWidget().updateAll(context)');
  });
});
```

- [ ] **Step 2: Run to confirm they fail.**
Run: `npx jest __tests__/versutus-widget-module-contract-test.ts`
Expected: FAIL (ENOENT on `VersutusStatusWidget.kt`).
Run: `cd android; .\gradlew :versutus-widget:testDebugUnitTest --tests "*WidgetLayoutTest*"`
Expected: FAIL (`WidgetLayout` unresolved).

- [ ] **Step 3: Implement the pure layout choice and the store.** `WidgetLayout.kt`:

```kotlin
package com.versutus.widget

enum class WidgetVariant { SMALL, MEDIUM, LARGE }

/** Which layout a placed widget's current size gets. Pure, JVM-tested. */
object WidgetLayout {
  fun variantFor(widthDp: Float, heightDp: Float): WidgetVariant = when {
    widthDp < 180f -> WidgetVariant.SMALL
    heightDp < 180f -> WidgetVariant.MEDIUM
    else -> WidgetVariant.LARGE
  }
}
```

`WidgetPayloadStore.kt`:

```kotlin
package com.versutus.widget

import android.content.Context

/** App-private storage for the last payload JS wrote. Nothing else reads it. */
internal object WidgetPayloadStore {
  private const val PREFS = "versutus_widget"
  private const val KEY = "payload_v1"

  fun write(context: Context, json: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
  }

  fun read(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
  }
}
```

- [ ] **Step 4: Implement the Glance widget and receiver.** `VersutusStatusWidget.kt`:

```kotlin
package com.versutus.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import java.time.ZoneId
import java.util.Locale

class VersutusStatusWidget : GlanceAppWidget() {
  override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM, LARGE))

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val parsed = WidgetPayload.parse(WidgetPayloadStore.read(context))
    provideContent {
      GlanceTheme {
        StatusCard(parsed)
      }
    }
  }

  companion object {
    val SMALL = DpSize(110.dp, 110.dp)
    val MEDIUM = DpSize(250.dp, 110.dp)
    val LARGE = DpSize(250.dp, 250.dp)
  }
}

@Composable
private fun StatusCard(parsed: WidgetPayload.Parsed) {
  val context = LocalContext.current
  val size = LocalSize.current
  val variant = WidgetLayout.variantFor(size.width.value, size.height.value)
  Column(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(GlanceTheme.colors.widgetBackground)
      .cornerRadius(android.R.dimen.system_app_widget_background_radius)
      .padding(14.dp)
      .clickable(actionStartActivity(openAppIntent(context, "versutus://chat"))),
  ) {
    when (parsed) {
      is WidgetPayload.Parsed.Ok -> Lines(parsed.payload, variant)
      WidgetPayload.Parsed.NeedsUpdate -> Line("Update Versutus to show status", bold = true)
      WidgetPayload.Parsed.Invalid -> {
        Line("Versutus", bold = true)
        Line("Open Versutus to connect")
      }
    }
  }
}

@Composable
private fun Lines(payload: WidgetPayload, variant: WidgetVariant) {
  val stamp = WidgetStamp.line(payload.writtenAt, System.currentTimeMillis(), ZoneId.systemDefault(), Locale.getDefault())
  Row(verticalAlignment = Alignment.CenterVertically) {
    Box(
      modifier = GlanceModifier
        .size(8.dp)
        .cornerRadius(4.dp)
        .background(if (payload.connected) GlanceTheme.colors.primary else GlanceTheme.colors.error),
    ) {}
    Spacer(GlanceModifier.width(6.dp))
    Line(payload.status, bold = true)
  }
  Spacer(GlanceModifier.height(4.dp))
  Line(payload.work)
  if (payload.approvalsPending > 0 && variant != WidgetVariant.SMALL) {
    Line("Tap to decide in Versutus", secondary = true)
  }
  if (variant != WidgetVariant.SMALL && payload.result != null) {
    Spacer(GlanceModifier.height(4.dp))
    Line(payload.result, maxLines = if (variant == WidgetVariant.LARGE) 4 else 2)
  }
  Spacer(GlanceModifier.height(6.dp))
  Line(stamp, secondary = true)
}

@Composable
private fun Line(text: String, bold: Boolean = false, secondary: Boolean = false, maxLines: Int = 1) {
  Text(
    text = text,
    maxLines = maxLines,
    style = TextStyle(
      color = if (secondary) GlanceTheme.colors.onSurfaceVariant else GlanceTheme.colors.onSurface,
      fontSize = if (bold) 15.sp else if (secondary) 11.sp else 13.sp,
      fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
    ),
  )
}

/** Every tap goes through the app's own `versutus://` router; nothing is decided here. */
internal fun openAppIntent(context: Context, uri: String): Intent =
  Intent(Intent.ACTION_VIEW, Uri.parse(uri))
    .setPackage(context.packageName)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
```

`VersutusStatusReceiver.kt`:

```kotlin
package com.versutus.widget

import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

class VersutusStatusReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = VersutusStatusWidget()
}
```

- [ ] **Step 5: Implement the native module.** `VersutusWidgetModule.kt`:

```kotlin
package com.versutus.widget

import androidx.glance.appwidget.updateAll
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class VersutusWidgetModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun definition() = ModuleDefinition {
    Name("VersutusWidget")

    // Refuse what the widget could not draw, so a bad write never replaces the
    // last good snapshot the widget is still honestly stamping.
    AsyncFunction("setPayload") { json: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (WidgetPayload.parse(json) !is WidgetPayload.Parsed.Ok) return@AsyncFunction false
      WidgetPayloadStore.write(context, json)
      scope.launch { VersutusStatusWidget().updateAll(context) }
      true
    }

    AsyncFunction("clearPayload") {
      val context = appContext.reactContext ?: return@AsyncFunction
      WidgetPayloadStore.clear(context)
      scope.launch { VersutusStatusWidget().updateAll(context) }
    }
  }
}
```

- [ ] **Step 6: Run the tests and compile.**
Run: `npx jest __tests__/versutus-widget-module-contract-test.ts`
Expected: PASS.
Run: `cd android; .\gradlew :versutus-widget:testDebugUnitTest :versutus-widget:compileReleaseKotlin`
Expected: `BUILD SUCCESSFUL`, 11 tests passed.

If the compile reports `Unresolved reference: kotlinx`, add this line to the module's `dependencies` and rerun:

```groovy
  implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:${rootProject.ext.has('kotlinCoroutinesVersion') ? rootProject.ext.kotlinCoroutinesVersion : '1.9.0'}"
```

If `glance-appwidget:1.2.0` fails to resolve or compile, change both Glance lines to `1.2.0-rc01` (the version already compiling via `expo-widgets`), and update the Task 0.1 pin to match.

- [ ] **Step 7: Commit.**

```bash
git add modules/versutus-widget __tests__/versutus-widget-module-contract-test.ts
git commit -m "feat(widget): the Android widget draws a readable themed card from the last snapshot and opens Versutus on tap"
```

### Task 0.4: The app writes Android widget snapshots through the new module, and expo-widgets stops shipping its Android stub

**Files:**
- Create: `src/lib/widget/android-widget-payload.ts`
- Create: `__tests__/android-widget-payload-test.ts`
- Modify: `src/lib/widget/widget-device.ts`
- Modify: `app.json` (`expo-widgets` entry `:74-96`)
- Modify: `package.json` (add the `expo.autolinking` block)
- Delete: `src/components/widget/glanceable-widget.android.tsx`
- Test: `__tests__/widget-target-test.ts`

- [ ] **Step 1: Write the failing payload tests.** `__tests__/android-widget-payload-test.ts`:

```ts
import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

const base: GlanceableSnapshot = {
  status: 'connected',
  runsInFlight: 3,
  approvalsPending: 1,
  lastResult: 'Deployed the fix',
  writtenAt: 1_757_700_000_000,
};

describe('androidWidgetPayload', () => {
  test('carries the same words the iOS widget draws, plus what the native card needs', () => {
    expect(androidWidgetPayload(base)).toEqual({
      v: 1,
      status: 'Connected',
      connected: true,
      work: '1 run waiting on your approval · 2 runs in flight',
      result: 'Deployed the fix',
      approvalsPending: 1,
      writtenAt: 1_757_700_000_000,
    });
  });

  test('an absent result stays absent', () => {
    const { lastResult: _omit, ...rest } = base;
    expect(androidWidgetPayload(rest)).not.toHaveProperty('result');
  });

  test('a disconnected snapshot is not drawn as connected', () => {
    const payload = androidWidgetPayload({ ...base, status: 'reconnecting' });
    expect(payload.connected).toBe(false);
    expect(payload.status).toBe('Reconnecting');
  });

  test('survives the JSON round trip the native module parses', () => {
    expect(JSON.parse(JSON.stringify(androidWidgetPayload(base)))).toEqual(androidWidgetPayload(base));
  });
});
```

- [ ] **Step 2: Run to confirm it fails.**
Run: `npx jest __tests__/android-widget-payload-test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** `src/lib/widget/android-widget-payload.ts`:

```ts
// ─── The Android widget's payload ─────────────────────────────────
// The iOS widget draws `glanceableWidgetLines(snapshot)` inside expo-widgets'
// SwiftUI runtime. Android has no such runtime in this SDK, so its native
// Glance card is handed the same lines as data. The stamp is the one line not
// pre-rendered: the card formats it at draw time from `writtenAt`, so "Today"
// never goes stale on a home screen overnight.

import type { VersutusWidgetPayload } from '../../../modules/versutus-widget/src/VersutusWidget.types';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import { glanceableWidgetLines } from '@/lib/widget/widget-target';

export function androidWidgetPayload(snapshot: GlanceableSnapshot): VersutusWidgetPayload {
  const lines = glanceableWidgetLines(snapshot);
  return {
    v: 1,
    status: lines.status,
    connected: snapshot.status === 'connected',
    work: lines.work,
    ...(lines.result ? { result: lines.result } : {}),
    approvalsPending: Math.max(0, Math.trunc(snapshot.approvalsPending)),
    writtenAt: snapshot.writtenAt,
  };
}
```

- [ ] **Step 4: Route Android writes through the module.** Replace `src/lib/widget/widget-device.ts` from the `import` lines to the end with:

```ts
import { Platform } from 'react-native';

import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

/** The iOS widget this build registers (expo-widgets). */
export type WidgetTarget = typeof import('@/components/widget/glanceable-widget');

/** The Android widget module this build carries (modules/versutus-widget). */
export type AndroidWidgetModule = typeof import('../../../modules/versutus-widget').default;

/** iOS only: the expo-widgets target, or null. Android draws natively (see below). */
export async function loadWidgetTarget(
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
): Promise<WidgetTarget | null> {
  if (Platform.OS !== 'ios') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/** Android only: the Glance widget module, or null where the build lacks it. */
export async function loadAndroidWidgetModule(
  load: () => Promise<AndroidWidgetModule> = async () => (await import('../../../modules/versutus-widget')).default,
): Promise<AndroidWidgetModule | null> {
  if (Platform.OS !== 'android') return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * Hand the widget its next snapshot, or nothing. A refusing write is swallowed:
 * the widget keeps the last snapshot it holds and says when that was.
 */
export async function writeWidgetSnapshot(
  snapshot: GlanceableSnapshot,
  load: () => Promise<WidgetTarget> = () => import('@/components/widget/glanceable-widget'),
  loadAndroid: () => Promise<AndroidWidgetModule> = async () => (await import('../../../modules/versutus-widget')).default,
): Promise<void> {
  if (Platform.OS === 'android') {
    const module = await loadAndroidWidgetModule(loadAndroid);
    try {
      await module?.setPayload(JSON.stringify(androidWidgetPayload(snapshot)));
    } catch {
      // The widget keeps the snapshot it already holds.
    }
    return;
  }
  const target = await loadWidgetTarget(load);
  try {
    target?.default.updateSnapshot(snapshot);
  } catch {
    // The widget keeps the snapshot it already holds.
  }
}
```

Keep the file's existing header comment. Update its paragraph at lines 16-22 to say: iOS draws through expo-widgets, Android through `modules/versutus-widget`, and every other platform is answered before any import.

- [ ] **Step 5: Stop shipping expo-widgets' Android stub.**
- In `app.json`, set `"enableAndroid": false` in the `expo-widgets` props and delete the widget entry's `"android": { … }` block.
- In `package.json`, add a top-level `expo` block:

```json
  "expo": {
    "autolinking": {
      "android": {
        "exclude": ["expo-widgets"]
      }
    }
  },
```

- Delete `src/components/widget/glanceable-widget.android.tsx`.

- [ ] **Step 6: Replace the stub-era pins in `__tests__/widget-target-test.ts`.** These tests assert the path this task removes; update them in the same change rather than keeping the stub alive:
- Replace the test `the Android half is switched on, and the cell target is spelled out rather than defaulted` (`:118-134`) with:

```ts
  test('expo-widgets serves iOS only; Android is drawn by modules/versutus-widget', () => {
    const [, props] = widgetEntries()[0];
    expect(props.enableAndroid).toBe(false);
    expect(props.widgets[0].android).toBeUndefined();
    const pkg = JSON.parse(readSource('package.json'));
    expect(pkg.expo.autolinking.android.exclude).toContain('expo-widgets');
  });
```

- Delete the Android component source pins (`:189-218`). Add:

```ts
  test('no expo-widgets component exists for Android, because nothing there could render it', () => {
    const fs = jest.requireActual('fs') as { existsSync(path: string): boolean };
    expect(fs.existsSync([__dirname, '..', 'src', 'components', 'widget', 'glanceable-widget.android.tsx'].join(SEP))).toBe(false);
  });
```

- Replace the `loadWidgetTarget` Android case (`:243-250`) with:

```ts
  test('answers null on Android without importing the iOS target', async () => {
    const load = jest.fn(async () => target);
    jest.replaceProperty(Platform, 'OS', 'android');
    await expect(loadWidgetTarget(load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
```

- Replace `writes through on Android, the other platform whose target it now is` (`:289-…`) with:

```ts
  test('on Android the snapshot goes to the Glance module as its payload, never to expo-widgets', async () => {
    const updateSnapshot = jest.fn();
    const load = jest.fn(async () => target(updateSnapshot));
    const setPayload = jest.fn(async () => true);
    const loadAndroid = jest.fn(async () => ({ setPayload, clearPayload: jest.fn() }) as never);
    jest.replaceProperty(Platform, 'OS', 'android');
    const snap = snapshot({ runsInFlight: 1 });

    await writeWidgetSnapshot(snap, load, loadAndroid);

    expect(setPayload).toHaveBeenCalledWith(JSON.stringify(androidWidgetPayload(snap)));
    expect(load).not.toHaveBeenCalled();
    expect(updateSnapshot).not.toHaveBeenCalled();
  });
```

- Add `import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';` to the file's imports. The helpers `target`, `snapshot`, `widgetEntries`, `readSource` and `SEP` already exist there.

- [ ] **Step 7: Run the tests.**
Run: `npx jest __tests__/android-widget-payload-test.ts __tests__/widget-target-test.ts __tests__/widget-snapshot-test.ts`
Expected: PASS.
Run: `npm run verify`
Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git add -A src/lib/widget src/components/widget app.json package.json __tests__/android-widget-payload-test.ts __tests__/widget-target-test.ts
git commit -m "fix(widget): Android widget snapshots reach a real widget, and the expo-widgets stub that drew only its name is gone"
```

### Task 0.5: Regenerate, build, install, and verify on the phone

**Files:** none tracked. `android/` is generated.

- [ ] **Step 1: Regenerate the native project from clean.** This is required: the old generated `VersutusStatusProvider.kt` extends a class from `expo-widgets`, which is no longer linked on Android.
Run: `npx expo prebuild --platform android --clean`
Expected: completes. `android/app/src/main/java/com/versutus/app/VersutusStatusProvider.kt` no longer exists.

- [ ] **Step 2: Build.**
Run: `cd android; .\gradlew :versutus-widget:testDebugUnitTest :handsfree-voice:testDebugUnitTest assembleRelease`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Confirm the merged manifest.**
Run: `Select-String -Path android\app\build\intermediates\merged_manifests\release\processReleaseManifest\AndroidManifest.xml -Pattern 'VersutusStatusReceiver|VersutusStatusProvider|expo.modules.widgets'`
Expected: one line naming `com.versutus.widget.VersutusStatusReceiver`, and nothing for `VersutusStatusProvider` or `expo.modules.widgets`.

- [ ] **Step 4: Install.**
Run: `adb install -r android\app\build\outputs\apk\release\app-release.apk`
Expected: `Success`.

- [ ] **Step 5: Device checklist on the Samsung** (and a Pixel if available). Record results in `docs/plans/2026-09-12-android-widget-device-log.md`:
  1. Remove the old transparent widget. Its provider class is gone, so One UI shows it as unavailable.
  2. Long-press → Widgets → Versutus: the picker preview is an opaque card reading "Connected / 1 run waiting on your approval".
  3. Place it at 4x2: an opaque rounded card, readable on a dark wallpaper and then a light one, with status, work line, result and "Written Today HH:MM".
  4. Resize to 2x2: the result line drops, and status, work and stamp remain.
  5. Tap: Versutus opens on the Chat tab.
  6. Start a run from the app: within seconds the work line reads "1 run in flight"; when it settles, the result line updates.
  7. Trigger an approval: the work line leads with "1 run waiting on your approval" plus "Tap to decide in Versutus"; tapping opens Chat with the approval sheet showing.
  8. Force-stop Versutus: the widget keeps its last data and the stamp does not change.
  9. Reboot the phone: the widget redraws from the stored payload with the same stamp.
  10. `adb shell dumpsys appwidget | findstr versutus` lists `com.versutus.app/com.versutus.widget.VersutusStatusReceiver`.

- [ ] **Step 6: Commit the record and close the ledger entry.**

```bash
git add docs/plans/2026-09-12-android-widget-device-log.md FUTURE-ITEMS.md
git commit -m "docs(widget): record the Android widget's device check and mark the Android half shipped"
```

`FUTURE-ITEMS.md` §4 changes only after checklist items 1–10 pass.

---

## 4. Milestones — from a status card to a widget family

Before starting a milestone, expand its tasks into the Phase 0 step format (failing test, run, implement, run, commit) in `docs/plans/<date>-widget-m<N>.md`. The contracts, files and acceptance below are fixed.

### M1 — Looks native on any wallpaper, at any size, for any reader

| Task | Files | Test | Acceptance |
|---|---|---|---|
| 1.1 Brand fallback colours for Android < 12 | `modules/versutus-widget/android/…/WidgetColors.kt`: `ColorProviders(light = lightColorScheme(...), dark = darkColorScheme(background = Color(0xFF08080A), ...))` from `androidx.glance.material3`; `GlanceTheme(if (Build.VERSION.SDK_INT >= 31) GlanceTheme.colors else WidgetColors.colors)` | source pin in `versutus-widget-module-contract-test.ts` | readable on an Android 11 emulator |
| 1.2 1x1 status tile | `WidgetVariant.TINY` (< 80 dp): coloured dot + one-word status, tap opens the app | `WidgetLayoutTest`: `variantFor(57f, 57f) == TINY` | fits a 1x1 cell on One UI |
| 1.3 Large list | `LARGE` shows up to three recent runs from the payload (`runs: Array<{ title, state }>`, payload `v: 2`, parsed by `WidgetPayload` with `v` 1 still accepted) | `WidgetPayloadTest` v1 and v2 cases; Jest for `androidWidgetPayload` v2 | 4x4 shows three rows |
| 1.4 Accessibility | `GlanceModifier.semantics { contentDescription = "Versutus: $status. $work. $stamp" }` on the card; text honours system font scale (no fixed heights) | source pin | TalkBack reads one sentence |

### M2 — Actions that respect the app's safety rules

| Task | Files | Test | Acceptance |
|---|---|---|---|
| 2.1 Bot quick-launch | payload `bots: Array<{ id, label }>`, top 3 from the roster and recent Bot Chats; a row per Bot with `openAppIntent(context, "versutus://chat?bot=<id>")` (existing `chat` target, `src/lib/gateway/deep-link.ts:75-78`) | Jest: payload carries at most three Bots, ids URL-encoded; Kotlin: intent data per row | tap opens that Bot's chat |
| 2.2 Decide | when `approvalsPending > 0`, a "Decide" button → `versutus://chat`; the approval sheet shows there (`chat-screen.tsx:2122-2128`). Never an in-widget approve (ADR 0001) | source pin: no `actionRunCallback` touches approvals | tap lands on the sheet; a settled approval shows "no longer waiting" copy |
| 2.3 Start voice call | a button per Bot row using the voice plan's **signed** URL (`docs/plans/2026-09-12-realtime-voice-plan.md` §4.4). The widget module declares `implementation project(':handsfree-voice')` and calls `HandsfreeLaunchKey.sign(context, botId, engine = "auto", ts = System.currentTimeMillis())` when rendering | Kotlin: the rendered URL verifies with `HandsfreeLaunchKey.verify`; a tampered `bot` fails | after unlock and connect, tapping starts the call; the same URL typed via `adb` opens the confirm sheet |
| 2.4 Privacy toggle | a Settings row "Hide result text on the widget"; payload `redact: true` drops `result` and Bot labels (keeps counts and stamp) | Jest payload test; Kotlin parse test | toggling it changes the widget within seconds |

### M3 — Fresh while the app is closed, honest when it can't be

| Task | Files | Test | Acceptance |
|---|---|---|---|
| 3.1 Stamp roll-over | `WidgetRefreshWorker.kt` (WorkManager `PeriodicWorkRequest` every 6 h, no network constraint) calls `VersutusStatusWidget().updateAll(context)`, so "Today" becomes "Yesterday" without app activity; enqueued `KEEP` from `setPayload` | Kotlin test of the enqueue policy helper | next morning the stamp reads "Yesterday" |
| 3.2 Push-carried snapshot | add `expo-task-manager` (SDK 57 line); `src/lib/widget/widget-push-task.ts` defines a task with `TaskManager.defineTask` and registers it with `Notifications.registerTaskAsync`; the handler reads `data.widget` (a v2 payload stamped by the Gate) and calls `setPayload`. Android delivers only **data-only** messages to it, and Doze may delay delivery ([expo-notifications v57](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)) | Jest: handler ignores a payload with no `widget` key and writes a valid one; Gate `push-notifier` test: routine and reply notices include `widget` only for devices with the widget enabled | a routine finishing overnight updates the widget with its verdict and the Gate's stamp |
| 3.3 Gate side | `gate/core/push-notifier.mjs` adds a data-only companion message `{ data: { kind: 'widget', widget } }` for devices that opted in (`notifications.preferences.set` gains `widgetUpdates: boolean`) | `gate/__tests__/push-notifier.test.mjs` cases | no widget payload is sent to a device that did not opt in |

### M4 — Configurable per instance

- `android:configure` activity (`WidgetConfigureActivity.kt`) lets each placed widget pin a Bot; per-instance state via `updateAppWidgetState(context, PreferencesGlanceStateDefinition, glanceId)`.
- `widgetFeatures="reconfigurable|configuration_optional"`.
- Tests: Kotlin state key helpers.
- Acceptance: two widgets on one screen show two different Bots.

### M5 — iOS parity check

The iOS widget stays on `expo-widgets`. Add a tap URL (`versutus://chat`) and verify on an EAS/macOS build. No Android code changes.

---

## 5. Test strategy

- **Every widget change:**
  - Jest: `android-widget-payload`, `widget-target` seam, snapshot fold.
  - Kotlin JVM: payload, stamp, layout, launch-key URL.
  - `npm run verify` green, plus `.\gradlew :versutus-widget:testDebugUnitTest`. `verify` compiles no Kotlin, which is exactly how `8a83907` shipped a stub.
- **Before any widget change is called shipped:** the Task 0.5 device checklist on the Samsung, and on a Pixel when one is available.
- **Rendering check, optional from M1:** Glance's unit-test harness (`androidx.glance:glance-appwidget-testing`, `runGlanceAppWidgetUnitTest { provideComposable { … }; onNode(hasText("Connected")).assertExists() }`), with no Robolectric unless a composable reads resources ([Glance testing](https://developer.android.com/develop/ui/compose/glance/testing)).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Glance 1.2.0 conflicts with the build | Fallback to `1.2.0-rc01`, already compiling here (Task 0.3 Step 6) |
| Stale prebuild output references `expo-widgets` classes | `expo prebuild --clean` is mandatory (Task 0.5 Step 1) |
| Existing placed widget breaks on update | Expected: the provider class changes. The checklist starts by removing it. |
| One UI throttles updates | Updates are event-driven from the app plus the M3 worker. The widget never claims freshness: the stamp is always shown. |
| Push-driven updates delayed by Doze | Documented limitation; the stamp tells the truth |
| iOS regressions | iOS path untouched; `loadWidgetTarget` still answers on iOS (widget-target tests) |

## 7. Decisions for Ethan

1. **Native Glance module now, reconsider `expo-widgets` when SDK 58 is stable.** *Recommended.*
2. **Approvals open the app, never approve in the widget.** *Recommended*, and required by ADR 0001.
3. **Voice-call button uses signed auto-start.** *Recommended*; unsigned links always confirm.
4. **Privacy toggle default:** result text shown. *Recommended* for a single-operator phone; flip the default if the phone is shared.
5. **Background freshness via opt-in data pushes (M3).** *Recommended*, with the honest-stamp rule unchanged.

---

## Self-review

- **Spec coverage.**
  - Diagnosis with evidence: §0. Options compared: §1.
  - Phase 0: opaque, readable, real data, tap to open (Tasks 0.1–0.5).
  - Sizes, dynamic colour and accessibility: M1. Bot launch, approvals, voice call and privacy: M2. Freshness while closed: M3.
  - Configuration: M4. iOS: M5. Device checklist: Task 0.5. Risks and decisions: §6–§7.
- **Placeholder scan.** Phase 0 steps carry code, commands and expected output. Milestone rows carry files, contracts, tests and acceptance; their step expansion is scheduled at milestone start.
- **Type consistency.**
  - `VersutusWidgetPayload` (Task 0.1) is the type returned by `androidWidgetPayload` (Task 0.4) and parsed by `WidgetPayload.parse` (Task 0.2).
  - `WidgetVariant` and `WidgetLayout.variantFor` are defined in Task 0.3 and used in `VersutusStatusWidget.kt`.
  - `openAppIntent` is defined in Task 0.3 and reused in M2.
  - The signed call URL matches the voice plan's §4.4.

