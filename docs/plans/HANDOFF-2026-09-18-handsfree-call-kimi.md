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

## Round 2 (Kimi, finished by Claude)

Kimi ran out of its usage window after 5 commits and one uncommitted Kotlin change. Claude
committed the Kotlin change, fixed the host harness and ran the final gate. Branch
`fix/handsfree-call-start` now has 8 commits on master `173b780` (25 files, +1865/−196).

| Commit | What |
|---|---|
| `a37afb5` | Grok: a PC-powered call names why it cannot start and does not wait on the phone recognizer |
| `d120a20` | Grok: a voice session start or failure is written to the Gate log |
| `0fbead7` | Kimi: a failed availability read no longer blocks a PC-powered call |
| `68b2c5f` | Kimi: a dropped media socket rejoins the call inside the Gate resume window |
| `08f6272` | Kimi: a grant that never attaches stops blocking new starts |
| `4eb0c31` | Kimi: the Gate call loop survives the turns the start fix never reached (turn watchdog, one terminal end) |
| `f228415` | Kimi: a hang-up the operator asked for is not a voice error |
| `092c17e` | Kimi's code, committed by Claude: a Gate call with no audio device, or a link closed without an `ended` frame, ends instead of hanging |

**Verified on the host (2026-09-19):**
- `npm run verify` green on `092c17e` (1085 Gate tests, 0 failures, no ratchet drift).
- The Android Kotlin compiles (Kimi, on a scratch copy of the main repo's android project, restored).
- A real voice-worker harness (`temp/worker-harness-round2.mjs`, not in verify) ran against the
  installed venv and models. Whisper loaded on CUDA. Kokoro spoke a sentence (90 KB PCM in 1.3 s),
  that PCM was fed back as mic audio, and `voice.final` returned the exact sentence.
  Kimi's first run reported "0 bytes of PCM". That was a harness bug (it parsed stdout per chunk
  without line buffering, dropping the large audio lines). The Gate's `jsonrpc-stdio` buffers
  correctly.

**Still needs the phone:** the real tap, the mic prompt and the foreground notification, audio
over the live Gate, barge-in by voice, backgrounding mid-call. **Deploy note:** the Gate-side
fixes (logging, watchdog, grant TTL) only take effect once the Gate runs this code, which means
merging to master and then `service stop` + `service start`.
