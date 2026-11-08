# Ambient Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status 2026-11-08:** phases 0-2 were executed on the local `ambient-redesign` branch and stopped there by Ethan's decision. The field default is now 1/4 (`STAGE_RENDER_SCALE = 0.25`), not the 1/2 this plan describes; the code is authoritative. Several steps below changed in execution (see the spec's section 11 and `docs/perf/README.md`). Phases 3-5 were not started.

**Goal:** Make the Versutus ambient lamp cheap enough for smooth 60 fps on the Galaxy A54 without losing the colour-changing lighting, then layer the new surfaces and motion language on top.

**Architecture:** The native lamp shader renders at 1/2 size and upscales, redrawing at 24 per second (an automatic governor steps down to 12, a smaller field, then rest). Every brightness change moves a full-screen dark overlay (the Veil) instead of redrawing the field; only hue changes redraw the field, and only for the transition. The send swell, parallax and tilt become cheap layers. Phases 0 to 2 are specified step by step below; phases 3 to 5 are outlined with exit gates and get their own detailed plans when phase 2 passes on the phone.

**Tech Stack:** Expo v57, React Native 0.86.3, Reanimated 4.5.1, react-native-worklets 0.10.1, @shopify/react-native-skia 2.6.2, React Compiler on, Jest (jest-expo) for `__tests__/`, `node --test` for `scripts/__tests__/`, `adb` + `dumpsys gfxinfo` for device measurement.

**Spec:** `docs/superpowers/specs/2026-11-07-ambient-redesign-design.md`. Motion detail: `docs/superpowers/specs/2026-11-07-motion-language-draft.md`.

---

## Conventions for every task

- Read the versioned Expo docs (https://docs.expo.dev/versions/v57.0.0/) before touching Expo APIs; this plan only uses APIs already imported elsewhere in `src/` or confirmed in the installed type definitions.
- **Worklet rule:** a worklet may only call worklets. Every pure function in `src/lib/stage/` that the UI thread calls carries `'worklet'` as its first statement. JS-thread functions reach the UI thread's callers through Reanimated's `runOnJS` (as `src/components/ui/BaseSheet.tsx` does), NOT `scheduleOnRN` from `react-native-worklets`: importing that package whole from `AmbientCanvas.native.tsx` pulls its native module into 19 jest suites that render a Screen and mock only Reanimated (found 2026-11-08: `loadUnpackers` undefined). Only `src/components/animated-icon.tsx` imports worklets directly.
- Commits use conventional-commit form (`feat(stage): ...`). Run `npm run verify` before the last commit of each phase; the single-task commands below are the fast loop.
- `__tests__/screen-chrome-quiet-test.ts` pins the source of `AmbientCanvas.native.tsx`; when a native change intentionally breaks a pin, change the pin in the same commit and say why in the commit body.
- Device work needs the A54 on Wi-Fi, awake and unlocked, with Wireless debugging on (`adb connect <ip:port>`). The phone's address changes between sessions. Never leave test packages installed on it.
- Stage only the files a task names, by path (`git add <paths>`); never `git add -A` at the repo root and never stage `coverage-baseline.json` (it is modified and uncommitted on master, and `npm run verify` can rewrite it).
- Nothing here deploys or releases. Phone builds and Taildrop are not a release.

## File map

| File | Phase | Responsibility |
|---|---|---|
| `scripts/perf/gfxinfo.mjs` (create) | 0 | Parse `dumpsys gfxinfo` text and judge it against the bar |
| `scripts/__tests__/perf-gfxinfo.test.mjs` (create) | 0 | Tests for the parser and the verdict |
| `scripts/perf/run-scenario.ps1` (create) | 0 | Drive one scenario on the phone, capture gfxinfo and meminfo, call the parser |
| `docs/perf/README.md` (create) | 0 | How to run the harness, the scenario list, where results go |
| `src/lib/stage/render-scale.ts` (create) | 1 | The render-scale constant and the canvas-size maths |
| `src/lib/stage/governor.ts` (create) | 1 | Pure frame-drop governor and its level table |
| `__tests__/stage-render-scale-test.ts`, `__tests__/stage-governor-test.ts` (create) | 1 | Tests |
| `src/components/layout/AmbientCanvas.native.tsx` (modify) | 1, 2 | Wire scale, governor, no idle sleep; then Veil, swell layer, parallax transform |
| `__tests__/screen-chrome-quiet-test.ts` (modify) | 1, 2 | Update the intentional source pins |
| `src/lib/stage/layers.ts` (create) | 2 | Veil mapping, swell-layer curves, colour helpers |
| `src/lib/motion/refcount.ts`, `src/lib/motion/breath.ts` (create) | 2 | The shared breath clock, ref-counted |
| `src/lib/stage/signals.ts` (modify) | 2 | Add the `working` signal |
| `src/components/chat/chat-screen.tsx` (modify) | 2 | Emit `signalWorking` |
| `src/components/layout/StageGlint.native.tsx` (create) | 2 | The one small Skia canvas; carries the swell now, ripples and rings later |
| `__tests__/stage-layers-test.ts`, `__tests__/motion-refcount-test.ts`, `__tests__/stage-signals-working-test.ts` (create) | 2 | Tests |
| `__tests__/stage-motion-test.ts` (modify) | 2 | `QUIET` gains `working: false` |

The web renderer (`AmbientCanvas.web.tsx`, `stage-gl.ts`, `src/lib/stage/motion.ts`) is out of scope: it keeps its idle sleep and its shader swell. `STAGE_TIMING.idleAfterMs`, `driftFrameMs` and `swellMs` stay in `choreography.ts` for it.

---

# Phase 0: measurement harness and baseline

Exit gate: the harness runs on the A54 and a baseline of today's build, including scroll, fling, drawer and idle, is recorded in `docs/perf/`.

### Task 0.1: gfxinfo parser and verdict

**Files:**
- Create: `scripts/perf/gfxinfo.mjs`
- Test: `scripts/__tests__/perf-gfxinfo.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/perf-gfxinfo.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THRESHOLDS, evaluate, evaluateScenario, parseGfxinfo } from '../perf/gfxinfo.mjs';

function fixture(overrides = {}) {
  const v = {
    total: 600,
    janky: 12,
    jankyPct: '2.00',
    p50: 6,
    p90: 9,
    p95: 11,
    p99: 19,
    missed: 0,
    uiSlow: 5,
    deadline: 0,
    ...overrides,
  };
  return [
    'Applications Graphics Acceleration Info:',
    'Uptime: 123456 Realtime: 123456',
    '',
    '** Graphics info for pid 4242 [com.versutus.app] **',
    '',
    'Stats since: 123456789ns',
    `Total frames rendered: ${v.total}`,
    `Janky frames: ${v.janky} (${v.jankyPct}%)`,
    'Janky frames (legacy): 20 (3.33%)',
    `50th percentile: ${v.p50}ms`,
    `90th percentile: ${v.p90}ms`,
    `95th percentile: ${v.p95}ms`,
    `99th percentile: ${v.p99}ms`,
    '50th gpu percentile: 3ms',
    `Number Missed Vsync: ${v.missed}`,
    'Number High input latency: 0',
    `Number Slow UI thread: ${v.uiSlow}`,
    'Number Slow bitmap uploads: 0',
    'Number Slow issue draw commands: 2',
    `Number Frame deadline missed: ${v.deadline}`,
  ].join('\n');
}

test('parses totals, jank and percentiles, ignoring the legacy and gpu lines', () => {
  const run = parseGfxinfo(fixture());
  assert.equal(run.totalFrames, 600);
  assert.equal(run.jankyFrames, 12);
  assert.equal(run.jankyPct, 2);
  assert.equal(run.p50Ms, 6);
  assert.equal(run.p95Ms, 11);
  assert.equal(run.missedVsync, 0);
  assert.equal(run.deadlineMissed, 0);
});

test('throws on text that is not gfxinfo output', () => {
  assert.throws(() => parseGfxinfo('error: closed'), /not gfxinfo output/);
});

test('a clean run passes the bar', () => {
  const verdict = evaluate(parseGfxinfo(fixture()));
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.failures, []);
  assert.ok(verdict.inBudgetPct >= THRESHOLDS.minInBudgetPct);
});

test('each limit fails on its own', () => {
  const janky = evaluate(parseGfxinfo(fixture({ janky: 60, jankyPct: '10.00' })));
  assert.equal(janky.pass, false);
  assert.match(janky.failures.join(' '), /frames in budget/);
  assert.match(janky.failures.join(' '), /janky/);

  const slow = evaluate(parseGfxinfo(fixture({ p95: 20 })));
  assert.equal(slow.pass, false);
  assert.match(slow.failures.join(' '), /p95/);

  const dropped = evaluate(parseGfxinfo(fixture({ deadline: 7, missed: 3 })));
  assert.equal(dropped.pass, false);
  assert.equal(dropped.droppedFrames, 7);
  assert.match(dropped.failures.join(' '), /dropped/);
});

test('a screen that rendered no frames is in budget by definition', () => {
  const verdict = evaluate(parseGfxinfo(fixture({ total: 0, janky: 0, jankyPct: '0.00', p95: 0 })));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.inBudgetPct, 100);
});

test('a scenario passes only if every run passes', () => {
  const good = parseGfxinfo(fixture());
  const bad = parseGfxinfo(fixture({ p95: 25 }));
  assert.equal(evaluateScenario([good, good, good]).pass, true);
  assert.equal(evaluateScenario([good, bad, good]).pass, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --import ./__tests__/fixtures/isolate-credential-vault.mjs --test "../scripts/__tests__/perf-gfxinfo.test.mjs"`
Expected: FAIL with `Cannot find module '.../scripts/perf/gfxinfo.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/perf/gfxinfo.mjs`:

```js
/**
 * Reads `adb shell dumpsys gfxinfo <package>` text and judges it against the
 * ambient-redesign performance bar (docs/superpowers/specs/2026-11-07-ambient-redesign-design.md,
 * section 7). Pure helpers are unit-tested; `main` is the command-line entry
 * that scripts/perf/run-scenario.ps1 calls.
 *
 * Usage: node scripts/perf/gfxinfo.mjs --file run1.txt [--file run2.txt ...] [--check]
 * `--check` exits 1 when any run misses the bar.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The bar, in one place. gfxinfo reports percentiles in whole milliseconds, so
 * a p95 under 16.7 ms reads as 16 or less.
 */
export const THRESHOLDS = Object.freeze({
  minInBudgetPct: 95,
  maxJankyPct: 5,
  maxP95Ms: 16.7,
  maxDroppedFrames: 0,
});

function intAfter(text, label) {
  const match = text.match(new RegExp(`${label}:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

function percentileMs(text, label) {
  const match = text.match(new RegExp(`${label} percentile:\\s*(\\d+)ms`));
  return match ? Number(match[1]) : null;
}

export function parseGfxinfo(text) {
  const total = intAfter(text, 'Total frames rendered');
  const janky = text.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
  if (total === null || !janky) throw new Error('not gfxinfo output: no frame totals found');
  return {
    totalFrames: total,
    jankyFrames: Number(janky[1]),
    jankyPct: Number(janky[2]),
    p50Ms: percentileMs(text, '50th'),
    p90Ms: percentileMs(text, '90th'),
    p95Ms: percentileMs(text, '95th'),
    p99Ms: percentileMs(text, '99th'),
    missedVsync: intAfter(text, 'Number Missed Vsync') ?? 0,
    slowUiThread: intAfter(text, 'Number Slow UI thread') ?? 0,
    deadlineMissed: intAfter(text, 'Number Frame deadline missed') ?? 0,
  };
}

export function evaluate(run, thresholds = THRESHOLDS) {
  const inBudgetPct = run.totalFrames === 0 ? 100 : 100 * (1 - run.jankyFrames / run.totalFrames);
  // The two counters overlap heavily; the larger one is the dropped-frame count.
  const droppedFrames = Math.max(run.missedVsync, run.deadlineMissed);
  const failures = [];
  if (inBudgetPct < thresholds.minInBudgetPct) {
    failures.push(`frames in budget ${inBudgetPct.toFixed(1)}% is under ${thresholds.minInBudgetPct}%`);
  }
  if (run.jankyPct > thresholds.maxJankyPct) {
    failures.push(`janky frames ${run.jankyPct}% is over ${thresholds.maxJankyPct}%`);
  }
  if (run.p95Ms !== null && run.p95Ms > thresholds.maxP95Ms) {
    failures.push(`p95 frame time ${run.p95Ms} ms is over ${thresholds.maxP95Ms} ms`);
  }
  if (droppedFrames > thresholds.maxDroppedFrames) {
    failures.push(`${droppedFrames} dropped frames (limit ${thresholds.maxDroppedFrames})`);
  }
  return { inBudgetPct, droppedFrames, pass: failures.length === 0, failures };
}

export function evaluateScenario(runs, thresholds = THRESHOLDS) {
  const results = runs.map((run) => ({ ...run, ...evaluate(run, thresholds) }));
  return { pass: results.every((result) => result.pass), runs: results };
}

export function main(argv = process.argv.slice(2), out = console) {
  const files = [];
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') files.push(argv[(i += 1)]);
    else if (argv[i] === '--check') check = true;
  }
  if (files.length === 0) {
    out.error('usage: node scripts/perf/gfxinfo.mjs --file <gfxinfo.txt> [--file ...] [--check]');
    return 2;
  }
  const runs = files.map((file) => ({ file, ...parseGfxinfo(readFileSync(file, 'utf8')) }));
  const result = evaluateScenario(runs);
  out.log(JSON.stringify(result, null, 2));
  return check && !result.pass ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --import ./__tests__/fixtures/isolate-credential-vault.mjs --test "../scripts/__tests__/perf-gfxinfo.test.mjs"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and commit**

Run: `npx eslint scripts/perf scripts/__tests__/perf-gfxinfo.test.mjs --max-warnings 0`
Expected: no output.

```bash
git add scripts/perf/gfxinfo.mjs scripts/__tests__/perf-gfxinfo.test.mjs
git commit -m "feat(perf): gfxinfo parser and bar verdict for the ambient redesign"
```

### Task 0.2: the scenario harness

**Files:**
- Create: `scripts/perf/run-scenario.ps1`

- [ ] **Step 1: Write the script**

Create `scripts/perf/run-scenario.ps1`:

```powershell
<#
 One performance scenario on a connected Android phone: reset gfxinfo, drive the
 scenario for -Seconds, dump gfxinfo, repeat -Runs times, then judge the runs
 with scripts/perf/gfxinfo.mjs. Raw output lands in docs/perf/raw/<Label>/<Scenario>/
 and the verdict in docs/perf/<Label>-<Scenario>.json.

 Scenarios: idle (no input), scroll (slow drags), fling (fast flicks), drawer
 (edge drags), manual (a notification cues you; you perform it).
 The app must be a release build. The phone must be awake and unlocked.
#>
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$Package = 'com.versutus.app',
  [ValidateSet('idle', 'scroll', 'fling', 'drawer', 'manual')][string]$Scenario = 'idle',
  [string]$ManualPrompt = 'Perform the scenario now.',
  [int]$Runs = 3,
  [int]$Seconds = 10,
  [string]$Serial = '',
  [string]$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $repo "docs\perf\raw\$Label\$Scenario"
New-Item -ItemType Directory -Force $out | Out-Null

if (-not $Serial) {
  $line = (& $Adb devices) | Select-String '\tdevice$' | Select-Object -First 1
  if (-not $line) { throw 'No adb device. Turn on Wireless debugging, then run: adb connect <ip:port>' }
  $Serial = ($line.Line -split '\s+')[0]
}
function Sh([string]$cmd) { & $Adb -s $Serial shell $cmd }
function Cue([string]$text) {
  & $Adb -s $Serial shell cmd notification post -S bigtext -t 'Versutus perf' vsperf "$text" | Out-Null
}

Sh 'input keyevent KEYCODE_WAKEUP' | Out-Null
Start-Sleep -Seconds 1
$locked = Sh 'dumpsys window' | Select-String -Pattern 'isKeyguardShowing=true|mKeyguardShowing=true|mShowingLockscreen=true' | Select-Object -First 1
if ($locked) { throw 'The phone is locked. Unlock it and run again.' }

$size = (Sh 'wm size') -join ' '
if ($size -match '(\d+)x(\d+)') { $w = [int]$Matches[1]; $h = [int]$Matches[2] } else { $w = 1080; $h = 2340 }
$x = [int]($w / 2); $yHigh = [int]($h * 0.70); $yLow = [int]($h * 0.30); $yMid = [int]($h / 2); $xFar = [int]($w * 0.80)

Sh "monkey -p $Package -c android.intent.category.LAUNCHER 1" | Out-Null
Start-Sleep -Seconds 8   # let the first light and the first paint settle

for ($i = 1; $i -le $Runs; $i++) {
  if ($Scenario -eq 'manual') {
    Cue "Run $i of ${Runs}: $ManualPrompt Starts in 5 s."
    Start-Sleep -Seconds 5
  }
  Sh "dumpsys gfxinfo $Package reset" | Out-Null
  $end = (Get-Date).AddSeconds($Seconds)
  switch ($Scenario) {
    'idle'   { Start-Sleep -Seconds $Seconds }
    'manual' { Start-Sleep -Seconds $Seconds }
    'scroll' {
      while ((Get-Date) -lt $end) {
        Sh "input swipe $x $yHigh $x $yLow 700" | Out-Null
        Sh "input swipe $x $yLow $x $yHigh 700" | Out-Null
      }
    }
    'fling' {
      while ((Get-Date) -lt $end) {
        Sh "input swipe $x $yHigh $x $yLow 90" | Out-Null
        Start-Sleep -Milliseconds 900
        Sh "input swipe $x $yLow $x $yHigh 90" | Out-Null
        Start-Sleep -Milliseconds 900
      }
    }
    'drawer' {
      while ((Get-Date) -lt $end) {
        Sh "input swipe 4 $yMid $xFar $yMid 300" | Out-Null
        Start-Sleep -Milliseconds 700
        Sh "input swipe $xFar $yMid 4 $yMid 300" | Out-Null
        Start-Sleep -Milliseconds 700
      }
    }
  }
  (Sh "dumpsys gfxinfo $Package") | Set-Content -Encoding ascii (Join-Path $out "run$i.txt")
}
(Sh "dumpsys meminfo $Package" | Select-Object -First 45) | Set-Content -Encoding ascii (Join-Path $out 'meminfo.txt')

$nodeArgs = @((Join-Path $repo 'scripts\perf\gfxinfo.mjs'), '--check')
for ($i = 1; $i -le $Runs; $i++) { $nodeArgs += '--file'; $nodeArgs += (Join-Path $out "run$i.txt") }
$json = & node @nodeArgs
$code = $LASTEXITCODE
$json | Set-Content -Encoding ascii (Join-Path $repo "docs\perf\$Label-$Scenario.json")
if ($code -eq 0) { Write-Host "PASS  $Label $Scenario" } else { Write-Host "FAIL  $Label $Scenario (see docs\perf\$Label-$Scenario.json)" }
Sh "am force-stop $Package" | Out-Null
exit $code
```

Notes for the implementer: `$args` is an automatic variable in PowerShell and `$pid` is reserved; the script avoids both. Use `.\gradlew.bat`, never bare `gradlew`, wherever a build step appears.

- [ ] **Step 2: Check the script parses**

Run (PowerShell 5.1 needs the variables to exist before `[ref]`): `$tokens = $null; $errs = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("$PWD\scripts\perf\run-scenario.ps1", [ref]$tokens, [ref]$errs); "parse errors: $($errs.Count)"`
Expected: `parse errors: 0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/perf/run-scenario.ps1
git commit -m "feat(perf): adb scenario harness that captures gfxinfo and judges the bar"
```

### Task 0.3: the perf README

**Files:**
- Create: `docs/perf/README.md`

- [ ] **Step 1: Write the doc**

Create `docs/perf/README.md`:

````markdown
# Performance runs (A54)

The bar (spec section 7): per scenario, 3 runs of 10 s. Every run needs at least 95% of frames in budget,
janky frames under 5%, p95 frame time under 16.7 ms (whole milliseconds, so 16 or less) and zero dropped
frames. The new layers add under 8 MB. An idle screen runs zero Reanimated animations apart from the
24-per-second drift. The thresholds live in `scripts/perf/gfxinfo.mjs` (`THRESHOLDS`); change them there
and say why in the commit.

## Run one scenario

Phone awake, unlocked, on Wi-Fi, Wireless debugging on, release build installed.

```powershell
adb connect <ip:port>
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario scroll
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario idle
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario manual -ManualPrompt "Stream a long reply while pinned."
```

Scenarios: `idle`, `scroll` (slow drags), `fling`, `drawer` (edge drags), `manual` (a notification cues you).
Manual ones to run each time: stream a long reply, stream plus expand a tool card, switch Bot, send a
message, an approval, a 10 s voice call, cold launch (force-stop, start, record the first 10 s).

Open the Home tab first for `idle`/`scroll`/`fling`; open a long thread (200 messages) for the chat
scroll and streaming runs; open the drawer from Home.

## Results

`docs/perf/<label>-<scenario>.json` is the verdict; `docs/perf/raw/<label>/<scenario>/` holds the raw
gfxinfo and meminfo. Record each phase's numbers in the table below.

## Record

| Label | Scenario | Frames / janky % / p95 (worst run) | Verdict | Notes |
|---|---|---|---|---|
| | | | | |
````

- [ ] **Step 2: Commit**

```bash
git add docs/perf/README.md
git commit -m "docs(perf): how to run and read the A54 scenario harness"
```

### Task 0.4: baseline of today's build (device)

**Files:**
- Create: `docs/perf/raw/baseline-<date>/...`, `docs/perf/baseline-<date>-*.json` (generated)
- Modify: `docs/perf/README.md` (fill the Record table)

- [ ] **Step 1: Build and install today's release APK**

From a worktree of `master`: `cd android; .\gradlew.bat assembleRelease` (run `npx expo prebuild --platform android` first only if native plugins changed; an unreadable `.pytest_cache` in the repo breaks JS bundling, so make sure it does not exist; Gradle can reuse a stale JS bundle, so after changing only env vars flip a source constant to force a rebuild). Install: `adb -s <serial> install -r app\build\outputs\apk\release\app-release.apk`.

- [ ] **Step 2: Run the scenarios**

```powershell
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario idle
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario scroll
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario fling
.\scripts\perf\run-scenario.ps1 -Label baseline-2026-11-07 -Scenario drawer
```
Expected: each prints PASS or FAIL and writes a JSON file. FAILs are expected for a baseline; they are the point.

- [ ] **Step 3: Record and commit**

Fill the Record table in `docs/perf/README.md` from the JSON files (worst run per scenario). Note in the commit body anything surprising, in particular whether scroll, fling or drawer fail on today's build with the shader at full size, and whether idle is quiet after the existing 40 s sleep.

```bash
git add docs/perf
git commit -m "docs(perf): baseline of the shipping build on the A54"
```

---

# Phase 1: the engine (1/2 field, governor, no idle sleep)

Exit gate: `npm run verify` is green; on the A54, `idle`, `scroll`, `fling` and `drawer` are recorded against the baseline; the lamp looks the same to Ethan in a side-by-side (banding is the thing to look for).

### Task 1.1: render-scale module

**Files:**
- Create: `src/lib/stage/render-scale.ts`
- Test: `__tests__/stage-render-scale-test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import {
  STAGE_OVERSIZE_DP,
  STAGE_RENDER_SCALE,
  oversizedBox,
  scaledCanvasSize,
  upscaleFactor,
} from '@/lib/stage/render-scale';

describe('stage render scale', () => {
  test('the shipped scale is one half', () => {
    expect(STAGE_RENDER_SCALE).toBe(0.5);
  });

  test('a canvas is the box times the scale, rounded, never under one pixel', () => {
    expect(scaledCanvasSize({ width: 411.4, height: 890.2 }, 0.5)).toEqual({ width: 206, height: 445 });
    expect(scaledCanvasSize({ width: 1, height: 1 }, 0.25)).toEqual({ width: 1, height: 1 });
  });

  test('a nonsense scale means full size', () => {
    expect(scaledCanvasSize({ width: 100, height: 200 }, 0)).toEqual({ width: 100, height: 200 });
    expect(scaledCanvasSize({ width: 100, height: 200 }, 3)).toEqual({ width: 100, height: 200 });
    expect(scaledCanvasSize({ width: 100, height: 200 }, Number.NaN)).toEqual({ width: 100, height: 200 });
  });

  test('scaling the canvas back up always covers the box', () => {
    for (const box of [
      { width: 411.4, height: 890.2 },
      { width: 360, height: 780 },
      { width: 393.7, height: 851.3 },
    ]) {
      for (const scale of [0.5, 0.33, 0.25]) {
        const canvas = scaledCanvasSize(box, scale);
        const factor = upscaleFactor(box, canvas);
        expect(canvas.width * factor).toBeGreaterThanOrEqual(box.width - 1e-9);
        expect(canvas.height * factor).toBeGreaterThanOrEqual(box.height - 1e-9);
      }
    }
  });

  test('the field is drawn a little oversize so it can move by transform', () => {
    expect(STAGE_OVERSIZE_DP).toBe(12);
    expect(oversizedBox({ width: 400, height: 800 })).toEqual({ width: 424, height: 824 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/stage-render-scale-test.ts`
Expected: FAIL, `Cannot find module '@/lib/stage/render-scale'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/stage/render-scale.ts`:

```ts
/**
 * How big the native lamp shader's surface is. The air is slow, soft value
 * noise, so a smaller Skia surface scaled back up by the compositor looks the
 * same while the GPU shades a quarter of the pixels. Spec: docs/superpowers/specs/
 * 2026-11-07-ambient-redesign-design.md section 3.
 */

/** The fraction of the screen's resolution the lamp renders at by default. */
export const STAGE_RENDER_SCALE = 0.5;

/** The field is drawn this much larger than the stage on every side (dp), so parallax and tilt can move it by transform without showing an edge. */
export const STAGE_OVERSIZE_DP = 12;

export type Box = { width: number; height: number };

export function scaledCanvasSize(box: Box, scale: number): Box {
  const s = Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 1;
  return {
    width: Math.max(1, Math.round(box.width * s)),
    height: Math.max(1, Math.round(box.height * s)),
  };
}

/** The scale that takes the (rounded) canvas back up to cover the box exactly. */
export function upscaleFactor(box: Box, canvas: Box): number {
  return Math.max(box.width / canvas.width, box.height / canvas.height);
}

export function oversizedBox(box: Box): Box {
  return { width: box.width + 2 * STAGE_OVERSIZE_DP, height: box.height + 2 * STAGE_OVERSIZE_DP };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/stage-render-scale-test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stage/render-scale.ts __tests__/stage-render-scale-test.ts
git commit -m "feat(stage): render-scale maths for the half-size lamp"
```

### Task 1.2: the governor

**Files:**
- Create: `src/lib/stage/governor.ts`
- Test: `__tests__/stage-governor-test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { GOVERNOR, GOVERNOR_LEVELS, governorAdvance, initialGovernor } from '@/lib/stage/governor';

/** Feed clean frames until `untilMs`; returns the clock. */
function runClean(state: ReturnType<typeof initialGovernor>, from: number, untilMs: number, dt = 16) {
  let t = from;
  while (t < untilMs) {
    t += dt;
    governorAdvance(state, t, dt);
  }
  return t;
}

describe('stage governor', () => {
  test('the level table: 24 Hz at half size, then 12 Hz, then a smaller field, then rest', () => {
    expect(GOVERNOR_LEVELS[0]).toEqual({ fieldHz: 24, scale: 0.5 });
    expect(GOVERNOR_LEVELS[1]).toEqual({ fieldHz: 12, scale: 0.5 });
    expect(GOVERNOR_LEVELS[2].fieldHz).toBe(12);
    expect(GOVERNOR_LEVELS[2].scale).toBeLessThan(0.5);
    expect(GOVERNOR_LEVELS[3].fieldHz).toBe(0);
  });

  test('clean frames never step down', () => {
    const s = initialGovernor();
    runClean(s, 0, 60_000);
    expect(s.level).toBe(0);
  });

  test('three drops inside the window step down one level', () => {
    const s = initialGovernor();
    expect(governorAdvance(s, 1000, 40)).toBe(false);
    expect(governorAdvance(s, 1020, 40)).toBe(false);
    expect(governorAdvance(s, 1040, 40)).toBe(true);
    expect(s.level).toBe(1);
    expect(s.drops).toBe(0);
  });

  test('drops spread across more than the window do not add up', () => {
    const s = initialGovernor();
    governorAdvance(s, 3000, 40);
    governorAdvance(s, 5600, 40);
    governorAdvance(s, 8200, 40);
    expect(s.level).toBe(0);
  });

  test('a long pause is not a drop: the app was in the background', () => {
    const s = initialGovernor();
    expect(governorAdvance(s, 10_000, GOVERNOR.pauseMs + 1)).toBe(false);
    governorAdvance(s, 10_020, 40);
    governorAdvance(s, 10_040, 40);
    expect(s.level).toBe(0);
  });

  test('it never goes below the last level or above the first', () => {
    const s = initialGovernor();
    let t = 1000;
    for (let i = 0; i < 30; i += 1) {
      t += 20;
      governorAdvance(s, t, 40);
    }
    expect(s.level).toBe(GOVERNOR_LEVELS.length - 1);
    runClean(s, t, t + 600_000);
    expect(s.level).toBe(0);
    runClean(s, t + 600_000, t + 700_000);
    expect(s.level).toBe(0);
  });

  test('it steps back up only after a clean stretch, and waits longer if it flaps', () => {
    const s = initialGovernor();
    let t = 1000;
    for (let i = 0; i < 3; i += 1) {
      t += 20;
      governorAdvance(s, t, 40);
    }
    expect(s.level).toBe(1);
    t = runClean(s, t, t + 19_000);
    expect(s.level).toBe(1);
    t = runClean(s, t, t + 2_000);
    expect(s.level).toBe(0);

    // trouble again right after stepping up: it steps down and now waits twice as long
    for (let i = 0; i < 3; i += 1) {
      t += 20;
      governorAdvance(s, t, 40);
    }
    expect(s.level).toBe(1);
    expect(s.upWaitMs).toBe(GOVERNOR.cleanMsToStepUp * 2);
    const downAt = t;
    t = runClean(s, t, downAt + 39_000);
    expect(s.level).toBe(1);
    runClean(s, t, downAt + 41_000);
    expect(s.level).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/stage-governor-test.ts`
Expected: FAIL, `Cannot find module '@/lib/stage/governor'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/stage/governor.ts`:

```ts
/**
 * The lamp's safety valve. It watches the UI thread's frame gaps and steps the
 * lamp down when the phone cannot keep up: 24 draws a second, then 12, then a
 * smaller field, then rest. It steps back up only after a long clean stretch,
 * and waits longer each time it flaps. The thresholds are starting guesses:
 * tune them on the A54 (docs/perf/README.md).
 *
 * Pure and worklet-safe: `governorAdvance` runs on the UI thread every frame
 * and mutates its state in place, so a frame allocates nothing.
 */

export const GOVERNOR = {
  /** A frame gap at or over this is a dropped frame (about two frames at 60 Hz). */
  dropFrameMs: 25,
  /** A gap over this is a pause (backgrounded, screen off), not a drop. */
  pauseMs: 1000,
  /** Drops are counted inside a window this long. */
  windowMs: 2000,
  dropsToStepDown: 3,
  /** Clean time before stepping back up. */
  cleanMsToStepUp: 20_000,
  /** Stepping down within this of stepping up doubles the next wait. */
  flapWindowMs: 60_000,
  maxUpWaitMs: 120_000,
} as const;

/** Index = level. The scale is the fraction of screen resolution the field renders at. */
export const GOVERNOR_LEVELS = [
  { fieldHz: 24, scale: 0.5 },
  { fieldHz: 12, scale: 0.5 },
  { fieldHz: 12, scale: 0.33 },
  { fieldHz: 0, scale: 0.33 },
] as const;

export type GovernorState = {
  level: number;
  windowStart: number;
  drops: number;
  cleanSince: number;
  upWaitMs: number;
  lastUpAt: number;
};

export function initialGovernor(level = 0): GovernorState {
  return {
    level,
    windowStart: 0,
    drops: 0,
    cleanSince: 0,
    upWaitMs: GOVERNOR.cleanMsToStepUp,
    lastUpAt: -1e9,
  };
}

/** Feed one frame. Returns true when the level changed. */
export function governorAdvance(state: GovernorState, nowMs: number, frameDeltaMs: number): boolean {
  'worklet';
  if (frameDeltaMs > GOVERNOR.pauseMs) {
    state.cleanSince = nowMs;
    state.windowStart = nowMs;
    state.drops = 0;
    return false;
  }
  if (nowMs - state.windowStart > GOVERNOR.windowMs) {
    state.windowStart = nowMs;
    state.drops = 0;
  }
  if (frameDeltaMs >= GOVERNOR.dropFrameMs) {
    state.drops += 1;
    state.cleanSince = nowMs;
    if (state.drops >= GOVERNOR.dropsToStepDown && state.level < GOVERNOR_LEVELS.length - 1) {
      if (nowMs - state.lastUpAt < GOVERNOR.flapWindowMs) {
        state.upWaitMs = Math.min(state.upWaitMs * 2, GOVERNOR.maxUpWaitMs);
      }
      state.level += 1;
      state.drops = 0;
      state.windowStart = nowMs;
      return true;
    }
    return false;
  }
  if (state.level > 0 && nowMs - state.cleanSince >= state.upWaitMs) {
    state.level -= 1;
    state.cleanSince = nowMs;
    state.lastUpAt = nowMs;
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/stage-governor-test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stage/governor.ts __tests__/stage-governor-test.ts
git commit -m "feat(stage): frame-drop governor that steps the lamp down and back up"
```

### Task 1.3: wire the native canvas

**Files:**
- Modify: `src/components/layout/AmbientCanvas.native.tsx` (imports at lines 1-33; `LampCanvas` at 99-250)
- Modify: `__tests__/screen-chrome-quiet-test.ts:135`

- [ ] **Step 1: Change the source pin first (it must fail against today's source)**

In `__tests__/screen-chrome-quiet-test.ts`, replace

```ts
    expect(native).toMatch(/const running = focused && !reduced && awake;/);
```
with
```ts
    // The air no longer sleeps after idle (Ethan, 2026-11-07); the governor is the safety valve.
    expect(native).toMatch(/const running = focused && !reduced;/);
    expect(native).not.toContain('idleAfterMs');
    expect(native).toContain('governorAdvance(');
    // Skia on Android draws into a TextureView so the scale and transforms (and later the Veil) composite; `opaque` would switch it to a SurfaceView, which ignores them.
    expect(native).not.toContain('opaque');
    // Importing react-native-worklets whole pulls its native module into every jest suite that renders a Screen (they mock Reanimated only); the UI-to-JS hop is Reanimated's runOnJS.
    expect(native).not.toContain('react-native-worklets');
    expect(native).toContain('runOnJS(setLevel)(');
    // The existing pin `expect(native).toContain('{running ? <TiltSource');` becomes this: rest must stop the tilt sensor too.
    expect(native).toContain('const tiltOn = running && GOVERNOR_LEVELS[level].fieldHz !== 0;');
    expect(native).toContain('{tiltOn ? <TiltSource');
    // The eased levels are latched in a ref that survives the signals effect re-running.
    expect(native).toContain('applied.current.speaking');
    expect(native).toContain('applied.current.connection');
```

Run: `npx jest __tests__/screen-chrome-quiet-test.ts`
Expected: FAIL on the new `running`, `idleAfterMs` and `governorAdvance(` expectations (the `opaque` pin already passes and stays as a guard).

- [ ] **Step 2: Update the imports**

In `src/components/layout/AmbientCanvas.native.tsx`, change the React and Reanimated imports and add the new modules. Replace lines 2-31 (everything from the `expo-router` import down to the `useStageLights` import, keeping the line-1 Skia import and the `AmbientFallback` import below) with:

```tsx
import { useIsFocused } from 'expo-router';
import { Component, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import {
  Easing,
  SensorType,
  useAnimatedReaction,
  useAnimatedSensor,
  useDerivedValue,
  runOnJS,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import {
  STAGE_GAIN,
  STAGE_TIMING,
  STILL_TIME_SEC,
  connectionGain,
  lampOnGain,
  stageUniforms,
  tintBlend,
  tintDipGain,
} from '@/lib/stage/choreography';
import { GOVERNOR_LEVELS, governorAdvance, initialGovernor, type GovernorState } from '@/lib/stage/governor';
import { mixLights, type StageLights } from '@/lib/stage/lamp';
import { scaledCanvasSize, upscaleFactor, type Box } from '@/lib/stage/render-scale';
import { STAGE_SHADER_SKSL } from '@/lib/stage/shader';
import { getStageSignals, subscribeStageSignals } from '@/lib/stage/signals';
import { useStageLights } from '@/lib/stage/use-stage-lights';
```

(The `Canvas, Fill, Shader, Skia, type SkRuntimeEffect` import on line 1 and the `AmbientFallback` import stay as they are.)

- [ ] **Step 3: Replace `LampCanvas`**

Replace lines 99-250 (the doc comment above `LampCanvas` and the whole function) with:

```tsx
/**
 * The native stage: the lamp shader (src/lib/stage/shader.ts) as a Skia
 * runtime effect, driven on the UI thread by Reanimated. The same curves as
 * the web renderer (src/lib/stage/choreography.ts), on shared values.
 *
 * It renders at a fraction of the screen's resolution and is scaled back up,
 * redraws at the governor's field rate (24 a second by default), and never
 * sleeps while the screen is focused and motion is allowed: the governor
 * (src/lib/stage/governor.ts) steps it down if the phone cannot keep up.
 */
function LampCanvas({ effect, lights, parallaxY }: { effect: SkRuntimeEffect; lights: StageLights; parallaxY: number }) {
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const pixelRatio = PixelRatio.get();

  const size = useSharedValue({ width: 1, height: 1 });
  const renderScale = useSharedValue<number>(GOVERNOR_LEVELS[0].scale);
  const governor = useSharedValue<GovernorState>(initialGovernor());
  const [box, setBox] = useState<Box | null>(null);
  const [level, setLevel] = useState(0);
  const time = useSharedValue(STILL_TIME_SEC);
  const pending = useSharedValue(0);
  const from = useSharedValue<StageLights>(lights);
  const to = useSharedValue<StageLights>(lights);
  const blend = useSharedValue(1);
  const tintMs = useSharedValue<number>(STAGE_TIMING.tintMs);
  const lampOn = useSharedValue(1);
  const speaking = useSharedValue(1);
  const connection = useSharedValue(connectionGain(getStageSignals().connection));
  const swell = useSharedValue(1);
  const scroll = useSharedValue(0);
  const tiltX = useSharedValue(0);
  const tiltY = useSharedValue(0);

  // The first light of the session.
  useEffect(() => {
    if (firstLightDone) return;
    firstLightDone = true;
    if (reduced) return;
    lampOn.set(0);
    lampOn.set(withTiming(1, { duration: STAGE_TIMING.lampOnMs, easing: Easing.linear }));
  }, [lampOn, reduced]);

  // A room change crossfades from wherever the light is right now.
  const mirror = useRef({ from: lights, to: lights, start: Number.NEGATIVE_INFINITY, ms: STAGE_TIMING.tintMs as number });
  useEffect(() => {
    const m = mirror.current;
    if (m.to === lights) return;
    const now = Date.now();
    const current = mixLights(m.from, m.to, tintBlend(now - m.start, m.ms));
    const ms = reduced ? STAGE_TIMING.reducedTintMs : STAGE_TIMING.tintMs;
    mirror.current = { from: current, to: lights, start: now, ms };
    from.set(current);
    to.set(lights);
    tintMs.set(ms);
    blend.set(0);
    blend.set(withTiming(1, { duration: ms, easing: Easing.linear }));
  }, [lights, reduced, from, to, tintMs, blend]);

  useEffect(() => {
    scroll.set(withTiming(Math.max(-1, Math.min(1, parallaxY)), { duration: STAGE_TIMING.scrollTau * 2 }));
  }, [parallaxY, scroll]);

  // The levels the room's two eased lights were last sent toward. A ref, not locals of the effect below: that
  // effect re-runs when focus or Reduce Motion change, and must not forget where the lamp really is (a latch
  // reseeded from the signal would swallow the next real change).
  const applied = useRef({ speaking: false, connection: getStageSignals().connection });

  // What the room reacts to: sends, a Bot speaking, the Gate. `apply` runs on every signal update (a touch
  // is one, about once a second while scrolling), so a timing only starts when its own value really changed:
  // a running timing writes its shared value every frame and would redraw the shader at display rate.
  useEffect(() => {
    let sendCount = getStageSignals().sendCount;
    const apply = () => {
      const signals = getStageSignals();
      if (signals.sendCount !== sendCount) {
        sendCount = signals.sendCount;
        if (!reduced && focused) {
          swell.set(0);
          swell.set(withTiming(1, { duration: STAGE_TIMING.swellMs, easing: Easing.linear }));
        }
      }
      if (signals.speaking !== applied.current.speaking) {
        applied.current.speaking = signals.speaking;
        speaking.set(
          withTiming(signals.speaking ? STAGE_GAIN.speaking : 1, {
            duration: (signals.speaking ? STAGE_TIMING.speakRiseTau : STAGE_TIMING.speakFallTau) * 2.2,
            easing: Easing.out(Easing.cubic),
          }),
        );
      }
      if (signals.connection !== applied.current.connection) {
        applied.current.connection = signals.connection;
        connection.set(
          withTiming(connectionGain(signals.connection), {
            duration: STAGE_TIMING.connectionTau * 2.2,
            easing: Easing.out(Easing.cubic),
          }),
        );
      }
    };
    return subscribeStageSignals(apply);
  }, [focused, reduced, swell, speaking, connection]);

  // The governor's level changes arrive from the UI thread through `setLevel`. The scale the uniforms
  // use follows the committed level, so the shader's resolution and the canvas size always agree.
  useLayoutEffect(() => {
    renderScale.set(GOVERNOR_LEVELS[level].scale);
  }, [level, renderScale]);

  // The air's clock: advanced on the UI thread at the governor's field rate.
  // The same callback feeds the governor the frame gaps it judges.
  const running = focused && !reduced;
  // At rest nothing may write the shader's inputs: the tilt sensor writes every sample and would keep the
  // shader redrawing at the sensor rate, which would make the last rung costlier than the one above it.
  const tiltOn = running && GOVERNOR_LEVELS[level].fieldHz !== 0;
  const clock = useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame ?? 0;
    // The state object lives on the UI thread and is advanced in place: a frame allocates nothing.
    const g = governor.get();
    // `runOnJS`, not worklets' `scheduleOnRN`: see the worklet rule in Conventions.
    if (governorAdvance(g, info.timestamp, dt)) runOnJS(setLevel)(g.level);
    const hz = GOVERNOR_LEVELS[g.level].fieldHz;
    if (hz === 0) return;
    pending.set(pending.get() + dt);
    if (pending.get() >= 1000 / hz) {
      time.set(time.get() + Math.min(pending.get(), 100) / 1000);
      pending.set(0);
    }
  }, false);
  useEffect(() => {
    clock.setActive(running);
  }, [clock, running]);

  const uniforms = useDerivedValue(() => {
    const t = tintBlend(blend.get() * tintMs.get(), tintMs.get());
    const swellElapsed = swell.get() < 1 ? swell.get() * STAGE_TIMING.swellMs : null;
    return stageUniforms({
      // The shader works in canvas units, so it is told the canvas's own (scaled) size.
      width: size.get().width * renderScale.get(),
      height: size.get().height * renderScale.get(),
      pixelRatio,
      timeSec: time.get(),
      lights: mixLights(from.get(), to.get(), t),
      gain:
        lampOnGain(lampOn.get() < 1 ? lampOn.get() * STAGE_TIMING.lampOnMs : null) *
        connection.get() *
        speaking.get() *
        tintDipGain(t),
      swellElapsedMs: swellElapsed,
      scroll: scroll.get(),
      tiltX: tiltX.get(),
      tiltY: tiltY.get(),
    });
  });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const next = { width: Math.max(1, width), height: Math.max(1, height) };
    size.set(next);
    setBox(next);
  };

  const canvas = box ? scaledCanvasSize(box, GOVERNOR_LEVELS[level].scale) : null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {tiltOn ? <TiltSource tiltX={tiltX} tiltY={tiltY} /> : null}
      {box && canvas ? (
        // A smaller surface, scaled back up from the top-left to fill the stage.
        <Canvas
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
            transformOrigin: 'top left',
            transform: [{ scale: upscaleFactor(box, canvas) }],
          }}
        >
          <Fill>
            <Shader source={effect} uniforms={uniforms} />
          </Fill>
        </Canvas>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 4: Typecheck, run the pinned tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx jest __tests__/screen-chrome-quiet-test.ts __tests__/stage-motion-test.ts __tests__/stage-shader-test.ts`
Expected: PASS. If another pin in `screen-chrome-quiet-test.ts` fails because of an intentional change in this task, update that pin and say why in the commit body; do not weaken a pin that still describes a real rule.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/AmbientCanvas.native.tsx __tests__/screen-chrome-quiet-test.ts
git commit -m "feat(stage): half-size lamp, governor-driven field rate, no idle sleep on native"
```

### Task 1.4: the whole gate

- [ ] **Step 1: Run the repo gate**

Run: `npm run verify`
Expected: exits 0. `coverage-baseline.json` is a ratchet: if coverage rose it may rewrite the file; commit that change only if Ethan wants the raised marks (it was already modified and uncommitted before this work).

- [ ] **Step 2: Commit any gate fixes**

```bash
git add -A -- src __tests__ scripts docs
git commit -m "chore(stage): gate fixes for the half-size lamp"
```
(Skip when nothing changed.)

### Task 1.5: device gate for phase 1

**Files:**
- Create: `docs/perf/raw/phase1-<date>/...`, `docs/perf/phase1-<date>-*.json`
- Modify: `docs/perf/README.md` (Record table)

- [ ] **Step 1: Build and install the phase-1 release APK** (same commands as Task 0.4 Step 1).

- [ ] **Step 2: Run the same scenarios as the baseline**

```powershell
.\scripts\perf\run-scenario.ps1 -Label phase1-2026-11-07 -Scenario idle
.\scripts\perf\run-scenario.ps1 -Label phase1-2026-11-07 -Scenario scroll
.\scripts\perf\run-scenario.ps1 -Label phase1-2026-11-07 -Scenario fling
.\scripts\perf\run-scenario.ps1 -Label phase1-2026-11-07 -Scenario drawer
```

- [ ] **Step 3: Compare and decide**

Record phase 1 beside the baseline in `docs/perf/README.md`. Expected direction: fewer janky frames than the baseline in every scenario. Check three more things and write them in the commit body: (1) idle now keeps drawing after 60 s (confirm with `idle` run 3 and a manual look that the air still moves); (2) gradient banding at the half-size field on the A54's screen (look at a dark gradient region; if it bands, record it as the dither follow-up, do not change the shader in this task); (3) the governor: force it with a deliberately heavy screen, or temporarily lower `GOVERNOR.dropFrameMs` in a local build, and confirm the field rate steps down (the `scale` visibly changes at level 2).
If a scenario still fails the bar, do not start phase 2: report the numbers and which scenario, because the fix may be outside the lamp.

- [ ] **Step 4: Commit**

```bash
git add docs/perf
git commit -m "docs(perf): phase 1 numbers on the A54 against the baseline"
```

---

# Phase 2: the Veil, the breath clock and layer reactions

Exit gate: `npm run verify` green; `docs/perf` shows the phase-2 scenarios (idle, scroll, fling, drawer, plus manual: stream a long reply, send, expand a tool card) passing or improved against phase 1; Ethan judges the Veil's brightness against the old gain curve (decision D3: tune the opacity mapping if it reads wrong, do not drop the Veil).

### Task 2.1: layer maths

**Files:**
- Create: `src/lib/stage/layers.ts`
- Test: `__tests__/stage-layers-test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { STAGE_GAIN } from '@/lib/stage/choreography';
import { STAGE_BASE } from '@/lib/stage/lamp';
import {
  FIELD_GAIN,
  LAYER_TIMING,
  SWELL_PEAK,
  TOOL_BREATH,
  breathGain,
  lightCss,
  stageBaseCss,
  swellOpacity,
  swellRise,
  swellScale,
  veilOpacity,
} from '@/lib/stage/layers';

describe('the veil', () => {
  test('the field renders at its speaking level, so the room at rest is mostly lit', () => {
    expect(FIELD_GAIN).toBe(STAGE_GAIN.speaking);
    expect(veilOpacity(1)).toBeCloseTo(0.1228, 3);
  });

  test('speaking is the veil fully open; the call peak cannot go brighter', () => {
    expect(veilOpacity(STAGE_GAIN.speaking)).toBe(0);
    expect(veilOpacity(2)).toBe(0);
  });

  test('the Gate levels land where the draft says', () => {
    expect(veilOpacity(STAGE_GAIN.reaching)).toBeCloseTo(0.368, 3);
    expect(veilOpacity(STAGE_GAIN.offline)).toBeCloseTo(0.702, 3);
  });

  test('a lamp that is off is a closed veil', () => {
    expect(veilOpacity(0)).toBe(1);
    expect(veilOpacity(-1)).toBe(1);
  });
});

describe('the tool breath', () => {
  test('swings five percent either side of the room', () => {
    expect(TOOL_BREATH).toBe(0.05);
    expect(breathGain(0)).toBeCloseTo(0.95, 9);
    expect(breathGain(0.5)).toBeCloseTo(1, 9);
    expect(breathGain(1)).toBeCloseTo(1.05, 9);
  });

  test('as veil opacity it is plus or minus about 0.044', () => {
    expect(veilOpacity(breathGain(0)) - veilOpacity(1)).toBeCloseTo(0.0439, 3);
    expect(veilOpacity(1) - veilOpacity(breathGain(1))).toBeCloseTo(0.0439, 3);
  });
});

describe('the swell layer', () => {
  test('is shorter than the old shader swell and silent outside its run', () => {
    expect(LAYER_TIMING.swellMs).toBe(1100);
    expect(swellOpacity(null)).toBe(0);
    expect(swellOpacity(-5)).toBe(0);
    expect(swellOpacity(LAYER_TIMING.swellMs)).toBe(0);
  });

  test('attacks quickly, then fades slowly', () => {
    const peakish = swellOpacity(LAYER_TIMING.swellMs * 0.1);
    expect(peakish).toBeGreaterThan(SWELL_PEAK * 0.8);
    expect(peakish).toBeLessThanOrEqual(SWELL_PEAK);
    expect(swellOpacity(LAYER_TIMING.swellMs * 0.5)).toBeLessThan(peakish);
    expect(swellOpacity(LAYER_TIMING.swellMs * 0.95)).toBeLessThan(0.05);
  });

  test('rises with an ease-out and grows from 0.6 to 1.6', () => {
    expect(swellRise(null)).toBe(1);
    expect(swellRise(0)).toBe(0);
    expect(swellRise(LAYER_TIMING.swellMs)).toBe(1);
    expect(swellRise(LAYER_TIMING.swellMs * 0.5)).toBeGreaterThan(0.5);
    expect(swellScale(0)).toBeCloseTo(0.6, 9);
    expect(swellScale(1)).toBeCloseTo(1.6, 9);
  });
});

describe('colour helpers', () => {
  test('the stage base as css', () => {
    expect(stageBaseCss()).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
    expect(stageBaseCss()).toBe(stageBaseCss());
    expect(STAGE_BASE.length).toBe(3);
  });

  test('a light as css keeps its alpha and clamps to a valid channel', () => {
    expect(lightCss([0.02, 0.2, 0.3], 0.5)).toMatch(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.5\)$/);
    expect(lightCss([9, 9, 9], 1)).toBe('rgba(255, 255, 255, 1)');
    expect(lightCss([0, 0, 0], 0)).toBe('rgba(0, 0, 0, 0)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/stage-layers-test.ts`
Expected: FAIL, `Cannot find module '@/lib/stage/layers'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/stage/layers.ts`:

```ts
/**
 * Reactions that live on cheap layers above the lamp field instead of inside
 * its shader. Brightness is the Veil: the field renders at its speaking level
 * and a dark layer over it carries every brightness change as one alpha value,
 * so speaking, a tool's breath, the Gate's dimming and the first light never
 * redraw the field. The send swell is a soft gradient circle that rises and
 * fades, drawn once. Spec: docs/superpowers/specs/2026-11-07-ambient-redesign-design.md
 * section 3; motion draft sections 2.2 and 4.
 *
 * Pure and worklet-safe (the UI thread calls these every frame).
 */

import { STAGE_GAIN, easeOutCubic, smootherstep } from './choreography';
import { STAGE_BASE, linearToSrgb, type Rgb } from './lamp';

/** The brightness the field is rendered at. The Veil only ever darkens it. */
export const FIELD_GAIN = STAGE_GAIN.speaking;

export const LAYER_TIMING = {
  /** The send swell as a layer: shorter than the shader swell it replaces. */
  swellMs: 1100,
  /** One full breath of the shared clock. */
  breathMs: 2400,
} as const;

/** How far a tool's breath swings the room either side of its resting level. */
export const TOOL_BREATH = 0.05;
export const SWELL_PEAK = 0.5;

/** Veil opacity for a room brightness (1 = the lamp at rest). */
export function veilOpacity(gain: number): number {
  'worklet';
  const g = gain < 0 ? 0 : gain > FIELD_GAIN ? FIELD_GAIN : gain;
  return 1 - g / FIELD_GAIN;
}

/** The breath clock (0..1, eased) as a room-brightness multiplier. */
export function breathGain(breath: number): number {
  'worklet';
  return 1 + TOOL_BREATH * (2 * breath - 1);
}

/** The swell's strength. `null` means nothing is rising. */
export function swellOpacity(elapsedMs: number | null): number {
  'worklet';
  if (elapsedMs === null || elapsedMs < 0 || elapsedMs >= LAYER_TIMING.swellMs) return 0;
  const p = elapsedMs / LAYER_TIMING.swellMs;
  return SWELL_PEAK * smootherstep(p / 0.1) * Math.pow(1 - p, 1.6);
}

/** How far up the swell has travelled, 0..1 (1 when it is not running). */
export function swellRise(elapsedMs: number | null): number {
  'worklet';
  if (elapsedMs === null || elapsedMs >= LAYER_TIMING.swellMs) return 1;
  if (elapsedMs <= 0) return 0;
  return easeOutCubic(elapsedMs / LAYER_TIMING.swellMs);
}

/** The swell spreads as it rises. */
export function swellScale(rise: number): number {
  'worklet';
  return 0.6 + rise;
}

function channel(linear: number): number {
  const v = linearToSrgb(linear < 0 ? 0 : linear > 1 ? 1 : linear);
  return Math.round(v * 255);
}

/** The shader's base colour, for the Veil to darken toward. */
export function stageBaseCss(): string {
  return `rgb(${channel(STAGE_BASE[0])}, ${channel(STAGE_BASE[1])}, ${channel(STAGE_BASE[2])})`;
}

/** A lamp's core as a visible css colour (lamp light is dim by design, so it is lifted to be seen). */
export function lightCss(core: Rgb, alpha: number): string {
  return `rgba(${channel(core[0] * 3)}, ${channel(core[1] * 3)}, ${channel(core[2] * 3)}, ${alpha})`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/stage-layers-test.ts`
Expected: PASS, 11 tests. If `linearToSrgb` or `STAGE_BASE` is not exported with these names, `grep -n "export" src/lib/stage/lamp.ts` and adjust the import to the real names; the lamp lab imports `linearToSrgb` from `@/lib/stage/lamp` and `choreography.ts` imports `STAGE_BASE` from `./lamp`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stage/layers.ts __tests__/stage-layers-test.ts
git commit -m "feat(stage): Veil and swell-layer maths, the brightness-as-alpha model"
```

### Task 2.2: the shared breath clock

**Files:**
- Create: `src/lib/motion/refcount.ts`, `src/lib/motion/breath.ts`
- Test: `__tests__/motion-refcount-test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createRefCounter } from '@/lib/motion/refcount';

describe('createRefCounter', () => {
  test('starts on the first acquire and stops on the last release', () => {
    const events: string[] = [];
    const acquire = createRefCounter(
      () => events.push('start'),
      () => events.push('stop'),
    );
    const a = acquire();
    const b = acquire();
    expect(events).toEqual(['start']);
    a();
    expect(events).toEqual(['start']);
    b();
    expect(events).toEqual(['start', 'stop']);
  });

  test('releasing twice is harmless', () => {
    const events: string[] = [];
    const acquire = createRefCounter(
      () => events.push('start'),
      () => events.push('stop'),
    );
    const a = acquire();
    const b = acquire();
    a();
    a();
    expect(events).toEqual(['start']);
    b();
    expect(events).toEqual(['start', 'stop']);
  });

  test('can start again after stopping', () => {
    const events: string[] = [];
    const acquire = createRefCounter(
      () => events.push('start'),
      () => events.push('stop'),
    );
    acquire()();
    acquire()();
    expect(events).toEqual(['start', 'stop', 'start', 'stop']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/motion-refcount-test.ts`
Expected: FAIL, `Cannot find module '@/lib/motion/refcount'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/motion/refcount.ts`:

```ts
/**
 * A reference counter around a start/stop pair: `onFirst` runs when the count
 * goes 0 to 1, `onLast` when it returns to 0. Each acquire returns its own
 * release, safe to call more than once.
 */
export function createRefCounter(onFirst: () => void, onLast: () => void): () => () => void {
  let count = 0;
  return () => {
    if (count === 0) onFirst();
    count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      count -= 1;
      if (count === 0) onLast();
    };
  };
}
```

Create `src/lib/motion/breath.ts`:

```ts
/**
 * One heartbeat for everything that breathes (the tool-work breath on the
 * Veil, later the streaming orb, the listening composer, the skeleton sweep).
 * A single shared value runs a half-cycle timing that reverses forever, only
 * while at least one thing that breathes is mounted. Spec rule: no other
 * infinite loop is allowed in the app.
 */
import { useEffect } from 'react';
import { Easing, cancelAnimation, makeMutable, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';

import { LAYER_TIMING } from '@/lib/stage/layers';

import { createRefCounter } from './refcount';

const clock = makeMutable(0);

const acquire = createRefCounter(
  () => {
    clock.set(
      withRepeat(
        withTiming(1, { duration: LAYER_TIMING.breathMs / 2, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
  },
  () => {
    cancelAnimation(clock);
    clock.set(0);
  },
);

/** The shared breath value (0..1..0 over `LAYER_TIMING.breathMs`); runs only while `active` somewhere. */
export function useBreath(active: boolean): SharedValue<number> {
  useEffect(() => (active ? acquire() : undefined), [active]);
  return clock;
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx jest __tests__/motion-refcount-test.ts`
Expected: PASS, 3 tests.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/motion/refcount.ts src/lib/motion/breath.ts __tests__/motion-refcount-test.ts
git commit -m "feat(motion): one ref-counted breath clock for everything that breathes"
```

### Task 2.3: the `working` signal

**Files:**
- Modify: `src/lib/stage/signals.ts`
- Modify: `src/components/chat/chat-screen.tsx` (import at line 207; memo at 1211-1219; effects after 1225)
- Modify: `__tests__/stage-motion-test.ts:31`
- Test: `__tests__/stage-signals-working-test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/stage-signals-working-test.ts`:

```ts
import { getStageSignals, resetStageSignals, signalWorking, subscribeStageSignals } from '@/lib/stage/signals';

beforeEach(() => resetStageSignals());

describe('the working signal', () => {
  test('a quiet room is not working', () => {
    expect(getStageSignals().working).toBe(false);
  });

  test('is set and cleared, and listeners hear each real change once', () => {
    let heard = 0;
    const off = subscribeStageSignals(() => {
      heard += 1;
    });
    signalWorking(true);
    signalWorking(true);
    expect(getStageSignals().working).toBe(true);
    expect(heard).toBe(1);
    signalWorking(false);
    expect(getStageSignals().working).toBe(false);
    expect(heard).toBe(2);
    off();
  });

  test('resetting the room clears it', () => {
    signalWorking(true);
    resetStageSignals();
    expect(getStageSignals().working).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/stage-signals-working-test.ts`
Expected: FAIL (`signalWorking is not a function` or a type error).

- [ ] **Step 3: Add the signal**

In `src/lib/stage/signals.ts`:

Change the state type, adding after `speaking`:

```ts
  /** A tool or command is running right now (the room breathes while it works). */
  working: boolean;
```

Change the initial state (line 28) and the reset (line 80) to include `working: false`:

```ts
let state: StageSignalState = { sendCount: 0, speaking: false, working: false, connection: undefined, touchedAt: 0 };
```
```ts
  state = { sendCount: 0, speaking: false, working: false, connection: undefined, touchedAt: 0 };
```

Add `next.working === state.working &&` to the equality check in `update`, between the `speaking` and `connection` lines.

Add after `signalSpeaking`:

```ts
/** A tool or command started or stopped running. */
export function signalWorking(working: boolean): void {
  update({ working });
}
```

In `__tests__/stage-motion-test.ts` line 31, change `QUIET` to:

```ts
const QUIET: StageSignalState = { sendCount: 0, speaking: false, working: false, connection: 'connected', touchedAt: 0 };
```

- [ ] **Step 4: Emit it from the chat screen**

In `src/components/chat/chat-screen.tsx`:

Line 207, change to:
```ts
import { signalSent, signalSpeaking, signalWorking } from '@/lib/stage/signals';
```

Replace the memo at lines 1211-1219 with:

```ts
  const transcriptAnswers = useMemo(() => {
    let streaming = false;
    let working = false;
    let queued = 0;
    for (const message of messages) {
      if (message.streaming) streaming = true;
      if (message.command?.status === 'running') working = true;
      if (message.queued) queued += 1;
    }
    return { streaming, working, queued };
  }, [messages]);
```

After the existing `useEffect(() => () => signalSpeaking(false), []);` line add:

```ts
  // While a tool or command runs the room breathes; it settles when it ends.
  const isWorking = transcriptAnswers.working;
  useEffect(() => {
    signalWorking(isWorking);
  }, [isWorking]);
  useEffect(() => () => signalWorking(false), []);
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If any other file constructs a `StageSignalState` literal, tsc names it; add `working: false` there.

Run: `npx jest __tests__/stage-signals-working-test.ts __tests__/stage-motion-test.ts __tests__/chat-screen-motion-easing-test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stage/signals.ts src/components/chat/chat-screen.tsx __tests__/stage-signals-working-test.ts __tests__/stage-motion-test.ts
git commit -m "feat(stage): a working signal so the room can breathe while a tool runs"
```

### Task 2.4: the Glint (swell layer)

**Files:**
- Create: `src/components/layout/StageGlint.native.tsx`

There is no unit test for a Skia view; its logic lives in `layers.ts` (tested). This task is verified by the source pin in Task 2.6 and on the phone.

- [ ] **Step 1: Write the component**

Create `src/components/layout/StageGlint.native.tsx`:

```tsx
import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { LAYER_TIMING, swellOpacity, swellRise, swellScale } from '@/lib/stage/layers';

/**
 * The one small Skia canvas the stage owns above the Veil (spec: at most one
 * per screen). It holds a soft gradient circle that is drawn once and then
 * moved, scaled and faded by transform and opacity alone, so a sent message's
 * swell costs no shader work. Ripples and call rings join it in a later phase.
 *
 * The canvas is small and scaled up: a soft gradient survives upscaling.
 */
const GLINT_DP = 140;
/** 140 dp scaled by 3 is the 420 dp circle the motion draft describes. */
const SWELL_BASE_SCALE = 3;
/** How far up the stage the swell travels, as a fraction of its height. */
const SWELL_TRAVEL = 0.45;

type Props = {
  /** 0 to 1 over `LAYER_TIMING.swellMs`; 1 means nothing is rising. */
  swell: SharedValue<number>;
  stageHeight: SharedValue<number>;
  /** The room's light as a visible colour, and the same colour fully transparent. */
  core: string;
  clear: string;
};

export function StageGlint({ swell, stageHeight, core, clear }: Props) {
  const style = useAnimatedStyle(() => {
    const p = swell.get();
    const elapsed = p < 1 ? p * LAYER_TIMING.swellMs : null;
    const rise = swellRise(elapsed);
    return {
      opacity: swellOpacity(elapsed),
      transform: [
        { translateY: -stageHeight.get() * SWELL_TRAVEL * rise },
        { scale: SWELL_BASE_SCALE * swellScale(rise) },
      ],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.glint, style]}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Circle cx={GLINT_DP / 2} cy={GLINT_DP / 2} r={GLINT_DP / 2}>
          <RadialGradient c={vec(GLINT_DP / 2, GLINT_DP / 2)} r={GLINT_DP / 2} colors={[core, clear]} />
        </Circle>
      </Canvas>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  glint: {
    position: 'absolute',
    left: '50%',
    bottom: 24,
    width: GLINT_DP,
    height: GLINT_DP,
    marginLeft: -GLINT_DP / 2,
    opacity: 0,
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/StageGlint.native.tsx
git commit -m "feat(stage): the Glint canvas carrying the send swell as a layer"
```

### Task 2.5: Veil, swell layer, breath and parallax transform in the native stage

**Files:**
- Modify: `src/components/layout/AmbientCanvas.native.tsx` (the file as left by Task 1.3)

Apply these edits in order. Each "replace" block names the exact old text from the Phase 1 version.

- [ ] **Step 1: Add the failing pins first**

In `__tests__/screen-chrome-quiet-test.ts`, directly after the three expectations added in Task 1.3, add:

```ts
    // Brightness is the Veil; the field is rendered at one fixed level and never redraws for it.
    expect(native).toContain('veilOpacity(');
    expect(native).toContain('gain: FIELD_GAIN');
    expect(native).toContain('swellElapsedMs: null');
    expect(native).toContain('<StageGlint');
    expect(native).toContain('useBreath(');
```

Run: `npx jest __tests__/screen-chrome-quiet-test.ts`
Expected: FAIL on those five.

- [ ] **Step 2: Imports**

Add `useMemo` to the React import, and replace the Reanimated import block and the stage imports as follows.

Replace
```tsx
import { Component, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
```
with
```tsx
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
```

Replace
```tsx
import {
  Easing,
  SensorType,
  useAnimatedReaction,
  useAnimatedSensor,
  useDerivedValue,
  runOnJS,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
```
with
```tsx
import Animated, {
  Easing,
  SensorType,
  runOnJS,
  useAnimatedReaction,
  useAnimatedSensor,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
```

Replace
```tsx
import { mixLights, type StageLights } from '@/lib/stage/lamp';
import { scaledCanvasSize, upscaleFactor, type Box } from '@/lib/stage/render-scale';
```
with
```tsx
import { mixLights, type StageLights } from '@/lib/stage/lamp';
import { FIELD_GAIN, LAYER_TIMING, breathGain, lightCss, stageBaseCss, veilOpacity } from '@/lib/stage/layers';
import {
  STAGE_OVERSIZE_DP,
  oversizedBox,
  scaledCanvasSize,
  upscaleFactor,
  type Box,
} from '@/lib/stage/render-scale';
```

Add after the `import { AmbientFallback, type AmbientCanvasProps } from './ambient-fallback';` line:
```tsx
import { StageGlint } from './StageGlint.native';
```
and after the `useStageLights` import:
```tsx
import { useBreath } from '@/lib/motion/breath';
```
(keep import order as the repo's lint requires; run `npx eslint src/components/layout/AmbientCanvas.native.tsx --fix` after the edits).

- [ ] **Step 3: The working flag and the breath clock**

In `LampCanvas`, after `const tiltY = useSharedValue(0);` add:

```tsx
  const workingFlag = useSharedValue(0);
  const [working, setWorking] = useState(getStageSignals().working);
```

In the signals effect's `apply`, as its last statement (after the `if (signals.connection !== lastConnection) { ... }` block) add:

```tsx
      setWorking(signals.working);
```
(`apply` only mirrors `working` into React state; the veil flag is set by its own effect below, so it follows `running` as well.)

In the signals effect, change the swell timing from the shader's to the layer's:
```tsx
          swell.set(withTiming(1, { duration: LAYER_TIMING.swellMs, easing: Easing.linear }));
```

After `const running = focused && !reduced;` add:

```tsx
  // The tool-work breath rides the shared clock, which runs only while something breathes.
  const breath = useBreath(working && running);
  // The flag follows `running` too: under Reduce Motion the breath clock never starts and sits at 0,
  // which `breathGain` would read as a 4.4% dimmer room for the whole tool run.
  useEffect(() => {
    workingFlag.set(working && running ? 1 : 0);
  }, [working, running, workingFlag]);
```

- [ ] **Step 4: The uniforms no longer depend on brightness, swell, scroll or tilt**

Replace the whole `const uniforms = useDerivedValue(...)` block with:

```tsx
  // The field is drawn at one fixed brightness at the oversize box. Brightness is the Veil, the swell
  // is a layer, parallax and tilt move the field by transform: none of them redraw the shader.
  const uniforms = useDerivedValue(() => {
    const t = tintBlend(blend.get() * tintMs.get(), tintMs.get());
    return stageUniforms({
      width: (size.get().width + 2 * STAGE_OVERSIZE_DP) * renderScale.get(),
      height: (size.get().height + 2 * STAGE_OVERSIZE_DP) * renderScale.get(),
      pixelRatio,
      timeSec: time.get(),
      lights: mixLights(from.get(), to.get(), t),
      gain: FIELD_GAIN,
      swellElapsedMs: null,
      scroll: 0,
      tiltX: 0,
      tiltY: 0,
    });
  });

  // Everything that used to scale the lamp's gain now darkens it from above.
  const veilStyle = useAnimatedStyle(() => {
    const t = tintBlend(blend.get() * tintMs.get(), tintMs.get());
    const breathing = workingFlag.get() === 1 ? breathGain(breath.get()) : 1;
    const gain =
      lampOnGain(lampOn.get() < 1 ? lampOn.get() * STAGE_TIMING.lampOnMs : null) *
      connection.get() *
      speaking.get() *
      tintDipGain(t) *
      breathing;
    return { opacity: veilOpacity(gain) };
  });

  // Parallax and tilt as a transform of the field layer: at most 10 dp in total, inside the 12 dp oversize.
  const fieldStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tiltX.get() * 10 },
      { translateY: -scroll.get() * 6 + tiltY.get() * 4 },
    ],
  }));

  const veilColor = useMemo(() => stageBaseCss(), []);
  const swellCore = useMemo(() => lightCss(lights.key.core, 0.5), [lights]);
  const swellClear = useMemo(() => lightCss(lights.key.core, 0), [lights]);
```

- [ ] **Step 5: The render**

Replace the `const canvas = ...` line and the whole `return (...)` of `LampCanvas` with:

```tsx
  const fieldBox = box ? oversizedBox(box) : null;
  const canvas = fieldBox ? scaledCanvasSize(fieldBox, GOVERNOR_LEVELS[level].scale) : null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {tiltOn ? <TiltSource tiltX={tiltX} tiltY={tiltY} /> : null}
      {fieldBox && canvas ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: -STAGE_OVERSIZE_DP,
              top: -STAGE_OVERSIZE_DP,
              width: fieldBox.width,
              height: fieldBox.height,
            },
            fieldStyle,
          ]}
        >
          {/* A smaller surface, scaled back up from the top-left to fill the oversize field. */}
          <Canvas
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: canvas.width,
              height: canvas.height,
              transformOrigin: 'top left',
              transform: [{ scale: upscaleFactor(fieldBox, canvas) }],
            }}
          >
            <Fill>
              <Shader source={effect} uniforms={uniforms} />
            </Fill>
          </Canvas>
        </Animated.View>
      ) : null}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: veilColor }, veilStyle]} />
      <StageGlint swell={swell} stageHeight={heightValue} core={swellCore} clear={swellClear} />
    </View>
  );
```

`heightValue` is the stage height as its own shared value (the Glint reads only the height). Declare it next to `size`, above `onLayout`:

```tsx
  const heightValue = useSharedValue(1);
```
and in `onLayout`, after `size.set(next);` add `heightValue.set(next.height);`.

Also delete the now-unused `swellElapsed` local (it was inside the old `uniforms` block, already replaced) and confirm `STAGE_GAIN` is still used (the signals effect uses `STAGE_GAIN.speaking`); remove any import that is now unused, as lint will report.

- [ ] **Step 6: Typecheck, lint, tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/components/layout src/lib --max-warnings 0`
Expected: no output (run with `--fix` once for import order).

Run: `npx jest __tests__/screen-chrome-quiet-test.ts __tests__/stage-motion-test.ts __tests__/stage-layers-test.ts __tests__/stage-shader-test.ts`
Expected: PASS. A pin that fails because the old code is gone on purpose (for example one that expects `swell` to feed `uSwell` on native) is updated in this step with a one-line comment saying why.

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/AmbientCanvas.native.tsx __tests__/screen-chrome-quiet-test.ts
git commit -m "feat(stage): Veil carries brightness, swell and parallax become layers, tool work breathes"
```

### Task 2.6: the whole gate

- [ ] **Step 1:** Run `npm run verify`. Expected: exits 0. Also run the worklets-must-call-worklets check the repo already runs inside verify; if it flags `breathGain`, `veilOpacity`, `swellOpacity`, `swellRise`, `swellScale` or `governorAdvance`, the missing piece is a `'worklet'` directive on a helper they call.
- [ ] **Step 2:** Commit gate fixes with `git add -A -- src __tests__ docs` and `git commit -m "chore(stage): gate fixes for the Veil and layer reactions"` (skip when clean).

### Task 2.7: device gate for phase 2

- [ ] **Step 1:** Build and install the phase-2 release APK (as Task 0.4 Step 1).
- [ ] **Step 2: Scenarios**

```powershell
foreach ($s in 'idle','scroll','fling','drawer') { .\scripts\perf\run-scenario.ps1 -Label phase2-2026-11-07 -Scenario $s }
.\scripts\perf\run-scenario.ps1 -Label phase2-2026-11-07 -Scenario manual -ManualPrompt "Stream a long reply while pinned to the bottom."
.\scripts\perf\run-scenario.ps1 -Label phase2-2026-11-07 -Scenario manual -ManualPrompt "Send a message, wait for the reply, send another."
.\scripts\perf\run-scenario.ps1 -Label phase2-2026-11-07 -Scenario manual -ManualPrompt "Run a command that takes over 10 s, then expand its card."
```
- [ ] **Step 3: Judge and record**

Record in `docs/perf/README.md`. Then ask Ethan to judge the Veil against the old curve (D3): speaking brightening, the Gate dimming (turn the Gate off and on), the first light after a cold start, and a tool run's breath; tune `veilOpacity`'s mapping or `TOOL_BREATH` in `src/lib/stage/layers.ts` (update `__tests__/stage-layers-test.ts` with the new numbers) if anything reads wrong. Confirm in a screenshot that parallax and tilt no longer show an edge of the field. Check that the field stays inside the 8 MB allowance: compare `dumpsys meminfo` Graphics between `phase1` and `phase2`.
- [ ] **Step 4:** Commit with `git add docs/perf` and `git commit -m "docs(perf): phase 2 numbers and the Veil brightness judgment"`.

---

# Phases 3 to 5: outline and exit gates

Each of these gets its own detailed plan, written after the previous phase passes on the phone, because the numbers from the A54 change what is worth building. The outline fixes scope and gates; per-entry detail (triggers, timings, tokens, reduced-motion variants, cost classes) is in the motion draft, section 5.

### Phase 3: tokens, unified press/enter/exit, surfaces

Scope: the 11 motion tokens as one module (`src/lib/motion/tokens.ts`, replacing `Motion` in `src/constants/tokens.ts` and the deprecated `fast`/`slow`/`easing.spring`); a pinned test for the token values and the caps (concurrent animations, one loop, one Glint canvas, stagger of 6); the developer setting "New motion" (off by default) that gates phases 3 to 5 behind one flag; `PressableScale`, entering/exiting presets and `BaseSheet` retimed to tokens; surface rules (no backdrop blur anywhere, shadows only on modals, three surface levels, lit top edges that follow the field's colour a beat behind it); a lint or test that fails on `expo-blur`, `BlurView` or an animated elevation. Also: move parallax to a UI-thread scroll source (`useScrollOffset`) so the three tab screens, chat and terminal stop calling `useAmbientParallaxScroll`'s JS `setState`.
Exit gate: `npm run verify`; the full phase-2 scenario set passes on the A54 with "New motion" on and off; Ethan sees one consistent motion language.

### Phase 4: the hero moments (one at a time, in this order)

1. Send and Answer (M13 to M19, S3): swell layer (done in phase 2), thinking orb on the breath clock, orb handoff, speaking glow through the Veil, sheen sweep when the reply finishes.
2. The Ask (S4, M25/M26): the first field reaction (amber, held), card rise with the rationed spring, edge on the breath clock, approve shrinks to a chip. Needs an `approval` signal alongside `working`.
3. Changing Rooms (S2, M10/M11): hue crossfade shortened to `t.light` (600 ms), lit-edge relight, thread crossfade, crest settle.
4. The Call (S5, M52 to M57): the pool at 40% opacity, the central orb, level-driven rings in the Glint (extend `StageGlint` with the rings), mute and end. Needs the call level as a shared value.
5. First Light (S1, M1/M3): Veil warm-up shortened to 1800 ms, the hairline, the cascade.
Exit gate per moment: its `manual` scenario passes on the A54, with the governor forced to level 1 and level 2 as well; the moment's reduced-motion variant is tested; Ethan signs off the feel before the next moment starts. After the fifth, "New motion" flips on by default.

### Phase 5: the rest of the catalogue, by area

Chat (tool cards, errors, jump-to-bottom pill), composer, lists and drawers, sheets and menus, buttons and toggles, empty/loading/skeleton, Gate states, success and delight (M62 to M70). The D-gated items (D4 gradients, D5 smooth push-down, D6 route transitions, D7 the native 60 Hz cap, D8 night lamp and lamp-on-a-string, D9 call pool versus visible chat) are decided with a measurement each when their area is reached.
Exit gate per area: the scenarios for that area pass on the A54 at governor levels 0, 1 and 2; the motion draft's caps still hold.

---

## Self-review (run before handing this plan over)

**Spec coverage.** Engine (spec 3): field at 1/2 with upscaling (Task 1.1, 1.3), 24 per second with no idle sleep (1.3), governor (1.2, 1.3), Veil (2.1, 2.5), layer reactions for swell, parallax and tilt (2.4, 2.5), priority rule and field reactions (hue crossfade already exists; amber, failure and gate-hue reactions arrive with their hero moments in phase 4: stated in the outline), unchanged lamp colours (nothing edits `lamp.ts`). Surfaces and motion (spec 5): phase 3 and the outline. Verification (spec 7): harness (0.1 to 0.3), baseline (0.4), device gates (1.5, 2.7), CI covers pure logic only (every new `src/lib` module has a Jest test). Rollout (spec 8): phases 0 to 5 map one to one; the "New motion" setting is Phase 3. Unverified items (spec 9) are checked on the phone in 1.5 and 2.7. The reference prototypes (spec 6) are not in this plan: committing the labs to `tools/light-lab/` is a separate small task for after phase 2.

**Gaps found and handled.** The spec's "starts at 12 per second under battery saver" has no task: `expo-battery` is not a dependency, so it is deferred to phase 3 with the decision to add that dependency; the governor's level table already supports starting at level 1 (`initialGovernor(1)`). The dither on upscale is the shader's existing dither at the smaller size (the lab looked right at 1/2 this way); Task 1.5 checks banding on the phone and records it as a follow-up rather than changing the shader here.

**What was run when this plan was written (2026-11-07).** The new pure modules and their tests (Tasks 0.1, 1.1, 1.2, 2.1, 2.2, 2.3's signal change) were extracted into a scratch copy of the repo and run: 26 Jest tests across render-scale, governor, layers and refcount pass, the 6 `node --test` gfxinfo tests pass, the signals test passes with `stage-motion-test` (21 tests), and ESLint and `tsc --noEmit` are clean on them. The scratch copies were removed afterwards; nothing but the plan, the spec and the motion draft is in the tree. **Not run:** the `AmbientCanvas.native.tsx` wiring (Tasks 1.3, 2.5), `StageGlint.native.tsx`, the chat-screen edit, `run-scenario.ps1` (only its parse check is specified), and everything on the phone. Task 2.5's edit blocks are written against the file as Task 1.3 leaves it; if `tsc` or the pins disagree with a block, the instruction is to fix the block to match the code, not the reverse.

**Names used across tasks.** `STAGE_RENDER_SCALE`, `STAGE_OVERSIZE_DP`, `scaledCanvasSize`, `upscaleFactor`, `oversizedBox` (render-scale); `GOVERNOR`, `GOVERNOR_LEVELS`, `GovernorState`, `initialGovernor`, `governorAdvance` (governor); `FIELD_GAIN`, `LAYER_TIMING`, `TOOL_BREATH`, `SWELL_PEAK`, `veilOpacity`, `breathGain`, `swellOpacity`, `swellRise`, `swellScale`, `stageBaseCss`, `lightCss` (layers); `createRefCounter` (refcount); `useBreath` (breath); `signalWorking` and the `working` field (signals); `StageGlint` with props `swell`, `stageHeight`, `core`, `clear`. Each is defined in the task that first uses it and spelled the same afterwards.
