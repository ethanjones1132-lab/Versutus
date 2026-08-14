# CLI environments

A CLI environment is an optional execution attachment. It is not a provider and cannot own credentials or catalogs.

## Adapters

| Adapter | Probe | Notes |
|---|---|---|
| Codex | JSONL, version `0.142.x` | App-server stays behind schema fingerprint |
| Claude Code | stream JSON, `2.1.x` | `--bare` is never used to scrape OAuth |
| Hermes | ACP, `0.18.x` | Hermes is a gateway/agent/CLI, never an xAI provider |
| OpenCode | ACP (`opencode acp`), `1.17.x`–`1.18.x` | JSON `run --format json` is machine-readable; never pass `--auto` |

Unknown versions fail closed. Interactive-only operations require desktop presence and emit `terminal.chunk` text only.

## Policy

Runs get a sanitized environment plus `VERSUTUS_CLI_INVOCATION_TOKEN`. Inherited `*_API_KEY` values are dropped. Workspace roots are canonical; UNC/device paths are rejected. Unknown approvals deny. Cancel terminates the Windows Job Object and emits one `run.cancelled`.
