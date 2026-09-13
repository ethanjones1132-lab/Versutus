# Voice — the worker honours the §4.6 re-judge flow (2026-09-13)

The last non-device gap left by M6 (see `docs/plans/2026-09-12-voice-m6.md`,
"M6 — COMPLETE ... Honest gap"): `VoicePipeline.pushAudio` finalizes at the
first VAD `speech_end`. `TurnJudge.decide` — the 600 ms re-judge / 1.6 s force
logic — exists and is unit-tested, but nothing calls it. A thinking pause
therefore sends a half sentence, and the speculative-turn path on the Gate can
never be driven by the real worker (`voice.earlyEnd` fires only when Smart Turn
is already confident at the first pause).

## Decision

`VoicePipeline` holds the utterance after a VAD `speech_end` instead of
finalizing it:

- **Confident at the pause** (`TurnJudge.confident`): unchanged — emit
  `voice.earlyEnd` then `voice.final`, so the Gate's speculative turn starts.
- **Unsure at the pause**: hold the PCM and wait. Each frame the operator is
  quiet adds to the held silence; at `rejudge_ms` (600) call
  `TurnJudge.decide`; `complete` finalizes, `incomplete` re-judges a window
  later, and `decide`'s own `force_ms` (1600) still wins.
- **Speech resumes** before a held turn is confirmed: it is one utterance —
  the held PCM joins the new buffer, and nothing was sent.
- **No Smart Turn installed**: unchanged — a pause ends the turn, so the
  degraded fallback and its test stay as they are.

Time is the audio that keeps arriving: the phone sends 20 ms frames whether or
not it is speaking, so the held silence is measured from the decoded chunk
durations — no timer, no new thread.

## Files in play

- Modify `gate/voice-worker/versutus_voice/server.py` (`VoicePipeline`)
- Modify `gate/voice-worker/tests/test_pipeline.py`
- `gate/voice-worker/versutus_voice/turn.py` is unchanged (`decide` is already
  the contract).

## Task 1 — the held turn, the re-judge and the force

1. **Write the failing tests** in `tests/test_pipeline.py`:
   - an unsure judge holds: a tone then 300 ms of silence emits no `final`;
   - re-judging at 600 ms of held silence with a scorer that turns confident
     emits `final` exactly then;
   - an unsure-to-the-end scorer emits `final` only at the 1.6 s force;
   - speech resuming during a hold merges the held audio and emits no `final`;
   - `turn_judge=None` still finalizes at the first pause.
2. **Run to confirm they fail**: `node gate/voice-worker/run-tests.mjs`.
3. **Implement** the pending-utterance state in `VoicePipeline` (`_pending`,
   `_finalize`, the per-frame silence accounting, the resume merge), resetting
   it in `open`/`close`.
4. **Run** the worker suite green.
5. **Gate and commit**: `npm run verify` EXIT=0, then

   ```
   git add gate/voice-worker/versutus_voice/server.py gate/voice-worker/tests/test_pipeline.py
   git commit -m "feat(voice): a thinking pause no longer sends the turn"
   ```

## Acceptance

- **PENDING-DEVICE:** on a real call, a 1.5 s thinking pause does not send and a
  completed turn is not delayed by more than 400 ms.
- The Gate-side thresholds and the socket's 600 ms speculation window are
  unchanged; `voice.earlyEnd` semantics for a confident pause are unchanged.
