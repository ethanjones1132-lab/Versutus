# Versutus

**OpenClaw Gateway Client** — a mobile app for connecting to and controlling AI agent environments from your phone.

Built with Expo SDK 56, React Native 0.85, and TypeScript. Primarily targets Android with a luxury dark design system (deep black + champagne gold).

## Features

### Gateway Connectivity
- **WebSocket client** — connects to OpenClaw gateways over the OpenClaw wire protocol (v4)
- **Device identity** — Ed25519 keypair generated on first launch, cryptographically signed auth payloads
- **Pairing flow** — challenge/response handshake, token storage via SecureStore, stale token recovery
- **Auto-reconnect** — exponential backoff (1s → 2s → 4s … up to 15s, max 12 attempts)
- **Reachability probing** — periodic UDP + TCP probes to detect gateway availability

### Chat Interface
- Streaming AI agent responses with delta message rendering
- Command execution with running/complete/error states
- Model picker for selecting gateway-hosted models
- Session management: current, restore, abort, compact
- Slash command autocomplete with fuzzy matching

### Terminal Interface
- Three modes: **Shell**, **RPC**, **Agent**
- Command history and log sheet
- Native Android M3 SegmentedButton mode picker
- Command chips with status, timing, and raw output

### Gateway Management
- Add gateways via URL (manual, local network discovery, Tailscale)
- Live capability catalog — see available/healthy/missing-scope feature groups
- Rename, repair, and delete gateways
- Compact gateway list with connection status badges

### Android-Native UI
- `.android.tsx` platform splits for native Android rendering
- Material 3 components, LazyColumn, Reanimated animations
- Haptics for confirmation, warnings, and interactions
- Deep black (`#08080A`) + champagne gold design tokens
- Adaptive icon with monochrome support

### Optimization Loop
Versutus ships with an automated optimization pipeline — a recurring 30-minute Grok headless loop that drives UI polish and feature implementation:

| Phase | Focus |
|-------|-------|
| Android Pass 1 | Foundation — onboarding/home Android elevation |
| Android Pass 2 | Interactions — chat/terminal native, haptics, motion |
| Android Pass 3 | Final polish — settings/add, luxury audit |
| Features (Pass 4+) | One backlog feature per pass from `features-backlog.json` |

## Project Structure

```
Versutus/
├── assets/                     # Images, icons, splash screens
│   └── images/
├── docs/                       # Plans and design documents
│   ├── gateway-detection-connection-loop-plan.md
│   ├── ui-polish-loop-plan.md
│   └── openclaw-gateway-followup.md
├── plugins/
│   └── with-openclaw-discovery.js   # Expo config plugin
├── scripts/
│   └── optimization-loop/           # Automated Grok optimization pipeline
│       ├── prompt-features.txt      # Feature phase prompt
│       ├── prompt-android-pass-*.txt
│       ├── features-backlog.json    # Prioitized feature backlog
│       ├── status.json              # Loop state tracker
│       ├── SCHEDULING.md            # Loop management docs
│       ├── launch-loop.bat
│       ├── schedule-loop.ps1
│       └── stop-loop.ps1
├── src/
│   ├── app/                        # Expo Router file-based routes
│   │   ├── (tabs)/                 # Tab navigation
│   │   │   ├── index.android.tsx   # Home screen (Android native)
│   │   │   ├── chat.android.tsx    # Chat screen (Android native)
│   │   │   ├── chat.tsx            # Chat screen (cross-platform)
│   │   │   ├── terminal.android.tsx# Terminal screen (Android native)
│   │   │   └── terminal.tsx        # Terminal screen (cross-platform)
│   │   ├── gateway/
│   │   │   ├── add.android.tsx     # Add gateway (Android native)
│   │   │   └── settings.android.tsx# Gateway settings (Android native)
│   │   ├── onboarding.android.tsx
│   │   └── dev/
│   │       └── preview.tsx         # Dev preview scenarios
│   ├── components/
│   │   ├── chat/
│   │   │   ├── chat-composer.tsx / .android.tsx
│   │   │   ├── message-bubble.tsx
│   │   │   ├── model-picker-sheet.tsx
│   │   │   ├── pairing-sheet.tsx / .native.tsx
│   │   │   ├── session-selector-sheet.tsx
│   │   │   ├── confirmation-sheet.tsx
│   │   │   └── chat-empty-state.tsx / .ios.tsx
│   │   ├── terminal/
│   │   │   ├── command-chip.tsx / .android.tsx
│   │   │   ├── mode-picker.tsx / .android.tsx
│   │   │   └── command-log-sheet.tsx
│   │   ├── gateway/
│   │   │   ├── gateway-home-dashboard.tsx
│   │   │   ├── gateway-capabilities.tsx
│   │   │   ├── gateway-command-panel.android.tsx
│   │   │   ├── compact-gateway-list.tsx
│   │   │   ├── gateway-card.android.tsx
│   │   │   └── gateway-card-inner.tsx / .android.tsx
│   │   ├── ui/
│   │   │   ├── Button.android.tsx
│   │   │   ├── BaseSheet.tsx / .android.tsx
│   │   │   └── index.ts
│   │   ├── home-status-card.tsx / .android.tsx
│   │   ├── connection-badge.tsx / .android.tsx
│   │   ├── pairing-panel.tsx / .android.tsx
│   │   └── glass-collapsible.android.tsx
│   ├── context/
│   │   └── gateway-provider.tsx     # Gateway connection React context
│   ├── hooks/
│   │   └── use-gateway-reachability.ts
│   ├── lib/
│   │   ├── gateway/
│   │   │   ├── client.ts           # OpenClawGatewayClient (WebSocket)
│   │   │   ├── types.ts            # Shared type definitions
│   │   │   ├── dashboard.ts        # Capability snapshot builder
│   │   │   ├── candidates.ts       # Gateway candidate resolution
│   │   │   ├── probe.ts            # Reachability probing
│   │   │   └── slash-commands.ts   # Command definitions
│   │   ├── discovery/
│   │   │   └── scanner.ts          # LAN gateway discovery (Zeroconf)
│   │   └── dev/
│   │       └── preview-scenarios.ts
│   └── constants/
│       └── tokens.ts               # Design tokens (colors, spacing, radius)
├── app.json                        # Expo app config
├── eas.json                        # EAS Build profiles
├── package.json
├── tsconfig.json
└── expo-env.d.ts
```

## Getting Started

### Prerequisites

- Node.js 18+
- [Expo CLI](https://docs.expo.dev/more/expo-cli/)
- Android Studio (for Android emulator) or a physical Android device

### Install

```bash
git clone <repo-url>
cd Versutus
npm install
```

### Development

```bash
# Start the Expo dev server
npm start

# Launch on Android
npm run android

# Launch on iOS
npm run ios

# Launch in web browser
npm run web
```

### Lint & Type Check

```bash
npm run lint         # ESLint via expo lint
npx tsc --noEmit     # TypeScript type check
```

### Build

```bash
# Preview APK (internal distribution)
npm run build:android:preview

# Preview APK (local build, no EAS remote)
npm run build:android:preview:local

# Production Android App Bundle
eas build --profile production --platform android
```

### Optimization Loop

To run the automated UI/feature optimization pipeline:

```powershell
.\scripts\optimization-loop\launch-loop.bat
```

See `scripts/optimization-loop/SCHEDULING.md` for scheduling details and manual one-off run instructions.

## Configuration

Gateway hosts are configured in `app.json` under `expo.extra.openClawGatewayHosts` and can also be added manually from the app UI.

The default Tailscale host is `ethanspc.tail3a1a8a.ts.net`.

EAS project ID: `52545800-300a-4bbc-a2b9-7e412d9c217e` (owner: `jonesinsrc`).

### Design Tokens

The design system lives in `src/constants/tokens.ts` and exposes:
- **Palette** — deep black base, champagne gold accent, status colors
- **Spacing** — compact 4px grid
- **Radius** — rounded corner values
- **Typography** — Instrument Sans + JetBrains Mono (from Google Fonts)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Expo SDK 56 · React Native 0.85 |
| Language | TypeScript 6 |
| Routing | Expo Router (file-based) |
| UI | React Native Gesture Handler · Reanimated 4 · expo-ui |
| Crypto | @noble/ed25519 · @noble/hashes |
| Storage | expo-secure-store · @react-native-async-storage |
| Build | EAS Build (Android: APK / App Bundle) |
| Discovery | react-native-zeroconf (LAN) |
| Design | Dark · Gold accent · Glassmorphism |

## Gateway Protocol

Versutus speaks the **OpenClaw wire protocol v4** over WebSocket:

1. **Connect** — opens WebSocket to `wss://<gateway>/openclaw`
2. **Challenge** — gateway sends `connect.challenge` event with a nonce
3. **Auth** — client responds with device identity, Ed25519 signature, auth token or pairing request
4. **Hello** — on success, gateway responds with `hello-ok` containing role, scopes, and optional device token
5. **Requests** — JSON-RPC style frames: `{ type: 'req', id, method, params }`
6. **Events** — server-pushed events for chat streaming, status updates

Device identity is persisted via SecureStore, with the Ed25519 keypair generated on first launch.

## License

Private — © JonesinSRC