# PLAN BRIEF — Enterprise hands-free voice for Versutus (Grok 4.6)

Date: 2026-09-12. You are the lead architect for this feature. Your deliverable
this run is a **diagnosis plus an executable implementation plan** — not code.
Another agent will audit your plan hard afterwards, so every claim needs
evidence (file:line, command output, or a cited URL).

## The operator's report

Ethan (the operator) installed the Android build from this worktree
(`android/app/build/outputs/apk/release/app-release.apk`, built 2026-09-12
08:46) on his Samsung phone (One UI launcher). He reports:

1. **The hands-free voice chat option does not appear reliably as an option
   when it should.**
2. **He could not get it to function at all.**

His direction, verbatim: *"no restrictions on the solution, this is full
enterprise solution to feel like gpt voice or other major league similar
features."* The previous plan's self-imposed limits (half-duplex only, no
realtime provider, no credential anywhere, no Gate changes) are **lifted**.
Keep what was good about it; do not inherit its ceilings.

## Where everything is

- **Your cwd:** `C:\Users\ethan\.codex\worktrees\bee6\Versutus`, branch
  `sprint/features-functions-ui`, HEAD `8a83907`. The current hands-free call
  landed in `f4bf7f0` (read its full commit message).
- **Current implementation:**
  - Native: `modules/handsfree-voice/**` (local Expo module; Kotlin
    `HandsfreeVoiceModule.kt`, `HandsfreeCallService.kt`,
    `HandsfreeCallState.kt`, `HandsfreeEndpointing.kt`; Swift counterparts).
  - JS: `src/context/handsfree-voice-provider.tsx`,
    `src/lib/voice/handsfree-*.ts`, `src/lib/voice/speech*.ts`,
    `src/components/voice/handsfree-call-*.tsx`,
    `src/components/chat/handsfree-call-sheet.tsx`, the Call control in
    `src/components/chat/chat-composer.tsx` and `chat-screen.tsx`,
    `src/lib/gateway/chat-input-source.ts`, and the
    `source: 'handsfree-call'` path in `src/context/gateway-provider.tsx`.
  - Earlier voice layers that must keep working unless your plan replaces
    them explicitly: B1 hold-to-talk dictation (`expo-speech-recognition`),
    B2/B3 read-aloud with per-Bot voices (`expo-speech`).
- **History:** the prior plan `docs/plans/2026-09-11-handsfree-voice.md` and
  its pre-revision copy `docs/plans/.handsfree-voice-before-kimi.md`, the
  briefs `docs/plans/EXEC-BRIEF-handsfree-voice*.md`, the execution logs
  `docs/plans/.exec-handsfree-voice.log` and
  `docs/plans/.exec-handsfree-voice-continue.log`, and `FUTURE-ITEMS.md`
  (Solution B, B4). The execution log admits the physical-device acceptance
  gate never ran.
- **Platform:** Expo SDK 57, React Native 0.86 (`package.json`). `AGENTS.md`
  requires reading the exact versioned docs at
  https://docs.expo.dev/versions/v57.0.0/ before proposing Expo work. An SDK 58
  migration spike exists read-only at
  `C:\Users\ethan\.codex\worktrees\sdk58-spike\Versutus` (branch
  `spike/expo-sdk58-migration`, uncommitted `package.json` changes). Propose
  SDK 58 only if you can justify it.
- **System shape:** the app connects to a gateway. Usually that is the
  Versutus Gate (`gate/`, Node, port 8760) fronting chat backends: Hermes
  Agent (named Bots are Hermes profiles served under `/p/<bot>`), Claude Code,
  Codex, and OpenCode. It can also be a direct Hermes or OpenClaw connection.
  Text chat streams through `sendChatInput` / `streamChat` in
  `gateway-provider.tsx`. The Gate already holds credentials in a DPAPI vault
  and, since `f4bf7f0`, relays push notifications. That makes it the natural
  home for a realtime relay or ephemeral-token minting. Domain vocabulary is
  in `CONTEXT.md`; decisions are in `docs/adr/`. The OpenClaw gateway surface
  has `talk.*` / `voicewake.*` commands (`src/lib/gateway/dashboard.ts`), which
  is prior art worth a look.
- **A parallel agent** is planning the Android home-screen widget in this same
  worktree (its file: `docs/plans/2026-09-12-android-widget-kimi-draft.md`).
  The widget will want a **Start voice call** button. **You own that
  entry-point contract**: define the deep link or intent (URL shape,
  parameters, what happens when the app is cold, locked, or disconnected) in
  a clearly titled section so the widget plan can adopt it.

## Phase 1 — Diagnose, with evidence

Establish exactly why, on a physical Samsung phone:

- **(a) The call control appears inconsistently.** Enumerate every condition
  that gates it (file:line). Say which ones flap in normal use: streaming,
  a running command, a pending approval, reconnects, surface kind (roster /
  configurable / Bot / group), availability-probe timing, permission state,
  AppState. Say which gates are wrong, not merely strict.
- **(b) The call cannot function.** Trace the whole path: start →
  permissions → foreground service → SpeechRecognizer / TTS → native events →
  reducer → send → reply correlation → speech → re-listen. Check at least:
  - Is the local module actually autolinked and present in the built APK?
    `android/` is generated by prebuild and git-ignored. Inspect
    `android/settings.gradle`, the autolinking output, the merged manifest
    under `android/app/build/intermediates/`, and the APK itself if needed —
    all read-only.
  - Samsung SpeechRecognizer availability (Google vs Samsung recognition
    service, `isRecognitionAvailable`, on-device recognizer).
  - Android 14/15 foreground-service rules: while-in-use microphone FGS
    start restrictions, and `FOREGROUND_SERVICE_MICROPHONE` plus
    runtime-permission ordering.
  - The `POST_NOTIFICATIONS` flow.
  - Audio focus and `MODE_IN_COMMUNICATION` side effects.
  - One recognizer per turn vs restart latency.
  - JS↔native event-name and payload mismatches.
  - What the user sees on each failure: silent failure vs honest copy.
- **Ranking.** Rank the root causes by likelihood. Mark anything that cannot
  be settled without the phone as **UNVERIFIED**, and give the exact on-device
  check that settles it (`adb logcat` tags/filters, `dumpsys` commands, what
  to tap).

## Phase 2 — Design the enterprise experience

Target the feel of ChatGPT Advanced Voice / GPT-Live, Gemini Live, or Grok
voice. Cover:

- **Conversation quality.** Quantified latency budgets (end of user speech →
  first reply audio, p50/p95). Semantic, not just silence-based, endpointing.
  Instant barge-in. Full-duplex (or explicitly justified near-full-duplex)
  audio with echo cancellation. Streaming speech out. Expressive voices.
  Noise robustness. Handling of thinking pauses.
- **Reliability.** Survive backgrounding, screen lock, Bluetooth / wired
  headset / car routing changes, Wi-Fi↔cellular and Tailscale handoffs, and
  gateway reconnects, with session resumption. Recover honestly when it
  cannot.
- **Discoverability and entry points.** Consider the in-chat control,
  notification controls, lock screen, a quick-settings tile, the home-screen
  widget, a launcher shortcut, the headset button, and assistant/wake. State
  which are in and out, and why.
- **Relationship to Bots and backends — the central design question.** Decide
  how a realtime speech model relates to the operator's Bots, each of which
  has its own persona, tools, memory and model. Compare at least three
  architectures on latency, voice quality, cost per minute, privacy,
  credential posture, **Bot fidelity** (does the voice actually talk *as* and
  *through* the Bot, with its tools and memory?), behaviour across Hermes /
  Claude Code / Codex / OpenCode, and failure modes. Examples:
  - A realtime speech-to-speech model as a voice front-end that delegates to
    the Bot through the Gate via tool calls.
  - A cascaded streaming pipeline: streaming STT → the Bot's own LLM stream →
    streaming TTS.
  - A hybrid chosen per backend or per turn.
  - On-device.

  Use **current (2026) documentation**: OpenAI Realtime API (WebRTC /
  WebSocket, ephemeral tokens), Gemini Live API, xAI voice APIs, Deepgram,
  ElevenLabs, Cartesia, and Android/iOS platform APIs. Recommend one
  architecture, with a fallback ladder down to today's on-device path.
- **Enterprise concerns.** No long-lived provider credential on the device
  (Gate-minted ephemeral tokens or a Gate relay). Consent and disclosure.
  Recording and retention policy. PII. Audit logs. Per-operator cost caps
  and rate limits. Observability (per-turn latency traces, error taxonomy).
  Feature flags and a kill switch. Graceful degradation.

Use web search. **Cite sources with URLs. Do not invent API names, parameters
or prices** — mark anything you could not confirm.

## Phase 3 — The implementation plan

Write it so an engineer or a coding agent can execute it task by task:

- **Design.** An architecture diagram (mermaid), component responsibilities,
  data flow, and protocol contracts (app↔Gate↔provider, with message shapes).
  State machines for the call and the audio session. The **entry-point
  contract** section for the widget and the other entry points.
- **Phases.**
  - **Phase 0 hotfix:** make the existing call reliably discoverable and
    working on Samsung. It must be concrete and small enough to ship in a day
    or two.
  - **Then the enterprise path**, in milestones that each ship independently
    behind a flag.
- **Every task** lists: exact files to create/modify, the change, the tests
  (Jest, Kotlin unit, Swift XCTest, Gate `node:test`), acceptance criteria,
  and a physical-device verification step.
- **Test strategy.** A device matrix (Samsung One UI, Pixel, current iPhone),
  a latency benchmark harness, soak tests (30-minute call, 10+ minutes locked),
  network chaos (airplane toggle, Wi-Fi→cellular), and Bluetooth routing.
- **Also:** risks, a cost model, a rollout plan, the telemetry dashboard, and
  **open decisions for Ethan** — each with your recommendation.
- **Repo conventions.**
  - `npm run verify` is the gate.
  - Work is framed as FEATURE / FIX / OPT by user-visible outcome.
  - Commit messages state how the world now behaves.
  - Unit-testable logic goes in `src/lib`.
  - No backend-name branching in app code.

## Hard rules for this run — violations get reverted

1. **Plan only.** The ONLY file you may create or modify is
   `docs/plans/2026-09-12-realtime-voice-grok-draft.md`. Create it within your
   first few minutes with a skeleton of the sections above, keep filling it as
   you go, and leave it complete when you finish.
2. **No other file changes**, in this worktree or anywhere else.
   - Git: no commands that change state (add, commit, checkout, switch,
     reset, restore, stash, clean, branch, worktree, merge, rebase, push,
     pull, fetch). Read-only git (log, show, diff, grep, blame, ls-files) is
     fine.
   - No `npm install` / `npx expo install`, no `expo prebuild`, no Gradle,
     no xcodebuild, no EAS, and do not run the test suite. Reading tests is
     enough.
   - If you need package sources that are not in `node_modules`, use
     `npm view` or unpack into a directory under `%TEMP%`, never into this
     worktree.
3. **Live systems are off-limits.** Do not start, stop or restart the Versutus
   Gate, Hermes, OpenClaw or any service. Do not call the operator's live
   gateway. No `adb` against devices.
4. **Subagents** may research, but the same rules bind them.
5. **When you are done**, print exactly one final line:
   `PLAN COMPLETE: docs/plans/2026-09-12-realtime-voice-grok-draft.md`
