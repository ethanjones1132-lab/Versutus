# Versutus

A mobile client for connecting to and controlling AI agent gateways (Hermes API servers and OpenClaw agents) from Android/iOS/web.

## Language

**Gateway**:
A reachable endpoint that hosts agent capabilities.
_Avoid_: server, backend, node

**Gateway profile**:
The app's stored configuration for a gateway (name, URL, auth token, kind, agent).
_Avoid_: gateway (when meaning the stored config), profile (alone), bot

**Bot**:
A named, isolated agent with its own soul, provider/model pin, avatar, sessions, memory, skills, and crons. A Bot **is** a Hermes profile (`~/.hermes/profiles/<name>/`); Bot Mode is a UI over that primitive, not a second store. A non-Hermes CLI environment is not a Bot.
_Avoid_: profile (alone), gateway profile, channel, capability instance, platform adapter, CLI environment (when meaning a Bot)

**Soul**:
A Bot's standing personality and instructions (Hermes `SOUL.md`).
_Avoid_: system prompt (a per-request overlay), personality (the unused gateway-detection plan term)

**Listen key**:
A Bot's Hermes API-server credential, used only to address that Bot through multiplex. Distinct from the provider keys the Bot inherits or owns.
_Avoid_: API key (alone), token, provider credential

**Connection status**:
The live state of the connection to a gateway: disconnected, connecting, reconnecting, connected, pairing.
_Avoid_: phase (when meaning the app-level journey)

**Connection phase**:
The app-level UX state of the connect journey: idle, booting, searching, connecting, connected, pairing, failed, onboarding.

**Reconnect**:
Automatic retry of the same gateway endpoint by the connection client, with exponential backoff (1s → 15s).
_Avoid_: retry (when meaning the full discovery loop)

**Auto-connect retry**:
Provider-level re-run of the discovery + probe + connect sequence.
_Avoid_: retry alone, reconnect loop

**Probe**:
A lightweight reachability check against a candidate gateway URL (e.g. HTTP /health).
_Avoid_: ping, handshake

**Session**:
The conversation context on a gateway, identified by a sessionId (Hermes) or sessionKey (OpenClaw).
_Avoid_: conversation (when meaning the server-held context)

**Terminal session**:
A live shell session to the gateway's terminal endpoint, distinct from a conversation session.

**Slash command**:
A text command (`/session`, `/model`, …) routed to the gateway's command engine.
_Avoid_: command string, RPC call (when user-facing)

**Capability kind**:
A category of thing the Gate can do (`provider`, `memory`, `cron`, …), defined once in code at `gate/core/capabilities/<kind>/kind.mjs`.
_Avoid_: capability (alone, when meaning the kind specifically), plugin (a gateway's own internal plugin list is a distinct, unrelated concept)

**Capability instance**:
One configured, named instance of a capability kind. Non-provider instances still live in `gate/registry/<id>.json`. Providers persist under Gate home.
_Avoid_: capability (alone)

**Provider**:
The Gate-owned registration that holds credential custody, readiness, and a live or last-known-good model catalog.
_Avoid_: child gateway, Hermes (when meaning a model vendor)

**CLI environment**:
An optional execution attachment that runs Hermes, Codex, or Claude through a versioned adapter.
_Avoid_: provider, agent (when meaning the CLI process)

**Pairing**:
The flow where a device requests access to a gateway and a human approves it.
_Avoid_: setup, onboarding

**Command transcript**:
A local record of slash-command executions keyed by gateway + session, surviving history reloads.
_Avoid_: history (when meaning the full message history)

**Run**:
A gateway-side execution unit with its own lifecycle (running, approval-required, completed, errored).
_Avoid_: job, task

**Approval**:
A pending gateway action on a run that requires the user's explicit consent before execution.
_Avoid_: confirmation (the in-app sheet pattern is different: it happens before the command is sent)

**Local notification**:
A system notification fired by the app itself while its connection to the gateway is alive.
_Avoid_: push (which implies server delivery)

## Relationships

- A **gateway** is reachable via exactly one **gateway profile**
- A **connection status** describes the live connection to a **gateway**; a **connection phase** describes the journey to it
- A **reconnect** reuses the same endpoint and **session**; an **auto-connect retry** re-runs discovery and **probes**
- A **session** belongs to a **gateway** and is preserved across **reconnects**
- A **Bot** has many **sessions**, one **soul**, and its own crons; it is not a **gateway profile**
- A **soul** belongs to exactly one **Bot**
- A **Bot** lives on one Hermes **CLI environment**; Codex, Claude Code, and OpenCode are not Bots
- Many **Bots** are reached through one **gateway**; a Bot is not its own **gateway profile**
- A **Bot** is addressed with its own **listen key**; provider credentials stay in the Hermes profile
- A **command transcript** is keyed by gateway + **session**
- A **capability instance** belongs to exactly one **capability kind**
- A **provider** owns registration, credentials, readiness, and its catalog. Agents and CLI environments only reference `{providerId, modelId}`.
- Provider child gateway profiles are retired; Hermes remains a gateway/agent/CLI environment, never an xAI provider.
- **Pairing** is required when a gateway does not recognize the device
- A **run** may require an **approval** before it can proceed
- An **approval** is resolved per run via the gateway's approval endpoint; only runs the app initiated can be approved
- A **local notification** can announce an approval request or run completion while the app's connection is alive

## Example dialogue

> **Dev:** "When the phone reconnects after a wifi blip, do we re-probe the network?"
> **Domain expert:** "No — a reconnect just retries the same gateway. Only when that fails do we fall back to the auto-connect retry, which probes candidates again."

> **Dev:** "If I add a Bot, is that another gateway profile?"
> **Domain expert:** "No — the gateway profile is how the phone remembers the Gate. A Bot is an isolated agent living on that gateway: its own soul, sessions, and crons."

## Flagged ambiguities

- "retry" and "reconnect" were used interchangeably — resolved: they are distinct mechanisms with different costs (endpoint retry vs discovery loop)
- "session" meant both the conversation context and a live terminal shell — resolved: session vs terminal session
- "gateway" meant both the reachable endpoint and its stored config — resolved: gateway vs gateway profile
- "push" meant both local notifications and server-delivered push — resolved: local notification vs true push (relay-delivered, Phase D)
- "profile" meant three things — resolved: **gateway profile** (phone's stored gateway), **Bot** (Hermes profile / Bot Mode agent), **provider profile** (`providers.profiles.list` connection template). Never say "profile" alone.
- "bot" was briefly used for Discord/Telegram platform adapters (`runner.adapters`) — resolved: those are channels. A Bot is a Hermes profile.
- A Bot that is "just a CLI backend" (Codex/Claude/OpenCode wearing the roster UI) is deferred — a Bot is a Hermes profile. See ADR 0004.
