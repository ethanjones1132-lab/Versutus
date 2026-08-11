# Provider Configuration Guide

This guide explains how to configure AI model providers for the Versutus Gate.

## Overview

Each provider is a directory under `gate/providers/<id>/` containing a `provider.mjs` file. The Gate loads these providers at startup and exposes their models through the gateway manifest.

## Creating a New Provider

Use the CLI to scaffold a provider:

```bash
node gate/cli.mjs add <id> --flavor <flavor>
```

- `<id>`: Provider identifier (lowercase alphanumeric + hyphens, e.g., `my-openai`, `claude-anthropic`)
- `<flavor>`: Implementation template (`openai`, `anthropic`, or `custom`)

This creates `gate/providers/<id>/provider.mjs` with a template.

## Configuration Fields

Each provider configuration must define the following:

### `id` (string, exported)
A unique identifier for the provider. Must be lowercase alphanumeric with hyphens.

Example:
```javascript
export const id = 'my-provider';
```

### `label` (string, exported)
A human-readable name for the provider, shown in UI and logs.

Example:
```javascript
export const label = 'My AI Provider';
```

### `config` (object, exported)

The configuration object with the following required fields:

#### `flavor`
The implementation template to use. One of:
- `openai`: OpenAI-compatible chat completions API (models via POST to `/chat/completions`)
- `anthropic`: Anthropic-specific implementation
- `custom`: Custom implementation with full control

Example:
```javascript
flavor: 'openai'
```

#### `baseUrl`
The API endpoint base URL. Must use HTTPS (no HTTP).

Example for OpenAI:
```javascript
baseUrl: 'https://api.openai.com/v1'
```

Example for Anthropic:
```javascript
baseUrl: 'https://api.anthropic.com'
```

Example for a self-hosted server:
```javascript
baseUrl: 'https://my-llm-server.example.com/v1'
```

#### `apiKeyEnv`
The name of the environment variable containing the API key. The key is **never stored in code** — only the environment variable name is recorded in the config.

Example:
```javascript
apiKeyEnv: 'OPENAI_API_KEY'
```

The Gate loads the actual key from `process.env['OPENAI_API_KEY']` at runtime.

#### `models`
An array of available model IDs. Must be non-empty.

Example:
```javascript
models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo']
```

Example for Anthropic:
```javascript
models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229']
```

#### `capabilities`
What the provider actually supports. `chat` must be `true`. Set `streaming: true`
only if the upstream API supports server-sent events for this endpoint — the
Gate will refuse a streaming request to a provider that didn't declare it.

Example:
```javascript
capabilities: { chat: true, streaming: true }
```

## Full Example

### OpenAI Provider

**File:** `gate/providers/openai-prod/provider.mjs`

```javascript
export const id = 'openai-prod';
export const label = 'OpenAI Production';

export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  models: [
    'gpt-4-turbo-preview',
    'gpt-4',
    'gpt-3.5-turbo',
  ],
  capabilities: { chat: true, streaming: true },
};
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

**File:** `gate/providers/claude/provider.mjs`

```javascript
export const id = 'claude';
export const label = 'Anthropic Claude';

export const config = {
  flavor: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  models: [
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ],
  capabilities: { chat: true, streaming: true },
};
```

**Set the environment variable:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Custom Provider

**File:** `gate/providers/custom-llm/provider.mjs`

```javascript
export const id = 'custom-llm';
export const label = 'Custom LLM Server';

export const config = {
  flavor: 'custom',
  baseUrl: 'https://my-llm-server.example.com/v1',
  apiKeyEnv: 'CUSTOM_LLM_TOKEN',
  models: ['my-model-1', 'my-model-2'],
  capabilities: { chat: true, streaming: true },
};
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
- Check that the provider directory exists: `gate/providers/<id>/provider.mjs`
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
