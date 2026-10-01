# Failure audit 2026-10-01 - final report (round 2)

Branch `claude/app-failure-audit-fc957c` (on top of round 1; **not deployed**, pushed to `origin/master` and the branch).
Companion docs: [the list](failure-audit-2026-10-01-second-pass.md) (where / what / why per finding, with a *Fix status* line) and [the fix log](failure-audit-2026-10-01-second-pass-fixes.md) (diagnosis and fix per finding).

## Result

135 findings from the second scan: **121 fixed, 11 partly fixed, 3 not fixed**, in 30 work packages. Nothing was run on a phone.

| Not fixed | Why |
|---|---|
| R2-OC-10 the picked model never reaches the OpenClaw wire | The repo has no protocol evidence that `chat.send` takes a model; inventing a wire field is unsafe. Needs the OpenClaw protocol or a product call (a visible "model not supported here"). |
| R2-NOTIF-06 an approval action tapped after Android killed the process is dropped | Needs a headless task that can decide an approval fail-closed with no UI - a design of its own. |
| R2-NW-V1 the pushed widget approval count is host-global | The Gate cannot scope to what this phone started; a product decision. |

The 11 *partly fixed* are each a deliberate boundary named in the fix log - for example the OAuth registration is still inert by design (only its leaked listener was fixed), `verifyInvocationToken` still has no production caller (the feature gap, not a defect), HANDSFREE-3's sentence scan is incremental but the per-delta prefix proof is still linear in the reply, the Live Activity update is not throttled with the tray notice, and local bot-message notices still lack the Reply category.

The headline fixes:
- **Gate:** Stop now kills the Claude Code process (it kept working in the workspace); a hung Codex handshake no longer spawns a new process on every retry; the run archive pruned by a field it never wrote and deleted the wrong runs; finished runs released nothing (their decrypted keys stayed in memory forever); every record write that deleted the file before renaming is atomic now; a disabled provider no longer answers and its model list is not erased by a refresh; a failing provider stream is recorded as failed; concurrent provider state updates no longer overwrite each other; vendor calls are bounded and the DPAPI helper cannot hang; the service supervisor survives a failed spawn.
- **OpenClaw:** a turn always settles (it hung the composer forever after a socket drop); a refused credential stops retrying and keeps its message; half-open sockets are detected and a reconnect reloads the thread; failed reads are errors, not empty lists (which opened a new session every time); the tailnet-IPv4 fallback works for this dialect.
- **Phone:** the App-lock switch takes effect (it was inert until a cold start); a restored run is no longer reported as failed; Pause/Resume notices were inverted; approval-decision history could be erased by one failed read; every haptic call now goes through the safe wrapper (a missing vibrator module silently killed buttons, including the Home buttons that open Fleet and Council); the widget retries a refused write, its five-minute floor actually fires, and a push no longer wipes the card; Council can no longer create two rooms or leak a prompt-named room; Runs/Spend/Activity stop fanning out duplicate reads against the single-threaded Gate; the hands-free notification Mute worked backwards.

## How it was done

Free `opencode` models (**space-bunny-free** wrote almost everything; **longcat-2.5-preview-free** stalled or returned nothing on most runs and was retired from the work) scanned, wrote the fixes and reviewed them; Claude supervised, read the diffs of the risky ones, spot-checked claims and resolved integration problems.
Each scan was verified by a second model session that re-read the cited code (it corrected several claims and added 25 new defects); the Fleet / Council / Compose / Onboarding area could not be verified that way (its verifier timed out twice), so its findings are scan-only and four were re-read by Claude.
Each package ran behind a harness the author cannot edit (typecheck, ESLint, related tests, diff guard) and was then reviewed by a separate session that traced the real code path. **11 reviews failed 10 packages**, each with a reproduced defect that was repaired and re-reviewed before landing, for example:
a redaction helper that leaked every secret containing a regex character; a widget companion that the phone's parser would have refused entirely; an OpenClaw session pin written to a copy the app never reads; a haptics-style "fix" whose test hid that the Retry button unmounts the moment it is tapped; a freshness stamp written by a wave that read nothing, which would have kept the Runs scorecards empty for a minute after every reconnect; an abort that never reached the retry ladder it was meant to stop.

## Verification

On the tip: `verify-config`, `tsc`, ESLint (0 errors), the full jest suite with coverage and the ratchet, and the Gate suite (1,469 tests) - see the last section of the fix log for the final run. Integration found three problems no single package could see (two tests mocking modules whose exports changed under them, one race-prone supervisor test); all three were test-only. The Kotlin changes were compiled and unit-tested by their reviewers; the Swift changes (iOS) could not be compiled on this machine and are the least verified part of this round.

## What still needs a device

Everything marked `[device?]` in either list. In order of value, after the round-1 list: hands-free call mute from the notification (once calls open), widget after a push while the app is closed, Settings -> App lock on/off then background, a Council round with Stop, an OpenClaw gateway drop mid-turn, and the Runs screen right after a reconnect.

## Deploying

The Gate fixes are in master but the live Gate runs the old code until it is restarted (`service stop` then `service start` from a checkout that has them, then prove 15 routable bots, per the Gate runbook). Nothing was restarted.
