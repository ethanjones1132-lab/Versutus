# Versutus

Versutus is a mobile/web client for connecting to and controlling AI agent gateways from Android, iOS, and the web. It is a client, not a gateway server or relay.

The primary transport is the Hermes API server: OpenAI-compatible HTTP REST plus streamed SSE on the gateway host. An OpenClaw WebSocket adapter remains available for compatible gateway profiles.

## Current Surface

- Home command center with gateway status, capability groups, saved profiles, run presence, and approval presence.
- Streaming chat with markdown, fenced code blocks, copy actions, slash commands, sessions, model selection, offline queued input, and run approvals.
- Activity tab with live run events, approval decisions, stop-run controls, recent run history, and configured agent targets.
- Tools tab with Shell, Gateway RPC, and Agent modes; bounded ANSI-safe virtualized terminal output and shell history.
- Gateway discovery through local network, Tailscale candidates, saved profiles, manual URLs, and `versutus://add` deep links.
- SecureStore-backed gateway profiles, API tokens, active profile, and device identity.
- Dark-only luxury design system: deep black surfaces, champagne accents, restrained glass, Instrument Sans, and JetBrains Mono.

## Technology

- Expo SDK 56
- React Native 0.85 and React 19
- Expo Router with native tabs
- TypeScript 6
- Reanimated 4
- Hermes HTTP/SSE client and OpenClaw adapter
- Expo SecureStore, Notifications, Clipboard, Symbols, and WebBrowser

## Development

```bash
npm install
npm start
npm run android
npm run ios
npm run web
```

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run smoke:portal
```

CI runs all four checks on pushes and pull requests.

## Gateway Configuration

Configured hosts may be supplied through:

- `EXPO_PUBLIC_HERMES_GATEWAY_HOSTS`
- `EXPO_PUBLIC_OPENCLAW_GATEWAY_HOSTS` (legacy environment name)
- `EXPO_PUBLIC_OPENCLAW_GATEWAY_HOST` (legacy environment name)
- `expo.extra.gatewayHosts` in `app.json`

Saved profiles can also be added from the app. Deep-link example:

```text
versutus://add?url=https%3A%2F%2Fpc.example.ts.net&token=API_KEY&name=Home%20PC&agentId=main
```

HTTPS/WSS is recommended for remote gateways. Cleartext HTTP/WS is supported for trusted local networks. Discovery TLS fingerprints are recorded for visibility, but the current Expo fetch transport does not perform certificate pin verification.

## Repository Map

```text
src/app/                  Expo Router screens and tabs
src/components/           UI primitives and feature surfaces
src/context/              Gateway provider and app state
src/lib/gateway/          Hermes/OpenClaw clients, routes, storage, runs
src/lib/portal/            Gateway identification and adapter seam
src/lib/terminal/         Terminal stream and output model
src/constants/             Dark-only design tokens
docs/                     Domain glossary, ADRs, audits, and roadmap
scripts/                  Smoke checks and optimization tooling
```

## Scope Limits

True remote push delivery, background gateway connectivity, and public-internet relay access require a companion relay/server component. They are intentionally not fabricated inside this client repository. Local notifications work while the app connection remains alive.

## License

Private - JonesinSRC
