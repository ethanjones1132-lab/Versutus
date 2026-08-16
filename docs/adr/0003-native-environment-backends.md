# 0003 — Native environment backends

Supersedes ADR 0002 on credential and catalog ownership. Everything else in 0002 stands.

A **backend** is something the app can hold a conversation with. There are two kinds:

- **Environment backend** — a native agent CLI (OpenCode, Codex, Claude Code, Hermes) supervised by
  the Gate and proxied to. It owns its own sessions, model catalog, tools and approvals.
- **Direct provider backend** — a plain HTTP model endpoint (NVIDIA NIM). Chat only.

The Gate translates a backend's native API into the manifest endpoints the app already speaks. It
does not reimplement sessions, tool execution or approvals that the platform already has.

## What changed from 0002

0002 held that a CLI environment "must not store credentials, tokens, catalogs". That was right when
an environment was only an execution attachment. It is wrong for a backend: OpenCode already holds
credentials for seven providers and reaches 577 models on this desktop, and reproducing that in the
Gate would be duplicate bookkeeping that drifts.

- An environment backend **owns its catalog**. The Gate surfaces it; it does not mirror it.
- An environment backend **may hold its own credentials**. The Gate discovers what the CLI already
  has and only provisions what is missing.

## Invariants

- Credentials reach a CLI **only by deliberate binding**, never by inheritance. `buildCliEnvironment`
  strips every inherited `*_API_KEY`; bound keys are injected explicitly from the DPAPI vault.
- **Attach before spawn.** A second native server against one data directory corrupts it — observed
  as `SQLiteError: no such column: replacement_seq` until every instance was stopped. A server the
  Gate attached to is never terminated by the Gate.
- Capabilities are advertised **only when a backend provides them**. No backend, no `sessions` or
  `tools` in the manifest.
- Event translation is driven by **observed** events, not the published union. OpenCode's OpenAPI
  lists 87 event variants across two generations; only one generation fires on 1.18.x.
- Unknown adapter, CLI or protocol versions still fail closed (0002).
- Still no `--yolo`, danger, sandbox-bypass, `never` or `dontAsk` flags (0002).
- The Gate still runs as the logged-in user with DPAPI CurrentUser custody (0002).

## Rejected

- Mirroring an environment's model catalog into Gate provider records — duplicate state that drifts
  the moment the CLI adds a provider.
- Reimplementing run execution in the supervisor when the CLI ships a server that already does it,
  with sessions and tools attached.
- Making a direct provider depend on a CLI being installed. NVIDIA-only chat must keep working with
  no environment present.
