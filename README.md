# Versutus

A mobile and web client for AI agent gateways.

Point it at a Hermes Agent running on your own machine — over LAN, over Tailscale, or through a gate you control — and drive it from a phone: chat, Bots, agentic runs, approvals, tools.

Versutus is a **client**. It holds no model credentials of its own, brokers nothing on anyone else's behalf, and is not a public relay. Your agent stays where you put it.

**Status:** working Android / iOS / web client. Pre-release, single-author, actively built. Not published to an app store.

---

## Why this exists

Hermes Agent ships a desktop app, a TUI, and an HTTP API server. It does not ship a mobile client — [NousResearch/hermes-agent#35966](https://github.com/NousResearch/hermes-agent/issues/35966) has been open and unassigned since it was filed.

The common workaround is to bridge the agent into Telegram or Discord and talk to it there. That gets you a text box and gives up the parts that make an agent worth running remotely: run lifecycle, approval prompts, tool-call inspection, capability discovery, and per-Bot session scoping.

Versutus speaks to the API server directly, so those survive the trip to a phone.

---

## Gateways

Three gateway shapes, one portal seam:

| Kind | Transport | Typical use |
|---|---|---|
| **Hermes** | HTTP REST + SSE — `/v1/chat/completions`, sessions, runs | Primary PC agent (API server, port 8642) |
| **Versutus Gate** | Open Gateway Manifest + OpenAI-compatible chat proxy | Multi-provider gate (`gate/` in this repo, port 8760) |
| **OpenClaw** | WebSocket v4 adapter | Compatible OpenClaw profiles |

The app never assumes a capability. It reads a capability snapshot from the live gateway and renders surfaces that gateway actually advertises — Quick RPC is filtered to commands the gateway can run, and the Shell tab appears only when a terminal endpoint is advertised (Hermes does not advertise one). Capability-gated UI is covered by live smoke tests, not by hope.

---

## Bot Mode

Hermes Bot Mode shipped 2026-08-17. Versutus models it as the primitive it actually is rather than bolting it on as a second gateway.

**A Bot is a Hermes profile** — `~/.hermes/profiles/<name>/`, with its own soul, memory, model pin, sessions, and crons. It is not a gateway profile, not a channel, and not a platform adapter. That one decision ([ADR 0004](docs/adr/0004-bots-are-hermes-profiles.md)) is what keeps the routing honest downstream.

What that buys, and what is implemented:

- **Roster** — the Chat tab lands on a roster, not on last night's session. Configurable chat is the first row; every Bot, including `default`, is a row beneath it ([ADR 0010](docs/adr/0010-chat-tab-is-the-roster.md), [ADR 0013](docs/adr/0013-default-profile-is-a-bot-row.md)).
- **Bot Chat** — tapping a Bot opens its canonical persistent conversation, not whichever session ran most recently ([ADR 0012](docs/adr/0012-bot-tap-opens-bot-chat.md)).
- **Multiplex routing** — Hermes HTTP is scoped to `/p/<bot>/` using that Bot's own listen key, read from its profile env ([ADR 0005](docs/adr/0005-bot-routing-via-hermes-multiplex.md), [ADR 0006](docs/adr/0006-bot-listen-keys-from-profile-env.md)).
- **Fail-closed multiplex** — if a Bot cannot be addressed with its own credential, the request does not silently fall back to the default profile ([ADR 0008](docs/adr/0008-bot-multiplex-fail-closed.md)).
- **Credential hygiene** — profile inventory reads the Bot list without ingesting the provider keys those profiles hold. Provider credentials stay in Hermes.

Deferred on purpose, and tracked: New Agent creation, routines, `@mention` handoff, and group chats. The first slice is talk-to-existing, because the runtime is worth proving before the surface area grows ([ADR 0007](docs/adr/0007-bot-slice-talk-then-create.md)).

---

## Surface

- **Home** — connection hero, capability groups ordered ready-first, saved profiles, live run and approval presence.
- **Chat** — streaming markdown, executable-first slash command palette, sessions, model picker and `/model set` override, durable offline outbox, tool-call cards when the stream or history exposes them, inline run approvals.
- **Activity** — start an agentic run, watch live events, approve or deny, stop, persisted history, profile-scoped gateway targets.
- **Tools** — Shell when the gateway advertises a terminal; otherwise RPC / Agent.
- **Discovery** — LAN beacons, Tailscale candidates, saved profiles, manual add, `versutus://add` deep links.
- **Identity** — SecureStore-backed profiles, tokens, device identity; Gate pairing for custom and OpenClaw access grants.

---

## Stack

Expo SDK 57 · React Native 0.86 · React 19 · TypeScript 6 · Expo Router (native tabs) · Reanimated 4 · Skia · `@noble/ed25519` for device identity · Expo SecureStore / Notifications / Symbols.

---

## Quick start

```bash
npm install
npm start          # then: npm run android | npm run ios | npm run web
```

Point the app at a gateway by saved profile, LAN discovery, or deep link:

```text
versutus://add?url=https%3A%2F%2Fpc.example.ts.net&token=API_KEY&name=Home%20PC&agentId=main
```

Hosts can also be supplied via `EXPO_PUBLIC_HERMES_GATEWAY_HOSTS`, `EXPO_PUBLIC_OPENCLAW_GATEWAY_HOSTS`, or `expo.extra.gatewayHosts` in `app.json`.

HTTPS/WSS is recommended for anything off-LAN. Cleartext is supported for trusted local networks. Discovery TLS fingerprints are **observed and displayed**, not pin-verified — Expo's fetch does not expose the hook required to pin them, and the UI says "fingerprint seen" rather than implying a guarantee it cannot make.

### Versutus Gate

```bash
cd gate
node --env-file=.env cli.mjs start
```

Providers live at `gate/registry/<id>.json`, scaffolded with `node cli.mjs add <id> --kind provider` and validated against `gate/core/capabilities/provider/kind.mjs`. Provider keys are read from `gate/.env` and never committed — the ignore rules for `gate/credentials/`, `gate/.tokens.json`, and friends are deliberate.

### Android APK without EAS

EAS free-tier Android quota and `eas build --local` are frequently unavailable. Direct prebuild works:

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew.bat assembleRelease --no-daemon
# -> android/app/build/outputs/apk/release/app-release.apk
```

---

## Verification

```bash
npm run verify        # config check, tsc --noEmit, lint, jest + coverage ratchet, gate tests
npm run smoke:portal  # portal seam, no gateway required
```

Against a live gateway:

```bash
npm run smoke:live                            # Hermes, default http://127.0.0.1:8642
npm run smoke:live -- http://127.0.0.1:8760   # Gate
```

Live smoke exercises connect, capability snapshot, auth rejection, and every capability-gated surface the gateway advertises — models, sessions, skills, toolsets, and runs.

**What is actually enforced:**

| | |
|---|---|
| Test files | 135 — 63 app (Jest) + 72 gate (`node:test`) |
| Test cases | 928 |
| Coverage on `src/lib/gateway` | 44.77% statements · 46.99% lines · 36.06% branches · 48.29% functions |
| Coverage direction | ratcheted — `scripts/coverage-ratchet.mts` fails the build if it drops |
| CI | `tsc`, lint, Jest, gate tests, and portal smoke on every push and PR |
| Architecture decisions | 13 ADRs in `docs/adr/`, including one that supersedes an earlier one |

Coverage is mid-40s and rising, scoped deliberately to `src/lib/gateway` — the transport, routing, and persistence layer where a regression is silent. UI is covered by behaviour tests rather than counted toward that gate. The ratchet exists so the number cannot quietly go backwards.

---

## Scope limits

Stated plainly, because a client that pretends otherwise will lie to its user:

- **True push, background keepalive, and public-internet relay require a companion server.** Not invented here. Local notifications fire only while the app's gateway connection is alive.
- **Hermes host-only administration** — config file, channel daemons, on-disk logs — is guidance surfaced in slash commands, not remote REST. The app does not pretend to reach them.
- **Shell requires a gateway that advertises a terminal endpoint.** Hermes does not.
- **Discovery TLS fingerprints are observed, not pinned.** See above.

---

## Repository map

```text
src/app/         Expo Router screens and tabs
src/components/  UI primitives and feature surfaces
src/context/     Gateway provider and app state
src/lib/gateway/ Clients, routes, storage, runs, persistence
src/lib/portal/  Identification, manifest, adapters
src/lib/terminal/Terminal stream and output model
src/constants/   Dark-only design tokens
gate/            Versutus Gate server — providers, capabilities, CLI
docs/            Glossary, ADRs, audits, plans
scripts/         smoke:live, smoke:portal, verification tooling
```

---

## Docs

- **[CONTEXT.md](CONTEXT.md)** — the domain glossary. Every term the codebase uses, what it means, and what not to call it. Read this before the code; the naming is load-bearing.
- **[docs/adr/](docs/adr/)** — 13 architecture decision records.
- [docs/portal-architecture.md](docs/portal-architecture.md) — the portal seam.
- [docs/provider-setup.md](docs/provider-setup.md) · [docs/cli-environments.md](docs/cli-environments.md) — Gate operations.

---

## License

MIT © 2026 Ethan Jones. See [LICENSE](LICENSE).
