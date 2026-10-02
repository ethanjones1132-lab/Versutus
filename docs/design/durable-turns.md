# Durable turns - the PC keeps working, the phone catches up

Status: design for round 4 (2026-10-02). Source: the operator's requirement, in their words -
"a disconnect from phone to PC does not interrupt anything except data transmission" - and the
round-4 durability scan (`%TEMP%\vfix\scans4\dur.verified.md`, findings GATE-1..4, APP-1..3, V-1, V-2, VOICE-1/2).

## 1. What is wrong today (measured / traced)

| # | Fact | Where |
|---|---|---|
| 1 | A named chat turn survives a phone disconnect ("detach"), but only until `10 min - (time it already ran attached)`, then it is aborted silently: no push, no frame, no record. An attached turn has no bound at all. | `gate/core/server.mjs` `streamBackendTurn`, `DEFAULT_DETACHED_TURN_MAX_MS` |
| 2 | The 8-turn detach limit is global; the 9th disconnect is read as a Stop and aborts that turn. | `DETACHED_TURN_LIMIT` |
| 3 | Chat turns have NO journal. While detached the stream is dropped (`clientDisconnected` suppresses writes), `inFlightTurns` is an in-memory `Map`, the reply is only ever delivered as one best-effort push (errors swallowed, body usually empty, text capped at 2000). There is no `/v1/turns` route. | `streamBackendTurn`, `notifyPush` |
| 4 | `gate.close()` (every `service restart`/deploy) aborts every in-flight turn, then the attached stream ends with `[DONE]` and no error: the phone finalises a HALF answer as a finished reply (tool cards flipped to "complete"), nothing is recorded, nothing pushed. | `close()` |
| 5 | Hermes interrupts the agent when its session SSE client disconnects (`agent.interrupt("SSE client disconnected")`) - so any Gate-to-Hermes drop kills agent work. (Not fixed this round: Hermes `/v1/runs` is the durable path; see section 7.) | Hermes `api_server.py` |
| 6 | The phone's re-attach is a 3-timer ladder (2/8/20 s) armed only on a connection ERROR; a phone that was merely backgrounded, locked or killed never arms it; the foreground edge reconciles once. | `gateway-provider.tsx` |
| 7 | The offline outbox re-sends a queued line with a NEW turn id (no idempotency), so an accepted-but-unseen turn runs twice; and it deletes a row whose send failed. | `session-persistence.ts`, `gateway-provider.tsx` flush |
| 8 | Chat turns routed to the Gate's OWN providers (no backend/Bot) are not detachable at all. | `dispatchChat` path |

## 2. Principle

A turn belongs to the Gate, not to the HTTP request that started it. The request is one *subscriber*.
Every event of a turn is written to a journal on the Gate as it happens; any subscriber (the original
request, a later request after a reconnect, another device) reads the journal from a sequence number and then
follows it live. Nothing but an explicit Stop, the turn's own end, or a real stall ends a turn. A Gate restart
is an honest, recorded end ("interrupted"), never a silent success.

## 3. The Gate contract (what Gate and app are both built against)

### 3.1 Turn identity
The phone names every turn: header `X-Versutus-Turn-Id: <id>` (pattern already enforced by `TURN_ID_PATTERN`).
A turn is keyed `callerId + turnId`; `callerId` is the authenticated device (existing).

### 3.2 Journal
Per turn: a meta record and an append-only event log, persisted under `<gateHome>/turns/` (one JSONL file per
turn, atomic meta, appended events, coalesced writes). Meta:

```json
{ "turnId": "t-...", "sessionId": "api_...", "backendId": "hermes-local", "botId": null, "model": "kilo/x",
  "status": "running | done | failed | cancelled | interrupted",
  "startedAt": 1790900000000, "updatedAt": 1790900001234, "finishedAt": null,
  "lastSeq": 42, "error": null, "reason": null, "textLength": 1234 }
```

`status` meanings: `done` (assistant content delivered), `failed` (backend/model error, with `error`),
`cancelled` (the phone's Stop), `interrupted` (the Gate itself ended it: restart, or a stall - `reason`
is `gate_restart` | `stalled` | `max_age`).

Events: one line per frame exactly as it is written to the SSE stream (`{ "seq": n, "t": ms, "data": "<the data: payload>" }`),
plus a terminal event. A replay re-sends the same `data:` payloads, so the app's existing stream parser reads
a replay with no new code. `data` is capped per turn (default 2 MB of events; beyond it the oldest *delta* events
are dropped and the meta carries `droppedEvents`, but the assembled final text is kept separately, up to 256 KB).
Retention: 300 turns and 7 days, oldest finished first; running turns are never pruned.

### 3.3 Routes (all caller-scoped: a device sees only its own turns)

- `GET /v1/turns?sessionId=<id>&status=running|done|failed|cancelled|interrupted&limit=50` ->
  `{ "object": "list", "data": [meta...] }`, newest first. This is how a reopened app learns what is still running.
- `GET /v1/turns/{turnId}` -> `{ ...meta, "text": "<assembled reply so far / final>" }`; 404 `unknown_turn`.
- `GET /v1/turns/{turnId}/events?after=<seq>` -> `text/event-stream`. Replays every event with `seq > after`
  (each frame prefixed `id: <seq>`), then follows live while the turn runs, then sends `data: [DONE]` and ends.
  A finished turn replays and ends at once. Keepalive as for chat streams. 404 `unknown_turn`.
- `POST /v1/chat/cancel` (existing) also records `cancelled` in the journal.
- `POST /v1/chat/completions` with a turn id the caller already used: NOT a second turn. It answers `200` as an
  `events` replay-then-follow of the existing turn (`X-Versutus-Turn-Resumed: 1`), so a retry of an accepted send is
  exactly-once. (Replaces the old `409 turn_id_in_use` for the same caller; a different caller's id is independent.)

### 3.4 Detach policy
- Closing the phone's request NEVER cancels a named turn and never starts a wall-clock countdown.
- A detached turn ends only when: it finishes; the phone calls Stop; or it **stalls** - no event for
  `detachedStallMs` (default 30 min; tools that run long emit progress, and a running tool part suspends the clock
  for backends that report it) - or reaches the safety ceiling `detachedTurnMaxMs` (default 12 h). Both are recorded
  as `interrupted` with `reason` and produce a push.
- The count limit becomes a runaway guard only (default 256 per caller): over it a NEW detach is refused with a log
  line and the turn keeps streaming attached; it never aborts a running turn.

### 3.5 Gate restart
- `close()` ends every attached stream with an `error` frame `{ "error": { "code": "gate_restart", "message": "The Gate restarted while this turn was running." } }`
  BEFORE aborting, and journals `interrupted` / `gate_restart`.
- On start, every turn the journal still shows as `running` is closed as `interrupted` / `gate_restart` (the process that
  owned it is gone), so the app's next `GET /v1/turns` tells the truth.

### 3.6 Completion delivery
When a detached turn finishes, the push carries the journal's assembled text (not the 2000-char sample) and a
`turnId`; delivery failures are logged (not swallowed). The reply is also fetchable by `GET /v1/turns/{id}` until retention.

## 4. The app contract

1. **Idempotent sends**: a send mints its `turnId` ONCE, stores it on the outbox row (and on the in-flight message), and
   every retry/resend of that line reuses it. The outbox row is removed only after the Gate has accepted the turn
   (a successful stream start or a `Resumed` replay), never because the call returned.
2. **Re-attach on return**: on foreground, on reconnect and on opening a thread, the app asks `GET /v1/turns?sessionId=<current>&status=running`.
   For a running turn it rebuilds the streaming bubble from `GET /v1/turns/{id}/events?after=0` (or from its last seen `seq`),
   keyed by the TURN ID (not a text-prefix match), and keeps following until `[DONE]`. For a finished turn it settles the bubble
   from `GET /v1/turns/{id}`. For `interrupted`/`failed` it shows the honest reason ("The Gate restarted while this was running" /
   the error) with a Retry that reuses nothing.
3. **No time limit on the app's patience**: while the turn status is `running` the app keeps re-attaching (backing off up to ~30 s),
   not 3 timers over 20 s.
4. **Visible**: a thread with a running turn shows "Running on your PC" in the session list and the thread header; the Activity
   list shows running turns; completion/interruption raises the existing notification.
5. A queued line whose send returned a connection error stays owed (and keeps its turn id).

## 5. Voice calls (design, built in the voice packages)
A call's turn is an ordinary durable turn (same journal, `turnId` = the call's turn id). A socket drop never aborts it: the call keeps its
state for a resume window (90 s), control frames (`reply`, `final`, `turn`, `speech`) are buffered like audio is, the phone resumes with
its `voiceSessionId`, and a call that is not resumed ends WITHOUT cancelling the turn: the reply lands in the chat thread (history +
push). Details in the voice briefs.

## 6. Acceptance (what "done" looks like on the phone)
1. Start an agent turn that takes minutes; lock the phone / airplane mode for 5+ minutes; the PC keeps working (check `GET /v1/turns/<id>`).
2. Unlock: the thread shows the turn still running (or finished) with its progress, no "Connection lost", no duplicate bubble.
3. Kill the app mid-turn, reopen: same.
4. Restart the Gate mid-turn: the thread says honestly the Gate restarted; nothing shows as a finished reply that was cut off.
5. Send a message offline, kill the app, reconnect: it is sent once.

## 7. Out of scope this round (documented, not forgotten)
- Surviving a Gate restart for Hermes agent work: Hermes interrupts a turn when its session SSE client disconnects. The durable
  Hermes primitive is `POST /v1/runs` (session-bound, events at `/v1/runs/{id}/events`, status/output readable after the stream dies,
  but marked `interrupted` if Hermes itself restarts). Moving chat turns onto it is the next step and needs its own design (approvals,
  history writes, model pinning).
- Turns routed to the Gate's own providers (item 8 above) get the same journal in a follow-up package.
