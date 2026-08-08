# Versutus

A mobile client for connecting to and controlling AI agent gateways (Hermes API servers and OpenClaw agents) from Android/iOS/web.

## Language

**Gateway**:
A reachable endpoint that hosts agent capabilities.
_Avoid_: server, backend, node

**Gateway profile**:
The app's stored configuration for a gateway (name, URL, auth token, kind, agent).
_Avoid_: gateway (when meaning the stored config)

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
- A **command transcript** is keyed by gateway + **session**
- **Pairing** is required when a gateway does not recognize the device
- A **run** may require an **approval** before it can proceed
- An **approval** is resolved per run via the gateway's approval endpoint; only runs the app initiated can be approved
- A **local notification** can announce an approval request or run completion while the app's connection is alive

## Example dialogue

> **Dev:** "When the phone reconnects after a wifi blip, do we re-probe the network?"
> **Domain expert:** "No — a reconnect just retries the same gateway. Only when that fails do we fall back to the auto-connect retry, which probes candidates again."

## Flagged ambiguities

- "retry" and "reconnect" were used interchangeably — resolved: they are distinct mechanisms with different costs (endpoint retry vs discovery loop)
- "session" meant both the conversation context and a live terminal shell — resolved: session vs terminal session
- "gateway" meant both the reachable endpoint and its stored config — resolved: gateway vs gateway profile
- "push" meant both local notifications and server-delivered push — resolved: local notification vs true push (relay-delivered, Phase D)
