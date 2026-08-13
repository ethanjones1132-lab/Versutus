# Capability Configuration Guide

This guide explains how to register new capabilities for the Versutus Gate — both
adding an instance of an existing capability kind (common, config-only) and
authoring a brand-new kind (rare, a small amount of code).

## Two Tiers: Kinds and Instances

- **Kind** — a category of thing the Gate can do (`provider`, and any others
  that get added later). Defined once, in code, at
  `gate/core/capabilities/<kind>/kind.mjs`.
- **Instance** — one configured, named instance of a kind (e.g. "my nvidia
  chat provider"). Defined by config only, at `gate/registry/<id>.json`. No
  code.

Registering a new *instance* of an already-existing kind is the common case
and needs no code at all. Authoring a new *kind* is rarer and is the only
place a model writes real logic.

## Adding an Instance (common case)

```bash
node gate/cli.mjs add <id> --kind <kind-id>
```

- `<id>`: instance identifier (lowercase alphanumeric + hyphens, e.g.
  `my-openai`, `standup-reminder`). This becomes the filename —
  `gate/registry/<id>.json` — never a field inside the file itself.
- `<kind-id>`: an already-registered kind, e.g. `provider`.

This creates `gate/registry/<id>.json`, pre-filled with one entry per field
the kind declares in its `configFields`, using each field's declared
`default` where one exists and a type-appropriate placeholder otherwise
(empty string, empty list, `0`, `false`, the first `enum` option, or
`ENV_VAR_NAME_HERE` for a `secret-ref`). Fill in real values inside the
`config` block; do not add or remove keys, and do not add an `id` field.

### Instance file shape

```json
{
  "kind": "<kind-id>",
  "label": "<human-readable name>",
  "config": {
    "...": "one entry per the kind's configFields"
  }
}
```

## Adding a New Kind (rare — the only place a model writes code)

```bash
node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>
```

- `<kind-id>`: lowercase alphanumeric + hyphens, e.g. `cron`, `memory`.
- `<label>`: human-readable name shown in UI/logs.
- `<family>`: the capability group this kind belongs to for the app's
  capability snapshot (often the same as `<kind-id>`, but doesn't have to
  be — several kinds can share one family).

This creates `gate/core/capabilities/<kind-id>/kind.mjs`, scaffolded with
the required fields (below) as empty stubs. Fill in the stubs; do not
restructure the file, add new top-level exports, or rename the existing
ones.

### The kind contract

Every `kind.mjs` exports a default object with exactly these fields:

```ts
export default {
  kind: string,                 // matches the directory name
  label: string,
  family: string,
  configFields: FieldDescriptor[],
  validate(config) -> { ok: boolean, errors: { field: string, message: string }[] },
  toManifestEntry(instance) -> object,   // what this instance advertises in the manifest
  createHandlers(instance) -> Record<string, (params) => unknown>,  // RPC methods, or {} if none
};
```

`configFields` describes each config field declaratively:

```ts
type FieldDescriptor = {
  key: string;
  label: string;
  type: 'string' | 'string-list' | 'number' | 'boolean' | 'enum' | 'secret-ref';
  required?: boolean;
  options?: string[];   // enum only
  default?: unknown;
  help?: string;
};
```

Use `type: 'secret-ref'` for any field that holds a credential's *reference
name*, never the credential itself — the actual value is set separately,
through the Gate's secret store (`registry.secrets.set`), and is never
written into `gate/registry/<id>.json`.

`validate(config)` should name every violated rule with a `field` and
`message`, not just the first one — that's what lets the app render a
helpful, specific error next to the offending form field.

`createHandlers(instance)` returns RPC methods local to this one instance,
e.g. `{ run: async () => {...} }` — the Gate automatically prefixes each key
with the instance's id (`<instance-id>.run`) before it becomes callable, so
you never need to worry about colliding with another instance's method
names, even of the same kind. Return `{}` if this kind has no RPC surface
of its own (e.g. `provider`, whose "surface" is the Gate's dedicated chat
HTTP routes, not generic RPC).

## Worked Example: `provider`

`provider` is the one kind the Gate ships today — an LLM chat backend. Its
`configFields` are `flavor` (enum: `openai`/`anthropic`/`custom`), `baseUrl`
(string), `apiKeyEnv` (secret-ref), `models` (string-list), and `streaming`
(boolean, default `true`).

```bash
node gate/cli.mjs add my-openai --kind provider
```

produces `gate/registry/my-openai.json`:

```json
{
  "kind": "provider",
  "label": "My-openai",
  "config": {
    "flavor": "openai",
    "baseUrl": "",
    "apiKeyEnv": "ENV_VAR_NAME_HERE",
    "models": [],
    "streaming": true
  }
}
```

Fill in the real values:

```json
{
  "kind": "provider",
  "label": "OpenAI Production",
  "config": {
    "flavor": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "models": ["gpt-4-turbo-preview", "gpt-4", "gpt-3.5-turbo"],
    "streaming": true
  }
}
```

Set the environment variable (or use `registry.secrets.set` from the app
instead — either works, the secret store is checked first):

```bash
export OPENAI_API_KEY=sk-...
node gate/cli.mjs start
```

## Validation

Every instance is validated against its kind's `validate()` on load. A
config that fails validation is skipped with a logged reason — it never
takes down the Gate or any other instance.

For `provider` specifically:
- `flavor` must be one of `openai`, `anthropic`, `custom`
- `apiKeyEnv` must be a non-empty string (never a literal key)
- `models` must be a non-empty array
- `baseUrl` must start with `https://` (loopback addresses are exempt, for
  local testing)

## Accessing the Gateway

```bash
curl http://127.0.0.1:8760/.well-known/gateway.json
```

The manifest lists every registered kind's schema (`capabilityKinds`) and
every configured instance (`capabilityInstances`), plus, for backward
compatibility, a `providers[]` array derived from instances of kind
`provider`:

```json
{
  "providers": [
    { "id": "my-openai", "label": "OpenAI Production", "models": ["..."], "capabilities": { "chat": true, "streaming": true } }
  ],
  "capabilityKinds": [
    { "id": "provider", "label": "Model provider", "family": "provider", "configFields": ["..."] }
  ],
  "capabilityInstances": [
    { "id": "my-openai", "kind": "provider", "label": "OpenAI Production", "family": "provider", "manifestEntry": {} }
  ]
}
```

Call any registered method, built-in or instance-contributed:

```bash
curl -X POST http://127.0.0.1:8760/v1/capabilities/rpc \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"method":"registry.instances.list"}'
```

Get all models across all provider instances:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8760/v1/models
```

## Troubleshooting

### An instance isn't loading
- Check that the file exists: `gate/registry/<id>.json`
- Check the Gate startup logs for a validation error
- Call `registry.instances.list` over RPC — a skipped instance's reason
  is visible there

### `add` fails with "kind not found"
- The kind hasn't been scaffolded yet — run `add-kind` first, or check the
  kind id for typos

### A provider's API key isn't found
- Check the environment variable name matches `apiKeyEnv` in the config,
  or that a secret was set for that same name via `registry.secrets.set`
- The secret store is checked first, `.env` second — either can supply it
