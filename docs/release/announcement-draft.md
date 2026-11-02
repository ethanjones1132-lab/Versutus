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
(README.md:7; docs/release/PRIVACY.md:17-20).

The app identifies a gateway rather than assuming one. It recognises a Hermes fingerprint, an
Open Gateway Manifest, or an OpenClaw endpoint (src/lib/portal/identify.ts:2-6). Nothing is
fetched from a service owned by the author; the only third party involved is the Expo Push
Service, and only when you turn push on (docs/release/PRIVACY.md:16-20, 27-32).

#### Chat and Bots

- Chat lands on a roster, not on last night's session; each Bot is a row you tap
  (README.md:45; src/components/chat/chat-screen.tsx:2948;
  src/components/chat/chat-roster.tsx:234).
- A Bot is a Hermes profile or an OpenCode agent, and the server stays the source of truth for
  that roster (docs/adr/0016-bots-on-opencode.md:5).
- OpenCode Bots are free-model only by default, and the app only offers rows the Gate marked
  free (docs/adr/0016-bots-on-opencode.md:14-16).
- Creating an agent from the phone runs a bounded `hermes profile create` with a fixed argv,
  not arbitrary CLI (docs/adr/0015-new-agent-via-bounded-cli.md:3).
- A reply is drawn as plain text while tokens arrive, then parsed as markdown once the stream
  completes (src/components/chat/message-bubble.tsx:211, 217;
  src/components/chat/markdown/parser.ts:360-369).
- Tool calls get their own card with running, complete and error states
  (src/components/chat/tool-call-card.tsx:11-15).
- Slash commands open a searchable palette over the command surface the app offers
  (src/components/chat/slash-command-palette.tsx:14-17).
- An unsent message goes into a durable offline outbox, and a storage read that fails is not
  mistaken for an empty queue (src/lib/gateway/session-persistence.ts:157-171).
- `@mention` hands a message from one Bot to another through the gateway
  (src/context/gateway-provider.tsx:4719-4735).

#### Rooms, routines, runs and approvals

- A group room holds 2 to 6 Bots, and one phone send runs one round
  (src/lib/gateway/groups.ts:3-14).
- A routine is a scheduled job with a title, a prompt and a cron schedule
  (src/lib/gateway/routines.ts:9-15; src/components/activity/cron-section.tsx:288).
- Activity links into Runs, where an agentic run starts from the phone
  (src/app/(tabs)/activity.tsx:38-40; src/app/runs.tsx:698).
- A pending run approval can be approved or denied from the Activity screen
  (src/app/(tabs)/activity.tsx:291).
- Batch approval is fail-closed: it only covers read-only rows, and the single Approve/Deny
  controls are disabled while a batch is running
  (src/components/activity/approval-inbox.tsx:72-73, 203-210).
- Council asks one prompt of up to three Bots and shows the answers side by side
  (src/app/council.tsx:68, 74-81).
- Fleet draws the Bots you already know about as a star map, from state the app already holds
  (src/app/fleet.tsx:44-55).

#### Tools and terminal

- Tools offers three modes: Shell, Gateway RPC and Agent
  (src/components/terminal/terminal-modes.ts:1-7).
- Shell is offered only when the gateway advertises a terminal group; an unconfirmed read says
  so instead of pretending there is no shell
  (src/lib/terminal/shell-support.ts:17-40).
- Terminal output with control sequences is parsed in one linear pass, so long output does not
  rescan the text before it (src/lib/terminal/ansi.ts:113-116).
- Structured command results can be shown as a JSON tree
  (src/lib/terminal/json-tree.ts:15-46).

#### Voice

- Push-to-talk holds the mic and puts the transcript into the composer; the push-to-talk path
  never sends by itself (src/components/chat/chat-composer.tsx:222-228; README.md:71-73).
- With the speaker on, a completed reply is read aloud in the Bot's voice; a reply queued
  behind one already being spoken carries its own voice, not the speaker's
  (src/lib/voice/speech-reply.ts:2-13; src/lib/voice/speech.ts:44-45, 92-94; README.md:73-74).
- Hands-free call is a deterministic turn machine with a confirmation window, so a pause to
  think is not mistaken for the end of a turn (src/lib/voice/handsfree-session.ts:1-16).
- A call can only start from an explicit Start call tap; there is no wake word and no
  always-listening mode (README.md:78-82).

#### Notifications and the home screen

- Local notifications fire while the gateway connection is alive
  (src/lib/notifications/local.ts:1-3).
- True push is delivered by your own Gate calling the Expo Push Service
  (src/lib/notifications/local.ts:4; docs/release/PRIVACY.md:27-30;
  gate/core/push-send.mjs:1).
- A companion push is queued as its own kind so its partial line is not merged away by an app
  snapshot (src/lib/widget/widget-device.ts:123-139).
- The home-screen widget shows connection, in-flight work, pending approvals and the newest
  outcome, and always says when it was written
  (src/lib/widget/snapshot.ts:1-12; src/lib/widget/widget-target.ts:7-17).

#### Getting in and moving around

- Deep links cover `versutus://add` (prefilled add-gateway sheet), `versutus://chat` (one Bot's
  chat) and `versutus://compose` (shared text as a draft, never a send)
  (src/lib/gateway/deep-link.ts:8-14; app.json:10).
- Gate pairing can wait for a human to approve the request on the Gate machine
  (src/lib/portal/access.ts:47-51).
- The app lock is opt-in and uses the device's own authentication, with the device passcode as
  the fallback (src/components/app-lock-gate.tsx:1-5, 203-209).

### What it does not do

- It is pre-release and is not published to an app store (README.md:9).
- It is not a public relay and does not host your agent for you
  (README.md:7; docs/release/PRIVACY.md:27-30).
- Local notifications cannot announce new Gateway events after the connection is lost
  (src/lib/notifications/local.ts:1-3).
- Push does not keep the app alive or expose the Gateway to the internet (README.md:242).
- Shell requires a gateway that advertises a terminal endpoint; Hermes does not
  (README.md:244).
- Discovery TLS fingerprints are observed and shown, not pin-verified (README.md:245).

---

## 2. Web demo script

The demo is the browser build of the same client. It needs a browser and a reachable gateway;
there is no install, no APK and no Metro (README.md:194-201).

```bash
npm run export:web
npm run serve:web
```

`export:web` is `expo export --platform web` (package.json:98). `serve:web` runs
`scripts/serve-web-demo.mjs` (package.json:99), which serves `dist/` on port 8090 by default
(scripts/serve-web-demo.mjs:10-18).

The Gate must allow the browser origin. The server prints every candidate origin it can be
reached on and the exact `--allow-origin` flag to copy into the Gate's start command
(scripts/serve-web-demo.mjs:5-8; README.md:201).

Say this plainly while demoing: this is the same client, not the phone app. The web build has
no Play Store install, no OS-keychain app lock (web keeps secrets in browser storage) and no
device push notifications (README.md:201). The instructions serve the demo locally; the
repository provides no hosted demo URL (README.md:201).

A gateway is still required. Nothing in the demo substitutes for one
(README.md:194-201).

---

## 3. Release notes - 1.0.0 (draft)

These expand the `## [1.0.0]` section of `CHANGELOG.md`; that file remains the release body.
Each entry below was checked against the cited source.

### Added

- OpenCode agents can sit on the roster as Bots next to Hermes profiles, with the same Bot
  Chat. A roster row is tagged with its runtime once more than one runtime answers
  (docs/adr/0016-bots-on-opencode.md:5, 9; src/lib/gateway/bot-runtimes.ts:31-36).
- OpenCode Bots are free-model only by default; create and edit refuse a paid or unknown model,
  and the app only offers rows the Gate flagged free
  (docs/adr/0016-bots-on-opencode.md:14-16).
- The Gate detects and speaks the OpenCode 2.x dialect, in addition to the earlier one
  (gate/core/cli-environments/adapters/opencode.mjs:7;
  gate/core/cli-environments/backends/opencode.mjs:76).

### Changed

- A Bot's lamp colour keeps clear of the red, amber and mint status hues, so a room cannot be
  mistaken for an error or a connection state (src/lib/bot-avatar.ts:30-32).
- A Bot reply queued behind one that is still being spoken keeps its own voice options instead
  of borrowing the speaking reply's (src/lib/voice/speech.ts:92-94).
- Terminal output full of control sequences is consumed in one forward pass, so a long Shell
  history does not rescan the plain lines before it (src/lib/terminal/ansi.ts:113-116).
- A slow provider-catalogue read no longer shortens another request's own timeout: each waiter
  gets its own deadline on the one shared read
  (gate/core/backend-model-route.mjs:259-270).

### Fixed

- Home-screen widget: a push that carries only a work line or an approval count is kept rather
  than merged away while another widget write is queued
  (src/lib/widget/widget-device.ts:123-139).
- Terminal JSON viewer: nested nodes with identical keys expand independently, and an empty
  string value is shown as an empty value rather than vanishing
  (src/lib/terminal/json-tree.ts:15-18, 131-142).
- Activity: a failed routine run says it failed instead of reading "completed"
  (gate/core/cron-view.mjs:43-57).
- Activity: the routine title filter stops hiding rows once the list falls to three or fewer
  (src/components/activity/cron-section.tsx:164-174).
- Activity: single approve/deny is disabled while a batch decision is running
  (src/components/activity/approval-inbox.tsx:203-210).
- Voice: recovered speech is held until the merged composer draft is saved, so a failed save
  cannot lose it (src/lib/voice/handsfree-recovery.ts:70-99).
- Hands-free replies wait for punctuation before reading a decimal prefix aloud, so `3.14` is
  not cut into two sentences (src/lib/voice/speech-chunks.ts:29-42).

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
- gate/core/cli-environments/adapters/opencode.mjs
- gate/core/cli-environments/backends/opencode.mjs
- src/app/council.tsx
- src/app/fleet.tsx
- src/app/runs.tsx
- src/app/(tabs)/activity.tsx
- src/components/app-lock-gate.tsx
- src/components/chat/chat-composer.tsx
- src/components/chat/chat-roster.tsx
- src/components/chat/chat-screen.tsx
- src/components/chat/markdown/markdown-text.tsx
- src/components/chat/markdown/parser.ts
- src/components/chat/message-bubble.tsx
- src/components/chat/slash-command-palette.tsx
- src/components/chat/tool-call-card.tsx
- src/components/activity/approval-inbox.tsx
- src/components/activity/cron-section.tsx
- src/components/terminal/terminal-modes.ts
- src/context/gateway-provider.tsx
- src/lib/bot-avatar.ts
- src/lib/gateway/bot-runtimes.ts
- src/lib/gateway/deep-link.ts
- src/lib/gateway/groups.ts
- src/lib/gateway/routines.ts
- src/lib/gateway/session-persistence.ts
- src/lib/notifications/local.ts
- src/lib/portal/access.ts
- src/lib/portal/identify.ts
- src/lib/terminal/ansi.ts
- src/lib/terminal/json-tree.ts
- src/lib/terminal/shell-support.ts
- src/lib/voice/handsfree-recovery.ts
- src/lib/voice/handsfree-session.ts
- src/lib/voice/speech-chunks.ts
- src/lib/voice/speech-reply.ts
- src/lib/voice/speech.ts
- src/lib/widget/snapshot.ts
- src/lib/widget/widget-device.ts
- src/lib/widget/widget-target.ts
