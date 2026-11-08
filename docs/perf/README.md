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
