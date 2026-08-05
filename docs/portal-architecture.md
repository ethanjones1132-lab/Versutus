# Versutus Portal Architecture — Open Gateway Contract

Date: 2026-08-05
Status: **Foundational phase — contract defined, core implemented**
Supersedes: the "gateway type detection is theory only, DO NOT IMPLEMENT" rule in `docs/gateway-detection-connection-loop-plan.md` (that rule belonged to the old OpenClaw-first plan; the product direction is now explicit: Versutus **identifies** gateways and **requests access** to them regardless of origin).

## 1. Vision

Versutus is a **remote portal into the user's desktop(s)** — a universal client that:

1. **Identifies** any open gateway it encounters — Hermes, OpenClaw, or custom-built gates — from LAN (mDNS), tailnet, manual URL, deep link, or relay.
2. **Requests access** with a single, signed, device-identity-backed handshake that each gateway kind answers in its own dialect.
3. **Connects** through a per-kind adapter and exposes the unified surface: chat, runs, terminal, sessions, approvals.

The gateway is the host; Versutus is the portal. Any host that speaks one of the supported dialects — or serves the Open Gateway Manifest — is reachable.

## 2. The Open Gateway Manifest (`/.well-known/gateway.json`)

The universal contract that makes **custom gates first-class**. Any gateway (Hermes, OpenClaw, or custom) can serve this JSON at its base URL. Versutus treats the manifest as authoritative when present; fingerprinting covers gates that do not serve it.

```json
{
  "manifest": "versutus-gateway/v1",
  "kind": "hermes" | "openclaw" | "<custom-kind-id>",
  "name": "Home PC",
  "version": "0.1.0",
  "vendor": "jonesinsrc",
  "auth": {
    "schemes": ["bearer", "challenge-response", "none"],
    "grantPath": "/.well-known/gateway/access",
    "challengePath": "/.well-known/gateway/challenge"
  },
  "transport": { "primary": "http" | "ws", "basePath": "/openclaw" },
  "capabilities": {
    "chat": true, "runs": true, "terminal": false,
    "sessions": true, "models": true, "approvals": true
  },
  "endpoints": {
    "health": "/health",
    "chat": "/v1/chat/completions",
    "runs": "/v1/runs",
    "terminal": "/better-gateway/terminal/stream"
  }
}
```

Rules:
- `manifest` MUST be `versutus-gateway/v1` (or a future `vN`) — anything else is rejected as not-an-open-gateway.
- `kind` selects the adapter. `hermes`/`openclaw` map to built-in adapters; anything else is treated as `custom` with the kind id preserved for display.
- `auth.schemes` advertise how the gate answers access requests; `grantPath` (optional) advertises the universal access endpoint.

## 3. Identification cascade (`src/lib/portal/identify.ts`)

Given a base URL (from any origin), identify in order, first match wins:

| # | Signal | Result |
|---|--------|--------|
| 1 | Beacon TXT `kind` field (mDNS) | instant, no network |
| 2 | `GET /.well-known/gateway.json` + validation | authoritative (works for any custom gate) |
| 3 | Hermes fingerprint: `GET /health` + `GET /v1/capabilities` (presence of `runtime`, `auth`, `endpoints`) | `hermes` |
| 4 | OpenClaw fingerprint: bounded WS connect to `<ws-base>/openclaw`, expect `connect.challenge` event | `openclaw` |
| 5 | HTTP `/health` responds but nothing else matches | `unknown` with `transportHint: http` |

Output: `GatewayIdentity { kind, kindLabel, name?, version?, vendor?, manifest?, auth: { schemes, requiresToken, grantPath? }, transportHint?, capabilities?, source, identifiedAt }`.

## 4. Access request (`src/lib/portal/access.ts`)

Universal handshake, per-kind dialect, one result shape:

```ts
type AccessRequestResult =
  | { status: 'granted'; token: string; role?: string; scopes?: string[] }
  | { status: 'pending-approval'; requestId?: string; hint?: string }
  | { status: 'token-required'; hint?: string }
  | { status: 'denied'; reason: string };
```

| Kind | Dialect |
|------|---------|
| hermes | POST `/.well-known/gateway/access` with signed device payload → granted / pending / token-required. **Server support does not exist yet in Hermes** — client falls back to `token-required` (paste `API_SERVER_KEY`), the current flow. |
| openclaw | Existing WS v4 pairing via the salvaged `OpenClawGatewayClient`: stored device token → hello-ok (`granted` with deviceToken), `PAIRING_REQUIRED` → `pending-approval`, auth missing → `token-required`. |
| custom | Manifest-driven: if `grantPath` exists → standard signed access request; else `token-required`. |
| unknown | `token-required` (user supplies token; kind may still connect as generic HTTP). |

The signed payload reuses the existing Ed25519 device identity:

```
POST <grantPath>
{ "manifest": "versutus-gateway/v1",
  "device": { "id", "publicKey", "clientId": "versutus-mobile", "clientMode": "ui" },
  "role": "operator", "scopes": [...], "signedAtMs": ...,
  "signature": <Ed25519 over "v4|<deviceId>|<clientId>|<role>|<scopes>|<signedAtMs>">,
  "client": { "name": "Versutus", "version": "1.0.0", "platform": "android" } }
→ 200 { "status": "granted", "token", "role", "scopes", "expiresAtMs"? }
→ 202 { "status": "pending", "requestId" }
→ 200 { "status": "token-required", "hint"? }
→ 403 { "status": "denied", "reason" }
```

## 5. Origin federation (how gateways are found)

| Origin | Mechanism | Status |
|--------|-----------|--------|
| Local LAN | mDNS `_openclaw-gw._tcp` (+ TXT: kind, displayName, tailnetDns, tlsFingerprint) | built |
| Tailnet | `*.ts.net` + `100.x` candidates, `tailnetDns` from beacon | built |
| Manual | URL entry + identify-on-save | built (this phase) |
| Deep link | `versutus://add?url=...&kind=...` | planned |
| Relay / rendezvous | Public relay server: device registers, portal pulls gateway list, traffic via wss tunnel | **new component — next phase** |

The relay is the "remote portal" enabler for gateways behind NAT that don't run Tailscale. Design: gateway connects out to relay (wss), registers under an owner key; portal lists owned gateways, requests access through the relay's forward; relay is a dumb authenticated pipe (no payload inspection). Reference implementation planned as a companion Node service.

## 6. Adapter architecture (`src/lib/portal/adapters.ts`)

```
GatewayKind ──► registry ──► GatewayClientLike (Hermes-shaped surface)
   hermes   ──► HermesGatewayClient          (existing HTTP/SSE client)
   openclaw ──► OpenClawGatewayClient        (salvaged WS v4 client, src/lib/gateway/openclaw-client.ts)
   custom   ──► Hermes-shaped HTTP fallback  (manifest-driven generic transport: next phase)
   unknown  ──► Hermes-shaped HTTP fallback
```

Provider dispatch (`gateway-provider.tsx` picks the client by `profile.kind`) is the **next step**; this phase ships the registry + both clients + the add-flow wiring.

## 7. Roadmap

- [x] **Phase A (this commit): Contract + identification + access request**
  - `docs/portal-architecture.md` (this doc)
  - `src/lib/portal/manifest.ts` — manifest types, fetch, validation
  - `src/lib/portal/identify.ts` — cascade (beacon → manifest → hermes → openclaw → unknown)
  - `src/lib/portal/access.ts` — universal access request per kind
  - `src/lib/portal/adapters.ts` — kind → client registry
  - `src/lib/gateway/openclaw-client.ts` + `openclaw-types.ts` — WS v4 client salvaged from git HEAD (was being deleted by the Hermes-HTTP migration)
  - `GatewayProfile.kind` persistence; add-gateway flow identifies before saving, requests access, shows the identified kind
- [ ] **Phase B: Provider dispatch + unified connect**
  - `attachClient` selects adapter by `profile.kind`; OpenClaw compat shim (chat via WS events) so openclaw/custom profiles connect end-to-end; pairing sheet wired for `pending-approval`
- [ ] **Phase C: Remote enablers**
  - Push notifications (expo-notifications): run-complete, approval-requested, gateway-down
  - Run-approval native sheet (`resolveApproval` already client-ready)
  - Deep links + QR onboarding
- [ ] **Phase D: Relay server** (companion repo): registration, owner-key auth, wss forwarding, gateway directory API
- [ ] **Phase E: Manifest-driven generic transport** — custom gates with manifest endpoints but no built-in adapter get chat/runs/terminal executed from `endpoints` + `auth.schemes`

## 8. Validation

- [x] `npx tsc --noEmit`
- [ ] Live identification against a real Hermes gateway (blocked previously: smoke 0/18 — needs a responsive gateway call path)
- [ ] OpenClaw WS handshake against a real OpenClaw gateway
- [ ] A toy custom gate serving `/.well-known/gateway.json` + grant endpoint (fastest way to prove the contract — a 30-line Node script)
