# Execution brief — hands-free background voice chat

Execute the implementation plan at `docs/plans/2026-09-11-handsfree-voice.md`
in this repo, in order, Step 1 through Step 8.

That plan went through three authorship passes: an initial architecture
decision (client-side half-duplex, not a realtime-provider route), a
seamlessness pass grounded in checked documentation of current voice-assistant
behavior, and a second independent review that found and fixed several real
"declared but never wired" bugs (an `endRequested` event nobody consumed, a
fresh message id that would have silently dropped the user's turn, a grace
window that was a no-op on iOS, a phase transition timed on the wrong signal).
Every correction in the plan is inline-marked "(Corrected/Added 2026-09-12
second review: ...)" with the exact file/line it is grounded in — these have
been independently verified against the actual current code, not just
asserted. **Treat the plan as authoritative. Do not redesign it, do not
"simplify" a fix back to what it corrected, and do not reopen the (a)/(b)
architecture decision in the Decision section.**

## The one real platform limit — be honest about it, don't work around it

This is a Windows machine. **iOS Swift code cannot be compiled or tested
here** — the plan's own Step 3 verify line says so ("build iOS in Step 8
because this checkout is on Windows") and Final verification item 3 requires
an iOS build on macOS or EAS. Write the iOS Swift files completely and
correctly per the plan — do not skip them — but do not claim they were built,
compiled, or tested here, because they cannot be. Your final report must state
plainly which platform's work is verified (Android + all pure TypeScript/Jest
logic, which run fine on Windows) and which is written-but-unverified (iOS
native code, pending a macOS/EAS build the operator will run separately).

## Hard rules

- Implement ONLY what the plan specifies, in the order given. Each step names
  its own files and its own verification — run each step's verification as
  you finish it, not only once at the very end.
- Do not modify `package.json` or run `npm install` unless a step's own file
  list explicitly requires it — check first; the plan is deliberately designed
  to add zero new JS dependencies (the native module uses the Expo Modules API
  and platform APIs directly, and the send earcon and barge-in VAD are native
  code, not new npm packages).
- Do not touch `README.md` or `FUTURE-ITEMS.md` until Step 8, and Step 8 not
  until you have actually run Final verification items 1 and 2 (the ones
  achievable on this machine) and they pass. Step 8's own text says do not
  claim B4 (full realtime voice) as closed by this work — it is not.
- If a step's premise turns out to be false — a cited file/line has drifted,
  a function signature differs from what the plan quotes, a referenced type
  does not exist under the name given — STOP and report exactly what you
  found. Every specific citation in this plan (line numbers, function names)
  was checked against the code as of 2026-09-12; if your read of the file
  disagrees, trust what you see and say so, don't silently paper over it.
- Follow the plan's own internal cross-references literally. Where it says a
  later step consumes something an earlier step produces (e.g. Step 1 declares
  events, Step 4's reducer names what each one does, Step 6 wires phase
  transitions to native calls) — verify the thing named in the earlier step
  is actually what the later step expects, the same class of check the second
  review already made once. Don't introduce a new version of that same bug.
- No code anywhere may branch on `hermes`, `opencode`, `codex`, or
  `claude-code` by name. No wake word, no always-listening, no automatic
  background start. Auto-send only inside an explicitly-started call session —
  the ordinary composer dictation path keeps its "never auto-send" behavior
  completely unchanged; regression-check this explicitly (Final verification
  item 9).
- Commit nothing. Leave all changes in the working tree.
- Other completed workstreams (widget, push notifications, backend-locked
  model selection) already show as modified/untracked files in `git status` —
  those are finished, unrelated, already-verified work. Do not touch them, do
  not "clean up" anything in them, and do not let their presence confuse which
  files are yours.

## What "done" means for this dispatch

Steps 1–7 implemented and their own verifications passing on this machine
(Android build/tests, all Jest, all pure-TS logic). Full `npm run verify`
green. Step 8 (docs) only after that, with the exact honesty constraints its
own bullets specify. iOS Swift files written per the plan but explicitly
flagged as unverified-on-this-machine in your final report — that is a correct
and expected outcome here, not a failure to hide.

## Report when done

Steps completed, files changed (grouped by the plan's own step numbers), test
results per step, the full `npm run verify` result, the Android Gradle
build/test result, explicit confirmation of what was NOT verifiable on Windows
(iOS build) and why, and anything you stopped on because a premise didn't hold.
