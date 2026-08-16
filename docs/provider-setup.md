# Provider setup

Providers are registered on the designated Windows Gate, not in the app and not inside Hermes.

## Modes

- `api_key` — official OpenAI API, Anthropic API, NVIDIA NIM, or xAI API. Keys live in the DPAPI vault.
- `oauth` — generic PKCE/device engine. `releaseOAuthProfiles` is empty until a desktop-client contract exists. xAI consumer OAuth stays disabled.
- `local_interface` — loopback `versutus-provider/v1` adapter. Upstream keeps credential custody.

## Where state lives

Non-secret config: `%LOCALAPPDATA%\Versutus\Gate\config\providers`  
Sanitized runtime: `%LOCALAPPDATA%\Versutus\Gate\state\providers`  
Credentials: `%LOCALAPPDATA%\Versutus\Gate\credentials` (DPAPI CurrentUser)

Override for tests: `VERSUTUS_GATE_HOME`.

## App

Use **Providers** on the home dashboard. Cards show auth, readiness, and catalog source (`live`, `last_known_good`, `legacy_bootstrap`). Model selection stores `{providerId, modelId}`.
