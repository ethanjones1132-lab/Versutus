# 0002 — Provider ownership and transports

Providers own their registration, credential custody, readiness, and live or last-known-good model catalog. Hermes and every other agent are dependents. A CLI environment is an optional execution attachment, not a provider, agent, or gateway profile.

The designated Windows Gate stores non-secret provider and environment state under `%LOCALAPPDATA%\Versutus\Gate`, protects credentials with DPAPI CurrentUser, and is the only process allowed to refresh or advertise provider catalogs.

## Invariants

- Provider modes are exactly `api_key`, `oauth`, and `local_interface`.
- Agents and CLI environments may reference `{providerId, modelId}`. They must not store credentials, tokens, catalogs, or provider auth fields.
- Unknown provider, CLI, protocol, or schema versions fail closed.
- No implementation may pass `--yolo`, danger/sandbox bypass, `never`, `dontAsk`, or equivalent approval-bypass flags to a CLI.
- xAI consumer OAuth stays disabled unless xAI explicitly permits third-party automated inference with that grant. Official xAI API-key access is independent.
- The Gate runs as the logged-in user, not SYSTEM.

## Rejected

- Treating Hermes as an xAI provider or copying Hermes/Codex/Claude credential stores.
- Representing a consumer product subscription as an API connection without an official provider contract.
- Keeping the AES key beside ciphertext in the source checkout.
- Scraping terminal prose or `--help` to discover CLI operations.
- Arbitrary-argument RPC into a CLI.
- Running the Gate as SYSTEM so DPAPI CurrentUser and interactive OAuth break.
