# 0001 — Approval UX and local notifications

Hermes exposes no remote pending-approval list (`rpc-routes.ts` guidance), and the gateway is a LAN/tailnet process with no webhook or push channel to the phone — so approvals are outbound-only and notifications are local. The app resolves approvals for runs it initiated (`POST /v1/runs/{run_id}/approval`) through an in-app Approve/Deny card, and fires local `expo-notifications` (approval-requested, run-complete, gateway-down) while its connection to the gateway is alive. True remote push (gateway → wss relay → FCM → phone) is deferred behind the Phase D relay server.

## Consequences

- Runs started elsewhere (e.g. from the PC) cannot be approved from the phone until the relay exists — the app only resolves approvals for runs it owns.
- Notifications are best-effort: nothing arrives if the app is backgrounded past the point the connection dies.
