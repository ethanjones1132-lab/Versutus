# Future Items

Feature candidates identified 2026-09-09, specced for handoff. Each item stands
alone: goal, the flow the user sees, where to build it, constraints, and how to
verify. File/line references are accurate as of 2026-09-09 — re-check before
quoting them in code. Item 1 is the recommended first build; items 4, 5 and 7
share a native-extension prerequisite, so whichever ships first pays for the
others.

House rules that apply to every item:

- Read the Expo v57 docs before writing code (AGENTS.md).
- `npm run verify` must pass (config check, `tsc --noEmit`, lint, Jest with the
  coverage ratchet, gate tests). The coverage gate counts only
  `src/lib/gateway/**`; new modules under `src/lib/notifications/` still ship
  with Jest tests in `__tests__/`, matching repo convention.
- Nothing here may pretend to be push. All notification work below is local
  notifications unless the item says otherwise; the README scope statement must
  stay true.

---

## 1. The morning briefing loop — "While you were away" (RECOMMENDED)

**Goal.** The app speaks first. A routine fires on the always-on gateway, the
phone posts a scheduled local notification at the routine's time, and the tap
lands on the result. Plus a Home digest of everything that happened since the
user last opened the app.

**Why first.** Creates the daily-open trigger at zero server cost, reuses the
cron UI already shipped, and its surfaces are reused by item 3 later.

### 1a. Routine → scheduled local notification

- `src/lib/notifications/local.ts` only ever posts immediate notifications
  (`trigger: null`, `present()` at line 40–57). Add a sibling module, e.g.
  `src/lib/notifications/routine-schedule.ts`, exporting
  `syncRoutineNotification(job)` / `cancelRoutineNotification(jobId)`.
- Trigger mapping: routines use 5-field cron strings
  (`DEFAULT_ROUTINE_SCHEDULE = '0 9 * * *'`, `src/lib/gateway/routines.ts:21`).
  Map the common shapes to `SchedulableTriggerInputTypes.DAILY` (fixed
  hour/minute) and `WEEKLY` (weekday + hour/minute). For anything more complex,
  compute the next fire date and schedule a one-shot `DATE` trigger, rescheduled
  each time the app opens while connected. Do not try to evaluate cron locally
  beyond that.
- Persist `jobId → notificationIdentifier` (AsyncStorage via
  `src/lib/storage/key-value.ts`), mirroring the `gatewayDownNotificationIds`
  pattern in `local.ts:23`, so edits/pauses reschedule exactly one notification
  (`cancelScheduledNotificationAsync` then re-schedule).
- Hook the three mutation points: routine create (`applyRoutineCreate` callers,
  `src/lib/gateway/routines.ts:40`), pause/resume and delete
  (`src/lib/gateway/cron-job-controls.ts`). Syncing happens only on the device
  that owns the routine's schedule — acceptable for single-operator use; note it
  in the UI copy.
- Copy must stay honest: the notification fires at the scheduled time whether or
  not the gateway actually ran. Use "due" wording — *"Scout's morning routine is
  due — open to see what it found"* — not a fake result count.

### 1b. "While you were away" digest on Home

- Home is `src/app/(tabs)/index.tsx`. Add a card component (e.g.
  `src/components/home-briefing-card.tsx`) rendered above the capability groups.
- Data sources, all already on device: the Activity tab's persisted run history
  (`ActivityRun` records; status mapping in `src/lib/gateway/runs.ts:138-149`),
  plus pending approvals surfaced the same way Activity does.
- Persist a `lastSeenAt` timestamp per gateway (key-value storage), stamped when
  Home unmounts or the app backgrounds; the digest is "since `lastSeenAt`."
  Empty state renders nothing — never a placeholder card.

### 1c. Deep-link the notification tap

- `NotificationRouter` (`src/app/_layout.tsx:27-37`) currently routes every tap
  to `/activity`. Read `response.notification.request.content.data` instead:
  carry `{ kind: 'routine', jobId, botId }` or `{ kind: 'run', runId }` in the
  payload, and route routine taps to the Bot Chat / run view and run taps to
  Activity. Keep `/activity` as the fallback for payloads with no `kind`.

**Verify.** New Jest tests for the cron→trigger mapping and the sync/cancel
bookkeeping; manual: create a routine on a device build, background the app,
confirm the notification fires and the tap deep-links.

---

## 2. Actionable approval notifications

**Goal.** Approve or deny a run from the notification itself, lock screen
included, without opening the app.

**Build.**

- Register a category at startup (alongside the existing response listener in
  `src/app/_layout.tsx:30`):
  `Notifications.setNotificationCategoryAsync('approval', [approve, deny])` —
  approve with `opensAppToForeground: false`, deny with
  `{ isDestructive: true, opensAppToForeground: false }`. No `:` or `-` in the
  category identifier (docs warn it breaks matching).
- `notifyApprovalRequired` (`src/lib/notifications/local.ts:59`) gains a
  `categoryIdentifier: 'approval'` and a `data` payload carrying the run id and
  gateway key. Its call site (`src/context/gateway-provider.tsx:2119`) currently
  passes only the prompt text — thread the run id through.
- Extend the response listener: on `response.actionIdentifier` `approve`/`deny`,
  call the existing approval path (registry entry `/approval approve` →
  `approval.approve`, `src/lib/gateway/dashboard.ts`). Post a follow-up local
  notification with the outcome ("Approved — run continuing").
- Fail closed: if the gateway is unreachable when the action fires, post
  "Couldn't reach the gateway — open Versutus to decide" and leave the approval
  pending. Only runs the app initiated can be approved (CONTEXT.md) — the
  payload's run id is the guard.

**Verify.** Jest: action-identifier routing and the disconnected fallback.
Manual on device: trigger an approval, background the app, approve from the
banner.

---

## 3. True push via a Phase D relay (the endgame)

**Goal.** Routine results and approval requests arrive when the app is fully
closed — the correct replacement for item 1's "due at the scheduled time"
approximation. **Fully specced as Solution A below**; this entry stays so the
priority ordering keeps making sense.

**Shape.** The Versutus Gate (`gate/`, port 8760) is the relay — it is already
the operator-run companion server and already owns a `cron` capability kind.

1. App obtains an Expo push token (`Notifications.getExpoPushTokenAsync`; the
   EAS `projectId` already exists in `app.json:69-71`) and registers it with the
   Gate alongside its device identity (pairing already exists — reuse it).
2. Gate watches its own job/run completions (it already dispatches cron) and
   sends the result payload through the Expo Push Service.
3. App side: the existing response listener routes the push the same way item
   1c routes local taps — design item 1's `data` payloads so the relay can
   supply the identical shape with real content.

**Constraints.** Real backend work in `gate/` with its own `node:test` suite;
requires credentials the operator controls (EAS project is theirs). Not started
here — this item is the placeholder that keeps item 1's copy honest. Push is
unavailable in Expo Go on Android; this repo already ships dev builds, so no new
cost.

**Verify.** Gate: `node:test` for token registration and send-on-completion.
App: smoke against the Gate with a test push.

---

## 4. Glanceable status — home-screen widget

**Goal.** Ambient presence: connection status, runs in flight, pending approval
count, last routine result — visible without opening the app.

**Shape.**

- There is no managed-Expo widget API as of SDK 57 — verify current guidance in
  the v57 docs before starting. Expected route: a config plugin that adds the
  native extension targets (WidgetKit on iOS, a Glance/RemoteViews provider on
  Android; `react-native-android-widget` is the known community route for
  Android — confirm it supports RN 0.86 before adopting).
- The app writes a small snapshot (JSON: status, counts, last result one-liner)
  to shared storage — App Group on iOS, shared prefs on Android — whenever run
  state changes in `gateway-provider.tsx` (the lifecycle hooks at `:1107` and
  `:2145` are the write points). The widget renders the snapshot; it never talks
  to the gateway itself.
- Widget tap deep-links via `versutus://` (item 8's link vocabulary).

**Constraints.** First native-extension target in the repo — budget for prebuild
+ release-build verification (`npm run build:android:preview:local` path in the
README). Web gets nothing; guard accordingly.

**Verify.** Snapshot writer unit tests; manual widget install on both platforms.

---

## 5. Share to Versutus (system share sheet)

**Goal.** Share a link, photo, or text from any app → lands in the Versutus
composer pre-filled, optionally addressed to a chosen Bot.

**Shape.**

- Define the internal handoff first: a new deep link, e.g.
  `versutus://compose?text=…&bot=…`, handled by extending the
  `GatewayDeepLinkRouter` pattern (`src/app/_layout.tsx:39-67`) — today it only
  accepts `add` / `gateway/add`. The compose route opens Chat with the draft
  populated (composer draft state exists: `src/lib/gateway/composer-draft.ts`).
- Android: `android.intentFilters` in `app.json` for `SEND` actions, plus a thin
  native/module read of `EXTRA_TEXT` — `react-native-receive-sharing-intent` is
  the known community route; verify RN 0.86 compatibility before adopting.
- iOS: a share extension target via config plugin that writes the shared payload
  to the App Group and opens the compose deep link.
- Images/files: phase 2. Text and URLs only for the first cut.

**Constraints.** iOS half depends on the same native-extension capability as
items 4 and 7. Shared content is untrusted input — it goes into the composer as
a draft, never auto-sent.

**Verify.** Jest for the deep-link parse + draft population; manual share from
Safari/Chrome on both platforms.

---

## 6. Quick reply from the notification

**Goal.** Reply to a Bot from the lock screen, messaging-app style.

**Build.**

- Register a `bot-message` category with a text-input action
  (`setNotificationCategoryAsync` with the category options'
  `textInput: { placeholder, submitButtonTitle }`).
- The response listener reads `response.userText` and the payload's
  `{ botId, sessionId }`, then sends through the Bot Chat path — the canonical
  session per ADR 0012, never configurable chat. Reuse the chat send pipeline
  rather than a parallel one.
- Disconnected fallback identical to item 2: park the reply in the durable
  offline outbox (already exists) and say so in a follow-up notification.

**Constraints.** Needs inbound bot-message notifications worth replying to —
lands after item 1 (or item 3) gives Bots a reason to notify. Depends on the
same response-listener plumbing as item 2; build them as one notification
workstream.

**Verify.** Jest: userText → Bot Chat send routing, outbox fallback. Manual on
device.

---

## 7. Live run progress on the lock screen

**Goal.** Start a run, pocket the phone, watch it work: an ongoing Android
notification, and later an iOS Live Activity / Dynamic Island.

**Shape.**

- Android first: a dedicated low-importance channel
  (`Notifications.setNotificationChannelAsync`) and one ongoing notification per
  active run, updated in place by re-posting the same identifier with new body
  text (elapsed time, current step from the run event stream). Retire it on
  terminal status (`isTerminalRunStatus`, `src/lib/gateway/runs.ts:127`) and hand
  off to the existing `notifyRunComplete`.
- Write points are the run lifecycle hooks in `gateway-provider.tsx` (around
  `:1107` and `:2145`), not a new poller.
- iOS Live Activity requires a widget-extension target and an activity-updates
  module (`expo-live-activity` is Expo's package for this — verify its SDK 57
  status in the v57 docs before committing). Sequence it after item 4 or 5 has
  paid for the native-extension setup.

**Constraints.** Same connection-alive limit as all local notifications: if the
app is killed, the notification freezes — the copy ("last update …") should make
staleness visible rather than imply liveness it doesn't have.

**Verify.** Jest: identifier-stable update + terminal-status retirement. Manual:
long run on Android, backgrounded.

---

## 8. Siri / Android app shortcuts on top of deep links

**Goal.** "Hey Siri, talk to Scout" → Bot Chat, composer focused. Cheapest item
on the list; compounds with everything above.

**Build.**

- Extend the deep-link vocabulary first: `versutus://chat?bot=<id>` opening Bot
  Chat (ADR 0012 canonical session) with the composer focused. Same
  `GatewayDeepLinkRouter` seam as item 5 — consider landing 5 and 8's link
  handling together.
- iOS: an App Intents config plugin donating per-Bot shortcuts. Android:
  `shortcuts.xml` + manifest meta-data via config plugin.
- Shortcut parameters (which Bot) map straight onto the `bot` query param; no
  new routing logic.

**Constraints.** Not a retention driver alone. Every surface above
(notifications, widget, share) should reuse this same link vocabulary — one
router, many entrances.

**Verify.** Jest for link parsing; manual invocation of a donated shortcut.

---

## Explicitly considered and ruled out

- **Voice input / talk** — previously ruled out (voice is host-side, no voice
  REST: `src/lib/gateway/rpc-routes.ts:115-116`). Now solved client-side instead
  of gateway-side — see **Solution B** below.
- **@mention handoff and group chats** — not missing, already decided as next
  work after the first Bot slice (ADR 0007); `group-room-view.tsx` and
  `src/lib/gateway/groups.ts` exist. Tracked by the sprint process, not here.
- **New Agent creation** — likewise already decided and specified
  (ADR 0015, `docs/adr/0015-new-agent-via-bounded-cli.md`).

---

# Deep-dive solutions

The two hardest problems, specced end to end. Both are buildable without
betraying the repo's core promise — Versutus holds no model credentials and
brokers nothing on anyone else's behalf. Each solution says exactly where that
promise gets stressed and how the design absorbs it.

---

## Solution A — True push notifications (operator-run relay)

**Problem.** Local notifications fire only while the app's gateway connection is
alive. A killed app is a silent app, so approvals and routine results wait for
the user to come back on their own — the retention loop from item 1 stays
approximate.

**Approach.** The Versutus Gate (`gate/`, port 8760) becomes the notification
relay. It is already the operator-run companion server, already paired with the
device, and already owns the `cron` capability kind — no third party is
introduced into the trust path. Delivery rides the Expo Push Service
(APNs/FCM underneath). What Expo's servers see is limited by design; see
Privacy below.

### A1. Credentials (one-time, operator-held)

- The EAS `projectId` already exists (`app.json:69-71`).
- iOS: an APNs key registered to the app's EAS project. Android: FCM
  credentials (`google-services.json` + service account) via EAS.
- Push is unavailable in Expo Go on Android — irrelevant here; the repo already
  ships dev builds / direct prebuild APKs (README).

### A2. Token lifecycle (app side)

- After pairing completes, call `Notifications.getExpoPushTokenAsync()` and
  register the token with the Gate over the existing authenticated channel —
  pairing is the trust bootstrap, reuse it rather than inventing a second
  handshake. Store the token in SecureStore (existing pattern).
- Re-register when the token changes; deregister on device revoke (the
  `/device revoke` surface shipped last sprint) and on gateway-profile removal.
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
  (which Bots, quiet hours) — preferences endpoint from A3, edited from a new
  pane in the app's gateway settings (`src/app/gateway/settings.tsx`).

### A5. Send path

- Expo Push API (`POST https://exp.host/--/api/v2/push/send`), chunked at 100
  messages, with receipt collection: `DeviceNotRegistered` removes the token
  from the registry immediately — a dead token that keeps receiving sends is
  how relays get throttled.
- **Payload shape is fixed by item 1c**: `{ kind: 'run' | 'approval' |
  'routine', runId?|jobId?, botId? }` — identical to the local-notification
  payloads, so the single response listener in `src/app/_layout.tsx:27-37`
  routes push and local taps through one code path. Do not invent a second
  shape.
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

- Approvals channel on Android at HIGH importance
  (`Notifications.setNotificationChannelAsync`) so they break through;
  routine results on a DEFAULT channel.
- On tap: existing response listener → item 1c routing. If the gateway is
  unreachable at tap time, land on Activity with the pending state visible —
  the run is gateway-side, so nothing is lost.
- Update the README scope limit ("True push … not invented here") the day this
  ships, and not before.

### A8. Rollout

1. A2–A5 behind a per-gateway toggle, off by default. 2. Preferences pane.
3. Rich-body opt-in. 4. On by default for new pairings once the smoke test has
run green against a real device for a week.

---

## Solution B — Voice chat capability

**Problem.** Hermes voice is host-side — the API server exposes no voice REST
(`src/lib/gateway/rpc-routes.ts:115-116` routes `talk.catalog` and
`voicewake.status` to that explanation), so the gateway's own voice pipeline
cannot be driven from a phone. That fact does not block voice chat; it only
blocks *remote control of the host's* voice.

**Approach.** Voice lives on the phone; text crosses the wire. Speech-to-text
turns the user's voice into a chat draft, the existing Bot Chat pipeline
carries it, and text-to-speech reads the reply aloud. Every backend Versutus
supports gets voice on day one because nothing about the gateway changes.

### B1. Speech-to-text (push-to-talk)

- Library: `expo-speech-recognition` (jamsch) — wraps iOS `SFSpeechRecognizer`
  and Android `SpeechRecognizer`, with on-device recognition support so audio
  need not leave the phone. Its versioning aligns with Expo SDK releases from
  SDK 56 onward; **confirm an SDK 57-compatible release before adopting**, and
  if none exists, fall back to its config-plugin predecessor rather than
  writing a native module in-repo.
- Permissions via the config plugin: iOS `NSMicrophoneUsageDescription` +
  `NSSpeechRecognitionUsageDescription`; Android `RECORD_AUDIO`.
- UX in the existing composer (`src/components/chat/chat-composer.tsx`): a mic
  button beside send. Hold to talk; partial transcripts stream into the draft
  (`src/lib/gateway/composer-draft.ts`); release ends recognition and leaves
  the text in the composer **for review — never auto-send**. Haptics on
  start/stop (`expo-haptics`, already a dependency).
- Voice input lands in whichever conversation is open — Bot Chat stays
  canonical (ADR 0012); no routing change.

### B2. Spoken replies (TTS)

- Library: `expo-speech` (~57.0.1, official, in the SDK — `Speech.speak`,
  per-voice `rate`/`pitch`/`volume`, `onDone`/`onBoundary` callbacks).
- Opt-in per conversation: a speaker toggle in the chat header. When on, each
  completed assistant message is spoken. Long replies are chunked at sentence
  boundaries (respect `Speech.maxSpeechInputLength`; unbounded on iOS, finite
  on Android) and queued in order; a new user message or toggle-off calls
  `Speech.stop()` and clears the queue.
- **Per-Bot voices**: Bots have souls; give them voices. Persist
  `{ voiceIdentifier, rate, pitch }` per Bot in the bot chrome state
  (`src/lib/gateway/bot-chrome.ts` is the existing per-Bot presentation seam —
  verify it is the right home before extending). Pick from
  `Speech.getAvailableVoicesAsync()`, prefer `VoiceQuality.Enhanced`.
- iOS caveat to surface honestly in the UI: `expo-speech` produces no sound on
  a physical device in silent mode — show a one-time hint, not an error.
- Web: `expo-speech` works on web; STT on web degrades to the platform's
  dictation — acceptable, and say so in the UI.

### B3. Conversation loop (the "voice chat" feel)

- With the speaker toggle on: user holds-to-talk → reviews → sends → reply is
  spoken. That is a full voice loop with zero server work and works against
  Hermes, Gate, and OpenClaw identically.
- Keep the mic unusable-while-disconnected state explicit (composer already
  knows connection state).

### B4. Phase 2 — realtime voice via the Gate (only if B1–B3 earn it)

- A new Gate capability kind, `realtime-voice`, defined at
  `gate/core/capabilities/realtime-voice/kind.mjs` like every other kind:
  provider-backed realtime audio session (OpenAI-compatible realtime over
  WebSocket), with the Bot's soul injected as session instructions and tool
  calls routed back through the existing run/approval machinery so approvals
  still gate execution. The phone streams audio to the Gate; the Gate holds
  the provider credential — consistent with credential custody today.
- This is a large, paid-provider-dependent lift. It is justified only by
  evidence that operators actually use B1–B3 daily.

### B5. Explicitly not in scope

- **Wake word / always-listening** — `voicewake` is host-side by design, and
  always-on mic on a phone is a battery and privacy regression.
- **Remote control of the host's voice hardware** — the thing
  `rpc-routes.ts:115-116` says does not exist. If Hermes later ships voice
  REST, add it as a capability-gated surface, the established pattern.

### B6. Verify

- Jest: draft-population from transcript events, sentence chunking against
  `maxSpeechInputLength`, queue clearing on interrupt, per-Bot voice
  persistence.
- Manual on device (both platforms): hold-to-talk in Bot Chat, spoken reply
  with a per-Bot voice, silent-mode hint on iOS, and `npm run verify` green.

---

# Competitive deep dive (added 2026-09-09)

Benchmarked against the major mobile AI apps: ChatGPT (voice mode with file
uploads, widgets, memory manager, Projects), Claude (Projects, artifacts,
long-document analysis), Gemini (live voice, camera/screen share), Perplexity
(sourced answers). None of them is the real competitor, though — Versutus is an
*operator's* client for self-hosted agents. The competitor set matters for
**feel** (Part 1); the win comes from what they structurally cannot do
(Part 2).

Format per entry: what it is · why · where it hooks in · rough effort
(S/M/L). These are candidates, not commitments — promote one to a full spec
(like Solutions A/B) before building.

## Part 1 — Luxury parity: what the majors ship and Versutus should

### P1. Multimodal composer (photos, camera, files)

ChatGPT/Gemini treat attaching an image or PDF as table stakes; ChatGPT Voice
now takes file uploads mid-conversation. Versutus's composer
(`src/components/chat/chat-composer.tsx`) is text-only.
Hook: attachment tray in the composer, sent as data-URL content parts on the
existing chat pipeline. **Capability-gated, the established pattern** — the
attach button appears only when the selected model advertises vision/files,
exactly how the Shell tab appears only when a terminal is advertised.
Effort: M. Note: image *generation* stays out of scope — that's a provider
feature, not a client one.

### P2. Memory manager per Bot

ChatGPT's memory manager is a headline luxury feature, and Hermes Bots *have*
memory (`CONTEXT.md`: soul, memory, model pin per Bot) that today has no
first-class surface.
Hook: a Memory pane beside the Routines pane — read, search, edit, and prune
the Bot's memory, riding the existing `/memory` registry entry
(`src/lib/gateway/dashboard.ts`). Read-first, then edits behind confirmation.
Effort: M. Genuinely better than ChatGPT's version: the operator sees the raw
files, not a curated summary.

### P3. Session search, pinning, rename

Every major app has conversation search and pinning; Versutus has per-Bot
session lists with neither.
Hook: `src/lib/gateway/session-list.ts` + the sessions sheet — client-side
filter first (titles are local), server search only if the gateway offers it.
Pin/rename state in key-value storage, keyed by gateway + session like the
command transcript precedent.
Effort: S.

### P4. Biometric app lock

ChatGPT ships Face ID lock; an app holding gateway tokens and device identity
(SecureStore) has a stronger case for it than a chatbot does.
Hook: `expo-local-authentication` (not yet a dependency — add via
`npx expo install`), gate the `Stack` in `src/app/_layout.tsx` behind a lock
screen when enabled in settings. Opt-in, off by default.
Effort: S.

### P5. Spend dashboard

The majors show usage meters; Versutus already has the raw material —
`session-analytics.ts`, `ThreadSpendGlance` (`chat-screen.tsx:1318`), and the
`session.usage` overflow glance.
Hook: a full dashboard surface (gateway settings or its own Activity section):
spend per Bot / per gateway over time, charts in Skia (already a dependency).
No new protocol — aggregation over data the app already fetches.
Effort: M.

### P6. Transcript export & share

Claude/ChatGPT let you share a conversation. For an operator, the artifact is
the transcript of a run or a Bot Chat session — exported as Markdown.
Hook: share sheet export from the transcript view (`src/lib/gateway/transcript.ts`
is the model); redact tool-call payloads behind a toggle. No server, no link
hosting — the file is the share.
Effort: S.

*Already specced elsewhere in this document, also parity items: voice mode
(Solution B), home-screen widget (item 4), app shortcuts (item 8), live run
progress (item 7), push (Solution A — where Versutus's self-hosted relay is
arguably past parity, not at it).*

## Part 2 — Differentiators: what the majors structurally cannot do

The majors are one assistant behind one cloud account. Versutus fronts a fleet
of named, persistent, self-hosted agents with real permissions. Every entry
here exploits that.

### D1. Approval inbox with policies and audit

No consumer competitor has agent approvals *at all*; Versutus already has
inline approvals. Take it from feature to command center: an inbox-style triage
queue (batch approve/deny), **approval policies** ("auto-approve read-only
commands from Bots I trust"), and a durable audit log of every decision.
Hook: extends the `approval.approve` path and the Activity approvals presence;
policy engine client-side in `src/lib/gateway/`, audit in key-value storage.
Auto-approve stays opt-in per Bot and never covers destructive classes — the
fail-closed discipline (ADR 0008) applied to consent.
Effort: M–L. This is the flagship differentiator.

### D2. Fleet constellation (mission control)

A Skia-rendered live map of the operator's whole fleet: gateways as nodes,
Bots beneath them, routines as scheduled arcs, live runs and pending approvals
pulsing. Nothing like it exists in any competitor because no competitor has a
fleet.
Hook: read-only projection of data the provider already holds (capability
snapshot, roster, cron list, run state) — pure presentation, no new protocol.
Skia is already a dependency.
Effort: L. Highest "wow" per pixel in this document; also the screenshot that
sells the app.

### D3. Bot scorecards and the weekly operator report

Per-Bot track record: runs succeeded/failed, spend, average latency, approvals
requested vs granted. Delivered as a weekly digest notification — which folds
straight into the item 1 retention loop.
Hook: aggregation over persisted run history (`runs.ts`) and
`session-analytics.ts`; notification via item 1's scheduled-notification
plumbing.
Effort: M. Competitors meter usage; none of them *grades your agents*.

### D4. Routine template packs

ChatGPT has scheduled tasks but no templates, and none that target your own
infrastructure. Ship one-tap packs: "morning briefing," "inbox triage,"
"server watchdog," "weekly code review" — each a prefilled `RoutineDraft`
(`src/lib/gateway/routines.ts:15`) with a sane schedule.
Hook: a templates row in the Routines pane; creating one is the existing
create path with fields pre-populated. Pure client, no gateway change.
Effort: S. Cheap, and it seeds the item 1 loop for every new operator.

### D5. Budgets with hard stops

Competitors show you a meter after the fact. Versutus can *enforce*: per-Bot
spend caps that pause the Bot's runs and escalate to an approval when the cap
is hit ("Scout has spent $4.20 of $5 this week — approve more?").
Hook: client-side ledger over `session.usage` data + the existing run-start
path; the cap check happens before `executeRun` (`src/lib/gateway/runs.ts:211`).
Honest limit: enforcement is client-side, so it governs runs started from this
app — say so in the UI, don't pretend it's a server-side quota.
Effort: M.

### D6. Bot handoff packets

Export a Bot as a portable file — soul, routines, skills list, presentation
chrome — importable on another Hermes host. "Share your agent" with no cloud
marketplace, consistent with the self-hosted ethos.
Hook: export bundles what's readable via existing surfaces
(`bot-detail.ts`, routines list); **memory and credentials are excluded by
default** — that's the trust line, and the packet format should say so in a
manifest field. Import validates against the receiving gateway's capabilities
before creating anything.
Effort: M.

### D7. Council mode — broadcast and compare

Send one prompt to several Bots (or the same Bot on different model pins) and
render the answers side by side. Multi-agent comparison is something a
single-assistant app cannot offer.
Hook: fan-out over the existing per-Bot send path, results in a comparison
view; builds naturally on the group-session primitives
(`src/lib/gateway/groups.ts`) without shipping full group chats first.
Effort: M.

### D8. Deferred-execution queue ("when my PC wakes, run this")

The durable offline outbox exists for chat. Extend the idea to runs: queue a
run or prompt while the gateway is down; it fires automatically on reconnect,
and the result arrives via the item 1 / Solution A notification path.
Hook: outbox persistence (`composer-draft.ts` / outbox precedent) keyed per
gateway, drained by the reconnect path in the provider.
Effort: M. Quietly powerful: it makes "the gateway is asleep" a non-event,
which no competitor's always-on cloud ever has to solve — and no competitor's
user ever gets to feel.

## What we deliberately do NOT copy

- **Image/video generation surfaces** — provider features; Versutus is a
  client (README: "a client… brokers nothing").
- **Cloud accounts, hosted sync, social features** — the self-hosted,
  no-credential-custody stance is the product's spine; parity features that
  require breaking it (P8-style cloud sync) are rejected, not deferred.
- **Always-listening wake word** — host-side by design (Solution B5).

---

# Full specs (promoted 2026-09-09)

P5, D2 and D3 promoted from the competitive deep dive to handoff-ready specs.
Same house rules as the rest of the document: Expo v57 docs before code,
`npm run verify` green, honesty in copy wherever the data has limits.

---

## P5. Spend dashboard

**Goal.** One surface answering "what did my agents cost me?" — per Bot, per
gateway, over time — built entirely on data the app already fetches.

**What exists.** The hard part is done. `src/lib/gateway/session-analytics.ts`
already provides: `SessionUsageInput` (input/output tokens, actual + estimated
cost, `last_active`), `sessionSpendReadFromUnknown` / `totalUsage` for folding
`sessions.list` reads, `weekBuckets` for a 7-day window, `relativeMeter`, and
the two discipline rules this spec inherits — a failed read is named, never
rendered as zero spend (`applySessionSpendRead`, `:129-136`), and a truncated
window names its bound (`spendWindowCopy` + `SESSION_SPEND_LIST_LIMIT = 200`,
`:262-275`). `ThreadSpendGlance` proves the per-thread read in production.

**Build.**

1. **Screen**: new route `src/app/gateway/spend.tsx`, registered in the
   `_layout.tsx` Stack with the same modal treatment as `gateway/settings`.
   Entry points: gateway settings and the Activity tab.
2. **Sections, top to bottom**: gateway total (existing `totalUsage` fold) →
   7-day chart (existing `weekBuckets`) → **per-Bot breakdown** → per-session
   table (reuse `SessionUsageInput` rows, sorted by cost).
3. **Per-Bot breakdown is the new work.** A Hermes session belongs to exactly
   one Bot (CONTEXT.md), and Bot traffic is already scoped `/p/<bot>/` through
   multiplex (ADR 0005). Fetch `session.usage` per Bot scope and fold each with
   the existing helpers — no new aggregation logic, N existing reads. Gate the
   section on the roster having loaded; a Bot whose read fails shows "spend
   could not be read," never zero.
4. **Charts in Skia** — the dependency is present and the render pattern exists
   (`src/components/layout/AmbientCanvas.native.tsx`). Bar chart for the 7-day
   buckets, horizontal bars for per-Bot. Provide the plain-View fallback for
   web, matching the `AmbientCanvas` native/web split.
5. **Cost honesty, non-negotiable**: `costUsd` is nullable (`actual ?? estimated`,
   `:61-62`). When every session is estimate-only, the header says "estimated";
   when no cost fields exist at all (Gate bare-catalogue shape, `:88-97`), the
   dashboard shows tokens only and says why. Never mix actual and estimated in
   one number without labeling.

**Constraints.** The 200-row list cap applies here as-is; reuse
`spendWindowCopy` verbatim for the window line. No new gateway protocol — if
per-Bot `session.usage` isn't dispatched by a given gateway, that gateway's
dashboard degrades to the gateway total alone (capability-gated, the
established pattern).

**Verify.** Jest: per-Bot fold over mocked scoped reads, failed-read rendering,
estimate labeling. Manual: screen against a live Hermes gateway and the Gate.

---

## D2. Fleet constellation (mission control)

**Goal.** A Skia-rendered live map of the operator's fleet — gateways, their
Bots, routines, live runs, pending approvals — the screenshot that sells the
app.

**The honesty constraint that shapes everything.** Versutus holds **one live
gateway connection** (the provider tracks a single active gateway). So the
constellation renders two truth classes, visually distinct:

- **Connected gateway** — fully live: capability snapshot, roster, cron list
  (`CronJob` + `describeCronHealth`, `src/lib/gateway/cron.ts`), run state
  (`activityRuns` in the provider), pending approvals.
- **Saved-but-not-connected gateways** — last-known reachability from the
  probe wave (`src/lib/gateway/reachability-wave.ts`,
  `src/hooks/use-gateway-reachability.ts` already stamps `lastProbeAt`) and the
  profile's cached metadata. Rendered dimmed, labeled "last seen …", never
  rendered as live. Tapping one offers "connect" — that's the action the map
  exists to drive.

**Build.**

1. **Route**: `src/app/fleet.tsx`, full-screen (not modal — this is a
   destination), Stack-registered. Entry: a button on Home's connection hero.
2. **Model**: new `src/lib/fleet/constellation-model.ts` — a pure function
   from `{ profiles, reachability, connectedSnapshot, roster, cronJobs,
   activityRuns, pendingApprovals }` to a positioned node/edge graph.
   Pure and fully unit-testable; the Skia layer only draws what the model
   emits. Gateway nodes outer ring, Bot nodes clustered beneath their gateway,
   routine arcs on Bots that have them, live-run pulse, approval badge.
3. **Render**: Skia `Canvas` on native, following the `AmbientCanvas.native`
   pattern; web gets a simplified static SVG/list fallback (Skia-web is not
   part of this spec). Animations via Reanimated shared values, not per-frame
   JS — Reanimated 4 is already the house animation layer.
4. **Interaction**: tap a Bot node → Bot Chat (ADR 0012 canonical session);
   tap a gateway → connect sheet; tap an approval badge → Activity. Long-press
   a node → its detail sheet. No editing on the map in v1 — it is a lens, not
   a control surface.
5. **Live updates**: the map subscribes to provider state; no polling of its
   own. Disconnected gateways re-check via the existing probe wave only —
   the constellation must not add network traffic.

**Constraints.** Read-only projection — zero new protocol, zero new fetches.
Empty fleet (one gateway, no Bots) must still render something dignified: the
single gateway node with its connect state, not a broken-looking empty canvas.

**Verify.** Jest: `constellation-model.ts` exhaustively (positioning,
truth-class assignment, approval counts). Manual: two saved profiles, one
connected, one down — the down one is dimmed and dated, never green.

---

## D3. Bot scorecards + the weekly operator report

**Goal.** Per-Bot track record — success rate, latency, approvals, spend —
with a weekly digest notification that feeds the item 1 retention loop.

**What exists.** Run history is already persisted:
`ActivityRun` (`src/lib/gateway/runs.ts:50-61`) carries `status`
(running/waiting-approval/complete/failed/cancelled/unresolved), `startedAt` /
`finishedAt`, and `approved`; `loadActivityRuns` / `saveActivityRuns`
(`session-persistence.ts:86-105`) persist the list. Routine health exists via
`describeCronHealth` (`cron.ts:82`). Spend per Bot arrives with P5.

**The gap to close first: Bot attribution.** `ActivityRun` has **no Bot
field** — scorecards are impossible until runs know which Bot they ran on.
Step zero of this spec: add an optional `botId?: string` to `ActivityRun`,
stamped at run creation from the profile-scoped target (runs are already
launched profile-scoped per the Activity tab). Old persisted rows without it
aggregate under "unattributed" — never silently dropped, never guessed.

**Build.**

1. **Scorecard model**: `src/lib/fleet/scorecard.ts` (pure, tested) folding
   `ActivityRun[]` + cron health + P5's per-Bot spend into per-Bot cards:
   success rate (`complete` / terminal statuses; `cancelled` and `unresolved`
   counted separately — a cancelled run is not a failure), median run duration
   from `startedAt`/`finishedAt`, approval pressure (approvals requested vs
   granted, from `waiting-approval` history + `approved`), routine reliability
   from cron health, spend from P5.
2. **Window honesty, same discipline as P5**: the persisted run list is capped
   (`ACTIVITY_RUNS_PERSIST_CAP`), so every scorecard names its window —
   "last N runs" — the way `spendWindowCopy` names the 200-session bound.
3. **Surface**: a Scorecards section on the Activity tab (where runs already
   live), one card per Bot, tap → that Bot's run history filtered.
4. **Weekly report**: a scheduled **weekly** local notification
   (`SchedulableTriggerInputTypes.WEEKLY` — verified in the v57 docs) using
   item 1a's sync/cancel plumbing. Copy is honest in the same way item 1a's
   is: the scheduled notification cannot know the week's numbers while the app
   is closed, so it says *"Your weekly agent report is ready"* and the tap
   opens the scorecard surface, which computes live. When Solution A ships,
   the Gate can send the real numbers — the payload-shape rule (A5) already
   covers this.
5. **Opt-in**: the weekly notification is enabled from the scorecard surface,
   off by default; per-item-1a bookkeeping stores its identifier for cancel.

**Constraints.** Scorecards are client-side observations of runs this app saw
— runs started from the desktop or TUI never touched this device. The surface
says "runs seen from this device" once, in a footer, and never implies
otherwise. Do not build a server-side analytics pipe to fix this; if that
becomes worth having, it rides Solution A's relay, not a new channel.

**Verify.** Jest: attribution migration (old rows → "unattributed"), status
folding (cancelled ≠ failed), window line, median duration. Manual: run a mix
of successes/failures across two Bots, check the cards, enable the weekly
notification and confirm it schedules (device logs /
`getAllScheduledNotificationsAsync` in dev).
