# Versutus - announcement and release notes (draft)

**Draft only.** This file was written from the source tree in this checkout and is not posted
anywhere. Every feature claim below is followed by the file and line it was checked against.
There is no date, external link, download count, device result or performance figure in this
draft, because this checkout cannot prove any of those. Posting is Ethan's job.

The short drafts beside this one remain the source for the one-paragraph versions:
`docs/release/ANNOUNCEMENT.md` and `docs/release/RELEASE-NOTES.md`. This file does not replace
or contradict them; it expands them.

---

## 1. Hermes community announcement

### Versutus - a phone client for the agent you already run

Hermes Agent exposes an HTTP API server, and Versutus is a client for it. Point the app at that
server on your own machine - over LAN, Tailscale, or a gate you control - and drive the agent
from a phone: chat, Bots, agentic runs, approvals, tools (README.md:5). Versutus is a client, not
a relay: it holds no model credentials of its own and brokers nothing for anyone else
(README.md:7; docs/release/PRIVACY.md:16-21).

The app identifies a gateway rather than assuming one. It walks a beacon hint, an Open Gateway
Manifest, a Hermes fingerprint and an OpenClaw probe, and records "unknown" when nothing matched
(src/lib/portal/identify.ts:1-7). Nothing is fetched from a service owned by the author. Two
third parties can be involved, each only when you use the feature: the Expo Push Service when
you turn push on, and the device/platform speech recogniser when you dictate or run a
phone-transport call (docs/release/PRIVACY.md:22-31).

#### Chat and Bots

- Chat lands on a roster, not on last night's session; each Bot is a row you tap
  (README.md:45; src/components/chat/chat-screen.tsx:3360;
  src/components/chat/chat-roster.tsx:134-160, 401).
- The roster can be filtered by runtime - Hermes, OpenCode, Claude Code, Codex - once more than
  one runtime answers (src/lib/gateway/roster-filter.ts:3-14;
  src/components/chat/chat-roster.tsx:564-575).
- A Bot is a Hermes profile, an OpenCode agent, or a Gate-defined Claude Code or Codex agent;
  the runtime stays the source of truth for that roster
  (docs/adr/0016-bots-on-opencode.md:5;
  gate/core/cli-environments/backends/claude-code.mjs:150-167;
  gate/core/cli-environments/backends/codex.mjs:160-176). Claude Code agent files also appear
  as Bots on that roster (gate/core/cli-environments/claude-agents.mjs:1-10).
- OpenCode Bots are free-model only by default, and the app only offers rows the Gate marked
  free (docs/adr/0016-bots-on-opencode.md:14-16;
  src/lib/gateway/bot-runtimes.ts:79-91).
- Creating a Hermes agent from the phone runs a bounded `hermes profile create` with a fixed
  argv, not arbitrary CLI (docs/adr/0015-new-agent-via-bounded-cli.md:3). A create on another
  runtime is aimed at that runtime by `backendId` (docs/adr/0016-bots-on-opencode.md:11).
- A reply is drawn as plain text while tokens arrive, then parsed as markdown once the stream
  completes (src/components/chat/message-bubble.tsx:261-267;
  src/components/chat/markdown/parser.ts:359-369).
- Tool calls get their own card with running, complete and error states
  (src/components/chat/tool-call-card.tsx:11-21).
- Slash commands open a searchable palette over the command surface the app offers
  (src/components/chat/slash-command-palette.tsx:14-22).
- An unsent message goes into a durable offline outbox, and a storage read that fails is not
  mistaken for an empty queue (src/lib/gateway/session-persistence.ts:157-171).
- `@mention` hands a message from one Bot to another through the gateway, and a refused handoff
  says so in the thread instead of disappearing
  (src/context/gateway-provider.tsx:5478-5504).
- A session's file changes and diffs open from the chat menu, read-only, only where the backend
  can report them (src/components/chat/chat-overflow-sheet.tsx:171-178;
  src/components/chat/session-changes-sheet.tsx:10-20;
  src/lib/gateway/manifest-client.ts:60, 1286-1287).

#### Rooms, routines, runs and approvals

- A group room holds 2 to 6 Bots, and one phone send runs one round
  (src/lib/gateway/groups.ts:3-18).
- A routine is a scheduled job with a title, a prompt and a cron schedule
  (src/lib/gateway/routines.ts:11-17; src/components/activity/cron-section.tsx:61-63).
- The Routines view reads every backend the Gate serves routines for, groups them by the Bot
  that owns them, and says which backend did not answer rather than showing an empty list
  (src/components/activity/routines-section.tsx:28-37; src/lib/routines/targets.ts:4-13).
- New routine offers any backend or Bot the Gate reports routines for, with a schedule picker
  (src/components/routines/new-routine-sheet.tsx:19-25).
- Activity's Today feed covers runs and sessions since local midnight across backends, grouped
  by Bot, with backend chips and a local-time anchor
  (src/components/activity/today-section.tsx:12-20, 32-44;
  src/lib/activity/today.ts:1-10).
- A run row opens Runs on that run, and Runs is where an agentic task starts from the phone
  (src/app/(tabs)/activity.tsx:40-48; src/app/runs.tsx:196-224, 715-720).
- A pending run approval can be approved or denied from Activity
  (src/components/activity/today-section.tsx:203-215).
- Batch approval is fail-closed: it only covers read-only rows, it reports progress and any
  per-row failure, and the single Approve/Deny controls are disabled while a batch is running
  (src/components/activity/approval-inbox.tsx:115-116, 227-236, 262-274;
  src/lib/gateway/approvals.ts:92-95).
- Council asks one prompt of up to three Bots and shows the answers side by side
  (src/app/council.tsx:68, 84-93).
- Fleet draws the Bots you already know about as a star map, from state the app already holds
  (src/app/fleet.tsx:44-55).

#### Tools and terminal

- Tools offers three modes: Shell, Commands (Gateway RPC) and Agent
  (src/components/terminal/terminal-modes.ts:1-7).
- Shell is offered only when the gateway advertises a terminal group; an unconfirmed read says
  so instead of pretending there is no shell
  (src/lib/terminal/shell-support.ts:34-56).
- Terminal output with control sequences is parsed in one linear pass, so long output does not
  rescan the text before it (src/lib/terminal/ansi.ts:113-117).
- Structured command results can be shown as a JSON tree; nested keys that look alike expand
  independently, and an empty string stays an empty string
  (src/lib/terminal/json-tree.ts:15-24, 131-141).

#### Voice

- Push-to-talk holds the mic and puts the transcript into the composer; the push-to-talk path
  never sends by itself (src/components/chat/chat-composer.tsx:222-229; README.md:71-74).
- With the speaker on, a completed reply is read aloud in the Bot's voice; a reply queued
  behind one already being spoken carries its own voice, not the speaker's
  (src/lib/voice/speech-reply.ts:1-13; src/lib/voice/speech.ts:44-45, 92-96;
  README.md:73-74).
- Hands-free call is a deterministic turn machine with a confirmation window, so a pause to
  think is not mistaken for the end of a turn (src/lib/voice/handsfree-session.ts:1-16).
- A call can only start from an explicit Start call tap - there is no wake word and no
  always-listening mode (README.md:76-83).
- A one-tap call starts from the chat header, and the header shows the live call
  (src/components/chat/chat-header.tsx:61-67).
- A call continues the Bot's own conversation and renders its turns live in the thread it was
  started from, then reconciles with history
  (gate/core/voice/voice-backend.mjs:4-30;
  src/lib/voice/call-thread-projection.ts:20-29).
- On a call you can speak over the reply to stop it, and each finished sentence is spoken while
  later ones are still streaming (README.md:85-96).
- A `versutus://call` link opens a Bot's chat and asks for a call; a plain link never opens the
  microphone by itself (src/lib/gateway/deep-link.ts:150-171;
  modules/handsfree-voice/src/HandsfreeVoiceModule.ts:72-76).
- A Gate call sends raw microphone audio only to your own paired Gate, not to the phone's
  speech service (docs/release/PRIVACY.md:22-26).

#### Notifications and the home screen

- Local notifications fire while the gateway connection is alive
  (src/lib/notifications/local.ts:1-3).
- True push is delivered by your own Gate calling the Expo Push Service
  (src/lib/notifications/local.ts:4; docs/release/PRIVACY.md:27-31;
  gate/core/push-send.mjs:1).
- Approve and Deny on an approval notice settle the run approval the app is waiting on,
  including a tap that launched the app after it had been killed; anything else is refused with
  the reason instead of being decided (src/lib/notifications/approval-action.ts:8-20, 45-55;
  src/lib/notifications/approval-response.ts:1-20; src/app/_layout.tsx:45-50).
- A companion push is queued as its own kind so its partial line is not merged away by an app
  snapshot (src/lib/widget/widget-device.ts:123-138).
- The home-screen widget shows connection, in-flight work, pending approvals and the newest
  outcome, and always says when it was written
  (src/lib/widget/snapshot.ts:33-37, 50-70; src/lib/widget/widget-target.ts:9-15).

#### Getting in and moving around

- Deep links cover `versutus://add` (prefilled add-gateway sheet), `versutus://chat` (one Bot's
  chat), `versutus://compose` (shared text as a draft, never a send), `versutus://activity`
  (the scheduled-work surface) and `versutus://call` (one Bot's chat, asking for a call)
  (src/lib/gateway/deep-link.ts:28-46, 130-171; app.json:10).
- Gate pairing can wait for a human to approve the request on the Gate machine
  (src/lib/portal/access.ts:46-51). Approving from the Gate PC can be one click on the pair
  page, which answers only on loopback and shows the role and scopes the phone would get
  (gate/core/routes/pairing-page.mjs:1-25, 53-77); the Gate drops scopes it does not know and
  issues the clamped grant (gate/core/device-scopes.mjs:16-18, 62).
- On the web build, onboarding prints the exact `--allow-origin` Gate command for the browser
  origin in use (src/components/onboarding/onboarding-screen.tsx:69-72).
- The app lock is opt-in and uses the device's own authentication, with the device passcode as
  the fallback (src/components/app-lock-gate.tsx:1-5, 203-210).

### What it does not do

- It is pre-release and is not published to an app store (README.md:9).
- It is not a public relay and does not host your agent for you
  (README.md:7; docs/release/PRIVACY.md:27-31).
- Local notifications cannot announce new Gateway events after the connection is lost
  (src/lib/notifications/local.ts:1-3).
- Push does not keep the app alive or expose the Gateway to the internet (README.md:245).
- Shell requires a gateway that advertises a terminal endpoint; Hermes does not
  (README.md:247).
- Discovery TLS fingerprints are observed and shown, not pin-verified (README.md:248).
- Claude Code and Codex Bots are fixed by their environment: the phone can list, chat with and
  route to them, but cannot create one (src/lib/gateway/bot-runtimes.ts:35-45;
  gate/core/cli-environments/claude-agents.mjs:4-9).
- Agentic runs need a gateway that advertises the run API; the Hermes environment is the one
  that does (gate/core/cli-environments/adapters/hermes.mjs:93;
  src/app/runs.tsx:185-194).

---

## 2. Web demo script

The demo is the browser build of the same client. It needs a browser and a reachable gateway;
there is no install, no APK and no Metro (README.md:195-204).

```bash
npm run export:web
npm run serve:web
```

`export:web` is `expo export --platform web` (package.json:104). `serve:web` runs
`scripts/serve-web-demo.mjs` (package.json:105), which serves `dist/` on port 8090 by default
(scripts/serve-web-demo.mjs:10-18).

The Gate must allow the browser origin. The server prints every candidate origin it can be
reached on and the exact `--allow-origin` flag to copy into the Gate's start command
(scripts/serve-web-demo.mjs:5-8; README.md:204). The web build's own onboarding does the same
in-app for the origin it is actually running on
(src/components/onboarding/onboarding-screen.tsx:69-72).

Say this plainly while demoing: this is the same client, not the phone app. The web build has
no Play Store install, no OS-keychain app lock (web keeps secrets in browser storage) and no
device push notifications (README.md:204). The instructions serve the demo locally; the
repository provides no hosted demo URL (README.md:204).

A gateway is still required. Nothing in the demo substitutes for one
(README.md:195-204).

---

## 3. Release notes - 1.0.0 (draft)

These expand the `## [1.0.0]` section of `CHANGELOG.md`; that file remains the release body.
Each entry below was checked against the cited source.

### Added

- OpenCode agents can sit on the roster as Bots next to Hermes profiles, with the same Bot
  Chat. A roster row is tagged with its runtime once more than one runtime answers
  (docs/adr/0016-bots-on-opencode.md:5, 9; src/lib/gateway/roster-filter.ts:3-14).
- OpenCode Bots are free-model only by default; create and edit refuse a paid or unknown model,
  and the app only offers rows the Gate flagged free
  (docs/adr/0016-bots-on-opencode.md:14-16; src/lib/gateway/bot-runtimes.ts:79-91).
- The Gate detects and speaks the OpenCode 2.x dialect, in addition to the earlier one
  (gate/core/cli-environments/adapters/opencode.mjs:7;
  gate/core/cli-environments/backends/opencode.mjs:19-27, 44-52).

### Changed

- A Bot's lamp colour keeps clear of the red, amber and mint status hues, so a room cannot be
  mistaken for an error or a connection state (src/lib/bot-avatar.ts:10-13, 29-32).
- A Bot reply queued behind one that is still being spoken keeps its own voice options instead
  of borrowing the speaking reply's (src/lib/voice/speech.ts:92-96).
- Terminal output full of control sequences is consumed in one forward pass, so a long Shell
  history does not rescan the plain lines before it (src/lib/terminal/ansi.ts:113-117).
- A slow provider-catalogue read no longer shortens another request's own timeout: each waiter
  gets its own deadline on the one shared read
  (gate/core/backend-model-route.mjs:259-270).

### Fixed

- Home-screen widget: a push that carries only a work line or an approval count is kept rather
  than merged away while another widget write is queued
  (src/lib/widget/widget-device.ts:123-138).
- Terminal JSON viewer: nested nodes with identical keys expand independently, and an empty
  string value is shown as an empty value rather than vanishing
  (src/lib/terminal/json-tree.ts:15-24, 131-141).
- Activity: a failed routine run says it failed instead of reading "completed"
  (gate/core/cron-view.mjs:43-59).
- Activity: the routine title filter stops hiding rows once the list falls to three or fewer
  (src/components/activity/cron-section.tsx:189-200).
- Activity: single approve/deny is disabled while a batch decision is running
  (src/components/activity/approval-inbox.tsx:262-274).
- Voice: recovered speech is held until the merged composer draft is saved, so a failed save
  cannot lose it (src/lib/voice/handsfree-recovery.ts:70-100).
- Hands-free replies wait for punctuation before reading a decimal prefix aloud, so `3.14` is
  not cut into two sentences (src/lib/voice/speech-chunks.ts:29-42).

### Landed after this draft's first cut, not yet in `CHANGELOG.md`

These are user-visible and belong in the 1.0.0 section when it is finalized; they are kept
apart here because the 1.0.0 section of `CHANGELOG.md` does not carry them yet.

- Claude Code and Codex Bots: a built-in Bot for each environment, Claude Code agent files as
  roster rows, and the same Bot Chat
  (gate/core/cli-environments/backends/claude-code.mjs:150-167;
  gate/core/cli-environments/backends/codex.mjs:160-176;
  gate/core/cli-environments/claude-agents.mjs:1-10).
- Activity's Today feed is cross-backend and covers runs and sessions since local midnight
  (src/components/activity/today-section.tsx:12-20; src/lib/activity/today.ts:1-10).
- Routines across every backend, grouped by owning Bot, with a New routine sheet for any
  backend or Bot the Gate reports (src/components/activity/routines-section.tsx:28-37;
  src/components/routines/new-routine-sheet.tsx:19-25).
- A session's file changes and diffs open from the chat menu, read-only
  (src/components/chat/session-changes-sheet.tsx:10-20).
- A one-tap call from the chat header, call turns rendered live in the thread, and
  `versutus://call` links (src/components/chat/chat-header.tsx:61-67;
  src/lib/voice/call-thread-projection.ts:20-29; src/lib/gateway/deep-link.ts:150-171).
- Approve/Deny on an approval notice settles the waiting run approval, including a tap that
  launched a killed app; anything else is refused with the reason
  (src/lib/notifications/approval-action.ts:8-20, 45-55;
  src/lib/notifications/approval-response.ts:1-20; src/app/_layout.tsx:45-50).
- One-click pairing on the Gate PC's loopback pair page, showing the role and scopes the phone
  will get (gate/core/routes/pairing-page.mjs:1-25, 53-77;
  gate/core/device-scopes.mjs:16-18, 62).

---

## Sources

Every path cited above, opened and checked for this draft:

- README.md
- CHANGELOG.md
- docs/release/ANNOUNCEMENT.md
- docs/release/RELEASE-NOTES.md
- app.json
- package.json
- docs/release/PRIVACY.md
- docs/adr/0015-new-agent-via-bounded-cli.md
- docs/adr/0016-bots-on-opencode.md
- scripts/serve-web-demo.mjs
- gate/core/backend-model-route.mjs
- gate/core/cron-view.mjs
- gate/core/push-send.mjs
- gate/core/device-scopes.mjs
- gate/core/routes/pairing-page.mjs
- gate/core/voice/voice-backend.mjs
- gate/core/cli-environments/adapters/hermes.mjs
- gate/core/cli-environments/adapters/opencode.mjs
- gate/core/cli-environments/backends/claude-code.mjs
- gate/core/cli-environments/backends/codex.mjs
- gate/core/cli-environments/backends/opencode.mjs
- gate/core/cli-environments/claude-agents.mjs
- modules/handsfree-voice/src/HandsfreeVoiceModule.ts
- src/app/_layout.tsx
- src/app/council.tsx
- src/app/fleet.tsx
- src/app/runs.tsx
- src/app/(tabs)/activity.tsx
- src/components/app-lock-gate.tsx
- src/components/onboarding/onboarding-screen.tsx
- src/components/chat/chat-composer.tsx
- src/components/chat/chat-header.tsx
- src/components/chat/chat-overflow-sheet.tsx
- src/components/chat/chat-roster.tsx
- src/components/chat/chat-screen.tsx
- src/components/chat/session-changes-sheet.tsx
- src/components/chat/markdown/parser.ts
- src/components/chat/message-bubble.tsx
- src/components/chat/slash-command-palette.tsx
- src/components/chat/tool-call-card.tsx
- src/components/activity/approval-inbox.tsx
- src/components/activity/cron-section.tsx
- src/components/activity/routines-section.tsx
- src/components/activity/today-section.tsx
- src/components/routines/new-routine-sheet.tsx
- src/components/terminal/terminal-modes.ts
- src/context/gateway-provider.tsx
- src/lib/activity/today.ts
- src/lib/bot-avatar.ts
- src/lib/gateway/approvals.ts
- src/lib/gateway/bot-runtimes.ts
- src/lib/gateway/deep-link.ts
- src/lib/gateway/groups.ts
- src/lib/gateway/manifest-client.ts
- src/lib/gateway/routines.ts
- src/lib/gateway/roster-filter.ts
- src/lib/gateway/session-persistence.ts
- src/lib/notifications/approval-action.ts
- src/lib/notifications/approval-response.ts
- src/lib/notifications/local.ts
- src/lib/portal/access.ts
- src/lib/portal/identify.ts
- src/lib/routines/targets.ts
- src/lib/terminal/ansi.ts
- src/lib/terminal/json-tree.ts
- src/lib/terminal/shell-support.ts
- src/lib/voice/call-thread-projection.ts
- src/lib/voice/handsfree-recovery.ts
- src/lib/voice/handsfree-session.ts
- src/lib/voice/speech-chunks.ts
- src/lib/voice/speech-reply.ts
- src/lib/voice/speech.ts
- src/lib/widget/snapshot.ts
- src/lib/widget/widget-device.ts
- src/lib/widget/widget-target.ts
