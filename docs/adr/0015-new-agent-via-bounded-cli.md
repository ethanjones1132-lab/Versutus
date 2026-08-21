# 0015 — New Agent via bounded `hermes profile create`

Creating a Bot from the phone is `hermes profile create` with a **fixed argv** plus file writes the Gate already owns (SOUL.md, listen key). Not the dashboard (port 9119, different auth), not Python `/api/bots`, not arbitrary CLI RPC (ADR 0002).

Allowed argv only: `profile create <name>` plus `--clone-from default` (inherit provider keys), `--description`, `--no-alias`. Empty keys = no clone. After create: write SOUL.md if provided; ensure a **distinct** `API_SERVER_KEY` even when cloning (named prefixes reject the default listen key); optional `hermes -p <name> config set model.default` / `model.provider` for the pin.

Cannot create or delete `default`. Name is a directory id (alphanumeric, hyphen, underscore).
