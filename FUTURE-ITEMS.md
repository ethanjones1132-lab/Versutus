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

## Shipped since 2026-09-09 — removed from this document

| item | shipped as |
|---|---|
| 1a Routine → scheduled notification | `notifications/routine-schedule.ts`, `routine-sync.ts` |
| 1b "While you were away" digest | `components/home-briefing-card.tsx`, `src/lib/home/` |
| 1c Notification tap deep-link | `notifications/tap-route.ts` |
| 2 Actionable approval notifications | `notifications/approval-action.ts` |
| 4 (iOS half) Glanceable widget | `components/widget/glanceable-widget.tsx`, `lib/widget/` |
| 5 Share to Versutus | `gateway/share-intent.ts`, `share-intent-native.ts`, compose deep link |
| 6 Quick reply from notification | `notifications/bot-reply.ts` |
| 7 Live run progress | `notifications/run-progress.ts`, `components/widget/run-live-activity.tsx` |
| P4 Biometric app lock | `components/app-lock-gate.tsx`, `lib/settings/app-lock-device.ts` |
| P5 Spend dashboard | `src/app/gateway/spend.tsx` |
| P6 Transcript export & share | `gateway/transcript-share.ts` |
| D3 Bot scorecards + weekly report | `lib/fleet/scorecard.ts`, `notifications/weekly-report.ts` |
| D4 Routine template packs | `gateway/routine-templates.ts`, `chat/routines-pane.tsx` |
| Solution B, B1–B3 Voice chat | `expo-speech-recognition` + `expo-speech`, shipped and in daily use |

**Ambiguous, left in place rather than deleted:** D5 (budgets with hard stops) —
`components/activity/scorecards-section.tsx` surfaces a spend cap, but whether
the *enforcing* pre-run check exists was not confirmed. Verify before building.

---

## 3. True push via a Phase D relay (the endgame)

**Goal.** Routine results and approval requests arrive when the app is fully
closed — the correct replacement for item 1's "due at the scheduled time"
approximation. **Fully specced as Solution A below**; this entry stays so the
priority ordering keeps making sense.

**Shape.** The Versutus Gate (`gate/`, port 8760) is the relay — it is already
the operator-run companion server and already owns a `cron` capability kind.

1. App obtains an Expo push token (`Notifications.getExpoPushTokenAsync`; the
   EAS `projectId` already exists in `app.json`) and registers it with the
   Gate alongside its device identity (pairing already exists — reuse it).
2. Gate watches its own job/run completions (it already dispatches cron) and
   sends the result payload through the Expo Push Service.
3. App side: the existing response listener routes the push the same way
   `notifications/tap-route.ts` routes local taps — the `data` payload shapes
   already shipped, so the relay can supply the identical shape with real
   content.

**Constraints.** Real backend work in `gate/` with its own `node:test` suite;
requires credentials the operator controls (EAS project is theirs). Push is
unavailable in Expo Go on Android; this repo already ships dev builds, so no new
cost.

**Verify.** Gate: `node:test` for token registration and send-on-completion.
App: smoke against the Gate with a test push.

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

**Approach.** The Versutus Gate (`gate/`, port 8760) becomes the notification
relay. It is already the operator-run companion server, already paired with the
device, and already owns the `cron` capability kind — no third party is
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
  (which Bots, quiet hours) — preferences endpoint from A3, edited from a new
  pane in the app's gateway settings (`src/app/gateway/settings.tsx`).

### A5. Send path

- Expo Push API (`POST https://exp.host/--/api/v2/push/send`), chunked at 100
  messages, with receipt collection: `DeviceNotRegistered` removes the token
  from the registry immediately — a dead token that keeps receiving sends is
  how relays get throttled.
- **Payload shape is fixed by the shipped tap router**: `{ kind: 'run' |
  'approval' | 'routine', runId?|jobId?, botId? }` — identical to the
  local-notification payloads, so one response listener routes push and local
  taps through one code path. Do not invent a second shape.
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
  below is the cheaper client-side alternative to this** — decide between them
  before building either.

### B5. Explicitly not in scope

- **Wake word / always-listening** — host-side by design; always-on mic is a
  battery and privacy regression.
- **Remote control of the host's voice hardware** — the thing
  `rpc-routes.ts:115-116` says does not exist. If Hermes later ships voice
  REST, add it as a capability-gated surface, the established pattern.

---

# Competitive candidates (2026-09-09, unbuilt remainder)

Candidates, not commitments — promote one to a full spec before building.

### P1. Multimodal composer (photos, camera, files)

ChatGPT/Gemini treat attaching an image or PDF as table stakes. Versutus's
composer (`src/components/chat/chat-composer.tsx`) is text-only.
Hook: attachment tray in the composer, sent as data-URL content parts on the
existing chat pipeline. **Capability-gated, the established pattern** — the
attach button appears only when the selected model advertises vision/files.
Effort: M. Image *generation* stays out of scope — a provider feature, not a
client one.

### P2. Memory manager per Bot

Hermes Bots *have* memory (soul, memory, model pin per Bot) with no first-class
surface. Hook: a Memory pane beside the Routines pane — read, search, edit and
prune, riding the existing `/memory` registry entry
(`src/lib/gateway/dashboard.ts`). Read-first, then edits behind confirmation.
Effort: M. Better than ChatGPT's version: the operator sees the raw files.

### P3. Session search, pinning, rename

Hook: `src/lib/gateway/session-list.ts` + the sessions sheet — client-side
filter first (titles are local), server search only if the gateway offers it.
Pin/rename state in key-value storage, keyed by gateway + session.
Effort: S.

### D1. Approval inbox with policies and audit

No consumer competitor has agent approvals at all. Take it from feature to
command center: inbox-style triage (batch approve/deny), **approval policies**
("auto-approve read-only commands from Bots I trust"), and a durable audit log.
Hook: extends the `approval.approve` path and the Activity approvals presence;
policy engine client-side in `src/lib/gateway/`, audit in key-value storage.
Auto-approve stays opt-in per Bot and never covers destructive classes — the
fail-closed discipline (ADR 0008) applied to consent.
Effort: M–L. The flagship differentiator.

### D5. Budgets with hard stops — VERIFY STATE FIRST

Per-Bot spend caps that pause runs and escalate to an approval when hit.
`scorecards-section.tsx` already surfaces a cap; confirm whether the enforcing
pre-run check exists before specifying work.
Hook: client-side ledger over `session.usage` + the run-start path; the cap
check happens before `executeRun`. Honest limit: enforcement is client-side, so
it governs runs started from this app — say so, don't imply a server quota.
Effort: M.

### D6. Bot handoff packets

Export a Bot as a portable file — soul, routines, skills list, chrome —
importable on another Hermes host. Hook: export bundles what's readable via
existing surfaces; **memory and credentials excluded by default** — that's the
trust line, and the manifest should say so. Import validates against the
receiving gateway's capabilities first.
Effort: M.

### D7. Council mode — broadcast and compare

Send one prompt to several Bots (or one Bot on different model pins) and render
answers side by side. Hook: fan-out over the existing per-Bot send path, results
in a comparison view; builds on `src/lib/gateway/groups.ts` without shipping
full group chats first.
Effort: M.

### D8. Deferred-execution queue ("when my PC wakes, run this")

Extend the durable offline outbox from chat to runs: queue a run while the
gateway is down; it fires on reconnect and the result arrives via the
notification path. Hook: outbox persistence keyed per gateway, drained by the
reconnect path in the provider.
Effort: M. Makes "the gateway is asleep" a non-event.

## What we deliberately do NOT copy

- **Image/video generation surfaces** — provider features; Versutus is a client.
- **Cloud accounts, hosted sync, social features** — the self-hosted,
  no-credential-custody stance is the product's spine.
- **Always-listening wake word** — host-side by design.

---

## D2. Fleet constellation (mission control)

**Goal.** A Skia-rendered live map of the operator's fleet — gateways, their
Bots, routines, live runs, pending approvals — the screenshot that sells the
app.

**The honesty constraint that shapes everything.** Versutus holds **one live
gateway connection**. So the constellation renders two truth classes, visually
distinct:

- **Connected gateway** — fully live: capability snapshot, roster, cron list
  (`CronJob` + `describeCronHealth`, `src/lib/gateway/cron.ts`), run state,
  pending approvals.
- **Saved-but-not-connected gateways** — last-known reachability from the probe
  wave (`src/lib/gateway/reachability-wave.ts`,
  `src/hooks/use-gateway-reachability.ts` already stamps `lastProbeAt`) and the
  profile's cached metadata. Rendered dimmed, labeled "last seen …", never
  rendered as live. Tapping one offers "connect" — the action the map exists to
  drive.

**Build.**

1. **Route**: `src/app/fleet.tsx`, full-screen (not modal — a destination),
   Stack-registered. Entry: a button on Home's connection hero.
2. **Model**: `src/lib/fleet/constellation-model.ts` — a pure function from
   `{ profiles, reachability, connectedSnapshot, roster, cronJobs,
   activityRuns, pendingApprovals }` to a positioned node/edge graph. Pure and
   fully unit-testable; the Skia layer draws only what the model emits. Gateway
   nodes outer ring, Bots clustered beneath their gateway, routine arcs,
   live-run pulse, approval badge. Note `src/lib/fleet/scorecard.ts` already
   exists — this joins it in that folder.
3. **Render**: Skia `Canvas` on native, following `AmbientCanvas.native`; web
   gets a simplified static fallback. Animations via Reanimated shared values,
   not per-frame JS.
4. **Interaction**: tap a Bot → Bot Chat (ADR 0012); tap a gateway → connect
   sheet; tap an approval badge → Activity. Long-press → detail sheet. No
   editing on the map in v1 — it is a lens, not a control surface.
5. **Live updates**: subscribes to provider state; no polling of its own.
   Disconnected gateways re-check via the existing probe wave only — the
   constellation must not add network traffic.

**Constraints.** Read-only projection — zero new protocol, zero new fetches.
Empty fleet must still render something dignified.

**Verify.** Jest: `constellation-model.ts` exhaustively. Manual: two saved
profiles, one connected, one down — the down one dimmed and dated, never green.

---

# Added 2026-09-11

Six items raised in one session. They are not independent: the slash-command
regression blocks Workflows, and Workflows determines what the Activity tab
sheds. Each gets its own spec and implementation cycle — they must not be
designed as one change.

```
slash-command regression ──blocks──> Workflows ──defines──> Activity/cron
push on final response   (independent; Solution A is the real fix)
hands-free voice         (independent; compare against Solution B4)
Android widget           (independent; approach approved, below)
```

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

## Runs are broken — slash commands not recognized (BUG, blocks Workflows)

**Symptom.** Runs do not work, and the app does not appear to recognize slash
commands at all.

**Why this is logged as a bug, not a feature.** Slash-command handling is
already implemented — `src/lib/gateway/slash-commands.ts`,
`slash-palette.ts`, `busy-slash.ts`. So this is a regression in an existing
system, which is a much cheaper problem than it sounds.

**Why it must be fixed before Workflows.** Runs themselves are being replaced
(below), so repairing *run* execution is likely wasted work. The **slash-command
dispatch layer survives the rename**, and Workflows will be invoked through it.
Diagnose the dispatcher; do not invest in run execution.

**Not yet diagnosed.** Start at the dispatch path and establish whether commands
fail to parse, fail to match the registry, or match and fail to execute — the
three have different fixes.

---

## Runs become Workflows

**Goal.** Replace one-shot runs with reusable, named **Workflows** — task
sequences a slash command can reference and re-invoke.

**Shape (to be designed).** The slash command for a run becomes a reference to a
stored workflow or task sequence rather than an ad-hoc invocation. This is the
conceptual core of the 2026-09-11 batch: its shape determines what the Activity
tab sheds, so it is designed before the Activity work.

**Dependencies.** Blocked by the slash-command regression above.

**Open questions for the design session.** Where workflows are stored (app,
Gate, or Hermes-side); whether they are per-Bot or fleet-wide; how parameters
are passed; what happens to the persisted `ActivityRun` history and the
`botId` attribution that `lib/fleet/scorecard.ts` depends on.

---

## Activity tab becomes cron view, reporting and management

**Goal.** Remove run information from the Activity tab and make it a dedicated
surface for cron: viewing scheduled work, reporting on it, and managing it.

**What already exists to build on.** More than it first appears —
`notifications/routine-schedule.ts`, `routine-sync.ts`, `weekly-report.ts`,
`weekly-report-schedule.ts`, `gateway/routine-templates.ts`,
`gateway/cron.ts` (`CronJob`, `describeCronHealth`), and
`components/activity/scorecards-section.tsx`. This may be closer to *surfacing
and consolidating* what exists than to building scheduling from scratch.

**Dependencies.** Follows Workflows — what Activity removes depends on what runs
become.

**Care required.** `lib/fleet/scorecard.ts` and the shipped D3 weekly report
both read persisted run history. Removing runs from the Activity *surface* must
not silently break the scorecard's data source.

---

## Push notifications on model final response

**Goal.** Every session and profile raises a true push notification when the
model delivers its final response.

**This is Solution A, not a new mechanism.** Local notifications fire only while
the gateway connection is alive, so a closed app stays silent — exactly the
limitation Solution A exists to remove. The `bot-reply.ts` notification already
exists for the local case; the missing piece is the relay
(`push-registration.ts` is still absent) and the Gate-side notifier.

**Scope note.** "Model final response" is a new trigger class alongside A4's run
completed / errored / approval required / routine result. Add it to the
notifier's event subscription rather than building a parallel path, and keep the
A5 payload shape.

**Honesty constraint carried forward.** Until the relay ships, nothing may be
described as push (house rule, and the README scope statement).

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
