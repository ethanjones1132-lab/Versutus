# Provider Configuration Guide

This guide explains how to configure AI model providers for the Versutus Gate.

## Overview

Each provider is a JSON file at `gate/registry/<id>.json`. The Gate loads every instance in `gate/registry/` at startup and exposes provider models through the gateway manifest.

## Creating a New Provider

Use the CLI to scaffold a provider:

```bash
node gate/cli.mjs add <id> --flavor <flavor>
```

- `<id>`: Provider identifier (lowercase alphanumeric + hyphens, e.g., `my-openai`, `claude-anthropic`)
- `<flavor>`: Implementation template (`openai`, `anthropic`, or `custom`)

This creates `gate/registry/<id>.json` with a template.

## Configuration Fields

Each provider configuration must define the following:

### Top-Level Fields

#### `kind`
Must be the string `"provider"`. This identifies the capability type.

Example:
```json
"kind": "provider"
```

#### `label` (string)
A human-readable name for the provider, shown in UI and logs.

Example:
```json
"label": "My AI Provider"
```

#### `id` (derived from filename)
A unique identifier for the provider is derived from the JSON filename. For example, a file at `gate/registry/my-provider.json` has the id `my-provider`. The id must be lowercase alphanumeric with hyphens. Do not include an `id` field inside the JSON file — it is determined by the filename alone.

### `config` (object, exported)

The configuration object with the following required fields:

#### `flavor`
The implementation template to use. One of:
- `openai`: OpenAI-compatible chat completions API (models via POST to `/chat/completions`)
- `anthropic`: Anthropic-specific implementation
- `custom`: Custom implementation with full control

Example:
```json
"flavor": "openai"
```

#### `baseUrl`
The API endpoint base URL. Must use HTTPS (no HTTP).

Example for OpenAI:
```json
"baseUrl": "https://api.openai.com/v1"
```

Example for Anthropic:
```json
"baseUrl": "https://api.anthropic.com"
```

Example for a self-hosted server:
```json
"baseUrl": "https://my-llm-server.example.com/v1"
```

#### `apiKeyEnv`
The name of the environment variable containing the API key. The key is **never stored in code** — only the environment variable name is recorded in the config.

Example:
```json
"apiKeyEnv": "OPENAI_API_KEY"
```

The Gate loads the actual key from `process.env['OPENAI_API_KEY']` at runtime.

#### `models`
An array of available model IDs. Must be non-empty.

Example:
```json
"models": ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"]
```

Example for Anthropic:
```json
"models": ["claude-3-opus-20240229", "claude-3-sonnet-20240229"]
```

#### `streaming` (boolean, optional)
Whether the upstream API supports server-sent events for streaming responses. Defaults to `true` if omitted.
Set to `false` only if the provider does not support streaming — the Gate will refuse streaming requests to
providers that did not explicitly declare it as available.

Example:
```json
"streaming": true
```

Example (disabling streaming):
```json
"streaming": false
```

Note: The `capabilities` field does not exist in the input config. However, the manifest output (produced by `toManifestEntry()`)
will include a `capabilities` field derived from this `streaming` value and other provider metadata.

## Full Example

### OpenAI Provider

**File:** `gate/registry/openai-prod.json`

```json
{
  "kind": "provider",
  "label": "OpenAI Production",
  "config": {
    "flavor": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "models": [
      "gpt-4-turbo-preview",
      "gpt-4",
      "gpt-3.5-turbo"
    ],
    "streaming": true
  }
}
```

**Set the environment variable:**
```bash
export OPENAI_API_KEY=sk-...
```

**Start the Gate:**
```bash
node gate/cli.mjs start
```

### Anthropic Provider

**File:** `gate/registry/claude.json`

```json
{
  "kind": "provider",
  "label": "Anthropic Claude",
  "config": {
    "flavor": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "models": [
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307"
    ],
    "streaming": true
  }
}
```

**Set the environment variable:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Custom Provider

**File:** `gate/registry/custom-llm.json`

```json
{
  "kind": "provider",
  "label": "Custom LLM Server",
  "config": {
    "flavor": "custom",
    "baseUrl": "https://my-llm-server.example.com/v1",
    "apiKeyEnv": "CUSTOM_LLM_TOKEN",
    "models": [
      "my-model-1",
      "my-model-2"
    ],
    "streaming": true
  }
}
```

## Validation

The Gate validates all provider configurations on startup:

- `flavor` must be one of `openai`, `anthropic`, `custom`
- `apiKeyEnv` must be a non-empty string (not a literal key)
- `models` must be a non-empty array
- `baseUrl` must start with `https://` (TLS required)

If validation fails, the provider is skipped with a logged reason.

## Runtime Secrets

API keys are loaded at runtime from environment variables. This means:

- Never commit API keys to the repository
- Always use environment variables for secrets
- Set environment variables before starting the Gate

Example setup:
```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
node gate/cli.mjs start
```

## Accessing the Gateway

Once the Gate is running, access the manifest:

```bash
curl http://127.0.0.1:8760/.well-known/gateway.json
```

The manifest lists all loaded providers and their models:

```json
{
  "providers": [
    {
      "id": "openai-prod",
      "label": "OpenAI Production",
      "models": ["gpt-4-turbo-preview", "gpt-4", "gpt-3.5-turbo"],
      "capabilities": { "chat": true, "streaming": true }
    }
  ]
}
```

Get all models across all providers:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8760/v1/models
```

Get models for a specific provider:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8760/p/openai-prod/v1/models
```

The bearer token is printed when the Gate starts.

## Troubleshooting

### Provider not loading
- Check that the instance file exists: `gate/registry/<id>.json`
- Check the Gate startup logs for validation errors
- Ensure all required fields are present in `config`

### Invalid flavor
- Ensure `config.flavor` is one of: `openai`, `anthropic`, `custom`

### Invalid baseUrl
- Ensure `baseUrl` starts with `https://` (HTTP is not allowed)
- Check that the URL is reachable from your network

### Missing API key
- Ensure the environment variable is set before starting the Gate
- Check the variable name matches `apiKeyEnv` in the config
- Verify the key is correct and has not expired

### Empty models array
- At least one model ID must be listed in `config.models`
- Model IDs should match the provider's official model names
