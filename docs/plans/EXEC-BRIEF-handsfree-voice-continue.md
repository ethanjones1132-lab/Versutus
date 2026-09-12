# Execution brief — hands-free voice, CONTINUING from Step 4

A prior run implemented Steps 1–3 of
`docs/plans/2026-09-11-handsfree-voice.md` and then stalled diagnosing an
environment problem instead of reporting it cleanly. That problem is now
fixed and Steps 1–3 are independently verified — **do not redo them, do not
modify `modules/handsfree-voice/android/` or the Kotlin files in it.**

## What's already done (verified, not yours to touch)

- The entire native module exists at `modules/handsfree-voice/` — Android
  Kotlin (service, state, endpointing, module) and iOS Swift (module,
  endpointing, AppDelegate subscriber) per the plan's Step 1–3 contract,
  including the `bargeIn`/`level` events and `playSendEarcon()`.
- Android: compiles clean, its own unit tests pass
  (`HandsfreeCallStateTest` 7/7, `HandsfreeEndpointingTest` 5/5), and the
  whole app's manifest merges correctly. Verified via
  `cd android; .\gradlew :handsfree-voice:testDebugUnitTest :app:processDebugMainManifest`
  — **BUILD SUCCESSFUL.**
- iOS Swift files are written per the plan but **cannot be built on this
  Windows machine** — that remains true and is expected; do not attempt it.
- `app.json` (Step 1's permissions/UIBackgroundModes/copy changes) and
  `scripts/verify-config.mts` (Step 1's config checks) are done.
- Full `npm run verify` is green on the tree as it stands right now: 472
  suites, 4426 tests, coverage ratchet holding.

## Scope — implement Steps 4 through 8, in order

Read each step directly from the plan file — it is authoritative. Summary of
what's left:

- **Step 4**: the pure reducer (`src/lib/voice/handsfree-session.ts`) and
  crash-safe recovery (`src/lib/voice/handsfree-recovery.ts`). Note the
  reducer's phase list now includes `confirming` (the grace window) and the
  event-to-transition table is spelled out explicitly in the plan text — every
  native event from Step 1's contract has a defined destination, none is
  emitted-and-ignored.
- **Step 5**: `sendChatInput`'s `handsfree-call` source, in
  `gateway-provider.tsx` and new `src/lib/gateway/chat-input-source.ts`. Pay
  close attention to the plan's two "Added 2026-09-12 second review" bullets
  here — they document real, verified facts about `sendMessage`'s existing
  behavior (a fresh message id does not render on its own; a busy send must
  return `busy`, not a hollow `sent`) that the implementation must account for.
- **Step 6**: the orchestrating provider (`handsfree-voice-provider.tsx`),
  reply correlation (`handsfree-reply.ts`), and the explicit phase-to-native
  side-effect table the plan spells out. The call target is built by the
  caller (chat-screen) and passed into `start(target)` — the provider cannot
  read it from `useChatSurface()`, which the plan explains is too narrow.
- **Step 7**: the call UI — sheet, banner, Call control beside the existing
  mic. Includes the ambient Skia indicator and the send earcon call site
  (`playSendEarcon()` already exists natively from Step 3 — Step 7 just calls
  it on the `sending` transition).
- **Step 8**: documentation, and only after Steps 4–7's own verifications and
  the achievable parts of Final verification pass. Its own bullets specify
  exactly what may and may not be claimed (no "full-duplex", no naming
  GPT-Live/Gemini Live in shipped copy, B4 stays open).

## Hard rules

- The plan is authoritative. Every correction in it marked "(Corrected/Added
  2026-09-12 second review: ...)" was independently verified against the real
  code before you started — trust those, they are not speculation.
- Each step's own verification runs as you finish that step, not only at the
  end. After Step 7, run the full `npm run verify` — it must pass. Never
  weaken a test, a lint rule, or the coverage ratchet to get green.
- Do not modify `package.json` or run `npm install` — no new JS dependency is
  needed for Steps 4–8.
- Do not touch `modules/handsfree-voice/android/` (Kotlin) — if you find you
  need a native change to make a JS step work, that means a Step 1–3 contract
  assumption was wrong; STOP and report exactly what and why, do not silently
  add native code outside this brief's scope.
- Do not run `expo prebuild` or any Gradle command yourself — that
  infrastructure is already validated for the current native contract: if
  Steps 4–8 don't add new native surface (they shouldn't), there's nothing new
  to build there. If a step's own verification genuinely requires a fresh
  Android build, stop and say so rather than running prebuild/gradle blind.
- If a step's premise is false — a cited line has drifted, a referenced
  function doesn't exist — STOP and report. Do not invent a replacement.
- No backend-name branching anywhere. No wake word, no always-listening.
  Auto-send stays scoped to an explicitly-started call only.
- Commit nothing. Leave changes in the working tree. Other completed
  workstreams' files may show as modified in `git status` — not yours to
  touch.

## Report when done

Steps completed, files changed per step, test results per step, the full
`npm run verify` result, and anything you stopped on. State plainly that iOS
remains unverified on this machine (expected) and that Steps 1–3's native
code was not touched.
