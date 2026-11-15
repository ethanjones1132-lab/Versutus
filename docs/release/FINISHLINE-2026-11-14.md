# Android preview — 2026-11-14

The final software candidate is built and verified. Physical acceptance of this exact revision remains blocked by the A54 disappearing from USB. No publication was performed.

## Build

- Source: `b35ffd9031ce82e29848b21aacbd4a788672ca84` on `codex/app-finish-line`, integrated locally into main.
- APK: `C:/Projects/Versutus/output/versutus-finishline-b35ffd9-arm64-2026-11-14.apk`
- SHA-256: `589b25a450370753ff3dd74cc075b85816d5c4a4e7a0398a10a4ba947d0c00f9`
- Size: 64,524,098 bytes. Package `com.versutus.app`, version 1.0.0/code 1, arm64-v8a, target SDK 36.
- Signature verified and certificate matches the existing installed app. This is a local preview. The last revision installed during this campaign was `b53de70`; the final APK awaits installation.

## Changes

- Guided PC address/key setup and a copy-ready host guide. Failed attempts retain drafts and their explicit destination. Setup completes only after connection; retries cannot silently select another saved Gate.
- Activity uses Today/Routines, retaining live approvals and runs. Every Routine action, edit and transcript read carries its backend and Bot storage home. Partial reads remain visible, and offline approvals show a connection prompt.
- Routine editing accepts real Hermes schedule/origin shapes, preserves owners and refused drafts, and protects confirmed saves from stale rereads. Paused routines stay listed and show “Paused” instead of a stale next-run date.
- Details read the full scoped host record and show its authoritative latest run. Accepted requests are distinguished from confirmed starts. Refreshes run independently, and resumed reminders use the refreshed host schedule.
- Demonstrated source mojibake is fixed and guarded. No historical persisted-text repair is claimed.
- Idle figures keep seeded finite blinking, wake, thinking and reaction behavior. Idle waits now use cancellable timers; foreground and route gates suspend retained animation. The lamp remains intact. An unsuccessful lamp-pause experiment was measured and reverted.
- The Android three-button strip stays dark, with buttons and insets retained. Long model/usage header overflow was fixed and checked at the phone’s normal 1.1 text scale.

## Evidence

Clean Android QA reached a real free-model reply: `Ready — café 🌙 你好.` and reconnected after restart. Wrong address and rejected key stayed in setup. A later free-service quota error remained visible.

A dedicated Hermes Routine produced `FINISHLINE_ROUTINE_OK` with a completed durable execution. Provider failure was also observed. Actual phone Edit/save persisted a new name and cron expression; host pause/resume/reopen checks passed, including recalculation to 09:30 with the host’s `-05:00` offset.

A54 SM-A546U1, Android 16, arm64 preview. The installed baseline was November 12 `4e82510`, distinct from initial source `6c899d7`.

| Scenario | Cooled baseline p95 ms | Integrated `805249c` p95 ms | Frames >=34 ms | Budget |
|---|---|---|---|---|
| Roster idle | 36 / 32 / 32 | 16 / 15 / 14 | 0 / 0 / 0 | Pass 3/3 |
| Slow roster scroll | 44 / 42 / 40 | 19 / 20 / 18 | 1 / 0 / 2 | Fail 3/3 |
| Drawer | 36 / 38 / 36 | 23 / 24 / 26 | 3 / 4 / 10 | Fail 3/3 |

The unchanged budget requires at least 95% of frames <=16 ms, p95 <16.7 ms, and zero frames >=34 ms. These results precede the final idle-timer change; its A54 benefit remains unmeasured. No comparative parity is claimed.

One long-markdown scroll capture met the budget; the broader keyboard/send/response capture did not. Cold activity-launch samples improved from 2796/2251/1595 to 1530/1238/1121 ms; these are not full time-to-interactive. Eight background seconds added zero frames.

Final `npm run verify` passed: 914 app suites, 8,939 tests; 2,582 Gate tests passed with one existing skip. Coverage held without lowering thresholds. Portal and all seven visual journeys passed. Final independent review found no blocking issues. Live Gate smoke passed on the warm rerun; the preceding cold model-catalog read exceeded its eight-second timeout.

## Open checks and cleanup

- Reconnect/unlock the A54, install the final APK, and measure idle/scroll/drawer after the timer change. Check latest-run refresh on the final sheet, 1.5 text scale, and OS reduced motion. No configured emulator was available.
- Existing 1.1 text scale, absent animator-duration override and stay-awake value 15 were preserved. The 1.5 attempt failed before its first setting write. No network ADB mode was enabled. Remove the isolated `com.versutus.app.finishline` package when the device returns.
- Hermes 0.23’s HTTP session records do not expose Routine correlation for canonical session IDs. The app shows the host’s latest run and explicitly marks earlier conversation-transcript coverage as incomplete; it does not invent links.
- QA Gate 8761 is no longer running and its distinct bootstrap token was removed. Automatic approval review blocked recursive removal of the unused cache, reporting “blocked by policy”; that cache remains local.
- Supported deletion marked the dedicated `finishline-qa-20261114` profile deleted, but its live Hermes multiplexer still holds the directory. Filesystem/identity cleanup remains pending. Retry the supported profile-delete command after that gateway releases the home; do not stop unrelated live work to force removal. Test jobs were paused or terminal at their last confirmed read.
- Main Gate/Hermes listeners remain on 8760/8642. Existing keys, default model pins, jobs and app data were not reset.

Raw frame verdicts and dumps are in `docs/perf/finishline-*.json` and `docs/perf/raw/`. Private screenshots, recordings, traces and host proof remain in the original checkout’s `temp/finish-line/`. Resumption details are in `docs/plans/2026-11-14-app-finish-line.md`.

## Routing log

- Luna, xhigh — bounded onboarding, Activity, avatar/native-bridge slices — accepted after focused regressions; driver completed final integration.
- Luna, xhigh — independent targeted reviews — race, stale-save and stale-detail findings fixed; final review found no blocking issues.
- Grok, medium — one text-only review of the initial consequential diff — truncated/turn limit, not approval; not repeated.

The full local delegation ledger is `C:/Users/ethan/.agent-router/ledger.jsonl`.
