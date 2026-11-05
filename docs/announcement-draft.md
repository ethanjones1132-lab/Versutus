# Versutus release material — draft for review

Draft only; nothing here has been posted or released. Posting is Ethan's. Claims are cited inline; remove citations only after checking the corresponding source again.

## 1. Hermes-community announcement post

### Versutus: a client for the Hermes gateway you already run

I have been building Versutus, a mobile and web client for AI-agent gateways, including Hermes. It connects to an agent you run on your own machine and brings chat, Bots, agentic runs, approvals and tools to a phone. [README.md "client and gateway overview"]

Versutus is a client, not a hosted agent service or public relay; it holds no model credentials of its own. [README.md "client, credentials and relay"]

There is also a browser build you can serve locally and use with a reachable gateway. It is the same client surface, not the phone app; it has no device push notifications or OS-keychain app lock, and secrets are held in browser storage. [README.md "Web demo"]

Voice is optional. Push-to-talk leaves a transcript in the composer for review and does not send it automatically. A separate hands-free call is explicitly started, but actual availability is limited by the resolved engine and platform; phone-engine recognition is not guaranteed to keep audio on the phone, and Gate transport sends microphone PCM to the user's Gate. [README.md "Voice"]; [docs/release/PRIVACY.md "Voice transport, stated precisely"]; [docs/release/PLAY-DATA-SAFETY.md "Voice or sound recordings"]

This is a technical client for people who already operate an agent gateway; it does not provide or host one. [README.md "client and gateway overview"]

## 2. Web-demo walkthrough script

Prerequisites: a browser, a locally served web export, and a reachable gateway; the repository does not provide a hosted demo URL. [README.md "Web demo"]

1. In a checkout, run `npm run export:web`, then `npm run serve:web`. Open the URL printed by the server. **You should see:** the Versutus browser client. [README.md "Web demo"]; [docs/release/ANNOUNCEMENT.md "Local web-demo commands"]
2. Make sure the gateway permits the demo's browser origin using the `--allow-origin` value printed by the server. **You should see:** the browser client able to make its gateway requests once the origin is allowed. [README.md "Web demo"]; [docs/release/ANNOUNCEMENT.md "Gateway origin requirement"]
3. Connect to your gateway using a saved profile, LAN discovery, or a `versutus://add` link; only use a gateway URL and credentials you control. **You should see:** a connected gateway when the connection succeeds, or a connection/pairing state if additional access approval is required. [README.md "Quick start"]; [CONTEXT.md "Connection status and pairing"]
4. Open Chat. **You should see:** the roster, with configurable chat first and available Bots below it; select a row to open its chat. [README.md "Bot Mode"]; [CONTEXT.md "Roster and Bot Chat"]
5. Send a text prompt to the selected chat. **You should see:** the gateway's response in the chat; actual model behavior and returned content come from the gateway, not from a bundled Versutus model. [README.md "Surface: Chat"]; [README.md "Versutus is a client"]
6. If the connected gateway advertises agentic runs, open Activity and inspect its run/approval surfaces. **You should see:** only the capabilities and actions advertised by that gateway; approval actions require a pending approval. [README.md "Gateways"; "Surface: Activity"]; [CONTEXT.md "Run and approval"]
7. End the demo by disconnecting or closing the browser. **You should know:** the browser version does not provide device push notifications or OS-keychain app lock, and local serving does not create a public demo URL. [README.md "Web demo"]

## 3. Release notes — candidate notes

These are draft notes for the candidate `1.0.0` tree, not evidence of a published release: the changelog says no `v1.0.0` tag or GitHub release exists yet. [CHANGELOG.md "1.0.0 candidate status"]

### Added

- OpenCode agents can appear on the roster as Bots alongside Hermes profiles, using Bot Chat; only free models are offered. [CHANGELOG.md "1.0.0 > Added: OpenCode agents"]
- The Gate recognizes and communicates with an OpenCode 2.x server in its own dialect. [CHANGELOG.md "1.0.0 > Added: OpenCode 2.x"]

### Changed and fixed

- Bot room indicator colors no longer use the red, amber or mint status hues. [CHANGELOG.md "1.0.0 > Changed: Bot lamp colors"]
- Queued spoken replies retain their own voice options. [CHANGELOG.md "1.0.0 > Changed: queued spoken replies"]
- Terminal output containing control sequences is processed without rescanning the preceding plain lines. [CHANGELOG.md "1.0.0 > Changed: terminal output"]
- A slow provider-catalogue read no longer shortens another request's timeout. [CHANGELOG.md "1.0.0 > Changed: provider catalogue timeout"]
- Widget updates carrying only a work line or approval count are retained while another widget write is queued; nested terminal JSON nodes with duplicate keys expand independently, and empty string values remain visible. [CHANGELOG.md "1.0.0 > Fixed: widget and terminal JSON"]
- Activity reports failed routine runs as failed, keeps the routine filter usable for short lists, and disables single approve/deny controls while a batch decision runs. [CHANGELOG.md "1.0.0 > Fixed: Activity"]
- Recovered voice text is held until the merged composer draft is saved, and hands-free speech waits for punctuation before speaking a decimal prefix. [CHANGELOG.md "1.0.0 > Fixed: voice"]

### Known limits

- Versutus requires a gateway; the browser demo is served locally and requires a reachable gateway plus an allowed browser origin. [README.md "Web demo"]
- The web build is not the phone app: no device push notifications or OS-keychain app lock; browser storage is used for secrets. [README.md "Web demo"]
- Voice transport differs: a Gate-transport hands-free call sends raw microphone PCM to the user's Gate, while phone/OS recognition may use platform speech services; audio is not claimed to remain on the phone. [docs/release/PRIVACY.md "Voice transport, stated precisely"]; [docs/release/PLAY-DATA-SAFETY.md "Voice or sound recordings"]
- The pending-work register reports that hands-free calls do not open on the local engine; do not imply universal hands-free availability. [PENDING.md "Open work: hands-free calls"]
- Discovery TLS fingerprints are observed and shown, not pin-verified. [README.md "Quick start"]

### Not in this build / not established

- Versutus is not a hosted agent, public relay, or provider of model credentials. [README.md "client, credentials and relay"]
- New Agent creation, Routines, `@mention` handoff and group chats are deferred, not part of the current Bot Mode slice. [README.md "Bot Mode: deferred"]
- No hosted web-demo URL is supplied by this repository. [README.md "Web demo"]
- A public Play open-testing release, public GitHub release, or completed store submission is not established here; the changelog says the `1.0.0` release has not been created. [CHANGELOG.md "1.0.0 candidate status"]; [docs/release/CONTENT-RATING.md "Draft and not submitted"]
- No content rating or IARC certificate has been obtained. [docs/release/CONTENT-RATING.md "What this file does not establish"]

## Conflicts to resolve

- **Release prerequisites:** The task brief says the public release and web demo are prerequisites for Play open testing. The repository does not establish that sequence: `docs/release/RELEASE-PLAN.md` puts the GitHub release after the Play build is accepted and makes attaching the web export optional; `README.md` documents local web-demo serving but does not call it a prerequisite. **UNVERIFIED — do not publish a sequencing claim** until Ethan resolves this with the release plan. [docs/release/RELEASE-PLAN.md "GitHub release after Play build is accepted"; "Optional web export"]; [README.md "Web demo"]
- **Hands-free availability:** `README.md` describes the opt-in call as a shipping voice path, while `PENDING.md` says hands-free calls never open on the local engine. This draft avoids promising that the call works on every device/engine; confirm the offer/availability matrix before publishing hands-free instructions. [README.md "Voice"]; [PENDING.md "Open work: hands-free calls"]
- No direct disagreement between `app.json` and `README.md` was found in the reviewed app identity, voice-permission, or web-demo claims. [app.json "Expo identity and permissions"]; [README.md "Status"; "Voice"; "Web demo"]
