# Hermes Bots — talk-to-existing (slice 1)

Date: 2026-08-19
Status: Approved; implementation plan in `docs/superpowers/plans/2026-08-19-hermes-bots-talk.md`

After this runtime is proven, the next work is already decided (ADR 0007), in order:

1. New Agent from the phone (name, soul, inherit-or-empty provider keys, model pin)
2. Routines pane
3. `@mention`
4. Group chats

Avatars and full desktop-parity polish stay after those four. Non-Hermes CLI rows in the roster stay deferred (ADR 0004 option B).

---

## Problem

Hermes Desktop Bot Mode (v0.20.3) turns each Hermes profile into a named Bot: soul, provider/model pin, avatar, sessions, crons, and bot-to-bot handoff. Versutus still treats the attached Hermes as one agent — one session list on the unprefixed listener. Desktop Bots are invisible. The Phase 7 handoff (`GET /api/bots` over `runner.adapters`) described **channels** (Discord/Telegram), which is the wrong object.

This slice puts Hermes Bot Mode on the phone as **talk-to-existing**: a roster of Bots already configured on the desktop, and chat into them. It does not create Bots, edit souls, or port `@mention`.

## Language

See `CONTEXT.md`. Short:

- A **Bot** is a Hermes profile. Not a channel, not a backend, not a **gateway profile**.
- **Configurable chat** is the first roster row: model picker, sessions, CLI backend. Not a Bot.
- **Bot Chat** is a Bot's canonical forever-chat.
- A **listen key** is that profile's `API_SERVER_KEY`. Not a provider credential.

## Architecture

- Hermes is the system of record. The Gate inventories profiles and fronts multiplex. The phone has one gateway profile (the Gate). ADRs 0004, 0005, 0009.
- Backend = runtime (ADR 0003). Bot = selector on the Hermes backend: `backendId` + `bot=<id>`. Omitted `bot` is unprefixed configurable chat. `bot=default` is the Bot door onto the default profile (ADR 0013). Not a virtual backend. Not nested `/v1/bots/{id}/chat`.
- Named chat is `/p/<id>/` with that Bot's listen key. Multiplex off: fail honestly, do not write `config.yaml`, do not spawn a second Hermes (ADRs 0005, 0008).
- Listen keys: Gate reads **only** `API_SERVER_KEY` from each profile `.env` (including `~/.hermes` for `default`), vaults it, refreshes on inventory. Never copy provider keys, OAuth, messaging tokens, or SOUL (ADR 0006; narrow exception to ADR 0002).
- Chat tab **is** the roster. It does not resume the last session (ADR 0010). Configurable chat first; every Bot including `default` underneath (ADR 0013). Tap a Bot → Bot Chat. From there, that Bot's session list and New session (parallel thread, same profile). Bot Chat is never forked (ADR 0012). `/new`→compact in Bot Chat is not required for this slice; do not use `/new` to replace Bot Chat.

## Data flow

**Tab open.** Gate inventories `hermes profile list` (every profile, including `default`), reads listen keys, vaults them. App renders configurable chat, then Bots. No session resume.

**Configurable chat.** Today's conversation: `backendId` + model + that backend's sessions. `bot` omitted.

**Tap a Bot.** `backendId` = owning Hermes, `bot=<id>`. Gate uses `/p/<id>/` and that listen key. Find or create pinned Bot Chat (same identity Hermes Desktop uses — derive, do not invent a second title/flag); open it. Session switcher is that Bot only. New session `POST`s with the same `bot=`. Tapping a Bot does not depend on which backend configurable chat last used.

**Back to roster.** Leaves the composer; sessions remain. Next tab open is the roster again.

## Gate surface

**Inventory**

- `GET /v1/bots`, allowlisted, `resolveBackendFor('listBots')` (not position-based `resolveBackend`).
- Hermes adapter declares `'bots'`. Manifest `endpoints.bots` when `backendCan('bots')`.
- `hermes profile list` + listen key from each `.env`. No Python `/api/bots`. No `runner.adapters`.
- Item: profile id, display name, `routable` (listen key present). Last-activity only if already cheap. Missing key → listed, not routable.
- `bots.list` RPC exists iff the endpoint is advertised. No Home capability group until that pair exists.

**Conversation**

- Existing `/v1/sessions`, messages, chat/stream, jobs keep `backendId`.
- Hermes: optional `bot=<id>` (query/body). Set → prefix + listen key. Omitted → unprefixed. `bot=default` is prefixed, never collapsed to omitted.

## App

- Chat tab opens the roster, not last session.
- Row 1: configurable chat.
- Following rows: every Bot including `default`. Configurable chat and the `default` Bot are two doors into the same home (runtime vs Bot Chat).
- Tap Bot → Bot Chat. Session switcher + New session stay on that Bot. Bot Chat pinned and distinct.
- If Hermes is absent, configurable chat still works; Bots section empty with a reason.

## Errors

- Inventory failure → Bots empty, Chat tab alive.
- One profile's listen-key read fails → that row degraded; others load.
- Multiplex off + `bot` set → explicit error and host enable command; no config write.
- Unknown `bot` → 404, not silent default.
- Stale listen key → 401 attributed to that Bot, not “Gate is down.”
- Hermes down → backend-down on that Bot; configurable chat on another backend still works.
- Bot Chat missing → create and pin; create failure stays on roster.
- New session failure → stay in Bot Chat.
- Never fall back `bot=researcher` to unprefixed default.
- Never spawn a second Hermes on the same home.

## Verification

**Gate.** Inventory includes `default`; listen keys vaulted; no provider-shaped secrets. `/v1/bots` allowlisted and `resolveBackendFor('listBots')`. Absent Hermes → empty list, not 500. `bot=researcher` → `/p/researcher/` with that key. Omitted `bot` unprefixed. `bot=default` prefixed. Unknown bot 404. Multiplex off + `bot` → explicit error. Advertise/dispatch pair. Allowlist and `CAPABILITY_BACKING` drift tests.

**App.** Roster order. Tab does not auto-resume. Tap → Bot Chat. New session keeps `bot=`.

**Live.** `npm run verify`. Restart Gate (`node gate/cli.mjs start`). Real Hermes: desktop Bots appear; configurable chat works; tap Researcher → Bot Chat; New session is a second Researcher thread; default Bot and Chat row both work and differ. Device: Chat-tab paths are the SSE-`body` class — Node does not prove the phone. Device pass (or §2.1 probe) before claiming done.

## Non-goals (this slice)

- New Agent, soul editor, inherit-or-empty provider keys, model pin from the phone
- Routines pane, `@mention`, group chats
- Avatars (pass through a URL if Hermes already has one; do not generate)
- Codex/Claude/OpenCode as Bots
- Gate writes to Hermes `config.yaml`
- Python `/api/bots` / `runner.adapters`
- One gateway profile per Bot
- `/new`→compact inside Bot Chat (must not fork; compact itself can wait)

## Related

- ADRs 0004–0013 (`docs/adr/`)
- `CONTEXT.md`
- `docs/handoff-phase7-bots-2026-08-19.md` — keep as a warning: that document's object was channels, not Bots
