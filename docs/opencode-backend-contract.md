# Native backend contracts

Two environments implement the backend contract. Both were captured from the vendor's own
authoritative schema and then **verified live**.

| | OpenCode 1.18.18 | Codex 0.142.1 |
|---|---|---|
| Transport | HTTP + SSE (`opencode serve`) | newline-delimited JSON-RPC on stdio (`codex app-server`) |
| Contract source | `GET /doc` (OpenAPI 3.1) | `codex app-server generate-json-schema --out` |
| Conversation | session → messages (parts) | thread → turns → items |
| Lifecycle | attach to a running server, else spawn | always spawn (stdio is bound to its pipe) |
| Approvals | `permission.asked` + reply route | server→client JSON-RPC **requests** |
| Completion | `POST /message` blocks | `turn/start` accepts; await `turn/completed` |

Codex specifics are at the end; the bulk of this document is OpenCode.

# OpenCode backend contract

The native surface the Gate proxies to when an environment is used as a chat backend.
Captured from `GET /doc` (OpenAPI 3.1, `opencode 1.0.0`) and **verified live** against
`opencode serve` 1.18.18 on 2026-08-15.

## Server

`opencode serve --port <n> --hostname 127.0.0.1` prints `opencode server listening on http://…`.
Without `OPENCODE_SERVER_PASSWORD` it logs `server is unsecured` — set one whenever the Gate owns
the lifecycle.

One instance per data directory (`~/.local/share/opencode/opencode.db`). A second instance against
the same database breaks schema migrations — this is why the Gate **attaches to a reachable server
first** and only spawns when none answers.

## Endpoints used

| Purpose | Route |
|---|---|
| List sessions | `GET /session` |
| Create session | `POST /session` — `{ title?, parentID?, agent?, model?: {id, providerID, variant} }` |
| Get / delete session | `GET|DELETE /session/{sessionID}` |
| List messages | `GET /session/{sessionID}/message` → `{ info, parts }[]` |
| Send message | `POST /session/{sessionID}/message` — `{ model: {providerID, modelID}, parts: [{type:'text', text}] }` |
| Cancel | `POST /session/{sessionID}/abort` |
| Event bus (SSE) | `GET /event` |
| Approvals | `GET /session/{sessionID}/permission`, `POST /session/{sessionID}/permission/{requestID}/reply` |
| Providers + models | `GET /config/providers` → `{ providers[], default }` |
| Credential provisioning | `PUT|DELETE /auth/{providerID}` |

`POST /session/{id}/message` blocks until the turn completes and returns the assistant message.
Use `/event` for live deltas, `prompt_async` if a non-blocking submit is ever needed.

## Message shape

Messages are **parts-based**, which maps directly onto the app's existing
`SessionMessage.content: string | {type?, text?}[]` — `extractMessageText` already handles it.

```json
{ "info": { "id", "sessionID", "role", "time": {"created","completed"}, "modelID", "providerID" },
  "parts": [ {"type":"step-start"}, {"type":"text","text":"…"}, {"type":"step-finish"} ] }
```

A tool call is a part with `type: "tool"`:

```json
{ "id":"prt_…", "messageID":"msg_…", "sessionID":"ses_…", "type":"tool",
  "tool":"read", "callID":"call_…", "state": { "status":"pending", "input":{}, "raw":"" } }
```

## Event mapping

The OpenAPI union lists 87 variants across two generations. **These are the ones actually observed
live** — the `session.next.*` family did not appear and must not be relied on:

| Observed event | Payload | Normalized (`cli-environment-interface-v1.md`) |
|---|---|---|
| `message.part.delta` | `{sessionID, messageID, partID, field:'text', delta}` | `message.delta` |
| `message.part.updated` where `part.type==='tool'`, `state.status` pending/running | `{part}` | `tool.started` |
| `message.part.updated` where `part.type==='tool'`, `state.status` completed/error | `{part}` | `tool.output` |
| `message.updated` | `{info}` with tokens/cost | `usage` |
| `session.idle` | `{sessionID}` | `run.completed` |
| `session.error` | `{sessionID, error}` | `run.failed` |
| `permission.asked` / `permission.v2.asked` | `{id, sessionID, permission/action, patterns/resources}` | `approval.required` |
| `session.updated`, `session.status`, `session.diff` | — | `diagnostic` |

Every event carries `properties.sessionID`; filter the shared bus by it.

### Client-side approval matching

`approval.required` is the **typed** signal the app matches on (`runNeedsApproval`
in `src/lib/gateway/runs.ts`), alongside the waiting-state status spellings
(`waiting-approval`, `approval_required`, `pending-approval`, `needs-approval`).
A loose `approv` substring test remains as a fallback for gateways predating this
contract, but it explicitly does **not** fire for signals reporting a decision
already taken (`approved`, `denied`, `rejected`, `resolved`, `granted`) — matching
those re-opens the approval prompt for a decision the user already made and can
spin the run against its poll cap.

Renaming `approval.required` is therefore a **breaking change** for the app: add
the new spelling to `APPROVAL_REQUIRED_SIGNALS` in the same change.

## Native providers

`GET /config/providers` on this desktop returns 7 providers OpenCode already holds credentials for
— `opencode` (Zen, 62 models), `opencode-go` (19), `nvidia` (98), `kilo` (358), `groq`,
`alibaba-token-plan`, `open-azure`. The Gate should **surface these**, not duplicate them; inject a
vault credential only when provisioning a platform the CLI does not already have.

## Verified

- `POST /session` → session id, `POST /session/{id}/message` → assistant reply in ~5s.
- Tool use: "Read AGENTS.md and quote its first line" returned `` `# Expo HAS CHANGED` `` with a
  `read` tool part on the bus — the capability a direct provider proxy cannot offer.
- Prompts fail with `SQLiteError: no such column: replacement_seq` on 1.17.9 with a database that
  missed a migration; fixed by upgrading to 1.18.18. Both are inside the adapter's `1.17.x–1.18.x`
  supported range.

---

# Codex backend contract

Captured from `codex app-server generate-json-schema --out <dir>` (87 request methods, 68 server
notifications) and verified live against 0.142.1 on 2026-08-15.

## Transport

`codex app-server` speaks **newline-delimited JSON-RPC** on stdio — one JSON object per line, no
Content-Length framing. It is bidirectional: the server issues requests *to the client* for
approvals, so an unanswered request blocks the agent. `initialize` is both the handshake and the
liveness check.

There is nothing to attach to: a stdio server belongs to the process that spawned it.

## Methods used

| Purpose | Method |
|---|---|
| Handshake | `initialize` |
| List / create / delete threads | `thread/list`, `thread/start`, `thread/delete` |
| Read history | `thread/read` `{ threadId, includeTurns: true }` |
| Rename | `thread/name/set` |
| Send a turn | `turn/start` `{ threadId, cwd, input: [{type:'text',text}], model? }` |
| Cancel | `turn/interrupt` `{ threadId, turnId }` |
| Models | `model/list` |
| Account | `account/read` |

`cwd` scopes a thread to a directory — this is what keeps a run inside the configured workspace.

**Results paginate under `data`**, not under a named key. Reading only `models`/`threads` returns
empty against the real server; `unwrap()` accepts `data`, the named key, or a bare array.

## Event mapping

| Codex notification | Normalized |
|---|---|
| `item/agentMessage/delta` | `message.delta` |
| `item/started` with a command/patch/tool item | `tool.started` |
| `item/completed` with a tool item | `tool.output` |
| `item/commandExecution/outputDelta`, `process/outputDelta` | `tool.output` (byte arrays decoded) |
| `turn/completed` | `run.completed` |
| `error` | `run.failed` |
| `thread/tokenUsage/updated` | `usage` |
| anything else | `diagnostic` |

Approvals are **server requests**, not notifications: `execCommandApproval`, `applyPatchApproval`,
`commandExecutionRequestApproval`, `fileChangeRequestApproval`, `permissionsRequestApproval`.

`turn/start` returns as soon as the turn is *accepted*. The reply text only arrives on the
notification stream, so a non-streaming caller must await `turn/completed` and assemble the deltas.
One connection multiplexes every thread, so filter by `params.threadId`.

## Verified

- Handshake, `thread/start`, `turn/start`, history read-back, `thread/delete`, `model/list`.
- A full turn returned `codex ok` with `message.delta` ×3, `usage`, `run.completed`, and two
  messages persisted in the thread.
- Through the Gate: `hello from codex-local`, 2 messages persisted, alongside OpenCode.

## Environment note

This desktop's Codex default model is `gpt-5.6-sol`, which the installed 0.142.1 rejects with
"requires a newer version of Codex". Supported here: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. Either
upgrade Codex or set a supported default; the Gate passes whatever model the caller selects.

---

# Claude Code backend contract

Verified against 2.1.140 on 2026-08-15.

## Transport

A third style: **one process per turn**. `claude --print --output-format stream-json --verbose`
emits newline-delimited events and exits. There is no server to supervise between turns —
continuity comes from `--session-id <uuid>`, and history lives in on-disk transcripts.

Approval bypass flags (`--dangerously-skip-permissions`, `--permission-mode bypassPermissions`
or `dontAsk`) are never passed; a test asserts their absence.

## Sessions

Transcripts live at `~/.claude/projects/<flattened-cwd>/<session-uuid>.jsonl`, where the directory
name is the workspace path with `: \ / .` replaced by `-` (`C:\Projects\Versutus` →
`C--Projects-Versutus`). Listing sessions means reading that directory; `createSession` only
reserves a UUID, which `--session-id` binds on the first turn.

Session ids are validated against a UUID shape before touching the filesystem, so a crafted id
cannot escape the transcript directory.

## Event mapping

| stream-json event | Normalized |
|---|---|
| `assistant` with a `text` block | `message.delta` (whole block; Claude batches unless `--include-partial-messages`) |
| `assistant` with a `tool_use` block | `tool.started` |
| `user` with a `tool_result` block | `tool.output` |
| `stream_event` with `text_delta` | `message.delta` (token-level, when partial messages are on) |
| `result` | `run.completed`, or `run.failed` when `is_error` or the text starts with an API error |
| `system/*` (init, hooks, api_retry) | `diagnostic` |

**`result` carries `subtype: "success"` even for authentication failures**, with the error in
`result`. Trusting the subtype would surface "Failed to authenticate…" as the assistant's answer.

## Models

Claude Code exposes no model list. The backend offers the documented aliases — `opus`, `sonnet`,
`haiku` — and a full model name may be passed through.

## Verified

- Session listing, history read-back and delete against real transcripts.
- Through the Gate: session created, 2 messages of history, 3 sessions listed.
- Turns currently fail on this desktop with `401 OAuth access token has been revoked`; the backend
  reports that as `run.failed` rather than as the assistant's reply. Re-authenticate Claude Code to
  clear it.

## Version parsing

`claude --version` prints `2.1.140 (Claude Code)`. `probeVersion` took the last whitespace token and
read `"Code)"`, marking the environment `incompatible`. It now matches the first semver anywhere in
the line, which also covers `codex-cli 0.147.0` and bare `1.17.9`.
