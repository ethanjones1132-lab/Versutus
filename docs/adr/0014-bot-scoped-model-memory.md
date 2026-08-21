# 0014 — Bot-scoped model memory

Changing the model while inside a Bot conversation must not rewrite configurable chat's model. `GatewayProfile.backendModels` is keyed by CLI environment; a Bot is a selector on Hermes, not a backend (ADR 0009).

Store Bot picks in `GatewayProfile.botModels[botId]`. `effectiveModel(gateway, backendId, botId)` prefers `botModels[botId]` when a Bot is selected, else `backendModels[backendId]`, else `gateway.model`. `withSelectedModel` for a Bot writes **only** `botModels` — it does not clobber `gateway.model` or `backendModels`. Sends use `effectiveModel`, never a stale `gateway.model`.

In-session change is a per-request override Hermes already honors (`model` / `provider` on chat). It does not write that Bot's `config.yaml`. Profile pin at New Agent time is a separate create-time CLI write.

## Rejected

- Reusing `backendModels[hermes-local]` for the active Bot — configurable chat and Researcher would steal each other's model.
- Writing `gateway.model` on a Bot pick — every send path still reads that field.
