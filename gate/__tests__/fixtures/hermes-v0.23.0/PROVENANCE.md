# Hermes v0.23.0 contract fixtures — provenance

Pinned to Hermes Agent **v0.23.0** (tag `v0.23.0`, commit `2bd378e`, released 2026-11-05).
These are not a captured production traffic dump. Each file is either the unauthenticated
live probe from `.spike/ref/hermes-probe-unauth-2026-11-10.txt` or a shape reconstructed from
the upstream source at that tag. No API key, bearer token, real user data, hostname, account
id, or filesystem path appears in any fixture.

Source root for every "derived" entry:
- <https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/platforms/api_server.py>
- <https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/platforms/api_server_runs.py>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>
- <https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0>

| File | Status | Evidence |
|---|---|---|
| `health.json` | **live-probed** (2026-11-10) | Unauthenticated `GET /health` and `GET /v1/health` both returned `{"status":"ok","platform":"hermes-agent","version":"0.23.0"}`. Probe transcript in `.spike/ref/hermes-probe-unauth-2026-11-10.txt`. |
| `error-401.json` | **live-probed** (2026-11-10) | Authenticated routes answered `401` with this envelope; the key in the transcript was replaced by the probe harness with `<redacted>`, and that placeholder is kept. The probe line's trailing `, ` artifact was dropped; the key names and values are unchanged. |
| `health-detailed.json` | derived | `api_server.py` (`_handle_health_detailed` / readiness reporting) and the API-server docs, which name `status`, `platform`, `version`, `gateway_state`, `platforms` and `readiness.checks`. The nested `readiness.checks` entries are illustrative: the docs promise the key, not a fixed child shape. |
| `capabilities.json` | derived | `api_server.py` `_STATIC_FEATURE_FLAGS` and `_CAPABILITY_ENDPOINTS` at v0.23.0. Conditional `run_unknown_resolution` is omitted because its feature is off in the static table. |
| `models.json` | derived | `api_server.py` `GET /v1/models`; the docs state it lists the profile model, defaulting to `hermes-agent`. |
| `model-options.json` | derived | `api_server.py` `GET /api/model/options` and the docs' provider-row description (`slug`, `name`, `authenticated`, `source`, `is_user_defined`, `is_current`, `aliases`, `models`). Rows are representative, not a particular host's catalog. |
| `sessions.json` | derived | `api_server.py` `GET /api/sessions`; session field set from `_session_response` (`id`, `source`, counts, token/cost counters, `last_active`, `preview`, `has_*`). Timestamps are epoch seconds, per the API docs. |
| `session.json` | derived | `api_server.py` `GET /api/sessions/{session_id}`. The `{ "object": "hermes.session", "session": {...} }` wrapper is what the Gate and app read; the exact `object` string is **unverified**. |
| `session-messages.json` | derived | `api_server.py` `GET /api/sessions/{session_id}/messages` and `_project_client_message`; message `content` is a string, tool calls are OpenAI-shaped. |
| `session-chat.json` | derived | `api_server.py` `POST /api/sessions/{session_id}/chat`; docs describe the reply/`usage`/`runtime` fields and provider substitution (`runtime.model` vs `runtime.requested.model`). |
| `run-created.json` | derived | `api_server_runs.py` `_accepted_response`: `202` with `{run_id, status, replayed}`. |
| `run-status.json` | derived | `api_server_runs.py` `_set_run_status` / `_handle_get_run` and the docs' `GET /v1/runs/{run_id}` example (`object`, `run_id`, `status`, `session_id`, `model`, `output`, `usage`, `runtime`). |
| `approval-response.json` | derived | `api_server_runs.py` `_handle_run_approval`: `{object: "hermes.run.approval_response", run_id, choice, resolved}`. |
| `stop-response.json` | derived | `api_server_runs.py` `_handle_stop_run`: `{run_id, status: "stopping"}`. |
| `steer-response.json` | derived | `api_server_runs.py` `_handle_steer_run`: `{object: "hermes.run.steer", run_id, accepted: true}`. |
| `run-events.txt` | derived | `api_server_runs.py` `_run_event` and the docs' `GET /v1/runs/{run_id}/events`. The event name rides in the JSON `event` field (not `type`); `message.delta` carries `delta`; the terminal frame carries `output`, `usage`, `runtime` and the completion flags. Byte-for-byte relay is what the Gate promises. |
| `skills.json` | derived | `GET /v1/skills` (PR #33016, merged 2026-05-27); docs show `name`, `description`, `category`. |
| `toolsets.json` | derived | `GET /v1/toolsets` (PR #33016); docs show `name`, `label`, `description`, `enabled`, `configured`, `tools`. |
| `jobs.json`, `job-created.json` | derived | `api_server.py` `/api/jobs` routes at v0.23.0 and the `cron/jobs` records the Gate curates in `gate/core/cron-view.mjs` (`name`, `prompt`, `schedule`, `schedule_display`, `next_run_at`, `last_run_at`, `last_status`, `last_error`, `last_delivery_error`, `failure_streak`, `state`, `enabled`, `paused_at`, `paused_reason`, `cooldown_*`, `model`, `provider`, `enabled_toolsets`, `workdir`, `deliver`, `origin`, `latest_execution`). The nested job-record field names are **derived from the Gate's parser**, not independently captured at the tag. |

## What was not captured

The local Hermes is `0.23.0`, but every authenticated route answered `401 gateway_auth_failed`
without the key. That key is deliberately never read, so no authenticated response shape was
observed. Everything except `health.json` and `error-401.json` is source-derived. Treat any
mismatch found against a keyed host as a fixture defect to correct, not as proof the fixture
is live truth.
