# True push on model final response

**Goal:** When a model delivers its final response, every paired phone gets a real Expo push, for every session on every Versutus Gate profile.

**Architecture:** The Gate is the relay. Pairing is the trust bootstrap: `notifications.*` RPC binds to the Bearer device grant, never a client-supplied device id. The notifier subscribes to Gate lifecycle (chat turn complete, run completed/errored, approval required, routine result) and sends one A5 payload. "Model final response" is a new trigger class on that notifier, not a second listener and not a `finalizeStreamingMessage` local notice.

**Tech stack:** Expo 57 `expo-notifications` (`getExpoPushTokenAsync`, projectId `52545800-300a-4bbc-a2b9-7e412d9c217e`), SecureStore via `src/lib/storage/secure-key-value.ts`, Gate `node:test`, Expo Push API `POST https://exp.host/--/api/v2/push/send` (chunks of 100) plus `.../getReceipts`.

## Global constraints

- `npm run verify` must pass. Gate work ships `node:test` under `gate/__tests__/`.
- Nothing is described as push until the relay in this plan is in the tree. The README scope line stays until the last step.
- A5 data is exactly `{ kind: 'run'|'approval'|'routine', runId?|jobId?, botId? }`. Default bodies are ids-only copy. Rich bodies are per-device opt-in.
- Toggle off by default (A8). Do not flip new pairings on in this sprint.
- Hermes and OpenClaw profiles never register. Gate identity is `kind === 'custom'` (`versutus-gate`).

## File map

**App create:** `src/lib/notifications/push-registration.ts`, `__tests__/push-registration-test.ts`, `__tests__/push-channels-test.ts`, `__tests__/push-connect-hooks-test.ts`

**App modify:** `src/lib/notifications/tap-route.ts`, `src/lib/notifications/local.ts`, `src/app/_layout.tsx`, `src/context/gateway-provider.tsx`, `src/app/gateway/settings.tsx`, `__tests__/notification-tap-route-test.ts`, `README.md` (last), `.gitignore`

**Gate create:** `gate/core/push-tokens.mjs`, `gate/core/push-send.mjs`, `gate/core/push-notifier.mjs`, `gate/core/push-rpc.mjs`, `gate/__tests__/push-tokens.test.mjs`, `gate/__tests__/push-send.test.mjs`, `gate/__tests__/push-notifier.test.mjs`, `gate/__tests__/push-rpc.test.mjs`

**Gate modify:** `gate/core/server.mjs`, `scripts/smoke-live-gateway.mts`

**Not a new handshake.** No new pairing flow, no new capability kind. Methods sit next to `device.list` on `/v1/capabilities/rpc` and are advertised in `rpcMethods`.

## Payload and copy (locked)

| Trigger | When | `data` | Contentless title |
|---|---|---|---|
| `final-response` | Chat/provider turn completed with assistant content | `{ kind: 'reply', sessionId, botId? }` | `{bot or Versutus} finished a reply` |
| `run` | `run.completed` / `run.failed` | `{ kind: 'run', runId }` | `{bot or Versutus} finished a run` / `hit an error` |
| `approval` | `approval.required` | `{ kind: 'approval', runId }` | `Approval required` |
| `routine` | Cron/job session completed (`parseCronSessionId` in `gate/core/cron-view.mjs`) | `{ kind: 'routine', jobId, botId? }` | `{bot or A routine} finished` |

**A chat reply is not a run — reviewed and corrected 2026-09-11.** The first
draft carried a final response as `{ kind: 'run', runId: sessionId }`, which kept
the letter of A5 by putting a *session* id in a field named `runId` and calling a
chat turn a run. Two costs: the tap landed on Activity instead of the
conversation the reply belongs to, and `runId` stopped meaning one thing.
A5 is extended with a fourth kind rather than overloaded — the rule A5 actually
protects is "one payload vocabulary, one response listener," and a new kind
honours that while a reused-but-lying field does not.

`kind: 'reply'` carries `sessionId` (required) and `botId` (optional). A tap
opens that conversation via `openSessionById`
(`src/lib/gateway/session-open-by-id.ts`), not Activity. A cron session fires
`routine` only, never also `final-response`. An agentic run fires `run` only.
Empty turns and `empty_turn` do not notify.

Rich opt-in body: first 80 characters of assistant text or result, same truncation as `notifyApprovalRequired`. Never prompt text unless that opt-in is on.

---

## GATE workstream

### G1. Token store

**Files:** create `gate/core/push-tokens.mjs`. Test: `gate/__tests__/push-tokens.test.mjs`. Persist at `join(gateHome, 'push-tokens.json')`, `mode 0o600`, uncached reads like `DeviceTokenStore`. Add `gate/.push-tokens.json` to `.gitignore` so a mis-pointed home cannot be committed.

Record per `deviceId`: `{ expoPushToken, platform, timezone, enabled: false, richBody: false, botIds: [], quietHours: null | { startMinutes, endMinutes }, updatedAtMs }`. `botIds: []` means every Bot. `quietHours` is local to `timezone`.

- [ ] Write tests: upsert by deviceId, rotate token, remove, missing file is empty, never writes a token into a filename.
- [ ] Implement `upsert(deviceId, patch)`, `get(deviceId)`, `listEnabled()`, `remove(deviceId)`, `removeByToken(expoPushToken)`.
- [ ] Run: `cd gate; node --test __tests__/push-tokens.test.mjs`. Expected: PASS.

### G2. Expo send + receipts

**Files:** create `gate/core/push-send.mjs`. Test: `gate/__tests__/push-send.test.mjs`. Inject `fetch`. No live `exp.host` in CI.

```js
export function createPushSend({ fetchImpl = globalThis.fetch } = {}) {
  return { send(messages), collectReceipts(ticketIds) };
}
```

Each message: `{ to, title, body, data, channelId, sound: 'default' }`. Approvals use `channelId: 'approvals'` and Android high priority. Replies and routines use `model-replies` / `routine-results`. Chunk at 100. After send, collect receipts. Every `DeviceNotRegistered` returns that token so the caller can delete it immediately.

- [ ] Tests: 101 messages become two POSTs; a `DeviceNotRegistered` receipt is returned; a 200 with mixed tickets still inspects every receipt; network failure does not throw into the chat route (return `{ ok: false, error }`).
- [ ] Run: `cd gate; node --test __tests__/push-send.test.mjs`. Expected: PASS.

### G3. Notifier (dedupe, prefs, classify)

**Files:** create `gate/core/push-notifier.mjs`. Test: `gate/__tests__/push-notifier.test.mjs`.

```js
export function createPushNotifier({ tokens, send }) {
  return { notify(event), // event: { trigger, sessionId?, runId?, jobId?, botId?, text? }
           forget(key) };
}
```

`notify` is the only send entrance. Filters: `enabled === true`, bot allowlist, quiet hours in the stored timezone (missing timezone skips the quiet-hours filter, still sends). Dedupe key `${trigger}:${runId||sessionId||jobId}:${state}` with an in-memory set capped at 1000. One push per transition. Then `send`, then `tokens.removeByToken` for every dead token.

- [ ] Tests: disabled device is skipped; quiet hours skip; bot allowlist skip; duplicate `final-response` for the same session is one send; cron session classifies as `routine` not `final-response`; `DeviceNotRegistered` removes the row.
- [ ] Run: `cd gate; node --test __tests__/push-notifier.test.mjs`. Expected: PASS.

### G4. RPC on the paired device grant

**Files:** create `gate/core/push-rpc.mjs`. Modify `gate/core/server.mjs` (method tables ~524-587, RPC dispatch ~2023-2046, `device.revoke` wrapper). Test: `gate/__tests__/push-rpc.test.mjs` against `createGate({ port: 0, gateHome, pushFetch })` like `capabilities-rpc-route.test.mjs`.

Methods (all require `ctx.deviceId` from `deviceTokens.verify`; bootstrap token is 403 `pairing_required`):

- `notifications.register` params `{ expoPushToken, platform, timezone }` (token must match `^ExponentPushToken\[.+\]$`)
- `notifications.deregister` (no params)
- `notifications.preferences.get`
- `notifications.preferences.set` params `{ enabled?, richBody?, botIds?, quietHours? }`
- `notifications.test` sends one contentless test push to the calling device, ignoring `enabled` so smoke can run before the operator flips the toggle

Pass `ctx` as the second handler argument: `await handler(params, { deviceId: deviceGrant?.deviceId ?? null })`. Existing handlers ignore it. Advertise the five names in `rpcMethods`. Wrap `revokeDevice` so a revoke also `pushTokens.remove(deviceId)`.

- [ ] Tests: unauthenticated 401; bootstrap token 403 on register; register keys the row by the grant's deviceId, not `params.deviceId` (send a lying id, assert it is ignored); deregister deletes; preferences default `enabled: false`; revoke drops the push row; methods appear on the manifest.
- [ ] Run: `cd gate; node --test __tests__/push-rpc.test.mjs`. Expected: PASS.

### G5. Subscribe to lifecycle (the final-response trigger)

**Files:** modify `gate/core/server.mjs`.

Chat SSE today aborts the backend on `res.close` (`streamBackendTurn` ~121-127). A killed app would then never produce a final response. Split those: on `res.close`, stop writing to the socket, do **not** `controller.abort()`. Let the backend finish, persist the turn, then `notifier.notify({ trigger: 'final-response', sessionId, botId, text })` if content was delivered. Call the same notify from the non-streaming `/v1/chat/completions` success path (~1951) and from `chatViaProviderService` after a successful completion (`sessionId` if present, else the completion `id`).

**DECIDED 2026-09-11 — a closed app does NOT stop the session, and that is
intended.** A session outliving the app is the behaviour the operator wants: the
work continues on the always-on Gate and the push tells them it finished. So the
`res.close` / `controller.abort()` split applies to **every** client
unconditionally. Do not gate it on push being enabled, and do not treat a
disconnect as a cancel.

The consequence the operator accepts knowingly: an abandoned turn runs to
completion and its tokens are spent whether or not anyone reads the reply. That
is the cost of the feature, not a defect.

Because a disconnect no longer stops anything, **the operator needs a real way to
stop generation** — see G5b. `session.abort` does not exist today (verified
2026-09-11); G5b builds it as a user-facing terminate, not merely as a signal to
the notifier.

Parse teed run-event bytes for `run.completed`, `run.failed`, `approval.required` and notify. If `parseCronSessionId(sessionId)` matches, emit `routine` with that `jobId` and `parseRoutineOwner` botId instead of `final-response`.

### G5b. `session.abort` — true stop/terminate

**Files:** modify `gate/core/server.mjs`, `gate/core/push-rpc.mjs` (method table).
Test: extend `gate/__tests__/push-rpc.test.mjs` and `gate/__tests__/chat-route.test.mjs`.

Today the app's Stop button only aborts the local `AbortController`: it drops the
SSE and the UI stops moving. The backend never knew. Once G5 lands that gap
becomes user-visible and expensive — Stop would look like it worked while tokens
kept being generated and billed. A control that lies about stopping is worse than
no control.

`session.abort` params `{ sessionId }`, on the same paired-device grant as the
`notifications.*` methods (`ctx.deviceId` required; bootstrap token 403).
Behaviour:

- Abort the in-flight backend turn for that session — the same `controller`
  G5 stopped calling on `res.close`. Hold it in a per-session map keyed by
  `sessionId` so a later RPC on a different connection can reach it.
- Mark the turn deliberately cancelled so the notifier sends **no** push for it.
  A user who just pressed Stop must not get "finished a reply" seconds later.
- Idempotent: aborting an already-finished or unknown session is a success with
  `{ aborted: false }`, never an error. The app may fire it after the turn ended.
- Persist whatever partial assistant text was produced, exactly as a completed
  turn would. Stopping is not discarding.

- [ ] Tests: abort mid-turn ends the backend stream; no push is sent for an
      aborted turn; aborting an unknown session returns `{ aborted: false }`;
      unauthenticated 401; bootstrap token 403; the method appears in `rpcMethods`.
- [ ] Run: `cd gate; node --test __tests__/push-rpc.test.mjs __tests__/chat-route.test.mjs`. Expected: PASS.

- [ ] Extend `gate/__tests__/chat-route.test.mjs`: drop the client mid-stream, assert the backend `sendMessage` still resolves and `pushFetch` is called once with `data.kind === 'run'` and `data.runId === sessionId`.
- [ ] Extend `gate/__tests__/backend-run-events.test.mjs`: a completed run POSTs `kind: 'run'`; an `approval.required` frame POSTs `kind: 'approval'`.
- [ ] Empty turn: no push. Duplicate complete: one push.
- [ ] Run those two files plus `push-notifier.test.mjs`. Expected: PASS.

### G6. Live smoke dispatch

**Files:** modify `scripts/smoke-live-gateway.mts`.

- [ ] When the target advertises `notifications.test`, call it with the Gate token. Assert HTTP 200 and a ticket or a structured `{ skipped: 'no-token' }` if this host has no registered device (operator laptop). Do not fail the suite for a missing phone.
- [ ] Run: `npm run smoke:live -- http://127.0.0.1:8760` against a running Gate. Expected: existing checks still PASS; new check PASS or honest skip.

---

## APP workstream

### A1. Tap router accepts A5 `routine` and the new `reply`

**Files:** modify `src/lib/notifications/tap-route.ts`, `__tests__/notification-tap-route-test.ts`.

Today `routeForTap` handles three kinds: `'routine-due'`
(`ROUTINE_NOTICE_DATA_KIND`, local scheduled notices), `'run'`
(`RUN_NOTICE_DATA_KIND`), and `'weekly-report'`. Two additions:

1. **`kind: 'routine'`** — the A5 push spelling. Local notices keep
   `'routine-due'`; both require `jobId` and `botId`.
2. **`kind: 'reply'`** — new. Export `REPLY_NOTICE_DATA_KIND = 'reply'` beside
   `RUN_NOTICE_DATA_KIND`. Extend the `TapRoute` union with
   `{ kind: 'reply'; sessionId: string; botId?: string }`. `sessionId` is
   required; a reply without one returns null and falls back to Activity, per
   the module's existing "never guess an id" rule. `botId` is optional and rides
   along when present.

The response listener in `src/app/_layout.tsx` routes `reply` through
`openSessionById` (`src/lib/gateway/session-open-by-id.ts`) so the tap opens the
conversation. Keep Activity as the fallback for anything unrecognized — that
behaviour is unchanged.

- [ ] Tests: `kind: 'routine'` with both ids routes; half-shaped `routine` is null; existing `routine-due` still routes; run payload with extra `botId` still `{ kind: 'run', runId }`.
- [ ] Tests: `kind: 'reply'` with `sessionId` routes and carries `botId` when given; `reply` without `sessionId` is null; `reply` with an empty-string `sessionId` is null.
- [ ] Run: `npx jest __tests__/notification-tap-route-test.ts --runInBand`. Expected: PASS.

### A2. Push registration module

**Files:** create `src/lib/notifications/push-registration.ts`. Test: `__tests__/push-registration-test.ts`. Mock `expo-notifications`, `expo-constants`, `secureKeyValueStorage`.

```ts
const STORE_KEY = 'versutus:expo-push-token:v1';
const PROJECT_ID = '52545800-300a-4bbc-a2b9-7e412d9c217e';

export async function loadStoredExpoPushToken(): Promise<string | null>;
export async function obtainExpoPushToken(): Promise<string | null>;
// getExpoPushTokenAsync({ projectId: Constants.easConfig?.projectId ?? PROJECT_ID })
// persist on change; return null on web, missing permission, or throw

export async function registerWithGate(rpc: Rpc, token: string): Promise<void>;
export async function deregisterWithGate(rpc: Rpc): Promise<void>;
export async function syncPushRegistration(rpc: Rpc): Promise<void>;
// obtain, skip if null, registerWithGate
```

`Rpc` is `{ rpcRequest(method, params?): Promise<unknown> }`, the same seam as `client.rpcRequest`.

- [ ] Tests: register POSTs `notifications.register` with token/platform/timezone; a rotated token is written to SecureStore then registered; web returns null and never RPCs; `getExpoPushTokenAsync` throw is null, never thrown to connect; deregister calls `notifications.deregister`.
- [ ] Run: `npx jest __tests__/push-registration-test.ts --runInBand`. Expected: PASS.

### A3. Android channels + foreground handler

**Files:** modify `src/lib/notifications/local.ts` (next to `RUN_PROGRESS_CHANNEL_ID`), `src/app/_layout.tsx` (the mount effect that already calls `registerNotificationCategories`).

Create once per process:

- `approvals` at `AndroidImportance.HIGH`
- `model-replies` at `AndroidImportance.DEFAULT`
- `routine-results` at `AndroidImportance.DEFAULT`

Set `Notifications.setNotificationHandler` so a notice arriving while `AppState.currentState === 'active'` is not presented (the operator already has the stream). Background and killed still present. This is display policy, not a second router. Taps still go through the existing `addNotificationResponseReceivedListener`.

- [ ] Create `__tests__/push-channels-test.ts`: assert the three `setNotificationChannelAsync` names and importances, and that `src/app/_layout.tsx` calls the ensure function from the same mount effect as `registerNotificationCategories`.
- [ ] Run: `npx jest __tests__/push-channels-test.ts --runInBand`. Expected: PASS.

### A4. Register on connect, drop on profile removal, Stop still cancels

**Files:** modify `src/context/gateway-provider.tsx`.

After a successful `client.connect()` (~1398) and on later `onHealthCheck` reconnects, if `activeGateway.kind === 'custom'`, `void syncPushRegistration(client)`. Never await it in a way that can stall connect. On `deleteGateway`, if `clientRef` is still that profile, `await deregisterWithGate(client)` inside a try, then disconnect as today.

Stop: today's `abortController.abort()` only drops the SSE, and G5 no longer treats that as model-cancel. When the operator stops a send, also call `client.rpcRequest('session.abort', { sessionId })` if `sessionIdRef` is set, best-effort. That is the explicit abort the notifier honors.

**Depends on G5b**, which builds `session.abort`. Do not implement this step
before that RPC exists.

### A4b. Stop means stop — the user-facing terminate

**Files:** modify `src/components/chat/chat-screen.tsx` (the existing stop
affordance) and `src/context/gateway-provider.tsx`. Test:
`__tests__/session-abort-test.ts`.

G5 makes a closed app keep generating on purpose. That makes the Stop control
load-bearing: it is now the **only** way an operator halts token spend. It must
therefore do what it says.

- Stop calls `session.abort` on the Gate first, then tears down the local stream.
  Order matters: abort the source, then stop listening. Reversing it leaves a
  window where the UI is idle and the backend is still generating.
- The control reads **Stop** while a turn is streaming. It is enabled the moment
  a send starts and stays enabled until the turn is terminal.
- On success, the partial reply stays in the transcript, marked stopped — not
  deleted. The operator stopped it; they should still see what they paid for.
- If the abort RPC fails or the gateway is unreachable, say so plainly
  ("Couldn't reach the gateway — the model may still be running") and do not
  pretend the turn was cancelled. Fail closed on the claim, not on the attempt.
- A gateway that does not advertise `session.abort` (an older Gate, or Hermes)
  keeps today's local-only behaviour, and the control says it only stops
  following the reply. Capability-gated, the established pattern — never a Stop
  button that silently does less than it claims.

- [ ] Tests: stop calls `session.abort` with the live sessionId before teardown;
      a failed abort surfaces the honest message and leaves the turn marked
      running; a gateway without the method uses local-only teardown and the
      copy changes; partial text survives a stop.
- [ ] Run: `npx jest __tests__/session-abort-test.ts --runInBand` and `npx tsc --noEmit`. Expected: PASS.
- [ ] Manual: send a long turn, press Stop, confirm generation actually ends
      (Gate logs show the backend turn closed) and that no push arrives afterward.

- [ ] Create `__tests__/push-connect-hooks-test.ts` that reads `src/context/gateway-provider.tsx` and asserts `syncPushRegistration` is called after connect, `deregisterWithGate` is inside `deleteGateway`, and the stop path contains `session.abort`.
- [ ] Run: `npx jest __tests__/push-connect-hooks-test.ts --runInBand` and `npx tsc --noEmit`. Expected: PASS.

### A5. Preferences pane (toggle off by default)

**Files:** modify `src/app/gateway/settings.tsx`. Prefs live on the Gate (`notifications.preferences.*`), not `app-settings.ts`.

Show the section only when `activeGateway?.kind === 'custom'` and status is `connected`. Controls: Enable relay notifications (default off), Include reply text (rich body, default off), Quiet hours start/end, and a Bot multi-select from `listBots` (empty means every Bot). Load via `gatewayRequest('notifications.preferences.get')`. Each change calls `notifications.preferences.set` with that field. Copy must not say "push" until README is updated in A6. Use "Notify this phone when a model finishes, even if Versutus is closed."

- [ ] Manual on a dev build: pane hidden on a Hermes profile, visible on a Gate profile, toggle starts off, flipping it survives a reconnect (`preferences.get` returns the new value).

### A6. README, the day the relay is in the tree and not before

**Files:** modify `README.md` line 145.

Replace "True push, background keepalive, and public-internet relay require a companion server. Not invented here. Local notifications fire only while the app's gateway connection is alive." with: the Versutus Gate is the relay; Expo Push / APNs / FCM carry the envelope; model credentials never leave the host; default payloads are ids only. Keep the TLS-fingerprint honesty style.

- [ ] Do this last, in the same change that contains G5 and A2. `npm run verify`.

---

## Operator-held credentials (cannot be automated)

These are A1. CI and `node:test` must keep using a stubbed `pushFetch`. None of this belongs in the repo.

1. **APNs key** for bundle `com.versutus.app`, uploaded to EAS project `52545800-300a-4bbc-a2b9-7e412d9c217e`. Physical iPhone required.
2. **FCM** `google-services.json` plus the Firebase service account, uploaded via EAS for `com.versutus.app`. Expo Go on Android cannot receive these; this repo already ships dev builds (`npm run android` / `eas build`).
3. After credentials land, a **new native build** is required before `getExpoPushTokenAsync` succeeds on device. Unit tests never call it for real.

Without these, G1-G5 and A1-A5 still merge green. Real delivery is the final verification below.

---

## Final verification

1. `npm run verify` green (config, `tsc --noEmit`, lint, Jest coverage ratchet, `npm run test:gate`).
2. `cd gate; node --test __tests__/push-tokens.test.mjs __tests__/push-send.test.mjs __tests__/push-notifier.test.mjs __tests__/push-rpc.test.mjs` green.
3. `npm run smoke:live -- http://127.0.0.1:8760` green, including `notifications.test` skip-or-send.
4. On a **dev-build phone** paired to a Gate, with APNs/FCM on the EAS project: enable the settings toggle. Send a chat turn. Kill the app before the model finishes. Assert one tray notice, contentless, `data.kind === 'reply'` carrying `sessionId`. **Tap opens that conversation, not Activity.** Repeat with the app force-stopped before the send returns.
   - [ ] Confirm the turn **completed** on the Gate after the app died — that is the intended behaviour, not a leak.
8. **Stop actually stops.** Send a long turn. Press Stop. Confirm on the Gate that
   the backend turn ended (not merely that the app stopped rendering), that the
   partial reply is still in the transcript, and that **no push arrives** for the
   stopped turn. Then repeat with the gateway stopped mid-turn: the app must say
   it could not confirm the stop rather than claim the turn was cancelled.
5. Enable rich body, send again, assert the body is truncated assistant text and does not include the prompt.
6. Revoke the device from another session (`device.revoke` or `cli.mjs pair revoke`). Send again. Assert no push, and the push-tokens file no longer has that deviceId.
7. Confirm README no longer says push is "not invented here", and that no earlier commit on the branch described it as push before G5 existed.

If step 4 cannot run because credentials are missing, say that. Do not call the feature shipped.
