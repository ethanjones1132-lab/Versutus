# Performance runs (A54)

The bar (spec section 7): per scenario, 3 runs of 10 s. Every run needs at least 95% of frames in budget,
p95 frame time under 16.7 ms (whole milliseconds, so 16 or less) and zero dropped frames. The new layers
add under 8 MB. An idle screen runs zero Reanimated animations apart from the 24-per-second drift. The
thresholds live in `scripts/perf/gfxinfo.mjs` (`THRESHOLDS`); change them there and say why in the commit.

**The A54 runs at 120 Hz**, so gfxinfo's own "Janky frames" counts every frame over 8.3 ms and calls a
smooth 60 fps lamp 80% janky. The verdict therefore uses the frame-time HISTOGRAM instead: "in budget" is
the buckets at or under 16 ms, and a "dropped" frame is one in a bucket at or over 34 ms (two or more
missed 60 Hz frames). gfxinfo's janky % is still reported in the JSON but is not judged. (2026-11-08: the
first runs were judged on janky % and failed everything, including a build that was fine at 60 fps.)

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

Unpaired test builds (`com.versutus.perfa` baseline, `com.versutus.perfc` phase 1), release, A54 at 120 Hz, 2026-11-08, whatever screen an unpaired app opens (no Gate, no long thread). Phase 1 here is before the tilt and scroll writers move to a transform (task 2.5).

| Build | Scenario | Result (worst run unless stated) | Verdict | Notes |
|---|---|---|---|---|
| baseline (master 594e501) | idle | in budget 0% worst run; p50 97 ms, p95 105 ms; 309 frames at 34 ms or more (worst run); 307-312 frames per 10 s | FAIL | |
| phase 1 (a783d12) | idle | in budget 73% worst run; p50 13 ms, p95 30 ms; 15 frames at 34 ms or more (worst run); 345-348 frames per 10 s | FAIL | |
| baseline (master 594e501) | scroll | in budget 0% worst run; p50 77 ms, p95 101 ms; 351 frames at 34 ms or more (worst run); 331-351 frames per 10 s | FAIL | |
| phase 1 (a783d12) | scroll | in budget 64% worst run; p50 14 ms, p95 48 ms; 56 frames at 34 ms or more (worst run); 355-561 frames per 10 s | FAIL | |
| baseline (master 594e501) | fling | in budget 0% worst run; p50 81 ms, p95 105 ms; 402 frames at 34 ms or more (worst run); 332-402 frames per 10 s | FAIL | |
| phase 1 (a783d12) | fling | in budget 69% worst run; p50 12 ms, p95 42 ms; 50 frames at 34 ms or more (worst run); 535-693 frames per 10 s | FAIL | |
| baseline (master 594e501) | drawer | in budget 0% worst run; p50 81 ms, p95 109 ms; 414 frames at 34 ms or more (worst run); 343-418 frames per 10 s | FAIL | |
| phase 1 (a783d12) | drawer | in budget 65% worst run; p50 13 ms, p95 38 ms; 45 frames at 34 ms or more (worst run); 601-717 frames per 10 s | FAIL | |
| phase 2 (2188494) | idle | in budget 41% worst run; p50 19 ms, p95 40 ms; 44 frames at 34 ms or more (worst run); 420-430 frames per 10 s | FAIL | |
| phase 2 (2188494) | scroll | in budget 55% worst run; p50 15 ms, p95 34 ms; 62 frames at 34 ms or more (worst run); 498-1119 frames per 10 s | FAIL | |
| phase 2 (2188494) | fling | in budget 56% worst run; p50 15 ms, p95 32 ms; 30 frames at 34 ms or more (worst run); 521-685 frames per 10 s | FAIL | |
| phase 2 (2188494) | drawer | in budget 61% worst run; p50 14 ms, p95 36 ms; 41 frames at 34 ms or more (worst run); 636-719 frames per 10 s | FAIL | |

**Phase 2 did not beat phase 1 on this measurement.** Idle fell from 73-80% in budget to 41-49%, and the share of GPU frames over 16 ms went from 7% to 39% (idle run 1). Frames per 10 s rose from about 345 to about 425. Memory is the same. So the added layers (full-screen Veil, oversize field wrapper, Glint canvas) cost GPU time; cause not yet isolated. Phase 1 numbers were taken earlier in the same session, not alongside.

## Bisect of the phase-2 idle regression (2026-11-08)

Idle, 3 runs each, builds alternated in opposite orders across passes (labels `bisect<pass>-<build>`). Findings:
- Removing the Veil, the Glint canvas, or the wrapper's transform does NOT restore phase-1 numbers (phase 2: 38-48% in budget; no Veil 35-39%; no Glint 44-52%).
- Phase 1 plus ONLY the phase-2 shader inputs (constant gain 1.14, no swell, scroll and tilt fixed at 0) is the worst build: 7-10% in budget, about 212 frames per 10 s, 83-88% of GPU frames over 16 ms.
- Phase-2 geometry with the phase-1 shader inputs restored is as good as phase 1 (60-74%).
- So the layers are not the cost. When the shader's inputs change only on the 24-per-second clock, each draw shows as an expensive GPU frame (about 30 ms); when tilt and scroll keep nudging the inputs, the same app shows cheaper frames. The idle metric is therefore flattered by the tilt writes and cannot be read alone. The real cost is the shader draw itself.
- The phone warms during a session: phase 1 drifted from 79-85% to 62-77% in later passes. Always compare builds run in the same session, in balanced order.

