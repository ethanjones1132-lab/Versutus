# Cron transparency — design

**Date:** 2026-08-25 · **Status:** approved (placement, config scope, liveness, architecture)

## Problem

Hermes holds 36 fields per cron job and a full transcript for every run. Versutus
models a routine as `{ id, name?, paused? }` — three fields, no run state, no
transcript. An operator on the phone cannot answer "what is this job, what will
it do, as whom, did it work, and what is it doing right now".

Everything needed already exists on the wire. This is a surfacing problem, not a
capability one.

## What Hermes actually exposes

`GET /api/jobs` — per job: `prompt`, `model`, `provider`, `schedule`,
`schedule_display`, `enabled`, `state`, `paused_reason`, `next_run_at`,
`last_run_at`, `last_status`, `last_error`, `last_delivery_error`, `deliver`,
`origin`, `enabled_toolsets`, `workdir`, `failure_streak`, `cooldown_until`,
`cooldown_reason`, and `latest_execution`:

```json
{ "id": "1af0…", "job_id": "934a7d7ff88c", "status": "completed",
  "pid": 60248, "claimed_at": "…", "started_at": "…",
  "finished_at": "…", "error": null }
```

Each run writes a session named `cron_<jobId>_<yyyymmdd>_<hhmmss>`, readable
turn-by-turn via the sessions routes. Measured on the pilot host: 126 cron
sessions across 17 job ids, for 12 live jobs — five ids have history but no
surviving job.

There is **no event stream for cron**. Liveness is polling.

## Decisions

| Question | Decision |
| --- | --- |
| Placement | Activity tab becomes the run centre; the Bot routines pane links into it |
| Config scope | Curated fields lead; "Show raw record" reveals the untouched JSON |
| Liveness | Poll every 3s **only while the active-run view is open**, with an honest "updated Ns ago" |
| Architecture | The Gate assembles; the app renders |

`cron_<jobId>_<ts>` is a Hermes naming convention, not a domain fact. Joining on
it belongs in the Gate — the component that exists so "the app sees one dialect
instead of two gateways" — where it is unit-testable without a device, and where
the orphaned-history case is decided once instead of per consumer.

## Gate surface

Three RPC methods on the existing `/v1/capabilities/rpc`, resolved through
`resolveBackendFor('listJobs')` so they pick a cron-capable environment by
capability:

- **`cron.list`** → `{ jobs: CronJobView[] }`. Every job, curated + `raw`.
- **`cron.runs`** → `{ runs: CronRunView[] }` for one `jobId`, newest first,
  derived by prefix-matching session ids. Includes runs whose job is gone.
- **`cron.transcript`** → `{ turns: CronTurn[] }` for one `runId`, plus
  `status` so a caller can tell running from finished.

```
CronJobView  { id, name, botId?, schedule, scheduleDisplay, nextRunAt,
               lastRunAt, lastStatus, failureStreak, state, paused,
               pausedReason?, model?, provider?, toolsets[], workdir?,
               deliver?, origin?, prompt?, running, raw }
CronRunView  { id, jobId, startedAt, finishedAt?, status, error?, turnCount }
CronTurn     { id, role, text, at, toolName? }
```

`botId` comes from the existing `[bot:<name>]` name convention
(`parseRoutineName`), so a job shows which Bot owns it.

`running` is `latest_execution.status === 'running'` — the single flag the
Activity list keys its live badge off.

## App surface

**`src/lib/gateway/cron.ts`** — pure, fully tested: the view types, a
`cronJobSummary()` one-liner for the list row, `cronRunLabel()` for a run row,
`isRunLive()`, and `describeCronHealth()` mapping `lastStatus` / `failureStreak`
/ `cooldownReason` onto the existing run-failure vocabulary.

**Activity tab** grows a `CRON` section under the existing runs:

```
CRON (12)                                   ● 1 running
  Vantage - Autonomous Maintainer   running 4m   ▸
  Guardian Agent v2                 ok · next 07:00
  Daily Plan & Brief                ok · next 07:30
```

**Job detail** — curated config, health line, run history, "Show raw record".

**Active run view** — read-only transcript, polling every 3s while open,
elapsed timer, "updated Ns ago", and a clear terminal state when the run ends.

## Error and empty states

Honest in the existing idiom, never invented:

- Gateway that advertises no `jobs` endpoint → the section does not render.
- Jobs endpoint present, zero jobs → "No scheduled work on this gateway".
- A run whose job no longer exists → shown under its job id, labelled
  "job removed" rather than hidden.
- Transcript unreadable → the reason is named, the run row survives.
- Poll failure while open → the last good transcript stays, the freshness
  stamp goes stale and says so. It never silently freezes.

## Testing

Gate (`node --test`): the prefix join including orphaned ids; `running`
derivation; curated/raw split; capability resolution picking a cron-capable
backend; a job with no runs.

App (jest): every pure helper in `cron.ts`, including the degrade paths for
older Gates that report none of the new fields.

No new coverage floor; `src/lib/gateway/` is already ratcheted.

## Out of scope

Editing or creating crons from the phone, cancelling a running one, and
push-on-completion. Read-only, as asked.
