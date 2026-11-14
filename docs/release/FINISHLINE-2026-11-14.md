# Versutus app finish-line evidence — 2026-11-14

Status: native acceptance in progress. Local changes integrated through `baab934`; an additional measured drawer experiment is being evaluated. No publication or store release.

| Path | Observed result |
|---|---|
| Clean Android onboarding | Separate QA package and Gate home. Unreachable address stays editable and survives restart; rejected key stays in setup; corrected key reaches connected roster. |
| First real response | Free DeepSeek via isolated OpenCode: `Ready — café 🌙 你好.` rendered intact on A54; restart reconnects without setup. |
| Existing installation | Matching certificate upgrade retained saved Gate/Bots/data. Enabling phone Tailscale restored Home PC automatically. |
| Activity | Today/Routines composition; exact storage-home actions; partial Bot read warnings retained. Offline approval false-empty found physically and fixed with regression. |
| Routine execution | Dedicated QA Bot only. One unavailable free-model execution recorded failure; a currently zero-priced model produced `FINISHLINE_ROUTINE_OK` with completed durable execution. Native edit exposed structured-origin rendering crash; fixed and regression proved. Final packaged save/reopen/history acceptance pending. |
| Text | Demonstrated source mojibake fixed, AST guard; existing split UTF-8 transport regressions preserved. Real punctuation/emoji/Chinese reply rendered correctly. No historical text recovery claim. |
| Native shell | Dark three-button strip observed; system buttons retained. Long model/usage overflow found at font1.1 and fixed; final native 1.1/1.5 check pending. |

A54 SM-A546U1, Android16, arm64 release preview, main package `com.versutus.app`. Installed baseline was November12 `4e82510`, distinct from campaign source `6c899d7`. Paired cooled roster runs:

| Scenario | Baseline p95 ms (3 runs) | 805 p95 ms (3 runs) | 805 frames >=34ms | Existing budget |
|---|---|---|---|---|
| Roster idle |36/32/32|16/15/14|0/0/0|PASS 3/3|
| Roster slow scroll |44/42/40|19/20/18|1/0/2|FAIL 3/3|
| Drawer cycles |36/38/36|23/24/26|3/4/10|FAIL 3/3|

Budget is unchanged: >=95% frames <=16ms, p95<16.7ms, zero>=34ms. gfxinfo's 120Hz janky percentage is not this 60fps budget. Native idle figure work was the measured major contributor; lamp identity retained. No comparative parity claim.

Additional bounded observations: one QA long-markdown scroll capture p9516ms,96.1%<=16ms,zero>=34ms; broad keyboard/send/response capture p9519ms with18>=34ms, so no general pass. Cold Android activity launch old2796/2251/1595ms vs8051530/1238/1121ms; these are not full time-to-interactive. Idle PSS snapshot689MB->393MB (different runtime/cache state, not sole-cause attribution). Eight background seconds added zero frames.

Verification at baab934: `npm run verify` exit0 (914 app suites,8,923tests;2,582 Gate pass,1existing skip). Portal/visual at805: ALL PASS /7 of7. Main live Gate smoke after restart and Tailscale recovery: ALL PASS. Native-found fixes have focused red/green regressions and driver reruns. Independent small-fix review: no blocking findings. Final candidate verify passes915suites/8,928tests and unchangedGate2,582pass/1skip; all7visualjourneyspass.

Raw frame files: `docs/perf/raw/finishline-installed-cooled-roster-2026-11-14/` and `docs/perf/raw/finishline-805-roster-2026-11-14/`; verdict JSON siblings. Private screenshots/video/traces and host proof remain local under the original checkout `temp/finish-line/`; do not publish them blindly. Campaign ownership/resumption detail: `docs/plans/2026-11-14-app-finish-line.md`.

Routing: bounded Luna workers handled onboarding, Activity, figures/native bridge, and independent review; driver reproduced/checked/integrated and owns device acceptance. One text-only Grok review attempt truncated and hit its single-turn limit; it is not approval and was not repeated. Further Luna review found two initial race/stale-save bugs that were fixed with regressions. Full delegation ledger is local `~/.agent-router/ledger.jsonl`.

Final APK identity, final source SHA, final device checks, cleanup and remaining limitations will be filled after the last build; the805 APK is a pre-acceptance artifact.
