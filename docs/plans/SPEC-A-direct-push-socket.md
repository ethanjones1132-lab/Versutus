# Spec A — Direct Push Socket (no third parties)

Status: spec. No code. Builds on Task C (`82e34a1`).

## Goal

Run/approval/final-response/routine events reach the phone over a
persistent WebSocket from the app to the Gate, entirely inside the
tailnet. No Expo push service, no FCM, no Firebase. The Expo/FCM path
stays in the tree as a dormant fallback, switched per device.

## Non-goals

- Killing the Expo/FCM code. It stays, gated by a per-device transport
  flag (`direct` | `expo` | `both`, default `direct` once this ships).
- iOS. Android only. The foreground-service model does not port.
- Guaranteed delivery to a fully dead radio. If the phone has no data,
  nothing arrives until it wakes — same as any non-FCM transport.
  Accepted explicitly (see Alternatives).

## Architecture

```
Gate (:8760, 127.0.0.1 + tailnet IP)          Phone (ethans-a54)
─────────────────────────────────            ──────────────────
onRunEvent ──► push fan-out ──┬──► expo sink (existing, dormant)
                              └──► socket sink (NEW) ──► WS /v1/push-stream
                                     │                        │
                              per-device queue          ForegroundService
                              (cap 50, drop-oldest)     + WS client + backoff
```

The socket sink reuses everything Task C built: event taxonomy
(`run.completed`, `run.failed`, `approval.required`, `final-response`,
`routine`), per-device preference filtering (quiet hours, richBody,
per-bot), tap-routing payloads. Only the last-mile transport is new.

## Gate side

1. **Endpoint** `GET /v1/push-stream` (authenticated like the rest of
   `/v1/*`: paired-device bearer). Upgrades to WebSocket. Query param
   `?transport=direct` distinguishes from future uses.
2. **Handshake**: on connect the server sends `{"type":"hello",
   "serverTime":…, "lastEventId":…}`. Client replies `{"type":"resume",
   "lastEventId":…}` or `{"type":"hello-ack"}` for a fresh start.
3. **Fan-out**: extend the push fan-out (the thing that currently calls
   the Expo send path) with a socket sink. For each connected device
   with `transport ∈ {direct, both}` and passing preference filter,
   serialize the same payload the Expo path would send and push it on
   the socket with a monotonically increasing `eventId`.
4. **Offline queue**: per paired-device in-memory ring, cap 50,
   drop-oldest with a `{"type":"gap"}` marker when drops happened so
   the client knows it missed something and can show "N events missed,
   open app to sync" rather than silent loss. Queue drains on
   (re)connect after `resume`. No persistence across Gate restarts —
   accepted (Gate restarts are rare, supervised, and announced; a
   `gap` marker covers it).
5. **Heartbeat**: server ping every 25s, client pong. Either side
   closes after 2 missed beats. Keep-alive interval must sit under
   NAT/conntrack timeouts on Tailscale (generous, but 25s is cheap).
6. **Backpressure**: if a socket's send buffer exceeds 256KB (client
   not reading), drop the connection and let the client resume. Never
   let a wedged phone stall the fan-out loop — every sink call is
   non-blocking / fire-and-forget, same discipline as the existing
   `onRunEvent` observer rule.

Touchpoints (verify during implementation):
- `gate/core/server.mjs` — route + fan-out + queue.
- `gate/core/push-notifier.mjs` — reuse `messageFor`, preference
  filter, tap payload builders; add transport selection.
- `gate/core/push-tokens.mjs` — store per-device `transport` +`
  lastEventId` alongside the Expo token row (nullable token = direct
  device, no schema break).

## App side

1. **Foreground service** (`PushListenerService`, native module or
   Expo dev-client module): persistent notification, e.g. "Versutus
   listening · Gate reachable". Notification channel: low importance,
   silent, non-dismissible while enabled. Tapping it opens the app.
2. **WS client** in the service: connects to
   `ws://<gate-tailnet-ip>:8760/v1/push-stream?transport=direct`
   with the paired-device bearer. Gate address comes from the saved
   gateway record (the Tailscale IP, not 127.0.0.1).
3. **Reconnect/backoff**: on drop, retry with jittered exponential
   backoff (1s → 2 → 4 … cap 5min), reset on success. On network-change
   broadcast, reconnect immediately. On boot, `BOOT_COMPLETED`
   receiver restarts the service (with the user's opt-in).
4. **On message**: parse payload, hand to the existing notification
   pipeline (`ensurePushChannels`, same channel IDs, same tap-route
   intents as the Expo path) so a direct notification and an Expo
   notification are indistinguishable. Persist `lastEventId`.
5. **Settings UI** (extends the Notifications tab from Task C):
   - Transport row: Direct / Expo / Both (Expo options hidden with a
     "needs Firebase" note until FCM is configured).
   - Direct status row: Connected / Reconnecting (retry in Ns) /
     Disabled, plus last-event time. This is the user's health
     signal — no silent dead sockets.
   - Foreground-service toggle (the permission moment) + Doze
     exemption prompt (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`,
     asked from the toggle, never at launch — same rule as the
     notification permission).
6. **OEM hardening**: on first enable, if manufacturer is on the
   aggressive-killer list (Samsung, Xiaomi, Oppo, Vivo, OnePlus),
   show the "lock this app in recents / allow background activity"
   guidance card. Not code — copy + a link.

## Message protocol (v1)

All frames JSON. Server → client:

```json
{ "type": "hello", "serverTime": 1757…, "lastEventId": 412 }
{ "type": "push", "eventId": 413, "kind": "approval.required",
  "title": "…", "body": "…", "data": { "tap": { … } } }
{ "type": "gap", "dropped": 3, "resumeFrom": 410 }
{ "type": "ping" }
```

Client → server:

```json
{ "type": "hello-ack" }
{ "type": "resume", "lastEventId": 412 }
{ "type": "pong" }
```

`kind` values reuse the Task C taxonomy verbatim. `data.tap` reuses
the existing tap-routing shape so zero client routing changes.

## Security

- Same bearer auth as `/v1/*` over the existing TLS posture of the
  Gate endpoint. No new auth scheme, no unauthenticated listeners.
- The socket speaks only to the paired Gate IP recorded at pair
  time; on gateway-record change, drop and reconnect to the new one.
- No secrets in the persistent notification, no bodies in logs
  (log kinds + eventIds only).

## Battery / Doze posture

- WS + 25s heartbeat ≈ negligible radio cost on Wi-Fi / Tailscale;
  cellular idle is the worst case and still small vs. any polling.
- Doze: with the battery exemption granted, heartbeats survive. Without
  it, Doze batches network in maintenance windows — messages arrive
  late, `gap` markers stay honest, status row shows the truth.
- If the user denies the exemption, say so in the status row
  ("Direct may delay in Doze — grant exemption") rather than failing.

## Testing / acceptance

- Gate unit: fan-out to fake socket, queue cap + gap marker, resume
  replay order, slow-consumer drop, heartbeat timeout. (Node `--test`,
  same as the push suite.)
- App unit (jest): resume persistence, backoff sequence, message →
  notification-pipeline handoff shape.
- Live: release APK, kill app, trigger routine + approval from the
  Gate, confirm tray notice + tap route with only the tailnet up
  (phone on cellular, Wi-Fi off — proves no LAN dependence).
- Kill test: force-stop the app, confirm the service restarts (or the
  status row honestly reports otherwise on that OEM), confirm no
  duplicate notices when both app-foreground polling and socket are
  live (dedupe by eventId — client keeps a 200-id seen-set).

## Rollout

1. Gate socket sink + protocol, tests green, Gate service restart.
2. App service + client + Settings rows, release APK, Taildrop.
3. Live acceptance (above). Default transport flips to `direct`.
4. Expo/FCM stays dormant until Firebase items land, then becomes
   the `both` option — belt and suspenders, user-chosen.

## Alternatives considered

- **UnifiedPush + self-hosted ntfy**: same no-Google property, but
  adds a server component and a second app on the phone. Revisit if
  we ever need push to devices outside the tailnet without the app
  installed; until then the direct socket is fewer moving parts.
- **FCM-direct (no Expo)**: still Google. Rejected on the stated
  constraint.
- **Polling**: worse battery, worse latency, no reason to exist when
  the Gate can push down an open socket.
