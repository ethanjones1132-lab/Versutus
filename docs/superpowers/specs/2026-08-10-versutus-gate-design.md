# Versutus Gate + Manifest-Driven Transport — Design

Date: 2026-08-10
Status: Approved design, not yet implemented
Related: `docs/portal-architecture.md` (Phase E), `CONTEXT.md`

## 1. Purpose

Versutus today speaks two hardcoded dialects: Hermes (HTTP/SSE) and OpenClaw
(WS v4). Every new backend means a new adapter written by hand, and the app's
feature surface is shaped by whichever gateway was implemented most recently.

This design removes that ceiling in two moves:

1. **Versutus Gate** — a Node service on the user's PC that hosts any number of
   model providers behind one manifest, one URL, and one pairing. Appending a
   provider is a scaffold command plus a filled-in config block, safe enough
   that a language model can do it from a copy-pasteable prompt.
2. **`ManifestClient`** — an app-side client that resolves its routes from a
   gateway's advertised manifest rather than hardcoded paths, so any conforming
   gate works with no code change.

The Gate proves the manifest contract; `ManifestClient` consumes it. Neither is
useful alone, which is why they ship together.

## 2. Goals

- A conforming gateway works in the app without app code changes.
- Appending a provider on the PC surfaces it on the phone with no phone-side setup.
- Provider API keys never leave the PC.
- Onboarding requires no pasted API key.
- The reconnect behaviour hardened on 2026-08-10 lives in exactly one place and
  is shared by every client.

## 3. Non-goals

- **No relay server.** Remote access stays on Tailscale. `docs/portal-architecture.md`
  Phase D is explicitly not part of this work.
- **No new feature surfaces.** The 12 capability groups reporting `unsupported`
  against Hermes (voice, artifacts, cron, channels, nodes, devices, …) are
  follow-on work. This spec makes them expressible per-gateway; it does not build them.
- **No OpenClaw changes.** The existing WS adapter keeps working as-is.
- **No live provider calls in CI.** They cost money and require keys.

## 4. Architecture

```
gate/
  core/          host: HTTP, manifest, auth, pairing, sessions, SSE, errors
  flavors/       openai.mjs, anthropic.mjs — request/response translation
  providers/     one directory per appended provider (scaffolded)
  cli.mjs        add | start | pair | list
  .env           provider API keys (gitignored)
```

Three units with hard boundaries:

**`gate/core/`** owns everything shared. Provider modules never touch HTTP,
auth, or session state. A provider that throws, returns malformed data, or
fails config validation degrades to one unhealthy provider — it cannot take the
Gate down. This is the "safe fixed structure" the design depends on.

**`gate/flavors/`** carries the actual protocol translation. GPT, Grok, and Kimi
are all OpenAI-compatible and share `openai.mjs`, differing only in base URL,
key, and model list. Claude uses `anthropic.mjs`. A third flavor, `custom`, is
the escape hatch where a provider genuinely needs bespoke logic.

**`gate/providers/<id>/provider.mjs`** is a fixed-shape config module. The
flavor layer is what shrinks the model's job from "write a server" to "fill in
five fields", and is the reason the copy-pasteable prompt is viable.

The Gate runs as one process serving all providers. It is a sibling npm
workspace so its dependencies never enter the mobile bundle.

## 5. Provider module contract

`node gate/cli.mjs add grok --flavor openai` scaffolds:

```js
export const id = 'grok';
export const label = 'Grok';

// ─── CONFIG: edit only inside this block ───────────────
export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  capabilities: { chat: true, streaming: true },
};
// ─── END CONFIG ────────────────────────────────────────
```

Rules:

- Only the CONFIG block is editable. Structure outside it is supplied by the scaffold.
- `apiKeyEnv` names an environment variable read from `gate/.env`. A literal key
  in this file is a validation error, not a warning.
- `config` is validated against a schema at load. Failures are logged with the
  offending field and the provider is skipped; the Gate still starts.
- `capabilities` declares only what the provider actually supports. It is
  reported verbatim in the manifest and drives the app's capability snapshot.

`--flavor anthropic` for Claude. `--flavor custom` emits additional required
exports (`listModels`, `streamChat`) and is the only path where a model writes
real logic.

### Setup prompt

A copy-pasteable prompt lives at `gate/PROVIDER_PROMPT.md`. It instructs a model
to fill the CONFIG block of an already-scaffolded file — never to create or
restructure one. It states the schema, the flavor choice, and that the API key
must be referenced by env var name. The operator runs the scaffold command
first; the model only fills declared holes.

## 6. Manifest extension

`versutus-gateway/v1` gains one optional field. Existing manifests stay valid.

```json
{
  "manifest": "versutus-gateway/v1",
  "kind": "versutus-gate",
  "name": "Ethan's Gate",
  "auth": {
    "schemes": ["challenge-response", "bearer"],
    "grantPath": "/.well-known/gateway/access"
  },
  "transport": { "primary": "http" },
  "endpoints": { "health": "/health", "chat": "/v1/chat/completions" },
  "providers": [
    {
      "id": "claude",
      "label": "Claude",
      "basePath": "/p/claude",
      "models": ["claude-opus-5"],
      "capabilities": { "chat": true, "streaming": true }
    }
  ]
}
```

Each provider is reachable at `basePath` with the parent's endpoint paths
appended: `/p/claude/v1/chat/completions`. Providers inherit the parent's auth.

## 7. App-side changes

1. **`manifest.ts`** — parse and validate `providers[]`; absent means a
   single-provider gateway, preserving current behaviour.
2. **`identify.ts`** — carry providers through into `GatewayIdentity`.
3. **Child profile sync** — on connect and on capability refresh, materialize
   one `GatewayProfile` per advertised provider: `url` = parent URL + `basePath`,
   token inherited, new `parentId` field set. Providers removed upstream have
   their child profiles removed on next sync. Children are never probed
   independently; parent reachability governs.
4. **`ManifestClient`** — a `PortalClient` implementation that resolves routes
   from `endpoints` instead of hardcoded paths. Selected by `createClientForKind`
   when a manifest is present and the kind has no built-in adapter.

### Client refactor

`src/lib/gateway/client.ts` currently combines transport, health monitoring,
reconnect policy, Hermes route mapping, runs, and sessions. Writing
`ManifestClient` alongside it would duplicate the reconnect behaviour fixed on
2026-08-10 — the two-strike failure threshold, cancellation of a stale reconnect
on recovery, liveness derived from any successful request, and header
sanitization. Duplicated, those copies drift.

Two units are extracted first, and both clients compose them:

- **`http-transport.ts`** — fetch wrapper, header sanitization, timeouts, SSE
  parsing, `lastContactAt` tracking, `GatewayHttpError`.
- **`connection-monitor.ts`** — health loop, failure threshold, jittered
  backoff, reconnect scheduling, suspend/resume.

Existing tests in `__tests__/gateway-client-health-test.ts` cover this behaviour
and must pass unchanged through the refactor. That is the regression gate.

## 8. Auth and pairing

The Gate implements `POST /.well-known/gateway/access`, the signed Ed25519
request `src/lib/portal/access.ts` already sends and which no server currently
implements.

1. App signs a payload with its device identity (already built).
2. Gate verifies the signature against the supplied public key.
3. First contact returns `pending-approval` with a request id, unless a pairing
   window is open (`node gate/cli.mjs pair --open`), in which case it grants.
4. Operator approves with `node gate/cli.mjs pair approve <id>`.
5. Gate returns a device-bound bearer token, used for all subsequent calls.

No pasted API key. On 2026-08-10 a stray non-printable character in a pasted key
caused four failed builds before diagnosis; removing the step removes the class
of failure.

Child providers inherit the parent's token — one pairing covers every provider
appended thereafter.

## 9. Security posture

- Gate binds `127.0.0.1` by default and is exposed via Tailscale Serve, matching
  the existing Hermes setup. Binding `0.0.0.0` requires an explicit flag.
- Provider API keys live in `gate/.env`, gitignored, read by env var name. They
  are never included in the manifest, never logged, and never sent to the phone.
- Device tokens are bound to the device id that requested them and are revocable
  with `node gate/cli.mjs pair revoke <id>`.
- Signature verification rejects payloads whose `signedAtMs` is more than 300
  seconds from the Gate's clock in either direction, and rejects a signature
  already seen within that window, to prevent replay.

## 10. Testing

**Gate unit** — config schema validation including the literal-key rejection;
provider load-and-skip on malformed config; flavor request/response mapping
against recorded fixtures.

**Gate integration** — start the real Gate on an ephemeral port with a stub
provider; assert manifest shape, access grant and denial, chat streaming, and
that a throwing provider does not affect a healthy sibling.

**App unit** — `providers[]` parsing; child sync add and remove; `ManifestClient`
route resolution from endpoints; unchanged behaviour of the existing health and
capability suites.

**Live smoke** — extend `npm run smoke:live` to accept a target URL so the same
assertions run against both Hermes and the Gate. Identical results against two
unrelated backends is the evidence that the abstraction is real rather than
asserted.

## 11. Sequencing

1. Extract `http-transport.ts` and `connection-monitor.ts`; existing tests pass unchanged.
2. Gate core: manifest, health, config loading, provider registry.
3. Gate auth: signed access, pairing CLI, token store.
4. `openai` flavor + stub provider; Gate integration tests green.
5. `ManifestClient` + `createClientForKind` dispatch.
6. Manifest `providers[]` parsing and child profile sync in the app.
7. `anthropic` flavor.
8. `smoke:live` against the Gate; compare with Hermes.
9. `PROVIDER_PROMPT.md` and a real provider appended end to end.

Steps 1–4 are independently verifiable without touching the app. Step 8 is the
acceptance gate for the whole spec.

## 12. Follow-on work (not this spec)

- Feature surfaces for the capability groups currently reporting `unsupported`.
- Deep links and QR onboarding (`docs/portal-architecture.md` Phase C).
- Push notification delivery while backgrounded.
