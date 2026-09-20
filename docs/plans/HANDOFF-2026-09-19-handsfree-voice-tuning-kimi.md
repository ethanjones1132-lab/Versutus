# HANDOFF — Hands-free calling is finicky: listening too touchy, sending takes forever

Written 2026-09-19 by Claude, for Kimi K2.8 Preview (the `kimi-code/kimi-for-coding` alias). Third round. Read the two earlier briefs first —
they hold the rules and the history:

- `HANDOFF-2026-09-18-handsfree-call-grok.md` (goal, rules, voice direction)
- `HANDOFF-2026-09-18-handsfree-call-kimi.md` (rounds 1 and 2, with the commit list)

**All the rules in the first brief still apply**, in particular: `npm run verify` green on
every commit and never weakened, Expo v57 docs before native work, worklets call worklets,
and **do not touch the live Gate service, the Hermes fleet, or the phone build** — Ethan
deploys and tests on the device.

## Ethan's words, 2026-09-19

> "Still a bit finicky, listening seems very very touchy, sending takes forever."

A call now starts, reaches Hermes and holds a session. What is left is the feel of it:
the PC hears too much, and a turn takes too long to come back.

## The state of the code

Everything below is on **master** (`cb040c5`), deployed to the live Gate, and in the APK
`versutus-speaker-hermes-897b98d.apk` on Ethan's phone (the worker and Gate fixes after
that APK are host-side and need no rebuild).

Commits this session, newest first:

| Commit | What |
|---|---|
| `cb040c5` | PC engine: 250 ms to open an utterance, <400 ms is not a turn, Whisper silence segments dropped, 400 ms pre-roll |
| `2add026` | Gate logs each step of a call (audio, finals, first reply, speech, end reason) |
| `897b98d` | Loudspeaker unless a headset is connected |
| `4422ef7` | A failed spoken turn says why in `gate.log` |
| `6991229` | A call on an unscoped thread speaks to the streaming chat backend (Hermes), not `list()[0]` (Claude Code) |
| `beb136a` | `auto` on a ready PC engine drops the skipped engine's warning |
| `b39b229` | A sessionless thread gets a session on its next send |
| plus Grok's and Kimi's round-1/2 commits (see the earlier brief) |

## The two problems, with the evidence

### 1. Listening is far too touchy

From a live call (Gate log, session `55741aa9`), **33 finals in 2.5 minutes**, most of them
7–11 characters, one every 2–4 s. The VAD opened an utterance after 96 ms of sound and
Whisper wrote down stock phrases ("Thank you." is 10 characters) for what was noise.

`cb040c5` raised the bar (250 ms to open, 400 ms minimum utterance, no-speech segments
dropped, 400 ms pre-roll so the first word survives). Ethan still reports it is "very very
touchy", so the thresholds are a starting point, not the answer. Places to look:

- `gate/voice-worker/versutus_voice/vad.py` — `start_ms`, `silence_ms`, `threshold` (0.5).
  Silero's own probability is available; a noisy room needs an adaptive floor, not a
  constant.
- `gate/voice-worker/versutus_voice/turn.py` — `rejudge_ms=600`, `force_ms=1600`,
  `threshold=0.5`. **A 1.6 s pause forcing a turn is why "there is no option to continue
  talking"**: think for two seconds mid-sentence and the turn is sent. That is the single
  most likely cause of Ethan's "message going out prematurely".
- `gate/voice-worker/versutus_voice/server.py` — `SPEECH_START_MS`, `MIN_UTTERANCE_MS`,
  `PREROLL_MS`, `NO_SPEECH_PROB_MAX`, `AVG_LOGPROB_MIN`, and the early-end path.
- Smart Turn v3 is the model that should be judging "did they finish". **It is installed**
  (`smart-turn-v3.2-cpu.onnx`, 8.3 MB, checked 2026-09-19), so the degraded
  `TurnJudge(is_complete=lambda _: 1.0)` path is not the explanation — but confirm it
  actually *loads* at runtime (onnxruntime import, feature extraction) rather than
  returning None and silently degrading to "a pause is a turn".
- The phone captures with `AudioRecord` + `AcousticEchoCanceler`
  (`modules/handsfree-voice/android/.../HandsfreeGateMedia.kt`). Now that the call plays
  on the loudspeaker (`897b98d`), the PC's own voice can feed back into the mic. Confirm
  the AEC is actually engaged on the Gate path, or barge-in will trigger on the Bot's own
  speech.

### 2. Sending takes forever

Two different delays, and they must not be confused:

- **The host's Whisper pass.** Measure it. A real-model harness exists at
  `temp/worker-harness-round2.mjs` in the `Versutus-handsfree-call` worktree (not part of
  `verify`; it loads real models and needs the venv at
  `%LOCALAPPDATA%\Versutus\Gate\voice\venv`). Whisper loads on CUDA and a full loopback
  passes. Time `final` separately from the Bot turn — the Gate's `voice.final … afterMs`
  line gives call-relative timing, not per-utterance latency. Consider the model size,
  `beam_size` 5 on finals, and whether a final re-transcribes audio the partial pass
  already covered. **The installed Whisper is 1.5 GB** (`%LOCALAPPDATA%\Versutus\Gate\voice\
  models\whisper\model.bin`) — a large-class model on an 8 GB RTX 4060 that also holds
  Kokoro (310 MB). A distilled or smaller model is the obvious lever if the final pass is
  the delay; measure first, and keep accuracy honest (the loopback sentence must still
  come back word for word).
- **Hermes.** On the failing call the transcript reached Hermes at 13:17:42 and Hermes did
  not start the model request until **13:20:17** — 2.5 minutes, past the Gate's 120 s turn
  timeout, so the call said "that turn could not be completed" and never spoke. Hermes's
  own log shows its event loop blocked in that window. The same session answered in **3 s**
  minutes later. `%LOCALAPPDATA%\hermes\state.db` is **5.7 GB** (it was 4.45 GB in August)
  and is written by several Hermes processes at once; multi-minute stalls are a known
  effect. **This is the host's problem, not Versutus code — do not try to fix Hermes.**
  What Versutus owes the operator is honesty: a turn that is slow should say so on the
  phone ("still waiting on the PC…") rather than sitting silent for two minutes and then
  claiming it could not be completed. The Gate's turn timeout lives in
  `gate/core/voice/media-socket.mjs` (`turnTimeoutMs`).

## What to do

1. **Measure before tuning.** Use the harness and the Gate's own log lines; report numbers
   (time to final, time to first reply delta, time to first audio) before and after.
2. **Fix the endpointing comprehensively**: no turn on a cough, no turn on a thinking
   pause, a turn when the operator actually stops. Prove it with tests over recorded or
   synthesised audio — including a sentence with a 2 s mid-sentence pause, which must
   arrive as **one** turn.
3. **Make a slow turn visible** rather than silent, and reconsider the 120 s timeout.
4. **Check the echo path** now that audio plays on the loudspeaker.
5. Keep every seam tested: `gate/voice-worker/tests` (pytest, run with
   `-p no:cacheprovider`), `gate/__tests__`, `__tests__`.

Note: 4 pytest errors in `gate/voice-worker/tests` (`PermissionError` in
`_pytest/pathlib.py`) reproduce on clean master too — a local temp-dir ACL, not your doing.

## Report

Append a `## Round 3 (Kimi)` section to this file: commits, measured numbers before and
after, what you changed and why, and what still needs a phone in Ethan's hand.
