# EXEC BRIEF — Android widget plan (Hermes Agent · OpenCode Go · deepseek-v4.1-flash)

You are executing **`docs/plans/2026-09-12-android-widget-plan.md`**, the whole plan, task by task.

The plan is the spec. Follow its steps literally, using its code and commands:

1. Write the failing test.
2. Run it.
3. Implement.
4. Run it again.
5. Commit.

Deviate only when a step is impossible as written. Then take the smallest change that keeps the plan's intent, and record the deviation and its reason in the status log.

## Resume protocol — do this first, every time

A launcher restarts you whenever a session ends before the plan is finished (every session has a turn limit). Each start is a fresh session with no memory of the one before it.

1. Read `docs/plans/.widget-exec-status.md`, then run `git log --oneline -15` and `git status --short`.
2. Resume at the first task, in the order below, that has no DONE, DEFERRED, BLOCKED or PENDING-DEVICE block in the status log.
3. Treat uncommitted changes as the interrupted task's partial work, not noise.
   - Inspect them with `git diff` and keep what matches the plan.
   - Finish that task's remaining steps, including its tests and `npm run verify`, then commit.
   - Never discard them with `git checkout`, `git restore`, `git reset` or `git clean`.
   - Known on 2026-09-13: Task 0.4 was interrupted after it edited `__tests__/widget-target-test.ts`, `app.json`, `package.json` and `src/lib/widget/widget-device.ts`, deleted `src/components/widget/glanceable-widget.android.tsx`, and added `src/lib/widget/android-widget-payload.ts` and `__tests__/android-widget-payload-test.ts`. Resume there.
4. Never redo or recommit a task that is already DONE.

## Order of work

1. **Phase 0:** Tasks 0.1 → 0.2 → 0.3 → 0.4 → 0.5. Tasks 0.1–0.3 are DONE.
2. **Milestones M1 → M2 → M3 → M4 → M5.**
   - Before starting a milestone, expand its table rows into the plan's TDD step format.
   - Write the expansion to `docs/plans/2026-09-12-widget-m<N>.md`, commit it, then execute it.
3. **Skip M2 Task 2.3** (Start voice call button). The voice architecture is being redesigned and the signed launch key it needs does not exist yet. Log it as `DEFERRED — waits on the voice plan's launch key`.
4. **Device-only steps.** No phone is connected, so skip `adb install` and the Samsung checklist.
   - Do everything up to and including `assembleRelease`.
   - Write the checklist into `docs/plans/2026-09-12-android-widget-device-log.md` with every item marked `PENDING-DEVICE`.
   - Do not change `FUTURE-ITEMS.md` §4.
5. **M5 (iOS):** make the code change only, and log verification as `PENDING-MACOS`.

## Environment facts

- **Worktree:** this directory (`C:\Users\ethan\.codex\worktrees\bee6\Versutus`), branch `sprint/features-functions-ui`, Windows 11.
- **Shell syntax:** the plan's commands are PowerShell (`cd android; .\gradlew …`). In `cmd`, use `cd android && gradlew.bat …`.
- **The gate:** `npm run verify` must exit 0 before every commit.
- **Long commands run in the background, never in the foreground.** This covers Gradle (5–15 minutes), `npx expo prebuild --platform android --clean`, and `npm run verify`.
  - Start them with the terminal tool's `background=true` and `notify_on_complete=true`, and redirect output to a log under `docs/plans/`, e.g. `cd android && gradlew.bat :versutus-widget:testDebugUnitTest > ..\docs\plans\.gradle-widget.log 2>&1`.
  - Then call `process(action="wait")` and read the log's tail. Never use `nohup`, `start`, or a trailing `&`.
  - Record the exit code in the log (cmd: `… && echo EXIT=0 >> <log> || echo EXIT=1 >> <log>`).
  - A build has passed only when you have read `BUILD SUCCESSFUL` in its log. `npm run verify` has passed only when its log shows exit 0.
- **`android/local.properties`** is untracked and needs `sdk.dir=C:\\Users\\ethan\\AppData\\Local\\Android\\Sdk`. Recreate it after `expo prebuild --clean` deletes `android/`, and keep `ANDROID_HOME` set in the shell.

## Hard rules

1. **Stay inside this worktree.**
2. **Do not edit files another workstream owns:**
   - `modules/handsfree-voice/**`
   - `src/lib/voice/**`
   - `src/context/handsfree-voice-provider.tsx`
   - any `docs/plans/*voice*` file
3. **Git:** stage exactly the paths a step names (`git add <paths>`) and use the plan's commit message. Never push, amend, rebase, `reset --hard`, `clean`, `stash`, switch branches or delete branches.
4. **Never weaken a test to pass it.**
   - The one sanctioned exception is the explicit replacement of stub-era pins in Task 0.4 Step 6.
   - No `.skip` or `.only`, no `eslint-disable`, no `@ts-ignore`.
   - Do not lower `jest.coverageThreshold` or hand-edit `coverage-baseline.json`.
5. **Leave live systems alone.** Do not start, stop or restart the Versutus Gate, the Hermes gateway (never run `hermes gateway …`), OpenClaw, or any Windows service or scheduled task. Do not call the operator's live gateway. No `adb`.
6. **Dependencies:** only where the plan adds one (M3 `expo-task-manager`). Use `npx expo install expo-task-manager` so the SDK-57-compatible version is chosen.
7. **When a step fails:** if it still fails after two genuine fix attempts, log `BLOCKED: <task> — <exact error>` and move to the next task that does not depend on it. If nothing else can proceed, stop.

## Status log (required, never committed)

After every task, append one block to `docs/plans/.widget-exec-status.md`:

```
## <task id> — DONE | DEFERRED | BLOCKED | PENDING-DEVICE
commit: <sha or none>
verify: <last line of npm run verify>
gradle: <BUILD SUCCESSFUL | failure line | not run>
notes: <deviations, surprises>
```

## Finish

When everything that can run has run, append a summary to the status log. Its last line must be exactly one of the following, and print that same line:

- `WIDGET PLAN EXECUTION COMPLETE`
- `WIDGET PLAN EXECUTION STOPPED: <reason>`

The launcher stops restarting you only when it sees one of those lines in the status log.
