# Hermes Bots — create, model, routines, mentions, groups

Date: 2026-08-21
Status: Plan in `docs/superpowers/plans/2026-08-21-hermes-bots-create-and-collaborate.md`

After slice 1 (talk-to-existing) the next work is already decided (ADR 0007), plus in-session Bot model changes:

1. Change the selected Bot's model inside a chat session (ADR 0014)
2. New Agent from the phone — name, soul, inherit-or-empty provider keys, model pin (ADR 0015)
3. Routines pane
4. `@mention`
5. Group chats

Avatars and Codex-as-Bot stay later.

## Architecture (unchanged)

A Bot is a Hermes profile. `backendId` + `bot=<id>` (ADRs 0004–0009, 0013). Gate does not write Hermes `config.yaml` except the bounded New Agent pin (`hermes -p <name> config set`). Multiplex off still fails honestly (ADR 0008). Listen keys only from `.env` (ADR 0006). Distinct listen key per Bot even when inheriting provider keys.

## 1. In-session Bot model

Chat header model chip is visible on a Bot surface, not only configurable chat. Pick writes `botModels[botId]`. Send uses `effectiveModel(gateway, backendId, botId)`. Does not change configurable chat's model. Does not persist into that profile's `config.yaml`.

## 2. New Agent

Roster control opens a sheet: name (required), soul (optional), inherit keys from `default` vs empty, optional model/provider pin. Gate `POST /v1/bots` runs bounded `hermes profile create`. Then SOUL.md, distinct `API_SERVER_KEY`, optional config set. Response is the public bot; app refreshes roster and may open Bot Chat.

## 3. Routines

Jobs routes take `bot=`. A pane in Bot chat lists/creates/pauses/runs jobs on that profile. New jobs are named `[bot:<id>] <title>`. This is the existing Jobs API via `forBot`, not a new scheduler.

## 4. Mentions

Composer `@` suggests roster Bot ids (not configurable chat, not groups). Unknown `@` is left as text. Send stays in the current Bot Chat. Gate also posts the handoff into the mentioned Bot's Bot Chat with Desktop's prefix `Message from 🤖 <sender> (@<sender>):` so delivery does not depend on `bot_mode_protocol` being injected on the API path.

## 5. Groups

A **group** is a Gate-owned roster row (2–6 Bots) stored under Gate home, not a Hermes plugin file. Opening it ensures each member has a session titled `Group: <name>`. A user send fans out serial member turns (cap: 3 rounds, 10 messages) onto those sessions. Replies render attributed. Cross-machine groups are out.

## Non-goals

- Avatars / image.generate
- `/new` → compact in Bot Chat
- Codex/Claude/OpenCode as Bots
- Gate flipping `gateway.multiplex_profiles`
- Dashboard (9119) as the create path
