# HANDOFF — Hands-free calling, round 2 (for Kimi, after Grok 4.6)

Written 2026-09-18 by Claude. Read the round-1 brief first:
`C:\Projects\Versutus-pending\docs\plans\HANDOFF-2026-09-18-handsfree-call-grok.md` (the goal,
the verified facts and the rules). **All of its rules still apply.**

## Where Grok left it

Branch `fix/handsfree-call-start`, worktree `C:\Projects\Versutus-handsfree-call`. **Continue on
that branch in that worktree.** Grok made 2 commits on top of master `173b780` (19 files, +1195/−175),
and `npm run verify` was green:

- `a37afb5` fix(voice): a PC-powered call names why it cannot start and no longer waits on this
  phone's recognizer
- `d120a20` fix(gate): a voice session start or failure is written to the Gate log

Grok's root cause, which you should verify rather than trust:
- On a Gate-powered (`local`) call, the phone required on-device `SpeechRecognizer` and TTS
  **before** calling `voice.session.start`.
- Every `voice.session.start` error was swallowed (`catch { grant = null }`).
- A grant that failed to open media was never stopped, so the next tap hit a silent
  `call_in_progress`.
- Gate calls skipped the foreground session (no mic prompt, no survival in the background).
- The Gate never logged voice.

New files: `src/lib/voice/handsfree-start-attempt.ts` and `src/lib/voice/handsfree-start-reason.ts`.

## Your job

Grok fixed **starting** a call. Ethan asked for **full end-to-end coverage and fixes**. Finish it:

1. **Review Grok's two commits critically.** Look for regressions, a gate kept green by a weak
   test, dead paths, and copy that is still wrong for an engine. Fix what you find in new commits
   rather than rewriting its history.
2. **The rest of the call, not only the start.** On each engine (`local`, `codex`, `phone`, `auto`),
   trace and test the whole loop: mic → audio to the Gate → STT → Bot turn through the normal chat
   path → reply → TTS on the phone → next turn → hang up → transcript in the thread. Fix every break.
3. **The failure modes the start fix did not cover:** barge-in, a dropped connection mid-call,
   backgrounding and returning, the host voice worker crashing mid-call, a reply that never
   arrives, hang-up during a reply, and a second call right after a failed one.
4. **Host side of `local`.** Check that `gate/voice-worker` (Python) starts, that its models
   resolve, and that `voice.capabilities` tells the truth. You may start the worker **in a test
   harness** to prove this. Do **not** touch the live `VersutusGate` service.
5. **Tests at every seam**, fake-engine based, that assert a call **opens and completes a turn**,
   not just that no error appears.

## Working limits

- The Kimi subscription has a **5-hour usage window**. Run **one agent at a time**, with no
  parallel subagent fan-out. Commit as you go so a cut-off loses nothing.
- `npm run verify` must be green on every commit, and must not be weakened.
- When done, append a `## Round 2 (Kimi)` section to the bottom of **this file** with the commits,
  what you verified, and what still needs a phone to confirm.
