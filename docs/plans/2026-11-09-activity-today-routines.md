# Activity: Today + Routines (spec, 2026-11-09)

## Precedents

- **GitHub Actions** — workflow run lists drill into job and step status/logs; recent runs can be limited and filtered by workflow. Evidence: [workflow run history](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/viewing-workflow-run-history). **ADAPT** — use compact status, time, and a clear drill-in; avoid nested CI detail in the phone feed. *Visual ref - needs screening.*
- **Cronitor** — scheduled-job monitoring pairs lifecycle outcomes with schedule, duration, and execution history. Evidence: [Cron job monitoring](https://cronitor.io/docs/cron-job-monitoring). **ADAPT** — show last result and next fire together, and distinguish “paused,” “failed,” and “not run yet.” *Visual ref - needs screening.*
- **Home Assistant** — automation traces are reachable from Activity and show the run’s steps, trigger, outcome, and timeline. Evidence: [Testing automations and traces](https://www.home-assistant.io/docs/automation/testing/). **ADAPT** — make each activity row open its own run detail; don’t bring a large trace graph into the list. *Visual ref - needs screening.*
- **n8n** — one executions list spans workflows, with filters for status and start time; an execution can be opened for debugging. Evidence: [View all executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions/). **ADAPT** — make “Today” universal, but group by Bot/Agent first and keep backend filtering one tap away. *Visual ref - needs screening.*
- **Vercel** — deployment lists lead to detail pages with build time, logs, errors, and resource information. Evidence: [Deployments](https://vercel.com/docs/deployments). **ADAPT** — list the outcome and time first; place logs and detailed metrics behind a row tap. *Visual ref - needs screening.*

## Current state in Versutus

- Activity currently shows the active Gateway’s run glance, pending approvals, recent runs, a cron section, device-local approval decisions, spend, and Gateway selection. The screen itself calls this a scheduled-work view and directs full runs to `/runs` (`src/app/(tabs)/activity.tsx:34-39,260-365`).
- Run history on the Activity/Runs surfaces is app-held `ActivityRun` state filtered to the active Gateway, not a universal backend query (`src/context/gateway-provider.tsx:1538-1562`; `src/lib/gateway/runs.ts:65-91`). Gate CLI-environment runs are a separate durable archive, capped at 100 per environment, with a GET list route (`gate/core/cli-environments/run-archive.mjs:5-10,51-60`; `gate/core/server.mjs:4111-4122`). The archive’s client summary has environment, operation, state, and start/end times (`src/lib/gateway/environment-types.ts:59-72`).
- Today’s session data is uneven:
  - **Hermes:** session rows include start/last-active time, message/tool counts, tokens, and estimated/actual cost; messages have timestamps and tool calls (`gate/core/cli-environments/backends/hermes.mjs:37-64,73-93`). The Gate lists sessions for a resolved backend/Bot, not across every backend (`gate/core/server.mjs:3920-3959`).
  - **OpenCode:** session rows have creation/update time and token/cost totals; messages have timestamps and tool parts. Session tool count is currently zero in the normalized row, so daily counts require reading messages (`gate/core/cli-environments/backends/opencode.mjs:76-126,174-227`).
  - **OpenClaw:** normalized session rows may include timestamps, message/tool counts, token totals, and estimated cost; normalized messages may have timestamps. Missing values default to zero or absent, not measured daily totals (`src/lib/portal/openclaw-mapping.ts:49-92`).
  - **Codex:** thread rows expose creation/update times, turn count, and token usage, but no USD cost; thread items/messages and tool events are available through reads/streaming (`gate/core/cli-environments/backends/codex.mjs:23-69,75-120,231-253`).
  - **Claude Code:** session listing uses transcript birth/mtime for start/activity, but currently reports zero message/tool/token counts and no cost. Transcript messages and tools can be read; turn result events can carry cost and turn count (`gate/core/cli-environments/backends/claude-code.mjs:192-264,323-334`; `gate/core/cli-environments/backends/claude-code.mjs:111-122`).
- **Runs and approvals:** the Gate has no `GET /v1/runs` list—its `/v1/runs` route starts runs; individual run status/events are addressable by ID (`gate/core/server.mjs:3177-3203,3398-3413`). CLI environments do have archived run summaries; their adapters emit different event facts such as token usage, tools, and approvals (`gate/core/cli-environments/backends/codex.mjs:75-120`; `gate/core/cli-environments/backends/opencode.mjs:615-635`; `gate/core/cli-environments/backends/claude-code.mjs:111-122`).
- **Routines:** current job listing is a single-backend `/v1/jobs` proxy (`gate/core/server.mjs:3548-3556`); Hermes implements job list/create/run/pause/remove (`gate/core/cli-environments/backends/hermes.mjs:423-450`). Curated job data includes `lastRunAt`, `lastStatus`, and `nextRunAt` (`src/lib/gateway/cron.ts:15-47`). OpenCode Bots explicitly have no routines and runs are Hermes-only (`docs/adr/0016-bots-on-opencode.md:25-27`). Codex/Claude adapters expose no job-list capability (`gate/core/cli-environments/adapters/codex.mjs:4-11`; `gate/core/cli-environments/adapters/claude-code.mjs:128-138`).

## Proposal

**Activity has two views: `Today` and `Routines`.** Keep the existing Nocturne restraint: serif title, concise counts, sentence-case groups, value-step surfaces, and no dense dashboard cards (`docs/design-language-nocturne-2026-09.md:20-32,231-240`; `src/constants/tokens.ts:17-35,140-149`).

- **Today:** “Since midnight” with the local date/timezone; `All` plus one chip per backend present. A compact summary (“3 runs · 8 sessions · 2 need you”) precedes **Needs you**, **In progress**, then Bot/Agent groups. Within groups, newest first. Session rows are activity summaries, not full transcripts; tapping opens the relevant session. Example: “4 turns · 2 tools · 14:32” and “$0.03” only when actually available. Unknown metrics are omitted or marked unavailable, never shown as zero.
- **Routines:** list every scheduled job, grouped by Bot/Agent and backend. Row: routine name, schedule, last result/time, next fire, paused/running state. Tap opens the existing `CronJobSheet`; run history opens `CronRunSheet`. Create only when the backend advertises routine creation; otherwise say “Routines aren’t supported by this backend.” OpenCode Bots get that explanation, not a fake empty list.
- **Approvals and live runs** remain actionable, pinned above Today’s completed history and unaffected by the midnight filter. Approval taps return to their owning run/decision UI; live run taps open its events. Reuse `ApprovalInbox`, `ApprovalDecisionCard`, `RunCard`, and the existing sheets (`src/app/(tabs)/activity.tsx:292-314`; `src/components/activity/cron-section.tsx:297-319`).
- **New Gate contract:** `GET /v1/activity?since=<ISO>&backendId=<id>` returns `{since, generatedAt, backends:[{id,label,status,error?}], items:[{id,backendId,botId?,kind:'run'|'session',sessionId?,startedAt,finishedAt?,status,title,metrics:{turns?,tools?,tokens?,costUsd?}}], truncated?:{window?:true,items?:true}}`. Backend `status` distinguishes complete, partial, unavailable, and failed reads. The Gate reads archived CLI-environment runs and normalized sessions, filters sessions by last activity, and preserves unknown metrics rather than defaulting them to zero. The query is capped to seven days and 500 returned items; an older requested window or excess rows are identified in `truncated`. Compute local midnight on the client and pass the resulting ISO instant; do not let the Gate’s timezone define “today.”
- `GET /v1/routines` returns the same backend coverage metadata plus normalized routine rows. Hermes fills schedule, last result/time, and next fire from its jobs API; unsupported adapters report unsupported, not an empty successful list. Existing `/v1/jobs` remains the mutation/detail path until safely generalized.
- **States:** skeleton on first load; quiet “Nothing yet today” only after a successful read; offline retains the last snapshot with “Last updated …”; partial failure keeps healthy backend rows and names failed backends with Retry. Failed-first-read must not masquerade as empty—consistent with existing honest read-state handling (`src/lib/gateway/routines.ts:163-201`).
- **Remove from Activity:** device-local “Your decisions,” spend, Gateway target picker, the old run ribbon/recent-run teaser, and gateway-level “New scheduled job” form. Keep run creation/history in Runs and Gateway selection in connection/settings surfaces.

## Slices

1. **Gate daily aggregation contract** — **L**. Files: `gate/core/server.mjs`, `gate/core/cli-environments/backends/*`, new Gate activity aggregation module/tests. Check: `npm run verify`. Depends on: none.
2. **Gate routines aggregation and coverage** — **M**. Files: `gate/core/server.mjs`, Hermes routine adapter path, new routine aggregation tests. Check: `npm run verify`. Depends on: 1’s backend identity/coverage contract.
3. **App activity client and types** — **M**. Files: `src/lib/gateway/*` activity client/types; `src/context/gateway-provider.tsx`; tests. Check: `npm run verify`. Depends on: 1–2.
4. **Today/Routines Activity UI** — **L**. Files: `src/app/(tabs)/activity.tsx`, `src/components/activity/*`, tests. Check: `npm run verify`. Depends on: 3.
5. **Route and regression pass** — **M**. Files: relevant Activity/Runs navigation and tests. Check: `npm run verify` and `npm run smoke:portal`. Depends on: 4. (`README.md:208-222` documents these checks.)

## Risks

- Per-day session metrics require message/turn timestamps; lifetime session totals cannot be subtracted into today’s totals. Some backends lack cost or tool counts, and transcript/list windows may omit older activity.
- Mixing persisted Hermes app runs with Gate environment runs risks duplicates. Normalize stable IDs and source ownership; do not merge by matching timestamps/text.
- Midnight is a client-local boundary. Daylight-saving changes and timezone changes require recomputing `since` and refreshing.
- A backend that cannot list routines must be marked unsupported/unavailable, not silently counted as zero.

## Decisions for Ethan

- **Should Today show all sessions with activity, or only Bot chats?** Recommend all sessions with activity, grouped under Bot/Agent plus an “Unassigned” group; don’t guess ownership.
- **Should local device-held Hermes runs appear in universal Today?** Recommend yes only as a clearly labeled temporary source until Gate aggregation replaces them, with ID deduplication.
- **Routine creation for gateway-level/unowned jobs?** Recommend remove the generic create form; create only within a supported Bot’s routine context.
- **How much detail in Today?** Recommend counts and time in rows; keep transcripts, tool traces, and run events behind a tap.

## Unsure

- I did not verify an OpenClaw cron/routine RPC or whether every deployed OpenClaw gateway exposes one. Treat OpenClaw routines as unsupported until its live capability contract is confirmed.
- The brief calls OpenCode runs Hermes-only; ADR 0016 says `startRun` is Hermes-only, while Gate CLI environments separately archive operation runs. Product wording should distinguish **agentic runs** from **CLI environment runs**, rather than claim every backend’s run archive is the same kind of run.
- Gate’s exact source of Bot attribution for every CLI environment archive item was not established from the inspected summary shape; retain `botId` only when the Gate can prove it.
