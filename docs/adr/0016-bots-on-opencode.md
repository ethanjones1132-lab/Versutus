# 0016 — Bots on OpenCode (agents as Bots)

Supersedes the "Hermes profiles only" part of ADR 0004 and the "future non-Hermes roster row" caveat in ADR 0009. Everything else in 0004–0015 stands for Hermes Bots.

A **Bot** is now either a Hermes profile or an **OpenCode agent**. An OpenCode agent is a markdown file in the server's `<config>/agents/` directory (frontmatter: `description`, `mode: primary`, `model`; body: the soul as the system prompt). The Gate writes that file, reloads the server, and reads the roster back from `GET /agent`. The server stays the source of truth; the Gate keeps no Bot table of its own.

## Shape

- **One roster, one namespace.** `GET /v1/bots` merges every environment that implements `listBots`; each row carries `backendId` and `runtime` once more than one environment answers. A single-environment Gate answers byte-for-byte as before. A Bot name is unique across runtimes (create refuses a clash with 409 `bot_exists`), so `bot=<id>` still addresses a Bot with no environment named.
- **Ownership is looked up, not assumed.** `findBotOwner` asks each `forBot`-capable environment in turn; `unknown_bot` moves on, any other refusal means "owned, but unhealthy" and is reported as such. Conversations, runs, `GET`/`PATCH /v1/bots/{id}` all resolve through it. An operation the owner does not implement (memory, listen keys) is refused 501 by name — never asked of Hermes about a Bot it has never heard of.
- **Create is aimed.** `POST /v1/bots` takes `backendId` (query or body). `inheritKeys` and listen keys are Hermes-only and ignored on OpenCode.
- **A scoped session is the agent.** `forBot(id)` returns the same backend with `agent: id` on every session and turn, and `listSessions` limited to that agent's own sessions (OpenCode records `agent` on the session).

## Free-only

The Gate's OpenCode backend is `freeOnly` by default. A model is free when the server prices input and output at zero and the catalog has not marked it `deprecated`. Create and edit refuse anything else (`model_not_free`, `unknown_model`); a Bot with no pin is pinned to the server's default if that is free, else the first free model, so it can never drift onto a paid model if a key is added later; a scoped turn or new session naming a paid model is refused the same way. The app only offers rows the Gate flagged `free`. `listModels` also stops offering `deprecated` models (the server lists them; the provider no longer answers).

## Constraints that shaped it

- The server reads agent files once per instance, so a write is invisible until `POST /global/dispose`. Dispose drops in-flight work, so the Gate refuses (409 `backend_busy`) while any session is busy rather than interrupt a turn, and removes or restores the file it just wrote if the reload is refused or the agent does not appear.
- `PATCH /config` was rejected as the write path: it lands in the *project* config of whatever directory the server was started in and does not appear in `GET /agent` until a reload.
- The agents directory is asked of the server (`GET /path` → `config`), not derived from the Gate's environment: the Gate attaches to a server someone else may have started.
- An edit can only rewrite an agent that is a file the Gate can see (409 `bot_not_editable` otherwise — e.g. one defined in `opencode.json`). A model pin can be replaced, never cleared (null is ignored).

## Not carried over

OpenCode Bots have no listen key, memory files, skills or `[bot:<name>]` routines — those are Hermes profile features. Runs (`startRun`) are Hermes-only; chat goes through the streaming turn path. The roster tags the runtime; the app hides what an OpenCode Bot cannot do rather than offering it and failing.

## Rejected

- A Gate-owned agent table (ADR 0004 option B as written): invents identity the server already holds and drifts from it.
- A virtual backend per Bot (ADR 0009 option B): backends keep meaning CLI environments.
