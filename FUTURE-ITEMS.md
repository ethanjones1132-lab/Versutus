# Future Items

Feature candidates identified 2026-09-09, specced for handoff. Each item stands
alone: goal, the flow the user sees, where to build it, constraints, and how to
verify. File/line references were accurate as of 2026-09-09 — re-check before
quoting them in code.

**Revised 2026-09-11.** Shipped items were removed; what remains is unbuilt.
Completion was verified by checking for each item's named deliverable in the
tree, not by memory — the ledger below records what was removed and the evidence
for it. Original item numbers are retained: code comments cite them (e.g.
`src/components/widget/glanceable-widget.tsx` cites "Item 4b … §4"), so
renumbering would break those references.

**Revised 2026-09-23.** Re-audited against the live tree. Newly verified shipped
work joined the ledger above (item 3 push relay, P2, P3, D1, D2, D6, D7, D8, the
slash-command regression fix, Workflows, the Activity cron view, push on model
final response); P1, D5 and item 8 were re-scoped to the halves that remain.
Capability claims corrected: `gate/core/capabilities/` defines only `agent` and
`provider` kinds — the Gate fronts a backend's cron; it does not own a `cron`
kind. §4 / the Android widget section are untouched (device-held). Original
item numbers are still retained for the code comments that cite them.

House rules that apply to every item:

- Read the Expo v57 docs before writing code (AGENTS.md).
- `npm run verify` must pass (config check, `tsc --noEmit`, lint, Jest with the
  coverage ratchet, gate tests). The coverage gate counts only
  `src/lib/gateway/**`; new modules under `src/lib/notifications/` still ship
  with Jest tests in `__tests__/`, matching repo convention.
- Notification honesty: true push ships through the Gate relay (README scope
  statement). Anything the relay does not carry is a local notification and
  must not pretend to be push; the README scope statement must stay true.

---

## Shipped since 2026-09-09 — removed from this document

| item | shipped as |
|---|---|
| 1a Routine → scheduled notification | `notifications/routine-schedule.ts`, `routine-sync.ts` |
| 1b "While you were away" digest | `components/home-briefing-card.tsx`, `src/lib/home/` |
| 1c Notification tap deep-link | `notifications/tap-route.ts` |
| 2 Actionable approval notifications | `notifications/approval-action.ts` |
| 3 True push via a Gate relay | `notifications/push-registration.ts`, `gate/core/push-rpc.mjs` / `push-notifier.mjs` / `push-send.mjs` / `push-tokens.mjs`, tap listener in `src/app/_layout.tsx` |
| 4 (iOS half) Glanceable widget | `components/widget/glanceable-widget.tsx`, `lib/widget/` |
| 5 Share to Versutus | `gateway/share-intent.ts`, `share-intent-native.ts`, compose deep link |
| 6 Quick reply from notification | `notifications/bot-reply.ts` |
| 7 Live run progress | `notifications/run-progress.ts`, `components/widget/run-live-activity.tsx` |
| P2 Memory pane per Bot | `components/chat/bot-memory-pane.tsx` (mounted in `bot-detail-sheet.tsx`), `lib/gateway/bot-memory.ts` |
| P3 Session search, pin, rename | `lib/gateway/session-labels.ts`, search/pin/rename in `components/chat/thread-config-sheet.tsx` |
| P4 Biometric app lock | `components/app-lock-gate.tsx`, `lib/settings/app-lock-device.ts` |
| P5 Spend dashboard | `src/app/gateway/spend.tsx` |
| P6 Transcript export & share | `gateway/transcript-share.ts` |
| D1 Approval inbox, policies, audit | `components/activity/approval-inbox.tsx`, `lib/gateway/approval-policy.ts`, `approval-audit-view.ts` |
| D2 Fleet constellation | `src/app/fleet.tsx`, `lib/fleet/constellation-model.ts`, entry at `gateway-home-dashboard.tsx` |
| D3 Bot scorecards + weekly report | `lib/fleet/scorecard.ts`, `notifications/weekly-report.ts` |
| D4 Routine template packs | `gateway/routine-templates.ts`, `chat/routines-pane.tsx` |
| D6 Bot handoff packets | `lib/gateway/handoff.ts` + `handoff-import.ts` + `handoff-share.ts`, `src/app/gateway/import.tsx` |
| D7 Council mode | `src/app/council.tsx`, `lib/gateway/council.ts`, `components/chat/council-compare-view.tsx` |
| D8 Deferred-execution queue (runs) | run-shaped outbox rows (`session-persistence.ts` `isRunQueuedRow`) flushed through run dispatch on reconnect |
| Solution B, B1–B3 Voice chat | `expo-speech-recognition` + `expo-speech`, shipped and in daily use |
| 2026-09-11 slash-command regression | diagnosed and fixed — `docs/plans/2026-09-13-slash-command-dispatch.md` |
| Runs become Workflows | `lib/gateway/workflows.ts`, `/workflow` dispatch in `slash-commands.ts` |
| Activity tab → cron view | `app/(tabs)/activity.tsx` + `components/activity/cron-section.tsx`; run surface extracted to `src/app/runs.tsx` |
| 2026-09-11 push on model final response | `gate/core/push-notifier.mjs` `final-response` trigger → `reply` / `routine` kinds |

**Resolved 2026-09-23 — D5:** the enforcing pre-run check exists
(`src/lib/gateway/budgets.ts:104`, called before `executeRun` at
`src/context/gateway-provider.tsx:2676-2693`). D5 below is re-scoped to the
escalation half that remains.

---

## 4. Glanceable status — home-screen widget (ANDROID HALF OUTSTANDING)

The iOS half shipped: `src/components/widget/glanceable-widget.tsx` renders the
snapshot, `src/lib/widget/widget-target.ts` owns `WIDGET_NAME` and the pure
`glanceableWidgetLines` fold, and the app writes the snapshot on run-state
change. **The widget cannot be placed on an Android home screen.** Diagnosed
2026-09-11 — see "Android home-screen widget" in the 2026-09-11 section below,
which carries the full finding and the approved approach.

---

## 8. Siri / Android app shortcuts on top of deep links

**Goal.** "Hey Siri, talk to Scout" → Bot Chat, composer focused. Cheapest item
on the list; compounds with everything above.

**Status (2026-09-23).** The link half shipped: `versutus://chat?bot=<id>`
opens Bot Chat with the composer focused (`src/lib/gateway/deep-link.ts`,
`src/lib/gateway/composer-focus.ts`), and the static Android voice-call
shortcut donates via `plugins/with-voice-shortcuts.js`. What remains is the
per-Bot donation this item asks for: runtime Android recent-Bot shortcuts and
the iOS App Intents half (tracked in the sprint backlog).

**Build.**

- Extend the deep-link vocabulary: `versutus://chat?bot=<id>` opening Bot Chat
  (ADR 0012 canonical session) with the composer focused. The router seam and a
  `compose` link kind already shipped with item 5
  (`src/lib/gateway/deep-link.ts`) — extend that, do not add a second router.
- iOS: an App Intents config plugin donating per-Bot shortcuts. Android:
  `shortcuts.xml` + manifest meta-data via config plugin.
- Shortcut parameters (which Bot) map straight onto the `bot` query param; no
  new routing logic.

**Constraints.** Not a retention driver alone. Every surface (notifications,
widget, share) should reuse this same link vocabulary — one router, many
entrances.

**Verify.** Jest for link parsing; manual invocation of a donated shortcut.

---

## Explicitly considered and ruled out

- **Wake word / always-listening** — `voicewake` is host-side by design
  (Solution B5), and always-on mic on a phone is a battery and privacy
  regression. Note the 2026-09-11 hands-free voice item does **not** reverse
  this: a user-initiated call session is not always-listening.
- **@mention handoff and group chats** — already decided as work after the first
  Bot slice (ADR 0007); `group-room-view.tsx` and `src/lib/gateway/groups.ts`
  exist. Tracked by the sprint process, not here.
- **New Agent creation** — likewise already decided and specified
  (ADR 0015, `docs/adr/0015-new-agent-via-bounded-cli.md`).

---

# Deep-dive solutions

---

## Solution A — True push notifications (operator-run relay)

**Problem.** Local notifications fire only while the app's gateway connection is
alive. A killed app is a silent app, so approvals and routine results wait for
the user to come back on their own.

**Status (2026-09-23).** Shipped end to end: app registration
(`src/lib/notifications/push-registration.ts`, synced from the provider), Gate
registry + prefs RPC (`gate/core/push-rpc.mjs`, `push-tokens.mjs`), notifier
with dedupe, quiet hours and Bot filter (`push-notifier.mjs`), Expo send with
receipt pruning (`push-send.mjs`), and one tap path shared with local notices
(`_layout.tsx` → `tap-route.ts`). The `smoke:live` test-push dispatch (A5's
verify step, shipped 2026-09-23 in `scripts/smoke-live-gateway.mts` +
`scripts/smoke-live-push-check.mjs`) and the gateway-Settings door for
`NotificationsSection` (A4's pane, mounted in `settings.tsx`) both shipped;
only the A8 rollout policy is not executed. The README scope statement already
records the relay as shipped.

**Approach.** The Versutus Gate (`gate/`, port 8760) becomes the notification
relay. It is already the operator-run companion server, already paired with the
device, and already fronts the attached backend's cron (`cron.*` in
`gate/core/capabilities/gateway-methods.mjs`; `gate/core/capabilities/`
itself defines only `agent` and `provider` kinds) — no third party is
introduced into the trust path. Delivery rides the Expo Push Service
(APNs/FCM underneath).

### A1. Credentials (one-time, operator-held)

- The EAS `projectId` already exists in `app.json`.
- iOS: an APNs key registered to the app's EAS project. Android: FCM
  credentials (`google-services.json` + service account) via EAS.
- Push is unavailable in Expo Go on Android — irrelevant here; the repo already
  ships dev builds / direct prebuild APKs.

### A2. Token lifecycle (app side)

- After pairing completes, call `Notifications.getExpoPushTokenAsync()` and
  register the token with the Gate over the existing authenticated channel —
  pairing is the trust bootstrap, reuse it rather than inventing a second
  handshake. Store the token in SecureStore (existing pattern).
- Re-register when the token changes; deregister on device revoke and on
  gateway-profile removal.
- New module: `src/lib/notifications/push-registration.ts`. Jest tests for
  register/rotate/deregister against a mocked Gate client.

### A3. Gate: token registry

- Tokens keyed by paired device identity, persisted under Gate home — never
  committed, same discipline as `gate/credentials/` and `gate/.tokens.json`.
- New endpoints under the Gate's existing manifest seam: register, deregister,
  and (A6) notification preferences. Validate them against
  `gate/core/capabilities/` conventions like every other registry entry.

### A4. Gate: notifier

- The Gate already dispatches jobs/cron (`resolveBackendFor('createJob')`,
  `gate/core/server.mjs`). Subscribe to run lifecycle events: run completed,
  run errored, **approval required**, routine result ready.
- Dedupe (one push per run state transition) and per-device preference filters
  (which Bots, quiet hours) — preferences endpoint from A3, edited from the
  Notifications pane (`src/components/gateway/notifications-section.tsx`,
  mounted in Setup's Notifications tab and in gateway Settings — both doors
  shipped 2026-09-23).

### A5. Send path

- Expo Push API (`POST https://exp.host/--/api/v2/push/send`), chunked at 100
  messages, with receipt collection: `DeviceNotRegistered` removes the token
  from the registry immediately — a dead token that keeps receiving sends is
  how relays get throttled.
- **Payload shape is fixed by the shipped tap router**: `TapRoute`
  (`src/lib/notifications/tap-route.ts`) — `{ kind: 'run', runId }` |
  `{ kind: 'approval', runId }` | `{ kind: 'routine', jobId, botId }` |
  `{ kind: 'reply', sessionId, botId? }` | `{ kind: 'weekly-report' }` —
  identical to the local-notification payloads, so one response listener routes
  push and local taps through one code path. Do not invent a second shape.
- Gate tests with `node:test`: registry CRUD, notifier dedupe, send/receipt
  handling against a stubbed Expo endpoint. Extend `smoke:live` with a
  send-test-push dispatch.

### A6. Privacy (where the promise gets stressed)

- Default payload is **contentless**: "Approval required" / "Scout finished a
  run" with ids only — no prompt text, no result bodies. Rich bodies are a
  per-device opt-in in notification preferences.
- Expo's push service and APNs/FCM are in the delivery path; the docs and the
  README must say so plainly when this ships, the same way the TLS-fingerprint
  limitation is stated today. The model credentials and provider keys never
  move — only notification envelopes cross.

### A7. App receive path

- Approvals channel on Android at HIGH importance so they break through;
  routine results on a DEFAULT channel.
- On tap: existing response listener → shipped tap routing. If the gateway is
  unreachable at tap time, land on Activity with the pending state visible —
  the run is gateway-side, so nothing is lost.
- Update the README scope limit ("True push … not invented here") the day this
  ships, and not before.

### A8. Rollout

1. A2–A5 behind a per-gateway toggle, off by default. 2. Preferences pane.
3. Rich-body opt-in. 4. On by default for new pairings once the smoke test has
run green against a real device for a week.

---

## Solution B — Voice chat capability (B1–B3 SHIPPED)

Push-to-talk STT, spoken replies with per-Bot voices, and the review-then-send
loop shipped and are in daily use. What remains:

### B4. Phase 2 — realtime voice via the Gate

- A new Gate capability kind, `realtime-voice`, defined at
  `gate/core/capabilities/realtime-voice/kind.mjs` like every other kind:
  provider-backed realtime audio session (OpenAI-compatible realtime over
  WebSocket), with the Bot's soul injected as session instructions and tool
  calls routed back through the existing run/approval machinery so approvals
  still gate execution. The phone streams audio to the Gate; the Gate holds
  the provider credential — consistent with credential custody today.
- Large and paid-provider-dependent. **The 2026-09-11 hands-free voice item
  below chose the cheaper client-side alternative** and is implemented in the
  working tree (pending the device acceptance gate). That work does **not**
  close B4: its interrupt-by-speaking detector and sentence-level TTS
  pipelining are client-side approximations, not simultaneous
  listen-while-speaking or provider-side backchanneling. B4 remains open.

### B5. Explicitly not in scope

- **Wake word / always-listening** — host-side by design; always-on mic is a
  battery and privacy regression.
- **Remote control of the host's voice hardware** — the thing
  `rpc-routes.ts:115-116` says does not exist. If Hermes later ships voice
  REST, add it as a capability-gated surface, the established pattern.

---

# Competitive candidates (2026-09-09, unbuilt remainder)

Candidates, not commitments — promote one to a full spec before building.

### P1. Multimodal composer — library images shipped; camera and files remain

ChatGPT/Gemini treat attaching an image or PDF as table stakes.

**Shipped.** Image attach from the photo library, capability-gated: the
`+` menu offers an image only when the selected model declares image/vision
input (`supportsImageInput`, `src/lib/gateway/chat-parts.ts:92`; offered at
`src/components/chat/chat-screen.tsx:1144,2408` and drawn in the composer's
`+` menu at `src/components/chat/chat-composer.tsx:275-293`), and the picked image rides
the existing chat pipeline as a data-URL content part.

**Remaining.** Camera capture and non-image document attachments, through the
same gate and the same content-part path — the attach control must stay
fail-closed when the model does not advertise the capability. Hook: extend the
picker (`handleAttach`) and the parts fold. Image *generation* stays out of
scope — a provider feature, not a client one. Effort: S.

### D5. Budgets with hard stops — pre-run refusal shipped; approval escalation remains

**State verified 2026-09-23.** The enforcing pre-run check exists:
`checkBotBudget` (`src/lib/gateway/budgets.ts:104`) runs before every run
started from this app (`src/context/gateway-provider.tsx:2676-2693`) and
refuses a start when the Bot is over its cap, naming the cap and the overage;
the per-Bot budget cap surfaces in `spend-per-bot-section.tsx` (`botBudget`,
`budgetRowCopy`) — `scorecards-section.tsx`'s `botSpendCapCopy` is the
session-list bound, a different cap. Honest limit: enforcement is
client-side — it governs runs started from this app, not a server quota; say
so, don't imply a server quota.

**Remaining.** The original goal also promised escalation — over the cap, open
an approval rather than only refusing the start. Hook: feed the
`BudgetVerdict` into the existing approval path; auto-approve never applies.
Effort: S.

## What we deliberately do NOT copy

- **Image/video generation surfaces** — provider features; Versutus is a client.
- **Cloud accounts, hosted sync, social features** — the self-hosted,
  no-credential-custody stance is the product's spine.
- **Always-listening wake word** — host-side by design.

---

# Added 2026-09-11

Six items raised in one session. Four have shipped and moved to the ledger
above: the slash-command regression (diagnosed and fixed 2026-09-13),
Workflows, the Activity tab's cron view, and push on model final response
(inside the Gate relay). What remains from this batch is the Android
home-screen widget (approach approved below — device-held) and hands-free
voice (built, physical-device acceptance pending below).

---

## Android home-screen widget — APPROACH APPROVED (Recommendation A)

**Status.** Diagnosed 2026-09-11. Approach approved; not yet built.

**Problem.** The widget cannot be added to an Android home screen. It does not
appear in the widget picker at all.

**Root cause — three stacked causes, not one.** Verified against a generated
prebuild (`android/app/src/main/AndroidManifest.xml` contained **zero**
`appwidget` receivers, and no `res/xml` or provider class was emitted):

1. **`enableAndroid` defaults to `false`.** In
   `expo-widgets/plugin/build/withWidgets.js`:
   `const enableAndroid = props?.enableAndroid ?? false;` — and the plugin entry
   in `app.json` never sets it. `withAndroidWidgets` is therefore never called,
   so no receiver, `res/xml`, or provider class is generated and Android has
   nothing to list.
2. **No `android` block on the widget config.** The existing entry carries
   `supportedFamilies: ["systemSmall","systemMedium"]`, which is iOS WidgetKit
   vocabulary. Android takes a different schema entirely: `minWidth`,
   `minHeight`, `targetCellWidth`, `targetCellHeight`, `resizeMode`.
3. **The widget view is SwiftUI.** `glanceable-widget.tsx` imports
   `@expo/ui/swift-ui` and its modifiers. That cannot render on Android at any
   config setting.

(1) and (2) are config. (3) is a real, if small, build.

**Why this is cheap: the existing architecture already anticipated it.** The
data layer is platform-neutral — `src/lib/widget/widget-target.ts` owns
`WIDGET_NAME` and the pure `glanceableWidgetLines` fold, and the view "draws the
snapshot and nothing else — no gateway client, no read of its own, no clock of
its own." Only the rendering is iOS-bound. This is a view port, not a feature.

**Approved approach — A, sibling platform view.**

Add `src/components/widget/glanceable-widget.android.tsx` written against
`@expo/ui/jetpack-compose`, consuming `glanceableWidgetLines` unchanged. Metro's
platform resolution selects the right view per platform. Both views stay thin,
neither platform's primitives leak into the other, and because both consume the
same fold they cannot drift on *content* — only on layout.

Rejected alternatives, recorded so they are not revisited:

- **B — single view with a `Platform.OS` branch.** Fewer files, but it pulls
  both UI libraries into a bundle `expo-widgets/metro.config.js` deliberately
  keeps minimal, and a SwiftUI import on Android is a boot hazard.
- **C — port to Jetpack Compose only, dropping SwiftUI.** Simplest tree, but
  discards the working iOS widget. Only sensible if iOS widgets stop being a
  goal.

**Build.**

1. `app.json` → the `expo-widgets` plugin props gain `enableAndroid: true`.
2. The `VersutusStatus` widget entry gains an `android` block with sizing and
   `resizeMode`. Pick cell targets that fit the four lines the fold emits; the
   small family already drops the newest outcome, so mirror that rule rather
   than inventing a second one.
3. Add `glanceable-widget.android.tsx` against `@expo/ui/jetpack-compose`,
   reusing `glanceableWidgetLines` and `WIDGET_NAME`. Take the system
   foreground style, not app-palette hex — a widget is drawn over the
   operator's wallpaper.
4. Keep the seam: nothing imports the view statically; the first snapshot write
   is the only caller, so a client without the native side draws nothing rather
   than dying at boot.

**Constraints.** Re-running `expo prebuild` is required after the config change
— the manifest receiver is generated, not hand-written. Verified toolchain as of
2026-09-11: Gradle `assembleRelease` succeeds in ~13 min, producing a
debug-signed 153 MB universal APK (`com.versutus.app`, targetSdk 36).

**Verify.** Confirm the generated manifest contains an `appwidget` receiver and
`res/xml` widget info before building. Manual: widget appears in the Android
picker, places on the home screen, and updates on run-state change. Jest cover
stays on the fold, which is unchanged.

---

## Hands-free background voice chat

**Goal.** Start a voice chat that behaves like a hands-free phone call —
continuous turn-taking, running in the background so the phone can do other
things while the conversation continues.

**What exists and works well.** The shipped loop (Solution B1–B3) is
hold-the-mic → transcript fills the composer → user reviews and sends → reply
streams to chat and the voice toggle plays it back. The operator reports this
works well for its intended design. This item does not replace it; it adds a
second mode.

**The gap.** Today every turn requires three deliberate touches (hold, release,
send). A call-style mode needs automatic turn-taking — endpointing to detect
when the user stopped speaking, auto-send, spoken reply, and re-open the mic —
plus a background audio session so it survives leaving the foreground.

**Decide first, before any build.** This overlaps **Solution B4** (realtime
voice via the Gate). The client-side version is far cheaper and works against
every backend; B4 is provider-dependent and costly but gives true realtime
interruption. Choose one deliberately.

**Known constraints.** Background audio needs explicit Android foreground-service
and iOS background-mode configuration. Auto-send contradicts B1's deliberate
"never auto-send" rule — that rule was written for the composer path and a call
mode is a different contract, but the divergence must be explicit in the design,
not accidental. B5's wake-word prohibition still stands: a user-initiated call
session is not always-listening.

**Implementation status (2026-09-12).** The client-side path is built, and the
decision above is settled in its favor. A local Expo module
(`modules/handsfree-voice/`) owns the native microphone/audio session and the
Android `microphone|mediaPlayback` foreground service; a root provider
(`src/context/handsfree-voice-provider.tsx`) runs a pure turn reducer
(`src/lib/voice/handsfree-session.ts`) and sends recognized text through the
existing `sendChatInput` path with a `handsfree-call` source that is
connected-only, never queueing to the offline outbox. A disclosure sheet, an
in-call banner, and an ambient indicator ship with it. It is deliberately **not**
listed as shipped: the mandatory physical-device acceptance gate (three
complete turns in each of foreground, another app foregrounded, and screen
locked for ten minutes, on a physical Android 13+ device and a physical current
iOS device) has not been run, and iOS cannot be built on the Windows checkout
used here. Auto-send is scoped to an explicitly-started call; the composer path
still never sends. B4 is **not** closed by this work — see above.
