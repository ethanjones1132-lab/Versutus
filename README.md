# Versutus

Versutus is a mobile/web client for connecting to and controlling AI agent gateways from Android, iOS, and the web. It is a **client**, not a public relay.

It speaks three gateway shapes through one portal seam:

| Kind | Transport | Typical use |
|---|---|---|
| **Hermes** | HTTP REST + SSE (`/v1/chat/completions`, sessions, runs) | Primary PC agent (API server on port 8642) |
| **Versutus Gate** | Open Gateway Manifest + OpenAI-compatible chat proxy | Multi-provider gate (`gate/` in this repo, port 8760) |
| **OpenClaw** | WebSocket v4 adapter | Compatible OpenClaw profiles |

## Current Surface

- **Home** command center: connection hero, Chat / Activity / Tools actions, capability groups (ready-first), saved profiles, run/approval presence.
- **Chat**: streaming markdown, slash commands (executable-first palette), sessions, model picker / `/model set` override, offline outbox (durable), tool-call cards when the stream or history exposes them, run approvals.
- **Activity**: start an agentic run, live events, approve/deny, stop, recent history (persisted), gateway-target list (profile-scoped).
- **Tools**: Shell only when the gateway advertises a terminal; otherwise RPC/Agent. Quick RPC is filtered to commands the live gateway can actually run.
- **Discovery**: LAN beacons, Tailscale candidates, saved profiles, manual add, `versutus://add` deep links.
- **Identity**: SecureStore-backed profiles, tokens, and device identity; Gate pairing for custom/OpenClaw access grants.

## Technology

- Expo SDK 57 · React Native 0.86 · React 19
- Expo Router (native tabs)
- TypeScript · Reanimated 4
- Hermes HTTP/SSE client · ManifestClient (custom gates) · OpenClaw WS adapter
- Expo SecureStore, Notifications, Clipboard, Symbols, WebBrowser

## Development

```bash
npm install
npm start
npm run android
npm run ios
npm run web
```

### Local APK (Windows)

EAS free Android quota and `eas build --local` may be unavailable; a direct prebuild path works:

```bash
# set ANDROID_HOME / JAVA_HOME for your machine first
npx expo prebuild --platform android --clean
cd android && ./gradlew.bat assembleRelease --no-daemon
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.

### Versutus Gate (in-repo)

```bash
cd gate
# NVIDIA_API_KEY=... (or another provider) in gate/.env — never commit secrets
node --env-file=.env cli.mjs start
```

Providers live at `gate/registry/<id>.json` (example: `nvidia`), scaffolded via `node cli.mjs add <id> --kind provider` (fill in the generated template per `gate/CAPABILITY_PROMPT.md`) and validated against `gate/core/capabilities/provider/kind.mjs`. Tokens print on start and may be cached in `gate/.tokens.json` (gitignored patterns apply).

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run smoke:portal
```

Live checks against a running gateway (Hermes or Gate):

```bash
npm run smoke:live                              # Hermes default http://127.0.0.1:8642
npm run smoke:live -- http://127.0.0.1:8760     # Gate
```

Live smoke exercises connect, capability snapshot, auth reject, and capability-gated surfaces (models, sessions, skills, toolsets, runs when advertised). CI runs `tsc`, lint, Jest, and `smoke:portal` on pushes and pull requests.

## Gateway Configuration

Configured hosts may be supplied through:

- `EXPO_PUBLIC_HERMES_GATEWAY_HOSTS`
- `EXPO_PUBLIC_OPENCLAW_GATEWAY_HOSTS` / `EXPO_PUBLIC_OPENCLAW_GATEWAY_HOST` (legacy names)
- `expo.extra.gatewayHosts` in `app.json`

Saved profiles can also be added from the app. Deep-link example:

```text
versutus://add?url=https%3A%2F%2Fpc.example.ts.net&token=API_KEY&name=Home%20PC&agentId=main
```

HTTPS/WSS is recommended for remote gateways. Cleartext HTTP/WS is supported for trusted local networks. Discovery TLS fingerprints are **observed** (shown as “fingerprint seen”), not pin-verified by Expo fetch.

## Repository Map

```text
src/app/                  Expo Router screens and tabs
src/components/           UI primitives and feature surfaces
src/context/              Gateway provider and app state
src/lib/gateway/          Clients, routes, storage, runs, persistence
src/lib/portal/           Identification, manifest, adapters
src/lib/terminal/         Terminal stream and output model
src/constants/            Dark-only design tokens
gate/                     Versutus Gate server (providers, flavors, CLI)
docs/                     Domain glossary, ADRs, audits, plans
scripts/                  smoke:live, smoke:portal, ops tooling
```

## Scope Limits

- True remote push, background keepalive, and public-internet relay need a companion server; not invented in this client.
- Local notifications fire while the app’s gateway connection is alive.
- Hermes host-only admin (config file, channel daemons, logs on disk) is guidance in slash commands, not remote REST.
- Shell terminal requires a gateway that advertises a terminal endpoint (Hermes does not).

## Docs

- Domain language: `CONTEXT.md`
- Session handoff (ops / deploy): `docs/2026-08-11-session-handoff.md`
- Post-Gate audit & activation plan: `docs/superpowers/plans/2026-08-11-post-gate-audit-and-activation.md`
- Gate design: `docs/superpowers/specs/2026-08-10-versutus-gate-design.md`

## License

Private - JonesinSRC
