# HANDOFF — Hands-free calling never opens a call (for Grok 4.6)

Written 2026-09-18 by Claude for Grok 4.6. Ethan's words: *"I want full end to end coverage
and fixes to the hands free calling feature. It's crazy this hasn't worked yet."*
You do the heavy lifting. This brief has only the facts that were verified before handing over.

## The bug, as Ethan saw it (Android phone, 2026-09-18 19:52 local / 23:52Z)

Chat with the **Hermes** Bot via **Ethanspc**, thread "Untitled". Tap the call button → sheet
"Start a hands-free call with Untitled?" → **Using: This PC — local voice** → Start call →
red error:

> This phone would not open a call session. Try again; if it keeps failing, check that a
> speech recognition service is installed and enabled.

Screenshot: `docs/plans/2026-09-18-handsfree-unavailable.jpg` (copied next to this file).

## Verified facts

1. **The Gate was healthy** at the time: `VersutusGate` running, `gitHead 173b780` (= master),
   15/15 Bots routable on `http://127.0.0.1:8760`.
2. **The Gate logged nothing for the attempt.** `%LOCALAPPDATA%\Versutus\Gate\logs\gate.log`
   has only its 23:43Z startup lines, then silence through 23:52Z. Either the phone never
   reached the Gate's voice RPC, or the Gate does not log voice session opens/failures (in which
   case add that logging too — a failed call has to leave a trace on the host).
3. **The error message is wrong for this engine.** The user chose *This PC — local voice*, but the
   copy blames the phone's speech recognition service. The message comes from
   `handsfreeStartResultCopy('unavailable')` in `src/lib/voice/handsfree-call-copy.ts:119`.
4. **About ten different failures collapse into that one `'unavailable'`.** In
   `src/context/handsfree-voice-provider.tsx`, `'unavailable'` is returned at lines ~675
   (no gateway url), 698 (any non-identity error), 735, 752, 756, 776 (no native module),
   781, 784, 809 and 822. From the phone, nobody can tell which one fired. That is why this
   has been "fixed" repeatedly without ever working.

## Recent history (read before changing anything)

`git log --oneline -- src/lib/voice gate/core/voice src/context/handsfree-voice-provider.tsx`
— the latest commits are `25707e8` (pc engine is the call path), `5505aca` (Gate-token phones can
start a call) and `afad44d` (hermes phone identity). The design is in
`docs/plans/2026-09-12-realtime-voice-plan.md`, with milestones in `docs/plans/2026-09-12-voice-m*.md`
and older briefs `EXEC-BRIEF-handsfree-voice*.md` and `HANDOFF-2026-09-13-gate-voice-push.md`.

**Voice direction (Ethan, non-negotiable):** no paid voice APIs. Engines are `local` (the host
runs faster-whisper / Silero VAD / Kokoro, the flagship), `codex` (the ChatGPT subscription through
the Gate's `codex app-server` realtime), `phone` (on-device fallback) and `auto`. The phone streams
audio to the Gate and the Gate picks the engine.

## What to do

1. **Diagnose first, with evidence.** Give every `'unavailable'` exit its own distinct reason code,
   carry it into the UI, and log it on both sides: phone console and `gate.log`. Then find which exit
   fires for the `local` engine through a Hermes-via-Gate connection, and fix the root cause.
2. **Honest copy per engine and per reason.** A `local` or `codex` failure must not tell the user to
   install a phone speech recognition service. Say what failed and where: phone, network or host.
3. **Make a call actually work, end to end, on every engine:**
   start → mic → audio reaches the Gate → STT → Bot turn through the normal chat path → reply →
   TTS plays on the phone → next turn → hang up → the transcript lands in the thread. Cover barge-in,
   a dropped connection mid-call, app backgrounding, a missing or unready host voice worker, and a
   denied mic permission.
4. **Tests at every seam.** Unit tests for the start policy, the reason mapping and the copy. Gate
   tests extending `gate/__tests__/voice-rpc.test.mjs` for a real session open, audio in and reply
   out using a fake engine. Add an integration test that drives the provider's start path against a
   fake Gate and asserts that a call opens, not just that no error appears.
5. **The host side of `local`.** Check that the voice worker (`gate/voice-worker`, Python) starts,
   that its models are present, and that the Gate reports its readiness truthfully to the phone
   (`voice-engine-choice.ts`). If it is not ready, the sheet must say so *before* Start call is tapped.

## Rules

- Branch from `master` (`C:\Projects\Versutus`). Work in a worktree. Commit small, in the style
  `fix(voice): …` / `feat(call): …`, one behaviour per commit.
- **`npm run verify` is the whole gate** and must be green on every commit. Never weaken it: no
  `.skip`, no `eslint-disable`, no `@ts-ignore`, no lowered coverage thresholds or baselines.
- Read the Expo v57 docs (https://docs.expo.dev/versions/v57.0.0/) before touching native or
  Expo APIs.
- **Worklets call worklets only.** A JS function called from a Reanimated worklet force-closes
  Android. The gate checks for this; don't bypass it.
- **Do not restart, redeploy or touch the live Gate service or the Hermes fleet.** Ethan runs the
  host. Use fake engines and a test Gate. Leave deploy to Ethan.
- Leave `master` alone. When finished, report the branch, the commit list, the root cause of the
  "would not open a call session" failure with evidence, and anything you could not verify without
  a phone. Ethan will build the APK and test on device.
