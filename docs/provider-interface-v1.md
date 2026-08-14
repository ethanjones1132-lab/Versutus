# Versutus provider interface v1

A reusable loopback provider adapter. The upstream service keeps credential custody. Gate talks only to the local adapter.

## Required endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/versutus-provider.json` | Manifest (`versutus-provider/v1`) |
| `GET` | `/v1/health` | Adapter readiness |
| `GET` | `/v1/models` | Live catalog owned by this provider |
| `POST` | `/v1/chat/completions` | Chat, optional SSE |

Unknown spec versions fail closed. Redirects, non-loopback resolution, DNS rebinding, oversized bodies, and unbounded streams are rejected.

## Manifest

```json
{
  "spec": "versutus-provider/v1",
  "id": "echo",
  "label": "Echo",
  "protocols": ["openai_chat"],
  "auth": { "schemes": ["bearer"], "credentialCustodian": "external" },
  "endpoints": {
    "health": "/v1/health",
    "models": "/v1/models",
    "chat": "/v1/chat/completions"
  }
}
```

`auth.schemes:["none"]` is allowed only on loopback and must surface a warning. Prefer an adapter-local bearer stored in the Gate vault.

## Health and catalog

Health describes the adapter, not Gate. Catalog entries are provider-owned models with `id`, optional `label`, `available`, and modality metadata. Gate may persist last-known-good data but must label it `last_known_good` or `legacy_bootstrap`, never `live`.
