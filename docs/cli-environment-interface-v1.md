# CLI environment interface v1

A CLI environment is an optional execution attachment. It references providers and models. It never owns credentials or catalogs.

## Adapter contract

Adapters declare exact operations, input schemas, risk class, and whether the operation is machine-readable. Probe executable identity/version plus the native handshake. Do not parse `--help`. Unknown CLI or protocol versions are `incompatible`.

Supported initial probes: Hermes ACP, Codex JSONL, Claude stream JSON. Codex app-server is accepted only when its generated schema fingerprint matches the adapter fixture.

## Normalized events

`run.started`, `message.delta`, `tool.started`, `tool.output`, `approval.required`, `artifact.created`, `diagnostic`, `terminal.chunk`, `usage`, `run.completed`, `run.failed`, `run.cancelled`.

Each event has `runId`, monotonic `sequence`, `timestamp`, `type`, and `payload`. A run emits exactly one terminal `run.*` event.

## Prohibited

- Arbitrary-argument RPC. Remote callers invoke named, schema-bound operations only.
- Semantic parsing of terminal prose. Unstructured output is `terminal.chunk` text. Exit code is the only machine result for `machineReadable:false` operations.
- Inferring auth, health, models, approvals, or success from text.
- Passing `--yolo`, danger/sandbox bypass, `never`, `dontAsk`, or equivalent flags.

## Fallback terminal

`conpty` is local-visible only. Confirmations stay inside the visible terminal. Desktop presence is required before start.
