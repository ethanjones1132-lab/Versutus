# EXEC BRIEF — Remaining work sprint (OpenCode CLI · OpenCode Go · deepseek-v4.1-flash)

You are executing the remaining Versutus work in this worktree, **one task at a time**,
until the deadline **2026-09-13 13:00 local** or a provider rate limit.

The plans are the spec. Follow their steps literally, using their code and commands:

1. Write the failing test.
2. Run it.
3. Implement.
4. Run it again.
5. Commit.

Deviate only when a step is impossible as written. Then take the smallest change that
keeps the plan's intent, and record the deviation and its reason in the status log.

A parallel OpenCode run owns the Android widget in a **different** worktree
(`C:\Users\ethan\.codex\worktrees\bee6\Versutus`). Do not go there. Do not merge,
rebase, cherry-pick, or otherwise pull widget commits. Skip every widget item.

## Resume protocol — do this first, every time

A launcher restarts you whenever a session ends before the queue is finished. Each
start is a fresh session with no memory of the one before it.

1. Read `docs/plans/.voice-exec-status.md`, then run `git log --oneline -15` and
   `git status --short`.
2. If the status log has an **Operator continuation** block, that numbered list
   is the queue. A prior `DONE` that still says "Remaining:" is **not** finished.
   Otherwise resume at the first task, in the order below, that has no DONE,
   DEFERRED, BLOCKED or PENDING-DEVICE block.
3. Treat uncommitted changes as the interrupted task's partial work, not noise.
   - Inspect them with `git diff` and keep what matches the plan.
   - Finish that task's remaining steps, including its tests and `npm run verify`,
     then commit.
   - Never discard them with `git checkout`, `git restore`, `git reset` or `git clean`.
4. Never redo or recommit a task that is already DONE.

## Order of work

### Phase A — Hands-free voice plan (priority)

Execute **`docs/plans/2026-09-12-realtime-voice-plan.md`**.

1. **Phase 0:** Tasks 0.1 → 0.2 → 0.3 → 0.4 → 0.5 → 0.6 → 0.7 → 0.8 → 0.9.
2. **Task 0.10** is device-only. No phone is connected, so skip `adb install` and
   the Samsung checklist. Do everything up to and including `assembleRelease` if
   the plan requires a rebuild. Write the checklist into
   `docs/plans/2026-09-12-realtime-voice-device-log.md` with every item marked
   `PENDING-DEVICE`. Do not change `FUTURE-ITEMS.md` for a device-pending item.
3. **Milestones M1 → M9.**
   - Before starting a milestone, expand its table rows into the plan's TDD step
     format. Write the expansion to `docs/plans/2026-09-12-voice-m<N>.md`, commit
     it, then execute it.
   - **M1 S1** may spawn `codex app-server` as the plan writes. That is the only
     extra process this sprint may start. Do not start the Versutus Gate, Hermes,
     or OpenClaw.
   - **M1 S2** needs Ethan's fixture recordings. If
     `docs/plans/voice-spikes/fixtures/` is missing those recordings, log
     `PENDING-DEVICE` for the recording-dependent steps and continue with any
     synthetic-only steps the plan still allows. Do not invent recordings.
   - Device-only acceptance (Samsung call, lock-screen soak, Bluetooth) →
     `PENDING-DEVICE`. Still land the code, tests, and `assembleRelease`.
4. **M8 widget "Start voice call"** is in this plan. Implement the launch-key
   contract here. Do not edit widget module files; the other run owns those.

### Phase B — FUTURE-ITEMS.md, after the voice plan can go no further

Only start Phase B when Phase A is COMPLETE, STOPPED, or every remaining voice
task is PENDING-DEVICE / BLOCKED. Re-check the tree before building anything
listed here — `FUTURE-ITEMS.md` was last revised 2026-09-11 and some items may
already have landed (`f4bf7f0` shipped push, backend-locked models, and the
first hands-free call). If the named deliverable exists, log `DONE (already
shipped)` with the file evidence and skip it.

Work in this order:

1. **Runs are broken — slash commands not recognized** (`FUTURE-ITEMS.md`,
   2026-09-11). Diagnose the dispatcher; do not invest in run execution.
   Must still keep the hold-to-talk composer path and the shipped B1–B3 voice
   loop working.
2. **Item 8 — Siri / Android app shortcuts** on the existing deep-link router.
   Must still reuse `src/lib/gateway/deep-link.ts`; do not add a second router.
3. **P3 — Session search, pinning, rename.**
4. **P2 — Memory manager per Bot** (read-first).
5. **D5 — Budgets with hard stops** — VERIFY STATE FIRST. If the enforcing
   pre-run check already exists, log that and skip.
6. **P1 — Multimodal composer**, capability-gated.
7. **D1 — Approval inbox with policies and audit.**
8. **D8 — Deferred-execution queue.**
9. **D6 — Bot handoff packets.**
10. **D7 — Council mode.**
11. **D2 — Fleet constellation.**
12. **Workflows**, then **Activity tab becomes cron view** — only after the
    slash-command regression is actually fixed. Design before building; if a
    spec does not exist, write `docs/plans/2026-09-13-<name>.md` (plan only,
    one commit) then execute it.

**Skip always:** Android home-screen widget (the other run); wake word / always-
listening; image/video generation; anything in `FUTURE-ITEMS.md` "Explicitly
considered and ruled out" or "What we deliberately do NOT copy".

If Phase B has no specced TDD steps, write a short plan in `docs/plans/` first
(failing test → implement → verify → commit), commit the plan, then execute it.
Do not improvise a multi-file rewrite without that plan.

## Environment facts

- **Worktree:** this directory (`C:\Users\ethan\.codex\worktrees\voice\Versutus`),
  branch `sprint/voice-2026-09-13`, Windows 11. Deadline 2026-09-13 13:00 local.
- **Your shell tool runs Windows PowerShell 5.1.**
  - There is no `&&` or `||`. Chain commands with `;` and read `$LASTEXITCODE`
    after a native command.
  - Plan commands that use bash `&&` must be rewritten as PowerShell `;`.
- **Every shell call is capped at 10 minutes** (`timeout` may not exceed 600000).
  Anything that can run longer must use the long-command helper:
  - It covers `npm run verify`, every Gradle command, and
    `npx expo prebuild --platform android --clean`.
  - Start: `node docs/plans/.run-long.mjs start <name> <dir> '<command>'`.
    `<dir>` is relative to the repository root; single-quote the command.
    Examples:
    - `node docs/plans/.run-long.mjs start verify . 'npm run verify'`
    - `node docs/plans/.run-long.mjs start gradle-voice android '.\gradlew.bat :handsfree-voice:testDebugUnitTest'`
    - `node docs/plans/.run-long.mjs start prebuild . 'npx expo prebuild --platform android --clean'`
  - Poll: `node docs/plans/.run-long.mjs wait <name> 540`. It prints the log tail
    and ends with `FINISHED <name> EXIT=<code>`, or `STILL RUNNING <name>`. If it
    says still running, run the same wait again. Never start the same command twice.
  - A step has passed only when its `FINISHED` line shows `EXIT=0`. For Gradle,
    `BUILD SUCCESSFUL` must also be in the log.
- **Short commands** (a single `npx jest <file>`, git, reading files) run in the
  foreground as normal.
- **Toolchain:**
  - JDK 21 is installed (`C:\Program Files\Java\jdk-21.0.10`), and the launcher
    sets `JAVA_HOME` and `ANDROID_HOME`.
  - `android/local.properties` is untracked and needs
    `sdk.dir=C:\\Users\\ethan\\AppData\\Local\\Android\\Sdk`. Recreate it after
    `expo prebuild --clean` deletes `android/`.
- **The gate:** `npm run verify` must finish with `EXIT=0` before every commit.
  Capture the exit code directly — never pipe it through `tail` or `head`.
- **Expo SDK 57.** Read https://docs.expo.dev/versions/v57.0.0/ before writing
  Expo code (`AGENTS.md`).

## Hard rules

1. **Stay inside this worktree.**
2. **Do not edit files the widget run owns:**
   - `modules/versutus-widget/**`
   - `src/lib/widget/**`
   - `src/components/widget/**`
   - any `docs/plans/*widget*` file
   - the launcher and helper files `docs/plans/.run-*`
3. **Git:** stage exactly the paths a step names (`git add <paths>`) and use the
   plan's commit message. Never push, amend, rebase, `reset --hard`, `clean`,
   `stash`, switch branches or delete branches. Never commit the status log, the
   launcher, or `docs/plans/.long-*.log`.
4. **Never weaken a test to pass it.**
   - No `.skip` or `.only`, no `eslint-disable`, no `@ts-ignore`.
   - Do not lower `jest.coverageThreshold` or hand-edit `coverage-baseline.json`.
   - Do not delete or hollow out tests.
5. **Leave live systems alone.**
   - Do not start, stop or restart the Versutus Gate, Hermes (never run
     `hermes …`; it is being updated), OpenClaw, or any Windows service or
     scheduled task.
   - Do not run `opencode` yourself.
   - Do not call the operator's live gateway. No `adb`.
6. **One item per session when possible.** A tight green commit is worth more
   than a sprawling red one. If a task is bigger than one session, finish a
   genuine slice, commit it, and leave the rest for the next session.
7. **When a step fails:** if it still fails after two genuine fix attempts, log
   `BLOCKED: <task> — <exact error>` and move to the next task that does not
   depend on it. If nothing else can proceed, stop.
8. **Honestly blocked is a good session.** Faking green is the only unforgivable
   act. An item that cannot be proven by a test is not a licence to run the
   live Gate.
9. **Must-still-work.** Every change must keep typed chat, hold-to-talk
   dictation (B1), read-aloud (B2/B3), pairing, and the widget *code you did
   not touch* working. Do not branch app code on backend names.

## Status log (required, never committed)

After every task, append one block to `docs/plans/.voice-exec-status.md`, keeping
the existing format:

```
## <task id> — DONE | DEFERRED | BLOCKED | PENDING-DEVICE
commit: <sha or none>
verify: <FINISHED verify EXIT=… line>
gradle: <BUILD SUCCESSFUL | failure line | not run>
notes: <deviations, surprises>
```

## Finish

Do **not** print a final line because a remaining surface "needs a dedicated
session", is "optional polish", is "multi-session UI", or is "blocked because
the brief did not allocate backend work". D1 / P2 / P1 are in scope: build the
missing Gate substrate, then the app surface. Keep going one task at a time
until 13:00.

When everything that can run has run, or the remaining work is all
PENDING-DEVICE / BLOCKED **including** the D2 render, D7 compare view, D6
import, and Activity cron view, append a summary to the status log. Its last
line must be exactly one of the following, and print that same line:

- `REMAINING SPRINT EXECUTION COMPLETE`
- `REMAINING SPRINT EXECUTION STOPPED: <reason>`

The launcher stops restarting you only when it sees one of those lines in the
status log. If `.voice-exec-status.md` contains an **Operator continuation**
block after a withdrawn stop, ignore the withdrawn stop and resume at the
continuation's numbered list.
