# Android UI baselines

Capture reference screenshots from a **dev build** (`npx expo run:android`), not Expo Go — Compose `Surface` glass only renders in native builds.

## Prerequisites

- Android SDK + emulator or USB device with `adb` on PATH
- From repo root: `npx expo run:android`

## Capture procedure

1. Open **UI Preview**: navigate to `/dev/preview` (dev-only route).
2. For each scenario chip (Idle, Searching, Connecting, Pairing, Connected, Failed, Chat stream), capture a full-screen screenshot.
3. Save as `{scenario}.png` in this folder (e.g. `idle.png`, `chat-streaming.png`).

## Phase 0 acceptance

- Dark background + elevated cards (no light-mode mismatch)
- Hero card uses M3 elevation tier 3/6
- Pairing panel gold border visible on Android Compose surfaces