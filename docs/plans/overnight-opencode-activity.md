# OpenCode Activity — investigation draft and plan

Status: **draft for human review. Source-only investigation. Nothing reproduced.**
Worktree: `C:\rh-wt\20261101-0050-versutus-vs-overnight-20261101-ha`, HEAD `b258652`
("VS-OVERNIGHT-20261101 markdown: Harden markdown list and fenced-code parsing").
Author: unattended Ralph iteration (`activity_diagnosis`), one pass, no device and no live Gate.

Labels used throughout:

- **[SOURCE]** — read in this worktree at the cited `file:line`; the statement is about code, not about a running system.
- **[INFERENCE]** — a conclusion drawn from two or more [SOURCE] facts. Still not a measurement.
- **[HYPOTHESIS]** — plausible cause; needs the stated measurement to become fact.
- **[UNVERIFIED]** — a claim from the report, or something this tree cannot confirm.
- **[NOT RUN]** — a check a human must run; I did not run it, and no result is claimed.

> This document deliberately does **not** say the reported problem was reproduced, and it does **not**
> report device FPS, timings, HTTP statuses from a live machine, or the contents of any real archive.
> The Ralph check for this step only proves the word "Evidence" appears below; it proves nothing about
> the diagnosis.

---

## 1. The request as received

> "OpenCode Activity reportedly broken; trace run creation, events, archive and Activity rendering,
> compare Hermes paths, and propose concrete regression coverage and live checks. Recent OpenCode 2.x
> dialect and VS-020 are unverified suspects."

Two things about the request itself:

- "Activity" names more than one surface in this app (Section 2). A report that says only
  "Activity" cannot be answered until the reporter says which one, because one of them is
  Hermes-only **by design** and the other is the CLI-environment run launcher.
- `VS-020` is real and already closed at this HEAD: it is the Gate's "single writer per run"
  archive issue, documented in `gate/__tests__/backend-run-streams-single-writer.test.mjs:9-27` and
  fixed by `claimLive` plus the bounded completed-run memory
  (`gate/core/cli-environments/backend-run-streams.mjs:91-128`, `:242-245`). **[SOURCE]** The fix and
  its regression test are present; the test was not executed in this step (the step's check is the
  document grep only). So VS-020 is not an open suspect — a straggling relay in the same process can
  no longer append a second copy to a marked archive.

---

## 2. "Activity" is more than one surface, and only one of them can ever show an OpenCode run

**[SOURCE]**

1. The Activity **tab** — `src/app/(tabs)/activity.tsx` — is the scheduled-work view: a day glance
   (`ActivityGlance`, `activity.tsx:251-257`), pending approvals (`:281-293`), a four-row "Runs"
   preview (`:297-300` → `src/components/activity/recent-runs.tsx`), cron jobs (`:304`), local
   approval decisions (`:310-347`) and the gateway roster (`:353-369`).
   Its run rows come from `activityRunsForActiveGateway`, which is the **provider's device-local,
   persisted list**, not a gateway read (`src/context/gateway-provider.tsx:1472-1474`,
   `src/lib/gateway/session-persistence.ts:308-330`, cap `ACTIVITY_RUNS_PERSIST_CAP = 40` at
   `session-persistence.ts:13`).
2. The Runs **screen** — `src/app/runs.tsx` — is where a run is started, stopped, replayed and
   retried (`runs.tsx:188-259`, `:579-619`, `AgenticRunSheet` at `:815-820`). It reads the *same*
   provider list (`:169-179`), so both surfaces show "runs this phone started", not "runs the gate
   knows about".
3. The CLI-environment **run launcher** — `src/components/gateway/environment-run-launcher.tsx`,
   rendered only from `src/components/gateway/environments-section.tsx:184`, which is rendered only
   by `src/app/gateway/setup.tsx:106` — is a third, differently-shaped run surface
   (`/v1/environments/{id}/runs*`, `src/lib/gateway/environment-client.ts:261-275`).

**[INFERENCE]** An "OpenCode Activity" report is one of:

- (a) the Activity tab / Runs screen while an OpenCode environment is the selected backend — the
  surfaces are hidden or misleading (Section 4, H1–H2);
- (b) the Gateway-setup run launcher on an OpenCode environment — a different pipeline
  (`environment-run-view.ts`, `supervisor.mjs`) with its own known incremental-fold issue that is
  **out of this step's scope** (it is the `fold_cache` plan step);
- (c) a cross-device expectation — "my run started on the desktop/CLI is not in Activity" — which is
  expected behaviour today (Section 4, H4).

The rest of this draft covers (a) in depth and says where (b) and (c) diverge.

---

## Evidence

All line references were opened in this worktree during this iteration. No live call was made.

### 3.1 Run creation: app → Gate → CLI environment

**[SOURCE]**

- The app's client for a Gate is `ManifestClient` (`src/lib/portal/adapters.ts:301-304`): a
  `custom` profile **with** `manifest.endpoints.health` gets `ManifestClient`; only a bare
  Hermes/custom-without-manifest profile gets `HermesGatewayClient`
  (`src/lib/gateway/client.ts:126`, chosen at `adapters.ts:305-309`).
- `ManifestClient.startRun` (`src/lib/gateway/manifest-client.ts:1196-1205`) **requires the
  manifest-wide `endpoints.runs`** (`requireRunsEndpoint`, `:1264-1272`), and scopes the request with
  `withScope` (`:677-679`): `?bot=<id>` when a Bot is selected, else `?backendId=<id>` when an
  environment is selected (`:644-657`), else unpinned.
- `ManifestClient` also carries `getRunStatus` (`:1207-1213`), `streamRunEvents` (`:1215-1251`),
  `resolveApproval` (`:1253-1262`) and `stopRun` (`:1274-1286`). Its run endpoint templates come
  from the manifest (`endpoints.runStatus/runEvents/runApproval/runStop`), built by
  `gate/core/manifest.mjs:117-125`.
- The Gate's manifest advertises those endpoints **iff some backend lists `runs`**
  (`gate/core/manifest.mjs:74-75`, `:117-125`) and advertises the `runs`/`approvals` capabilities on
  the same condition (`:149`). Backend capability lists come from the adapters
  (`gate/core/cli-environments/backend-manager.mjs:140`).
- Hermes is the only adapter that lists `runs`:
  `gate/core/cli-environments/adapters/hermes.mjs:93`
  (`['chat','tools','mcp','sessions','models','runs','skills','diagnostics','cron','bots']`), and the
  Hermes backend implements the lifecycle at `backends/hermes.mjs:466` (`startRun`), `:488`
  (`getRunStatus`), `:492` (`stopRun`), `:504` (`runEvents`), `:518` (`replyApproval`).
- OpenCode does **not** list `runs`: `gate/core/cli-environments/adapters/opencode.mjs:9`
  (`['acp','run-json','mcp','sessions','tools','models','bots']`). The OpenCode backend has no
  `startRun`, `getRunStatus`, `stopRun` or `runEvents`; the only approval-shaped method is
  `replyApproval(sessionId, requestId, reply)` at `backends/opencode.mjs:1447-1461`, a **different
  signature** from the run-approval contract the Gate calls with
  `(runId, { approved, feedback })` (`gate/core/server.mjs:3396-3401`).
- Gate-side start route: `POST /v1/runs` (`gate/core/server.mjs:3190-3216`) resolves a backend
  through `resolveRunBackend` (`:3086-3128`). With an explicit `?backendId=` it calls
  `resolveBackend` and answers **501 `runs_unsupported`** when that backend has no `startRun`
  (`:3105-3115`). With a `?bot=`, it resolves the Bot's conversation backend and answers **501
  `backend_unsupported`** via `requireBackendMethod` (`:2750-2755`, called at `:3102`). With no
  scope at all it picks the first backend whose `startRun` is a function, else 501
  `runs_unsupported` (`:3117-3127`).
- Status/stop/approval/events routes: `:3411-3427`, `:3372-3387`, `:3389-3409`, `:3218-3370`.
  There is **no list-runs route** for `/v1/runs`; the route allowlist at `:740-745` and the gateway
  route table at `:2601-2603` name only start/status/events/stop/approval. `GET
  /v1/environments/{id}/runs` (`:4111-4124`) lists *CLI-environment* runs, a different namespace.

**[INFERENCE]** On a Gate where OpenCode is the pinned backend, a run start cannot succeed: the
Gate answers 501 before any backend work happens. On a Gate where OpenCode is attached but not
pinned, `POST /v1/runs` **can** succeed (Hermes takes it), so "OpenCode is installed" does not by
itself make runs broken. The distinguishing question is *what is pinned*: Bot scope, backend scope,
or neither.

### 3.2 Events and archive

**[SOURCE]**

- Live path: `executeRun` starts the run, then loops: abort check → approval check → open
  `streamRunEvents` under a wall-clock race → read status → repeat, bounded by
  `MAX_STATUS_POLLS = 120` and `MAX_RUN_WALL_CLOCK_MS = 30 min`
  (`src/lib/gateway/runs.ts:242`, `:255`, `:372-554`). A stream failure is remembered and the status
  read decides (`:449-536`); a non-terminal status after a clean stream end is polled again rather
  than presented as a finish (`:530-535`).
- Approval frames are filtered out of `onEvent` and only feed the approval promise
  (`runs.ts:471-487`); a status string that "needs approval" triggers the same path. `runNeedsApproval`
  normalises its input with `signal.trim()` (`runs.ts:200-206`) — it assumes a string.
- Activity rows: the provider writes a provisional row keyed `local-…`
  (`gateway-provider.tsx:4945-4954`), re-keys it to the gateway's run id in `onStarted` (`:4966-4981`),
  appends a one-line preview per event capped at `ACTIVITY_EVENT_CAP = 50` (`:4982-4990`;
  `runs.ts:93`), settles status/summary/finish on return (`:5042-5046`), and settles a thrown start or
  drive as `failed`/`cancelled` (`:5062-5078`).
- Previews pick `deltaText → text → message → status → error → errorMessage → result`
  (`runs.ts:147-168`), so a failed frame surfaces its error rather than a partial answer.
- The wire frames carry a top-level `sequence` (the Gate's own fixtures:
  `gate/__tests__/backend-run-events.test.mjs:22-24`, `gate/__tests__/backend-run-streams-single-writer.test.mjs:29-33`),
  but the app's `RunEvent` type does not model it (`src/lib/gateway/types.ts:311-315`: `type`, `data?`,
  `timestamp?`). Nothing in the app reads or orders by sequence today.
- Archive: the Gate tees the relayed bytes into `<gateHome>/run-streams/<key>.sse`
  (`gate/core/server.mjs:1602-1605`, `:3306-3358`) and writes a `<key>.complete` marker only on a
  clean stream end (`backend-run-streams.mjs:45-58`, `:299-315`). Replay serves the marked archive
  whole (`server.mjs:3244-3252`); an actively-teed run proxies live; an unmarked partial is
  re-streamed and healed, or served **flagged** `X-Run-Archive-Incomplete` when upstream refuses
  (`:3270-3280`). Scoped handles are hashed for the filename
  (`backend-run-handle.mjs:39-42`), so the archive key is the handle, not the raw run id.
- Replay in the app keeps the newest `RUN_TRANSCRIPT_EVENT_CAP = 4_000` frames and reports
  `omitted` (`runs.ts:95-133`; `gateway-provider.tsx:5156-5183`; rendered at
  `src/components/activity/agentic-run-sheet.tsx:159-163`).
- Replay is refused honestly when the run belongs to another gateway
  (`gateway-provider.tsx:5161-5165`) and when the client exposes no run events (`:5167-5170`).
  A replay miss is classified as `run_events_unavailable` and explained as "Replay unavailable"
  (`src/lib/gateway/run-failures.ts:196-197`, `:212-216`, `:322-325`), pinned by
  `__tests__/run-events-unavailable-test.ts`.

**[SOURCE] SSE framing is parsed one way and only one:** `streamSSE.acceptLine`
(`src/lib/gateway/http-transport.ts:262-275`) reacts to `id:` and `data:` lines and **ignores
`event:` lines**. `ManifestClient.streamRunEvents` then does
`try { onEvent(JSON.parse(data) as RunEvent) } catch { /* swallowed */ }`
(`manifest-client.ts:1240-1248`), while `HermesGatewayClient.streamRunEvents` keeps only
`JSON.parse` inside its `try` (`src/lib/gateway/client.ts:811-818`), so an `onEvent` throw there
escapes into `executeRun`'s `catch { streamFailed = true }` (`runs.ts:491-492`).

### 3.3 Activity rendering and its capability gates

**[SOURCE]**

- The `agent` capability group is defined at `src/lib/gateway/dashboard.ts:839-845`. Once a backend
  list exists, its status is overridden from the **selected** backend's capability list:
  `backendOverride = { sessions, tools, agent: backendScoped.runs, approvals: backendScoped.runs }`
  (`dashboard.ts:948-961`), with the reason spelled out in
  `src/lib/gateway/backend-capabilities.ts:10-28`.
- Three surfaces gate on it — `src/app/runs.tsx:181-186` (start card and empty-state variant,
  `:671-722`, `:732-752` — "Runs not offered", with "${name} is chat-only (or has no run API)"),
  `src/components/chat/chat-screen.tsx:3295-3297` (the overflow's `runsSupported`, which is what
  offers "Run task") and `src/components/gateway/gateway-home-dashboard.tsx:107-111` (the home
  dashboard's run affordance). The Activity tab is **not** among them. Byte-identity of the four
  `runs.tsx` empty-state variants is pinned by `__tests__/activity-connect-empty-test.ts:34-77`.
- The Activity tab **does not read `capabilitySnapshot` at all**: its `useGateway()` destructure is
  `activity.tsx:43-57`, and its Runs section is unconditional (`:297-300`). The empty copy it hands
  to `RecentRuns` is "No runs yet. Ask a Bot to do something and it shows up here."
  (`recent-runs.tsx:49-56`).
- `__tests__/backend-runs-capability-test.ts:8-13` states in its own header comment that "the
  Activity screen gates its run UI on the `agent` capability group". That is true of `runs.tsx`,
  **not** of `activity.tsx` — the comment records intent the tab does not implement.
- Capability snapshots can also be `unknown`: with a connected gateway but no capability catalog,
  every group returns `status: 'unknown'`, note "No capability catalog"
  (`dashboard.ts:986-995`). `runs.tsx` only distinguishes `ready` and `unsupported` (`:181-186`), so
  `unknown` falls through to the "No runs yet" variant (`:742-752`).

### 3.4 What `/run` does on a gateway that cannot run

**[SOURCE]**

- `/run` is explicitly exempted from the method-availability block and dispatched straight to
  `runTaskCommand` (`src/lib/gateway/slash-commands.ts:578-584`; exemption repeated at `:591-592`),
  because the registry method it would be judged on is not the path it uses.
- `runTaskCommand` only refuses when `context.runTask` is missing (`:807-812`), and the provider
  always supplies `runTask` (`gateway-provider.tsx:4861-4866`, exposed at `:7878`). So the
  "does not support agentic runs" branch is effectively unreachable through the normal provider.
- The provider's own pre-flight refuses only when the client or its run methods are missing
  (`gateway-provider.tsx:4872-4889`); `ManifestClient` always has them as prototype methods, so the
  pre-flight passes and the request reaches the Gate, which may answer 501 (Section 3.1).
- A 501 lands in the provider's `catch`, which settles the provisional row as `failed` with the
  message (`:5062-5078`). The row is durable (`session-persistence.ts:365-371`).

**[INFERENCE]** The operator-visible result of typing `/run …` on a connected OpenCode-pinned
gateway is: a refusal line in chat (the send's own failure) **and** a `Failed` run card in
Activity/Runs, for a capability the same app already knows is unavailable on that backend. That is
the most concrete mechanism I found for "OpenCode Activity broken", and it is entirely
source-visible.

### 3.5 Stop and settle honesty (adjacent, same surface)

**[SOURCE]**

- `stopActivityRun` marks the row `cancelled` unconditionally after a best-effort
  `serverSideCancelForCommand` (`gateway-provider.tsx:5105-5143`), and that helper swallows the
  refusal (`.catch(() => undefined)`, `src/lib/gateway/cancel.ts:31-39`). When this app is **not**
  driving the run (restored row, another device), nothing later corrects the row; it reads
  "Stopped" whether or not the Gate stopped anything. This is the same defect family as
  `QUALITY-SCAN-2026-10-11.md:227`, still open at this HEAD.
- Restored rows are normalised on load: a `running`/`waiting-approval` row restores `unresolved`
  (keeps whatever finish it had), and only untouched `local-` provisionals become `cancelled`
  (`session-persistence.ts:267-293`). `runStatusToActivityStatus` maps any non-terminal status to
  `unresolved` (`runs.ts:208-223`), and `executeRun` never claims otherwise (`:237-239`, `:540-553`).

### 3.6 Existing regression coverage (so a new test is not a duplicate)

**[SOURCE]** Relevant existing tests, by file:

| Area | Test |
|---|---|
| Run capability scoping | `__tests__/backend-runs-capability-test.ts` |
| Run endpoint scoping on the wire | `__tests__/manifest-runs-backend-scope-test.ts` |
| Provider run lifecycle / approvals / stop identity | `__tests__/provider-run-approval-lifecycle-test.tsx`, `__tests__/provider-run-stop-identity-test.tsx` |
| Orphan-row settling | `__tests__/activity-refused-run-settles-test.ts`, `__tests__/activity-run-restore-settle-test.ts` |
| Persistence ordering/coalescing | `__tests__/activity-run-persistence-{order,coalesce}-test.ts` |
| Gateway scoping of stored rows | `__tests__/activity-run-gateway-scope-test.ts`, `__tests__/activity-run-owner-actions-test.ts` |
| Glance / partition / copy | `__tests__/activity-glance-test.ts`, `__tests__/partition-runs-test.ts`, `__tests__/run-status-copy-test.ts` |
| Replay miss | `__tests__/run-events-unavailable-test.ts`, `__tests__/run-failures-test.ts` |
| Transcript cap/windowing | `__tests__/run-transcript-cap-test.ts`, `__tests__/agentic-run-transcript-*` |
| Runs empty states | `__tests__/activity-connect-empty-test.ts`, `__tests__/activity-connect-retry-test.tsx` |
| Gate archive/single-writer/events | `gate/__tests__/backend-run-streams-single-writer.test.mjs`, `gate/__tests__/backend-run-events.test.mjs`, `gate/__tests__/backend-run-handle.test.mjs` |

Gaps (nothing above pins these): Activity's run section on an unsupported/unknown backend; `/run`'s
capability bypass; frame-shape robustness in `streamRunEvents`; duplicate handling when a live run is
re-streamed from sequence 0.

---

## 4. Ranked hypotheses

Confidence is about the *mechanism being present in code*, never about the operator's symptom.

### H1 — "OpenCode Activity broken" is the Hermes-only run API showing through an ungated tab. **High**

[SOURCE] OpenCode declares no `runs` (`adapters/opencode.mjs:9`); the Gate's run routes 501 for it
(`server.mjs:3105-3127`, `:2750-2755`); `runs.tsx` hides and names the capability (`:181-186`,
`:732-752`); the Activity tab does not (`activity.tsx:43-57`, `:297-300`) and instead invites the
operator to start a run (`recent-runs.tsx:52-54`). [INFERENCE] With no stored runs on an
OpenCode-pinned backend the tab says "No runs yet — ask a Bot to do something", which is false:
nothing this backend starts can ever appear. Confirmation: a screenshot/state dump of Activity with
`agent` group `unsupported`.
Refutation: the reporter's backend is Hermes, or OpenCode gains `runs`.

### H2 — `/run` bypasses the capability check, so an unsupported backend yields a durable `Failed` row. **High**

[SOURCE] `slash-commands.ts:578-584`, `:807-812`; provider catch `gateway-provider.tsx:5062-5078`;
501 source `server.mjs:3105-3127`. The overflow entry to the same run is gated
(`chat-screen.tsx:3295-3297` passes `runsSupported`), so the typed command is the one path that
reaches a backend the app already judged unable. Confirmation: type `/run pong` from a Bot-less chat
pinned to `opencode-local` and look for a Failed card with a
`runs_unsupported`/`backend_unsupported` message.
Refutation: `runTask` refuses before `startRun` in the reporter's build.

### H3 — A live run replayed from the beginning duplicates Activity previews. **Medium**

[SOURCE] The Gate documents that an unmarked partial heals by re-streaming and that the upstream
"re-streams a live run from its first event" (`backend-run-streams.mjs:208-219`; `server.mjs:3234-3252`).
`executeRun` may open the stream more than once per run (`runs.ts:411-536`), and the Activity fold
appends every frame with no sequence/identity dedupe (`gateway-provider.tsx:4982-4990`). [INFERENCE]
A run that loses and reopens its stream can show the same previews twice in the 50-frame window.
Archive-level duplication is **not** the likely mechanism: VS-020 closed the in-process straggler
tee (see §1) and a completed run is served from its marked archive rather than re-streamed
(`server.mjs:3244-3252`), so the duplicate would be app-side, in the row. Confirmation: count repeated
`sequence` values fed to one row (`onEvent` calls) when a stream reconnects — not in the file.
Refutation: no re-stream actually happens in practice (needs capture).

### H4 — Activity never lists runs this device did not start. **Medium (as a cause of the report)**

[SOURCE] The row list is a local store (`session-persistence.ts:308-330`, cap 40), filtered by
`gatewayId` (`runs.ts:141-144`); the Gate exposes no `/v1/runs` list route (`server.mjs:740-745`,
`:2601-2603`). Confirmation: start a run from the CLI/desktop, refresh Activity — no row.
Refutation: the report is about runs started in the app.

### H5 — Frame-shape fragility silently drops events (and, on the older client, aborts the stream). **Medium-Low**

[SOURCE] `acceptLine` ignores `event:` (`http-transport.ts:262-275`); `runNeedsApproval` calls
`.trim()` on whatever arrives (`runs.ts:200-206`); `ManifestClient` swallows an `onEvent` throw per
frame (`manifest-client.ts:1240-1248`), `HermesGatewayClient` does not (`client.ts:811-818`), and on
that older client path `executeRun` then treats the whole stream as failed (`runs.ts:491-492`).
[HYPOTHESIS] If any upstream frame carries its type in an `event:` field or sends a non-object
`data:` payload, frames vanish (or the stream is abandoned) with no operator-visible cause.
Confirmation: inspect one real archived `.sse` file — does every `data:` line parse to an object with
a string `type`, and are there `event:` lines? Refutation: the wire always carries `type` in the JSON
body (the Gate's own fixtures assume exactly that, `gate/__tests__/backend-run-events.test.mjs:22-24`).

### H6 — Archive key divergence when `?bot=` is present on one request and absent on another. **Low**

[SOURCE] The archive key is `backendRunArchiveKey(handle)` (`server.mjs:3233`,
`backend-run-handle.mjs:39-42`); the handle is rebuilt with a Bot scope only when
`botId && !run.botId` (`server.mjs:3222-3232`). A handle minted without a Bot and later requested
with `?bot=` would tee under one key and replay under another. The app itself sends `?bot=` on **all**
run requests when a Bot is selected (`manifest-client.ts:652-679`) and never on a status/events call
that start did not already carry, so the app is consistent. Confirmation: only with a hand-crafted
request. Refutation: every caller keeps the scope constant.

### H7 — OpenCode 2.x "dialect" causes this. **Low, and probably not this surface at all**

[SOURCE] The v2 dialect is a *turns/events* concern (`docs/opencode-backend-contract.md:316-338`),
mapped by the OpenCode backend for chat. Runs have no v2 mapping because runs do not exist for
OpenCode (`adapters/opencode.mjs:9`, `backends/opencode.mjs`). The 2.x notes that *would* explain a
JSON-from-HTML class of failure are in the adapter's HTTP layer (`adapters/opencode.mjs:25-32`: the
v2 SPA catch-all answers `200 text/html` on unknown paths) and belong to the roster investigation,
not to `/v1/runs`. Confirmation: a captured request to Activity's surfaces that returns HTML.
Refutation: `/v1/runs*` never reaches the OpenCode server.

---

## 5. What this investigation could **not** establish

- **No reproduction.** [UNVERIFIED] The report's symptom, its backend pin, and whether the reporter meant
  the tab or the Runs screen. This draft does not claim any of them.
- **No live Gate, no device, no credentials, no archive read.** Every HTTP status quoted above is a
  code path, not an observation.
- **VS-020's live behaviour** was not exercised **[NOT RUN]**. Its fix is present in source and pinned
  by `gate/__tests__/backend-run-streams-single-writer.test.mjs`, but that test was not run in this
  step; this document therefore does not claim it is green at HEAD.
- **OpenCode 2.x live behaviour** against a real `opencode serve` was not exercised; the 2.x notes
  cited are the repo's recorded findings from 2026-10-21 (`adapters/opencode.mjs:25-26`).
- **No performance measurement.** Nothing here is a timing or FPS claim; `environmentRunView`'s
  module-level prefix cache (`environment-run-view.ts:103-129`) and the `fold_cache` step are out of
  scope except as a pointer.

---

## 6. Proposed work, one independent step per item

Each step is self-contained, changes no animation or layout, and is provable by a focused test.
Order is by value, not by dependency.

### Step A — Activity must name the run capability it shares with Runs

Problem: H1. The tab invites "Ask a Bot to do something and it shows up here" on a backend that can
never produce a row.

- Files: `src/app/(tabs)/activity.tsx`, optionally
  `src/components/activity/recent-runs.tsx` (add an optional `emptyVariant`/`runsUnsupported` prop
  rather than a second copy of the group), `__tests__/activity-connect-empty-test.ts` or a new
  `__tests__/activity-runs-unsupported-test.ts`.
- Change: read `capabilitySnapshot` from `useGateway()` exactly as `runs.tsx:181-186` does; when the
  `agent` group is `unsupported`, render the same "Runs not offered" words (byte-identical to
  `runs.tsx:739-748`) for the Runs section and leave the glance's figures alone (they stay 0; the
  ribbon stays empty and is not removed — visual contract unchanged).
- Acceptance tests:
  1. unsupported + connected → the Activity source/rendered tree contains `Runs not offered` and does
     **not** contain `No runs yet`;
  2. ready + connected → the existing "No runs yet" copy is unchanged byte-for-byte;
  3. no `capabilitySnapshot` (offline/unknown) → today's copy, so nothing new is claimed.
- Do not: touch `ActivityGlance` layout, the ribbon, or `runs.tsx`'s copy.

### Step B — `/run` must answer the capability question it already knows

Problem: H2. A known-unsupported backend still receives a start request and leaves a durable failed
row.

- Files: `src/lib/gateway/slash-commands.ts` (the `/run` early dispatch at `:578-584`);
  `src/context/gateway-provider.tsx` only if it must pass a new snapshot flag into the slash context;
  tests: `__tests__/slash-run-*.test.ts`, new `__tests__/slash-run-unsupported-test.ts`.
- Change: add one optional signal to `SlashCommandContext` — e.g.
  `agentRunsStatus?: 'ready' | 'unsupported' | 'unknown'` — filled by the provider from the same
  `capabilitySnapshot` the Runs screen reads. In `/run`'s dispatch, refuse only when the gateway is
  connected and the signal is explicitly `unsupported`; an absent signal keeps today's behaviour, so
  every existing caller and test is unaffected. Do **not** gate on `context.methods`: the
  `runs.create` registry entry is judged undispatched by design, which is exactly why the bypass at
  `:578-584` exists. Keep the offline path first (it must still say "reconnect"), keep `/workflow` out
  of scope, and keep the existing wording.
- Acceptance tests:
  1. connected + unsupported + a `runTask` spy → `runTask` is **not** called and the reply names the
     limitation;
  2. connected + ready → `runTask` is called once (no regression);
  3. offline → the existing "not connected" line wins;
  4. no run row is created (provider-level spy on `patchActivityRuns`/the store) for the refused case.
- Do not: weaken the `/run` bypass comment's original reason (the registry method it would be judged
  on is still not the path it uses); do not gate on `backendId` alone — Bot scope can legitimately
  route a run to Hermes.

### Step C — Guard run-event shape at the client boundary

Problem: H5. Two different clients treat a malformed/typed-outside frame differently; one drops the
frame silently, the other abandons that stream attempt.

- Files: `src/lib/gateway/manifest-client.ts` (`:1240-1251`), `src/lib/gateway/client.ts`
  (`:811-818`), `src/lib/gateway/runs.ts` (`:200-206` for the defensive `runNeedsApproval`).
- Change: accept a frame only when it is a non-null object; require a string `type` (or document and
  implement a single rule for `event:`-style frames, whichever the captured evidence supports); make
  `runNeedsApproval` tolerate a non-string input by returning `false`. Keep behaviour identical for
  every well-formed frame — no new API, no parsing of `event:` unless Step F's capture proves it is
  needed.
- Acceptance tests (hermetic, streamed from a `ReadableStream`):
  1. `data: {"data":{"text":"x"}}` → no throw, no `onEvent`, stream completes — and the same frame is
     ignored identically by both clients (today they diverge);
  2. `data: not-json` → unchanged (ignored);
  3. well-formed `run.started`/`approval.required` frames → still delivered/classified;
  4. `runNeedsApproval(undefined as unknown as string)` returns `false` (and the existing
     approval-signal table tests stay green).
- Do not: make the stream throw on an unknown frame; do not change `run_events_unavailable` handling.

### Step D — De-duplicate replayed frames in the Activity preview

Problem: H3. Only worth doing once Step F's capture shows re-streaming actually happens.

- Files: `src/context/gateway-provider.tsx` (`:4982-4990`), `src/lib/gateway/runs.ts` (a new pure
  fold helper), `src/lib/gateway/types.ts` (optional `sequence?: number` on `RunEvent`, which the wire
  already carries but the type omits — see §3.2), and
  `__tests__/run-event-preview-test.ts` or a new `__tests__/activity-run-event-dedupe-test.ts`.
- Change: track the highest `sequence` seen per run in the driver (reset when the row is re-keyed to a
  new run id) and append only strictly increasing frames when the frame carries a numeric `sequence`;
  never reorder; frames without a sequence append as today. Keep the cap at 50 and keep the newest-last
  order.
- Acceptance tests: (a) stream A then A+B → previews A,B (not A,A,B); (b) sequence gaps still append;
  (c) no-sequence events still append; (d) cap still trims the oldest.
- Do not: dedupe by preview text (two genuinely different frames can read alike), and do not touch the
  transcript sheet's own cap/windowing.

### Step E — `unknown` capability is not "No runs yet"

Problem: the `unknown` snapshot path (`dashboard.ts:986-995`) falls through `runs.tsx:181-186` to the
no-runs empty state, hiding the start card with no explanation while the catalog read is landing or
after it failed.

- Files: `src/app/runs.tsx`, `__tests__/activity-connect-empty-test.ts` (extend the byte-identity
  assertions with the new variant), maybe `src/lib/gateway/dashboard.ts` if a note is exposed.
- Change: add an `runsUnknown` variant rendered only when `status === 'connected'` and the group is
  `unknown`; wording must say the gateway has not reported the run API yet and offer the existing
  retry/refresh, never claim there are no runs.
- Acceptance tests: ready/unsupported/unknown variants are mutually exclusive and their strings are
  pinned; the existing four variants stay byte-identical.
- Do not: alter `buildCapabilitySnapshot` semantics or any dashboard tile.

### Step F — Live verification runbook (no code; a human runs it) **[NOT RUN]**

Purpose: turn H3/H5/H6 from hypotheses into measurements without credentials or a device in this
loop. All commands are read-only on the operator's own machine.

1. **Pin the environment.** On the reporter's device, record which backend the thread is on (Bots →
   Bot Chat means `?bot=`; Settings/Setup chip means `?backendId=`). This decides H1 vs H2 vs H4.
2. **Watch one request.** With the Gate reachable, trigger one run start from the app and capture the
   response status and body (Gate log or a local proxy; never print `Authorization`). 200 → runs are
   being served (backend was Hermes or unpinned). 501 → record the `code`
   (`runs_unsupported` vs `backend_unsupported`), which names the scope that refused it. Whether H1 or
   H2 happened is then decided by what the screen shows: an unchanged empty section means no run start
   was attempted (H1); a new `Failed` card means one was (H2).
3. **Inspect the archive bytes** (no secrets in them; still the operator's data):
   `Get-ChildItem <gateHome>\run-streams\*.sse` then, for the newest, split on blank lines and check
   every `data:` line with `ConvertFrom-Json`; count lines and confirm each object has a string
   `type` and (if present) a monotonic `sequence`; check whether any `event:` lines exist. This is the
   only honest test of H5 and H3.
4. **Check the marker pairing**: every served replay should have a matching `.complete`; a `.sse`
   without it is expected to re-stream (and is not a run-verdict source).
5. **Cross-device check** for H4: start a run from the CLI and pull to refresh Activity; no row is the
   expected result today, not a bug.
6. Record device, OS build, Gate version (manifest `version`), environment pin, and the raw statuses.
   Do not paste tokens or headers.

### Step G — (Only if Step F shows it) OpenCode run bridging is a product decision, not a bug fix

If the expectation is that OpenCode runs appear in Activity, the honest work is a Gate-side bridge
(`startRun`/`getRunStatus`/`runEvents`/`stopRun` mapped onto the OpenCode session event bus, per
`docs/opencode-backend-contract.md`), plus the `replyApproval` signature mismatch noted in §3.1.
That is a feature, needs its own PRD, and must not be faked by advertising `runs` on an adapter that
cannot serve them (the manifest would then over-claim, which `gate/core/manifest.mjs:135-154`
explicitly refuses to do).

---

## 7. Acceptance summary for the whole set

- Activity and Runs tell the operator the same thing about the same gateway at the same moment
  (A, E).
- A known-unsupported backend never receives a run start from the app, and no failed row is minted
  for it (B).
- A run stream can carry any frame shape without silently losing frames or abandoning the stream (C).
- Previews never repeat a frame the app has already shown, when the frame names its sequence (D).
- Every claim about real-system behaviour comes from Step F, and none of it is pre-written here.

Risks: A and E change copy only; B changes a refusal branch; C and D touch pure/near-pure logic.
No animation, layout, spacing, colour, or motion token changes are proposed. Existing snapshots and
source-assertion tests must be extended, never relaxed.

---

## 8. Questions for whoever owns the handoff

1. Which surface was "Activity" — the tab, the Runs screen, or Gateway setup's run launcher?
2. Which environment was pinned, and was a Bot selected?
3. Was VS-020 (the single-writer archive issue) the reason the archive looked wrong at the time, or
   did the duplicate frames come from the app's row rather than the file? VS-020's fix is in this
   tree, so a duplicate now would point at H3's app-side path.
4. Was any run row ever created (any status), or was the screen simply empty? Empty versus failed
   splits H1 from H2 immediately.
5. If a replay was attempted: what did the sheet say — "Replay unavailable", a run id, or nothing?
