# Option A — Persistent socket to your own Gate (spec)

Status: spec, not implemented. Recommendation: build this one.

## 1. What it is

The app holds one long-lived WebSocket to the Gate over Tailscale.
Gate pushes run / approval / final-response events down the socket.
No Google, no Expo push, no Firebase, nothing leaves the tailnet.

- Gate: `C:\Projects\Versutus\gate` (node:http server, port 8760 today)
- App: Expo SDK 57, `HermesGatewayClient` (HTTP + SSE today, no WS)
- Transport: `ws` (already a dep: app `ws@8.21.3`; Gate uses `ws` for the voice media socket)

## 2. Non-goals

- No chat-send over the socket in v1. Chat stays HTTP/SSE as today. Socket is notify-only: `run started/delta/final`, `approval requested`, `routine done`, `gateway notice`. (Full duplex later.)
- No relay/NAT traversal. Tailnet-only. Off-tailnet = disconnected, by design.
- No iOS background socket in v1. iOS suspends it; Android is the target.

## 3. Architecture

```
Gate (:8760, same node:http server)
 ├─ existing: HTTP routes (chat, runs, approvals, push-rpc…)
 ├─ existing: /v1/voice/stream  (media WS, per-call)
 └─ NEW:      /v1/events/stream (event WS, one per device, long-lived)
        ▲
        │  wss/ws over Tailscale (http://100.x:8760 or https tailscale-serve)
        ▼
App: EventSocket ──► gateway-provider ──► UI (badges, sheets, alerts)
         │ foreground service (Android) keeps it alive in Doze
```

Why a second WS path instead of reusing voice: voice socket is per-call with
audio framing and a 30s no-audio kill. Events need the opposite: silent for
hours, one per device, cheap heartbeat. Same `server.on('upgrade')` pattern,
new module next to `media-socket.mjs`.

## 4. Wire protocol (v1)

Path: `GET /v1/events/stream?deviceId=<id>` → 101 upgrade.
Auth: same device token as HTTP routes (`Authorization: Bearer <deviceToken>`
header on the upgrade request — mirrors `media-socket.mjs` + `requireDevice`).

Client → server (JSON text frames):
- `{ "type": "hello", "deviceId, "client": {"name":"Versutus","version":"1.0.0","platform":"android"}, "subscriptions": ["runs","approvals","routines","notices"] }`
- `{ "type": "ping", "t": <ms> }` → server replies `pong`
- `{ "type": "ack", "eventId": "<id>" }` (at-least-once; server replays unacked on reconnect, dedupe window 1000 ids — same DEDUPE_LIMIT idiom as push-notifier)

Server → client:
- `{ "type": "welcome", "serverTime": <ms>, "subscriptions": [...] }`
- `{ "type": "pong", "t": <ms> }`
- `{ "type": "event", "eventId": "<uuid>", "trigger": "run-started|run-delta|run-final|approval-requested|final-response|routine|notice", "sessionId?", "runId?", "botId?", "data": {...}, "ts": <ms> }`
- Event `data` reuses the push-notifier classification (`classifiedEvent` in
  `push-notifier.mjs`: final-response → routine vs session, bot scoping,
  quiet-hours flags). Same shape, different sink.

Heartbeat: client ping every 25s, server pong timeout 10s → reconnect.
Server also pings (ws built-in) every 30s as backstop.

## 5. Gate changes

1. **New `gate/core/events/event-socket.mjs`** — `attachEventSocket({ server, deviceTokens, now })`:
   - `new WebSocketServer({ noServer: true })`, `server.on('upgrade')` routes
     only `pathname === '/v1/events/stream'` (pass anything else through so the
     voice socket keeps working — two upgrade listeners, path-gated).
   - Auth on upgrade via `deviceTokens.verify()`; reject with
     `rejectUpgrade(socket, 401, ...)` (same helper idiom as media-socket).
   - `Map<deviceId, Set<ws>>` (allow 2 sockets/device during handover; kill
     older on hello with same deviceId + newer `t`).
   - `broadcast(event)` + `sendTo(deviceId, event)`; unacked buffer per device
     (cap 200, drop-oldest with a `notice: "missed-events"` marker).
   - Unit tests mirror `push-send.test.mjs` / `push-rpc.test.mjs` style.
2. **Fan-out**: hook the existing push dispatch site in `server.mjs`
   (~line 426–430, where `pushNotifier.notify(event)` fires). Add
   `eventSockets.broadcast(classifiedEvent(event))` next to it — best-effort,
   never throws into the turn. Expo push keeps firing in parallel until
   Option A proves itself, then gate it behind a per-device `transport:
   'socket' | 'expo' | 'both'` preference (stored in push-tokens row).
3. **Manifest**: advertise in `/.well-known/gateway.json`:
   `"endpoints": { ..., "events": "/v1/events/stream" }` + capability
   `"liveEvents": true`. The portal identify cascade needs no change
   (manifest is authoritative when present).
4. **Shutdown**: `close()` ends event sockets with code 1012 (service restart)
   so the app reconnects with backoff instead of hammering.

## 6. App changes

1. **New `src/lib/gateway/event-socket.ts`** — framework-free class (no
   react-native imports, same `openclaw-mapping.ts` rule so smoke tests can
   import it): connect/hello/ping/ack/replay-dedupe/backoff. Emits via
   callback `onEvent`. Reuse `connection-monitor.ts` policy constants style
   (base 1s, max 15s, jitter, 5-attempt escalation hands back to auto-connect).
2. **Wire into `HermesGatewayClient`**: `connect()` opens HTTP health check
   first (as today), then opens EventSocket; `connectionStatus` stays
   `'connected'` while either is alive; EventSocket drop → `reconnecting`,
   HTTP still usable. `suspendReconnect()` (backgrounded) pauses socket
   reconnect; the foreground service (below) is what keeps it alive instead.
3. **Foreground/background**: app foreground = socket owned by
   gateway-provider as today. App backgrounded = ownership hands to the
   foreground service (it holds the WS + posts local notifications on event).
   One socket at a time: service binds → provider suspends its copy.
4. **Local notifications**: `expo-notifications` `presentNotificationAsync`
   on event (no FCM involved — local only). Tap deep-links to the run/session
   (`versutus://...` scheme already registered).
5. **Quiet hours / bot filter**: enforce client-side from the stored
   push preferences row (server already classifies; client decides to buzz).
6. **SecureStore**: device token via the existing secure wrapper only.

## 7. Android keep-alive (the Doze part)

- **New minimal native module** `GateSocketService` (Kotlin, foreground
  service type `dataSync`): holds the WS, posts the persistent notification,
  re-emits events to JS. Own module, not a third-party dep (one file +
  config plugin `plugins/with-gate-socket-service.js`).
- **Permissions to add** in app.json: `FOREGROUND_SERVICE_DATA_SYNC`,
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (to fire the exemption intent),
  `RECEIVE_BOOT_COMPLETED` (restart service on boot).
  Already present: `FOREGROUND_SERVICE`, `POST_NOTIFICATIONS`.
- **First-run flow**: system dialog "Allow background use?" → exemption
  intent (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) → persistent
  notification "Versutus listening" (ongoing, low priority, tap opens app).
- **OEM reality**: Pixel = fine after exemption. Samsung (Device care →
  Never sleeping apps + turn off Adaptive battery for Versutus), Xiaomi
  (Autostart + No restrictions) need a one-time settings walkthrough —
  ship an in-app "Keep listening alive" screen with per-manufacturer steps.
- **What it survives**: Doze idle, app swiped away, screen off for hours.
  **What it doesn't**: phone fully off, no data/airplane mode, Battery saver
  extreme, user force-stop (service stays dead until next launch — show
  "listening paused" state on next open), PC asleep (see §8).

## 8. Failure modes (honest table)

| Condition | Behavior | UX |
|---|---|---|
| Doze idle, exemption granted | socket alive, heartbeat keeps NAT mapping | nothing shown |
| No exemption / OEM kills service | socket dies, no retry succeeds | "Listening paused — fix battery setting" card |
| Phone offline / airplane | backoff to 15s ceiling, stop at 5 attempts, auto-connect resumes on network change | status dot, silent |
| Tailscale down on phone or PC | same as offline; health probe fails | status dot |
| PC asleep / Gate stopped | TCP RST or timeout; same backoff | "Gateway unreachable" (existing copy) |
| Gate restart | 1012 close → immediate reconnect attempt | brief "reconnecting" |
| Missed events during gap | unacked replay on hello (cap 200) + `missed-events` marker if overflow | "3 happened while away" summary, no fake completeness |

FCM's one unreplicable advantage: Google's radio keeps a slot even in deep
Doze with zero exemption. Option A matches it on a Pixel with the exemption,
gets close on Samsung/Xiaomi with the settings dance, and never phones home.

## 9. Security

- Tailnet-only URL (`100.x` / `*.ts.net` from `extra.gatewayHosts`); never
  expose `:8760` on LAN/public without Tailscale. `usesCleartextTraffic`
  stays scoped to tailnet hosts (existing posture).
- Device token per phone, revocable (`pair list` / `device-revoke` flows
  exist). Socket auth = same bearer, verified pre-upgrade.
- No new secret storage: token in SecureStore, never in the service intent
  extras in cleartext (pass a handle, read from SecureStore on the JS side
  and hand the socket URL with an in-memory token over the bridge).

## 10. Verification

- `node --test "__tests__/*.test.mjs"` from `gate/` (new event-socket tests green)
- `npx tsc --noEmit` → 0; `npm run smoke:portal` green; `npm run lint` → 0
- Live: tailnet WS connect → kill app → wait 10 min screen-off → trigger run
  from PC → local notification lands < 5s. Repeat on Battery saver.
- Doze drill: `adb shell dumpsys deviceidle force-idle`, send event, confirm
  delivery; `force-inactive` to recover.
- Kill test: force-stop app → relaunch → `missed-events` replay correct.

## 11. Milestones

1. Gate: event-socket module + tests + manifest ad (~1 session).
2. Gate: fan-out hook + per-device transport pref (small).
3. App: EventSocket class + provider wiring + local notifications (the bulk).
4. Android: native service + config plugin + exemption flow + OEM screen.
5. EAS preview APK → Doze drill → ship.

## 12. Open decisions (yours)

- Persistent notification copy ("Versutus listening" vs run-count live text).
- v1 transports both socket+Expo in parallel, or socket-only from day one?
- Quiet hours enforced server-side (skip send) or client-side (send, no buzz)?
