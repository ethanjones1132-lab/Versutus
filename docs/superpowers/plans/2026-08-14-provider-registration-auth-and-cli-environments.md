# Provider Registration, Authentication, and CLI Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop-local Versutus Gate where providers own their registration, credentials, readiness, and live model catalogs across API-key, OAuth, and local-interface modes, while optional CLI environments expose the safe full capacity of supported CLIs without owning or scraping provider state.

**Architecture:** Introduce a `ProviderService` aggregate as the sole provider authority and a separate `CliEnvironmentService` whose records depend on provider/model references. Persist non-secret configuration and sanitized runtime state under `%LOCALAPPDATA%\Versutus\Gate`, protect credentials with Windows DPAPI CurrentUser, expose sanitized provider/environment APIs, and adapt external CLIs through versioned machine-readable protocols with explicit workspace, sandbox, approval, and lifecycle policies.

**Tech Stack:** Node.js ESM Gate, JSON Schema, Windows DPAPI and Job Objects, HTTP/SSE/JSONL, OAuth 2.0/OIDC, Expo/React Native/TypeScript app, Jest and Node test runner.

## Global Constraints

- Work in `C:\Projects\Versutus`; preserve unrelated worktree changes.
- Provider modes remain exactly `api_key`, `oauth`, and `local_interface`.
- A provider owns its registration, credential handle/custody state, health/readiness, and live or last-known-good model catalog.
- Hermes and all other agents are dependents; they never own, refresh, proxy, or advertise another provider's credentials or catalog.
- A CLI environment is an optional execution attachment, not a provider, agent, or gateway profile.
- Never read, copy, import, expose, log, or migrate credentials from Hermes, Codex, Claude Code, browser profiles, keychains, session databases, or inherited secret environment variables.
- Never represent a consumer product subscription as an API connection without an officially supported provider contract.
- Keep xAI consumer OAuth disabled unless xAI explicitly permits third-party automated inference with that grant; support official xAI API-key access independently.
- Run the designated Windows Gate as the logged-in user, not SYSTEM, so DPAPI CurrentUser and interactive browser authorization remain valid.
- OAuth public clients use PKCE or device authorization; no embedded client secret is treated as confidential in a desktop binary.
- Unknown provider, CLI, protocol, or schema versions fail closed.
- No implementation task may pass `--yolo`, danger/sandbox bypass, `never`, `dontAsk`, or equivalent approval-bypass options to a CLI.
- Before modifying Expo application code, read the exact versioned Expo documentation required by the repository `AGENTS.md` and reconcile it with the version in `package.json`.
- Each task follows test-first development and ends in a focused commit after its review gate passes.

## Audit Resolutions (2026-08-14)

Baseline evidence matches the tree: NVIDIA is the only registry provider, `kind.mjs` still requires `apiKeyEnv` + static `models[]`, secrets keep the AES key beside ciphertext, and ADR `0002` is unused.

Resolved without blocking:

- Work in this checkout (`C:\Projects\Versutus`) on branch `feat/provider-cli-environments`. Do not create another worktree; do not commit these tasks on `master`.
- Validators are hand-written against the JSON Schema documents. Do not add Ajv or other schema-runtime dependencies.
- `providerRuntimeV2` is not a code flag. Compatibility is Task 8's one-release legacy RPC delegation plus Task 2's copy-not-delete migration. Rollback leaves source registry files untouched and never exports the DPAPI vault.
- Task 1 rejects provider-owned fields on CLI environment records. Agent-record rejection is Task 9.
- Expo app code (Tasks 9 and 15) must follow `package.json` (`expo@~57`) and https://docs.expo.dev/versions/v57.0.0/. `AGENTS.md` still cites v56 and is stale.
- DPAPI, Job Objects, and ConPTY are injectable backends. Tests never call live CryptProtectData, create real Job Objects, or spawn the user's CLIs.
- `releaseOAuthProfiles` may ship empty. The OAuth engine is proven with `fakeOAuthIssuer()` only until a provider has an official desktop-client contract.
- Tasks 16–17 live proofs that need the installed user Gate or real provider credentials are recorded as manual; automated no-secret smoke still lands.

---

## Evidence and Current-State Baseline

- `gate/registry/nvidia.json` is the sole provider record. Its tracked static model list contains `deepseek-ai/deepseek-v4-flash-0731` and `meta/llama-3.1-8b-instruct`; DeepSeek Flash originates there and is not currently discovered from NVIDIA.
- `gate/core/capabilities/provider/kind.mjs` requires `apiKeyEnv` plus a non-empty hand-entered `models[]` and has no OAuth, local-interface, auth-state, readiness, or catalog-lifecycle model.
- `gate/core/server.mjs` returns configured strings from `/v1/models`, reports Gate-only health, and routes an unscoped request by the first provider that declares the model string.
- `gate/core/capabilities/registry-methods.mjs` writes registry JSON into the source checkout.
- `gate/core/capabilities/secrets.mjs` stores its AES key beside its ciphertext and explicitly protects only against accidental commit/backup disclosure, not local disk compromise.
- `src/app/gateway/capabilities.tsx` is a generic instance editor; it does not expose provider auth, readiness, catalog source/age, entitlement, or local-adapter status.
- `src/lib/gateway/child-sync.ts` turns providers into child `GatewayProfile` records, conflating providers with reachable gateway/agent endpoints.
- The installed Hermes Agent `0.18.0` exposes ACP, MCP, and a loopback JSON-RPC/WebSocket server. Its xAI source uses OIDC discovery plus OAuth device authorization, locked/atomic rotating refresh, proactive expiry refresh, terminal-error quarantine, and logout. Its token JSON is plaintext on Windows and must not be copied.
- Installed Codex CLI `0.142.1` exposes `exec --json`, output schemas, explicit workdir/sandbox/approval controls, MCP stdio, and an experimental schema-generating app server.
- Installed Claude Code `2.1.88` exposes bidirectional stream JSON, structured output, explicit workdir/tool/permission/session controls, and MCP server mode; `--bare` explicitly avoids OAuth/keychain reads.
- Official xAI inference documentation currently requires API-key bearer authentication and offers an authenticated models endpoint: <https://docs.x.ai/developers/rest-api-reference/inference> and <https://docs.x.ai/developers/rest-api-reference/inference/models>.
- Official OpenAI API documentation uses server-side API keys and `GET /v1/models`: <https://platform.openai.com/docs/api-reference/backward-compatibility> and <https://platform.openai.com/docs/api-reference/models/object>.
- OAuth implementation follows RFC 8414, RFC 8628, RFC 8252, and RFC 9700. DPAPI behavior follows Microsoft `CryptProtectData` documentation.

## Target Domain Contracts

### Provider registration

```ts
type ProviderRegistration = {
  schemaVersion: 2;
  kind: 'provider';
  id: string;
  label: string;
  providerType: 'openai' | 'anthropic' | 'nvidia-nim' | 'xai' | string;
  enabled: boolean;
  registration:
    | {
        mode: 'api_key';
        protocol: ProviderProtocol;
        baseUrl: string;
        credentialRef: string;
      }
    | {
        mode: 'oauth';
        protocol: ProviderProtocol;
        resourceBaseUrl: string;
        oauthProfileId: string;
      }
    | {
        mode: 'local_interface';
        protocol: 'versutus_provider_v1';
        manifestUrl: string;
        adapterCredentialRef?: string;
        credentialCustodian: 'external';
      };
  catalogPolicy: { ttlSeconds: number; allowLastKnownGood: boolean };
  requestPolicy: { timeoutMs: number };
};

type ProviderProtocol =
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'versutus_provider_v1';
```

### Provider runtime snapshot

```ts
type ProviderSnapshot = {
  id: string;
  label: string;
  providerType: string;
  mode: 'api_key' | 'oauth' | 'local_interface';
  auth: {
    state: 'missing' | 'authorizing' | 'ready' | 'refreshing' | 'needs_reauth' | 'denied' | 'disconnected';
    expiresAt?: string;
    scopes?: string[];
    credentialCustodian: 'gate' | 'external';
  };
  readiness: {
    state: 'ready' | 'degraded' | 'unavailable' | 'disabled';
    checkedAt: string;
    code?: string;
    message?: string;
  };
  catalog: {
    state: 'fresh' | 'stale' | 'unavailable';
    source: 'live' | 'last_known_good' | 'legacy_bootstrap';
    observedAt?: string;
    generation: number;
    models: ProviderModel[];
  };
};

type ProviderModel = {
  providerId: string;
  id: string;
  label?: string;
  available: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  contextLength?: number;
};
```

### CLI environment registration

```ts
type CliEnvironmentRegistration = {
  schemaVersion: 1;
  kind: 'cli-environment';
  id: string;
  label: string;
  adapterId: 'hermes' | 'codex' | 'claude-code';
  executable: { path: string; expectedPublisher?: string };
  protocolPreference: ('acp' | 'mcp' | 'app_server' | 'jsonl' | 'conpty')[];
  versionPolicy: { supported: string; adapterRevision: string };
  providerRefs: string[];
  workspacePolicy: {
    roots: string[];
    defaultRoot: string;
    defaultSandbox: 'read_only' | 'workspace_write' | 'isolated_worktree';
    allowAdditionalRoots: boolean;
  };
  lifecycle: {
    startup: 'on_demand' | 'persistent';
    idleTimeoutSeconds: number;
    maxConcurrentRuns: number;
  };
  enabled: boolean;
};
```

### CLI adapter and normalized events

```ts
type CliAdapterManifest = {
  adapterId: string;
  adapterRevision: string;
  supportedCliVersions: string;
  protocolVersions: Record<string, string>;
  capabilities: string[];
  operations: Record<string, {
    inputSchema: object;
    outputSchema?: object;
    risk: 'read' | 'workspace_write' | 'host_write' | 'network_external' | 'credential' | 'destructive';
    machineReadable: boolean;
  }>;
  probe(executablePath: string): Promise<CliProbe>;
  startRun(request: CliRunRequest, io: CliRunIo): Promise<CliRunHandle>;
};

type CliRunEvent = {
  runId: string;
  sequence: number;
  timestamp: string;
  type:
    | 'run.started'
    | 'message.delta'
    | 'tool.started'
    | 'tool.output'
    | 'approval.required'
    | 'artifact.created'
    | 'diagnostic'
    | 'terminal.chunk'
    | 'usage'
    | 'run.completed'
    | 'run.failed'
    | 'run.cancelled';
  payload: Record<string, unknown>;
};

type CliProbe = {
  state: 'ready' | 'not_installed' | 'incompatible' | 'degraded';
  executablePath: string;
  cliVersion?: string;
  protocol?: string;
  protocolVersion?: string;
  message?: string;
};

type CliRunRequest = {
  runId: string;
  environmentId: string;
  operation: string;
  providerRef: { providerId: string; modelId: string };
  workspaceId: string;
  sandbox: 'read_only' | 'workspace_write' | 'isolated_worktree';
  input: Record<string, unknown>;
};

type CliRunIo = {
  signal: AbortSignal;
  emit(event: Omit<CliRunEvent, 'runId' | 'sequence' | 'timestamp'>): void;
  requestApproval(request: Record<string, unknown>): Promise<'approve' | 'deny'>;
};

type CliRunHandle = {
  cancel(): Promise<void>;
  completed: Promise<{ state: 'completed' | 'failed' | 'cancelled'; exitCode?: number }>;
};
```

## File Responsibility Map

- `docs/adr/0002-provider-ownership-and-transports.md`: architectural invariants and rejected alternatives.
- `docs/provider-interface-v1.md`: reusable loopback provider adapter contract.
- `docs/cli-environment-interface-v1.md`: CLI adapter, run, event, approval, and fallback-terminal contract.
- `docs/schemas/provider-instance-v2.schema.json`: persisted provider registration schema.
- `docs/schemas/cli-environment-v1.schema.json`: persisted CLI environment schema.
- `gate/core/paths.mjs`: Gate home and data-path resolution.
- `gate/core/credentials/*`: DPAPI credential vault and redaction.
- `gate/core/providers/*`: provider schema, persistence, runtime, health, catalog, auth, routing, and errors.
- `gate/core/providers/profiles/*`: provider-specific official endpoint and auth policies.
- `gate/core/providers/oauth/*`: discovery, attempts, PKCE, device authorization, refresh, and revocation.
- `gate/core/providers/local/*`: local provider manifest client and loopback/SSRF enforcement.
- `gate/core/cli-environments/*`: environment persistence, adapter registry, supervisor, workspace policy, approvals, events, and process control.
- `gate/core/cli-environments/adapters/*`: Hermes, Codex, and Claude Code protocol adapters.
- `gate/core/capabilities/agent/kind.mjs`: agent dependency records that cannot contain provider credentials/catalogs.
- `src/app/gateway/providers.tsx`: provider management and lifecycle UI.
- `src/app/gateway/environments.tsx`: CLI environment management and lifecycle UI.
- `src/lib/gateway/provider-*`: app provider contracts and client state.
- `src/lib/gateway/environment-*`: app CLI environment contracts and run state.

## Test Fixture Contracts

- `validEnvironment(overrides = {})` returns a complete `CliEnvironmentRegistration` fixture and shallow-merges `overrides`; it lives in `gate/__tests__/fixtures/cli-environment.mjs`.
- `providerMigrationFixture()` creates isolated source/Gate-home temp directories and returns `{ sourceRoot, gateHome }`; tests remove the temp root in `afterEach`.
- `fakeExecutable(version, options = {})` creates a test executable shim that answers only version and native-handshake requests; it never reads the user's environment or home directories.
- `fakeOAuthIssuer()` starts a loopback issuer with deterministic discovery, PKCE, device-code, refresh-rotation, revocation, and error controls.
- `startProviderStub(options)` starts a loopback provider with deterministic health, models, chat, and SSE behavior.
- `postChat(body)` sends an authenticated request to the in-process Gate fixture.
- `collectRunEvents(runId)` consumes the environment SSE route until one terminal run event.
- `groupProviderModels(snapshots)` is the pure app selector produced in Task 15.
- `buildTaskDefinition(input)` is the pure Scheduled Task builder produced in Task 16.
- Test spies named `providerService`, `approvalService`, and `fallback` are instantiated inside their test file and never refer to live machine services.

---

### Task 1: Lock the Architecture in Contracts and Schemas

**Files:**
- Create: `docs/adr/0002-provider-ownership-and-transports.md`
- Create: `docs/provider-interface-v1.md`
- Create: `docs/cli-environment-interface-v1.md`
- Create: `docs/schemas/provider-instance-v2.schema.json`
- Create: `docs/schemas/cli-environment-v1.schema.json`
- Create: `gate/core/providers/schema.mjs`
- Create: `gate/core/cli-environments/schema.mjs`
- Create: `gate/__tests__/provider-schema-v2.test.mjs`
- Create: `gate/__tests__/cli-environment-schema.test.mjs`
- Create: `gate/__tests__/fixtures/cli-environment.mjs`

**Interfaces:**
- Produces: `validateProviderRegistration(value)` and `validateCliEnvironmentRegistration(value)`, each returning `{ ok: boolean, errors: Array<{field:string,message:string}> }`.
- Enforces: CLI environment records reject `credentials`, `tokens`, `catalog`, `models`, and provider auth fields. Agent-record rejection is Task 9.

- [x] **Step 1: Write failing schema tests**

```js
test('rejects mixed provider registration modes', () => {
  const result = validateProviderRegistration({
    schemaVersion: 2,
    kind: 'provider',
    id: 'mixed',
    label: 'Mixed',
    providerType: 'openai',
    enabled: true,
    registration: {
      mode: 'oauth',
      protocol: 'openai_responses',
      resourceBaseUrl: 'https://api.openai.com/v1',
      oauthProfileId: 'openai',
      credentialRef: 'must-not-coexist'
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 }
  });
  assert.equal(result.ok, false);
});

test('rejects provider state on a CLI environment', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({ models: ['gpt'] }));
  assert.equal(result.ok, false);
});
```

- [x] **Step 2: Run the tests and confirm the missing modules fail**

Run: `node --test gate/__tests__/provider-schema-v2.test.mjs gate/__tests__/cli-environment-schema.test.mjs`

Expected: FAIL because the validators do not exist.

- [x] **Step 3: Implement the schemas, validators, ADR, and protocol documents**

The provider interface must require `GET /.well-known/versutus-provider.json`, `GET /v1/health`, `GET /v1/models`, and `POST /v1/chat/completions`. The CLI interface must define the normalized events and explicitly prohibit arbitrary-argument RPC and semantic parsing of terminal prose.

- [x] **Step 4: Run the schema tests**

Run: `node --test gate/__tests__/provider-schema-v2.test.mjs gate/__tests__/cli-environment-schema.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit the contract slice**

```powershell
git add docs/adr/0002-provider-ownership-and-transports.md docs/provider-interface-v1.md docs/cli-environment-interface-v1.md docs/schemas gate/core/providers/schema.mjs gate/core/cli-environments/schema.mjs gate/__tests__/provider-schema-v2.test.mjs gate/__tests__/cli-environment-schema.test.mjs
git commit -m "docs(gate): define provider and CLI environment contracts"
```

### Task 2: Move Gate State Out of the Source Checkout

**Files:**
- Create: `gate/core/paths.mjs`
- Create: `gate/core/providers/store.mjs`
- Create: `gate/core/providers/migrate-v1.mjs`
- Create: `gate/__tests__/gate-paths.test.mjs`
- Create: `gate/__tests__/provider-store.test.mjs`
- Create: `gate/__tests__/provider-migration.test.mjs`
- Create: `gate/__tests__/fixtures/provider-migration.mjs`
- Modify: `gate/cli.mjs`
- Modify: `gate/core/capabilities/registry.mjs`
- Modify: `gate/core/capabilities/registry-methods.mjs`

**Interfaces:**
- Produces: `resolveGateHome(env, platform)`, `ProviderStore`, and `migrateLegacyProviders({sourceRoot, gateHome})`.
- Default home: `%LOCALAPPDATA%\Versutus\Gate`; `VERSUTUS_GATE_HOME` is an explicit override for tests/development.

- [x] **Step 1: Write failing path, atomic-store, and idempotent-migration tests**

```js
test('Windows default Gate home is outside the checkout', () => {
  assert.equal(
    resolveGateHome({ LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'win32'),
    'C:\\Users\\Test\\AppData\\Local\\Versutus\\Gate'
  );
});

test('legacy NVIDIA models are marked bootstrap, not live', async () => {
  const fixture = await providerMigrationFixture();
  const result = await migrateLegacyProviders(fixture);
  assert.equal(result.providers[0].catalog.source, 'legacy_bootstrap');
});
```

- [x] **Step 2: Run the focused tests and confirm failure**

Run: `node --test gate/__tests__/gate-paths.test.mjs gate/__tests__/provider-store.test.mjs gate/__tests__/provider-migration.test.mjs`

- [x] **Step 3: Implement data-home resolution, locked atomic writes, and migration receipts**

Write provider config to `config/providers`, sanitized state to `state/providers`, and a one-time receipt to `state/migrations/provider-v2.json`. Copy legacy records; never delete their source files during migration.

- [x] **Step 4: Verify the migration twice and after a simulated interrupted write**

Run: `node --test gate/__tests__/gate-paths.test.mjs gate/__tests__/provider-store.test.mjs gate/__tests__/provider-migration.test.mjs`

Expected: PASS with one migrated provider and no duplicate/partial record.

- [x] **Step 5: Commit the data-home slice**

```powershell
git add gate/cli.mjs gate/core/paths.mjs gate/core/providers/store.mjs gate/core/providers/migrate-v1.mjs gate/core/capabilities/registry.mjs gate/core/capabilities/registry-methods.mjs gate/__tests__/gate-paths.test.mjs gate/__tests__/provider-store.test.mjs gate/__tests__/provider-migration.test.mjs gate/__tests__/fixtures/provider-migration.mjs
git commit -m "feat(gate): persist provider state in Gate home"
```

### Task 3: Replace the Co-Located-Key Secret Store with DPAPI

**Files:**
- Create: `gate/core/credentials/vault.mjs`
- Create: `gate/core/credentials/windows-dpapi.mjs`
- Create: `gate/core/credentials/redaction.mjs`
- Create: `gate/__tests__/credential-vault.test.mjs`
- Create: `gate/__tests__/credential-redaction.test.mjs`
- Modify: `gate/core/capabilities/secrets.mjs`

**Interfaces:**
- Produces: `CredentialVault.get(ref)`, `.set(ref,value)`, `.delete(ref)`, `.has(ref)`, and `redactSensitive(value)`.
- Windows implementation uses DPAPI CurrentUser and `CRYPTPROTECT_UI_FORBIDDEN`; tests inject an in-memory vault.

- [x] **Step 1: Write failing vault tests for round-trip, tamper, delete, concurrency, and wrong-user failure**

```js
test('vault status never returns the value', async () => {
  await vault.set('provider/openai/api-key', 'secret-value');
  assert.deepEqual(await vault.describe('provider/openai/api-key'), { present: true });
});
```

- [x] **Step 2: Run the tests and confirm failure**

Run: `node --test gate/__tests__/credential-vault.test.mjs gate/__tests__/credential-redaction.test.mjs`

- [x] **Step 3: Implement DPAPI ciphertext persistence and fail-closed migration**

Use atomic replacement. Migrate an old secret only after successful old-store decryption and successful DPAPI write. Retain old files until a separately approved cleanup. Do not fall back to the old store when DPAPI fails.

- [x] **Step 4: Run the vault tests**

Run: `node --test gate/__tests__/credential-vault.test.mjs gate/__tests__/credential-redaction.test.mjs`

Expected: PASS; no test output contains fixture secret strings.

- [x] **Step 5: Commit the credential slice**

```powershell
git add gate/core/credentials gate/core/capabilities/secrets.mjs gate/__tests__/credential-vault.test.mjs gate/__tests__/credential-redaction.test.mjs
git commit -m "feat(gate): protect provider credentials with DPAPI"
```

### Task 4: Build Provider Runtime, Health, and Catalog Ownership

**Files:**
- Create: `gate/core/providers/service.mjs`
- Create: `gate/core/providers/runtime.mjs`
- Create: `gate/core/providers/health.mjs`
- Create: `gate/core/providers/catalog.mjs`
- Create: `gate/core/providers/errors.mjs`
- Create: `gate/__tests__/provider-service.test.mjs`
- Create: `gate/__tests__/provider-health.test.mjs`
- Create: `gate/__tests__/provider-catalog.test.mjs`

**Interfaces:**
- Produces: `ProviderService.list()`, `.get(id)`, `.create(input)`, `.update(id,input)`, `.delete(id)`, `.check(id)`, `.refreshCatalog(id)`, `.resolveModel(providerId,modelId)`, and `.chat(request,signal)`.
- Adapter contract: `authenticate()`, `health()`, `listModels()`, `chat()`, `disconnect()`.

- [x] **Step 1: Write failing state-machine and catalog-provenance tests**

```js
test('catalog failure yields degraded provider with visible LKG provenance', async () => {
  const snapshot = await service.refreshCatalog('nvidia');
  assert.equal(snapshot.readiness.state, 'degraded');
  assert.equal(snapshot.catalog.source, 'last_known_good');
  assert.equal(snapshot.catalog.state, 'stale');
});
```

- [x] **Step 2: Run the provider runtime tests and confirm failure**

Run: `node --test gate/__tests__/provider-service.test.mjs gate/__tests__/provider-health.test.mjs gate/__tests__/provider-catalog.test.mjs`

- [x] **Step 3: Implement the provider state machine, TTL refresh, LKG persistence, and backoff**

Map missing credentials, invalid credentials, entitlement denial, rate limits, overload, transient network errors, and disabled state to distinct codes. A Gate health response is never evidence that a provider is ready.

- [x] **Step 4: Run the provider runtime tests**

Run: `node --test gate/__tests__/provider-service.test.mjs gate/__tests__/provider-health.test.mjs gate/__tests__/provider-catalog.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit the provider runtime**

```powershell
git add gate/core/providers gate/__tests__/provider-service.test.mjs gate/__tests__/provider-health.test.mjs gate/__tests__/provider-catalog.test.mjs
git commit -m "feat(gate): add provider readiness and live catalogs"
```

### Task 5: Add Official API-Key Provider Profiles

**Files:**
- Create: `gate/core/providers/profiles/openai.mjs`
- Create: `gate/core/providers/profiles/anthropic.mjs`
- Create: `gate/core/providers/profiles/nvidia-nim.mjs`
- Create: `gate/core/providers/profiles/xai.mjs`
- Create: `gate/core/providers/profiles/registry.mjs`
- Create: `gate/__tests__/provider-profiles.test.mjs`
- Modify: `gate/flavors/openai.mjs`
- Modify: `gate/flavors/anthropic.mjs`

**Interfaces:**
- Produces provider-specific origin allowlists, auth headers, model-list parsers, health semantics, and protocol codec selection.
- Existing flavor modules become request/response codecs and stop resolving auth.

- [x] **Step 1: Write stub-server tests for auth, live models, and origin pinning**

```js
test('OpenAI profile obtains its catalog from authenticated /v1/models', async () => {
  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => model.id), ['gpt-test']);
  assert.equal(models[0].providerId, 'openai-main');
});
```

- [x] **Step 2: Run the profile tests and confirm failure**

Run: `node --test gate/__tests__/provider-profiles.test.mjs`

- [x] **Step 3: Implement profiles without external live calls**

Label the official OpenAI provider `OpenAI API`, not `ChatGPT`. Configure official xAI API-key auth independently from the disabled consumer OAuth profile. For hosted NVIDIA, use a live endpoint when supported and otherwise preserve a visibly stale bootstrap catalog.

- [x] **Step 4: Run provider profile and existing flavor tests**

Run: `node --test gate/__tests__/provider-profiles.test.mjs gate/__tests__/openai-flavor.test.mjs gate/__tests__/anthropic-flavor.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit the profile slice**

```powershell
git add gate/core/providers/profiles gate/flavors gate/__tests__/provider-profiles.test.mjs
git commit -m "feat(gate): add official API-key provider profiles"
```

### Task 6: Implement Generic OAuth Without Enabling Unapproved xAI OAuth

**Files:**
- Create: `gate/core/providers/oauth/profiles.mjs`
- Create: `gate/core/providers/oauth/discovery.mjs`
- Create: `gate/core/providers/oauth/attempt-store.mjs`
- Create: `gate/core/providers/oauth/pkce-callback.mjs`
- Create: `gate/core/providers/oauth/device-code.mjs`
- Create: `gate/core/providers/oauth/refresh.mjs`
- Create: `gate/core/providers/oauth/revocation.mjs`
- Create: `gate/__tests__/oauth-discovery.test.mjs`
- Create: `gate/__tests__/oauth-pkce.test.mjs`
- Create: `gate/__tests__/oauth-device-code.test.mjs`
- Create: `gate/__tests__/oauth-refresh.test.mjs`
- Create: `gate/__tests__/oauth-disconnect.test.mjs`
- Create: `gate/__tests__/fixtures/oauth-issuer.mjs`

**Interfaces:**
- Produces: `OAuthManager.begin(providerId)`, `.getAttempt(attemptId)`, `.cancel(attemptId)`, `.getAccess(providerId)`, and `.disconnect(providerId)`.
- Produces: `releaseOAuthProfiles`, a read-only map containing only approved production profiles.
- Attempts are in-memory, one-use, and expiry-bound. Tokens are vault-only.

- [ ] **Step 1: Write fake-issuer tests for PKCE, state, device polling, rotation, and quarantine**

```js
test('rotating refresh is single-flight and persists the newest token', async () => {
  const [first, second] = await Promise.all([
    manager.getAccess('fake-oauth'),
    manager.getAccess('fake-oauth')
  ]);
  assert.equal(fakeIssuer.refreshCalls, 1);
  assert.equal(first.accessToken, second.accessToken);
});
```

- [ ] **Step 2: Run the OAuth tests and confirm failure**

Run: `node --test gate/__tests__/oauth-*.test.mjs`

- [ ] **Step 3: Implement discovery/host pinning, PKCE callback, device flow, refresh, and disconnect**

Bind callbacks only to `127.0.0.1`; use a random port when the provider permits it. Honor `authorization_pending`, `slow_down`, expiry, refresh rotation, and revocation metadata. Terminal `invalid_grant` removes unusable token material and records `needs_reauth`; 429/5xx retains the grant and records degraded state.

- [ ] **Step 4: Assert that no production xAI consumer OAuth profile is selectable**

```js
test('xAI consumer OAuth is not a release profile', () => {
  assert.equal(releaseOAuthProfiles.has('xai-consumer'), false);
});
```

Run: `node --test gate/__tests__/oauth-*.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the generic OAuth engine**

```powershell
git add gate/core/providers/oauth gate/__tests__/oauth-discovery.test.mjs gate/__tests__/oauth-pkce.test.mjs gate/__tests__/oauth-device-code.test.mjs gate/__tests__/oauth-refresh.test.mjs gate/__tests__/oauth-disconnect.test.mjs gate/__tests__/fixtures/oauth-issuer.mjs
git commit -m "feat(gate): add provider-owned OAuth lifecycle"
```

### Task 7: Implement the Reusable Local Provider Interface

**Files:**
- Create: `gate/core/providers/local/manifest-client.mjs`
- Create: `gate/core/providers/local/ssrf-policy.mjs`
- Create: `gate/core/providers/local/adapter.mjs`
- Create: `gate/provider-sdk/conformance.mjs`
- Create: `gate/provider-sdk/example/echo-provider.mjs`
- Create: `gate/__tests__/local-provider-interface.test.mjs`
- Create: `gate/__tests__/fixtures/provider-stub.mjs`

**Interfaces:**
- Consumes the `versutus-provider/v1` document from Task 1.
- Produces a provider adapter whose external service retains upstream credential custody.

- [ ] **Step 1: Write failing conformance and attack tests**

```js
test('rejects a local provider manifest that redirects off loopback', async () => {
  await assert.rejects(() => client.discover(), /loopback|redirect/i);
});
```

- [ ] **Step 2: Run the local-interface tests and confirm failure**

Run: `node --test gate/__tests__/local-provider-interface.test.mjs`

- [ ] **Step 3: Implement manifest, health, models, chat/SSE, and loopback enforcement**

Reject redirects, DNS rebinding, non-loopback resolution, oversized headers/bodies, incompatible specs, and unbounded streams. Allow `auth.schemes:["none"]` only on loopback with an explicit warning; prefer an adapter-local bearer credential stored in the Gate vault.

- [ ] **Step 4: Run the local-interface tests and example conformance harness**

Run: `node --test gate/__tests__/local-provider-interface.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the local-interface slice**

```powershell
git add gate/core/providers/local gate/provider-sdk gate/__tests__/local-provider-interface.test.mjs gate/__tests__/fixtures/provider-stub.mjs
git commit -m "feat(gate): add reusable local provider interface"
```

### Task 8: Replace Registry Provider RPC and Model Routing

**Files:**
- Modify: `gate/core/server.mjs`
- Modify: `gate/core/manifest.mjs`
- Modify: `gate/core/capabilities/provider/kind.mjs`
- Modify: `gate/core/capabilities/registry-methods.mjs`
- Create: `gate/__tests__/providers-route.test.mjs`
- Create: `gate/__tests__/model-routing-v2.test.mjs`
- Modify: `gate/__tests__/chat-route.test.mjs`
- Modify: `gate/__tests__/manifest.test.mjs`

**Interfaces:**
- HTTP: `GET /v1/providers`, `GET /v1/providers/:id`, aggregated `GET /v1/models`.
- RPC: `providers.create/update/delete`, `providers.auth.setApiKey/begin/attempt.get/disconnect`, `providers.health.check`, and `providers.catalog.refresh`.

- [ ] **Step 1: Write failing route tests for sanitization and ambiguous model IDs**

```js
test('unscoped duplicate model requires providerId', async () => {
  const response = await postChat({ model: 'shared-model', messages: [] });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ambiguous_model');
});
```

- [ ] **Step 2: Run the route tests and confirm failure**

Run: `node --test gate/__tests__/providers-route.test.mjs gate/__tests__/model-routing-v2.test.mjs`

- [ ] **Step 3: Route all provider behavior through `ProviderService`**

Add `endpoints.providers` to the Gate manifest. Keep `/p/:providerId` compatibility routes. Make write RPC responses status-only and redact all errors. Delegate legacy registry provider calls for one compatibility release; deprecate arbitrary `registry.secrets.set`.

- [ ] **Step 4: Run all Gate route tests**

Run: `npm run test:gate`

Expected: PASS.

- [ ] **Step 5: Commit the provider API slice**

```powershell
git add gate/core/server.mjs gate/core/manifest.mjs gate/core/capabilities/provider/kind.mjs gate/core/capabilities/registry-methods.mjs gate/__tests__/providers-route.test.mjs gate/__tests__/model-routing-v2.test.mjs gate/__tests__/chat-route.test.mjs gate/__tests__/manifest.test.mjs
git commit -m "feat(gate): expose provider lifecycle and qualified models"
```

### Task 9: Enforce Agent Dependency Separation

**Files:**
- Create: `gate/core/capabilities/agent/kind.mjs`
- Create: `gate/core/providers/dependencies.mjs`
- Create: `gate/__tests__/agent-kind.test.mjs`
- Create: `gate/__tests__/provider-dependencies.test.mjs`
- Modify: `src/lib/gateway/child-sync.ts`
- Modify: `__tests__/child-sync-test.ts`

**Interfaces:**
- Agent config contains endpoint identity plus `dependencies: Array<{providerId:string,role:string,modelId?:string}>`.
- Agent validation rejects auth/catalog fields. Provider deletion reports dependent IDs and requires explicit resolution.

- [ ] **Step 1: Write failing ownership and deletion tests**

```js
test('agent cannot carry an xAI token or catalog', () => {
  const result = agentKind.validate({
    endpoint: 'http://127.0.0.1:8642',
    dependencies: [{ providerId: 'xai-main', role: 'primary' }],
    tokens: { access_token: 'forbidden' }
  });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the ownership tests and confirm failure**

Run: `node --test gate/__tests__/agent-kind.test.mjs gate/__tests__/provider-dependencies.test.mjs`

- [ ] **Step 3: Implement agent dependencies and retire provider child profiles**

Migrate stored child profiles back to the parent Gate plus `{providerId,modelId}` selection. Keep direct Hermes profiles as Hermes gateways/agents. Do not register Hermes under `versutus-provider/v1`.

- [ ] **Step 4: Run Gate and app child-profile tests**

Run: `node --test gate/__tests__/agent-kind.test.mjs gate/__tests__/provider-dependencies.test.mjs; npx jest __tests__/child-sync-test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit the ownership slice**

```powershell
git add gate/core/capabilities/agent/kind.mjs gate/core/providers/dependencies.mjs gate/__tests__/agent-kind.test.mjs gate/__tests__/provider-dependencies.test.mjs src/lib/gateway/child-sync.ts __tests__/child-sync-test.ts
git commit -m "feat(gate): separate agents from provider ownership"
```

### Task 10: Build CLI Environment Registry and Versioned Adapters

**Files:**
- Create: `gate/core/cli-environments/store.mjs`
- Create: `gate/core/cli-environments/adapter-registry.mjs`
- Create: `gate/core/cli-environments/adapters/hermes.mjs`
- Create: `gate/core/cli-environments/adapters/codex.mjs`
- Create: `gate/core/cli-environments/adapters/claude-code.mjs`
- Create: `gate/__tests__/cli-adapters.test.mjs`
- Create: `gate/__tests__/fixtures/cli-protocols/*`

**Interfaces:**
- Produces `CliEnvironmentStore` and `CliAdapterRegistry.get(adapterId)` using the target contract above.
- Supported initial probes: Hermes ACP, Codex JSONL, Claude stream JSON. Codex app-server is accepted only when its generated schema fingerprint matches the adapter fixture.

- [ ] **Step 1: Write failing version/protocol tests using captured non-secret fixtures**

```js
test('unknown newer CLI version is incompatible', async () => {
  const probe = await registry.get('codex').probe(fakeExecutable('999.0.0'));
  assert.equal(probe.state, 'incompatible');
});
```

- [ ] **Step 2: Run adapter tests and confirm failure**

Run: `node --test gate/__tests__/cli-adapters.test.mjs`

- [ ] **Step 3: Implement explicit adapter manifests and probes**

Do not parse `--help` to discover operations. Probe executable identity/version plus native handshake. Declare exact operations and input schemas per adapter revision. Mark commands that lack a machine contract `machineReadable:false`.

- [ ] **Step 4: Run adapter tests**

Run: `node --test gate/__tests__/cli-adapters.test.mjs`

Expected: PASS for the tested local-version fixtures and FAIL-CLOSED for unknown versions.

- [ ] **Step 5: Commit the CLI adapter registry**

```powershell
git add gate/core/cli-environments gate/__tests__/cli-adapters.test.mjs gate/__tests__/fixtures/cli-protocols
git commit -m "feat(gate): add versioned CLI environment adapters"
```

### Task 11: Add Provider-to-CLI Invocation Tokens and Credential Isolation

**Files:**
- Create: `gate/core/cli-environments/invocation-tokens.mjs`
- Create: `gate/core/cli-environments/process-environment.mjs`
- Create: `gate/__tests__/cli-invocation-tokens.test.mjs`
- Create: `gate/__tests__/cli-process-environment.test.mjs`
- Modify: `gate/core/providers/service.mjs`

**Interfaces:**
- Produces run-scoped tokens bound to environment, run, provider, model, endpoints, audience, expiry, and nonce.
- CLI-native sessions require a provider registered in `local_interface` mode with external credential custody.
- Produces: `buildCliEnvironment(parentEnvironment, request)` with an explicit non-secret allowlist and `VERSUTUS_CLI_INVOCATION_TOKEN`.

- [ ] **Step 1: Write failing audience, replay, expiry, and environment-leak tests**

```js
test('child environment excludes inherited provider secrets', () => {
  const child = buildCliEnvironment({ PATH: 'x', OPENAI_API_KEY: 'secret' }, request);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.ok(child.VERSUTUS_CLI_INVOCATION_TOKEN);
});
```

- [ ] **Step 2: Run the isolation tests and confirm failure**

Run: `node --test gate/__tests__/cli-invocation-tokens.test.mjs gate/__tests__/cli-process-environment.test.mjs`

- [ ] **Step 3: Implement minimal environment construction and run-scoped capability tokens**

Send prompts over stdin/native protocol, not command arguments. Never read CLI auth files. If a CLI cannot consume the Gate proxy and has no supported local interface, return `provider_cli_binding_unsupported`.

- [ ] **Step 4: Run the isolation tests**

Run: `node --test gate/__tests__/cli-invocation-tokens.test.mjs gate/__tests__/cli-process-environment.test.mjs`

Expected: PASS with no secret fixture in child environment or logs.

- [ ] **Step 5: Commit the credential-boundary slice**

```powershell
git add gate/core/cli-environments/invocation-tokens.mjs gate/core/cli-environments/process-environment.mjs gate/core/providers/service.mjs gate/__tests__/cli-invocation-tokens.test.mjs gate/__tests__/cli-process-environment.test.mjs
git commit -m "feat(gate): isolate provider credentials from CLI runs"
```

### Task 12: Implement CLI Supervisor, Workspace Policy, Approvals, and Cancellation

**Files:**
- Create: `gate/core/cli-environments/supervisor.mjs`
- Create: `gate/core/cli-environments/workspace-policy.mjs`
- Create: `gate/core/cli-environments/approvals.mjs`
- Create: `gate/core/cli-environments/windows-job.mjs`
- Create: `gate/core/cli-environments/run-protocol.mjs`
- Create: `gate/__tests__/cli-supervisor.test.mjs`
- Create: `gate/__tests__/cli-workspace-policy.test.mjs`
- Create: `gate/__tests__/cli-approvals.test.mjs`

**Interfaces:**
- Produces `CliEnvironmentService.startRun(request)`, `.events(runId)`, `.approve(runId,approvalId,decision)`, `.cancel(runId)`, `.start(id)`, `.stop(id)`, and `.check(id)`.
- Environment states: `not_installed`, `incompatible`, `stopped`, `starting`, `ready`, `busy`, `degraded`, `approval_required`, `crashed`.

- [ ] **Step 1: Write failing root-escape, approval, concurrency, process-tree, and cancellation tests**

```js
test('unknown native approval fails closed', async () => {
  const result = await approvals.normalize({ type: 'new-unmapped-risk' });
  assert.equal(result.decision, 'deny');
});
```

- [ ] **Step 2: Run supervisor tests and confirm failure**

Run: `node --test gate/__tests__/cli-supervisor.test.mjs gate/__tests__/cli-workspace-policy.test.mjs gate/__tests__/cli-approvals.test.mjs`

- [ ] **Step 3: Implement canonical roots, native sandbox mapping, Job Objects, and approval normalization**

Reject device/UNC paths by default and resolve reparse points before access. Default to read-only, workspace-write, or isolated worktree. Credential, install/update/plugin, system, destructive, and bypass actions require visible desktop-local one-run approval.

- [ ] **Step 4: Implement and verify the cancellation ladder**

Cancellation order is native cancel, close input/Ctrl+C, bounded grace, terminate Windows Job Object, then one `run.cancelled` event.

Run: `node --test gate/__tests__/cli-supervisor.test.mjs gate/__tests__/cli-workspace-policy.test.mjs gate/__tests__/cli-approvals.test.mjs`

Expected: PASS; no descendant process remains.

- [ ] **Step 5: Commit the supervisor slice**

```powershell
git add gate/core/cli-environments/supervisor.mjs gate/core/cli-environments/workspace-policy.mjs gate/core/cli-environments/approvals.mjs gate/core/cli-environments/windows-job.mjs gate/core/cli-environments/run-protocol.mjs gate/__tests__/cli-supervisor.test.mjs gate/__tests__/cli-workspace-policy.test.mjs gate/__tests__/cli-approvals.test.mjs
git commit -m "feat(gate): supervise CLI runs with policy and cancellation"
```

### Task 13: Add Local-Interactive ConPTY Fallback Without Prose Automation

**Files:**
- Create: `gate/core/cli-environments/conpty.mjs`
- Create: `gate/__tests__/cli-conpty.test.mjs`
- Modify: `gate/core/cli-environments/adapters/hermes.mjs`
- Modify: `gate/core/cli-environments/adapters/codex.mjs`
- Modify: `gate/core/cli-environments/adapters/claude-code.mjs`

**Interfaces:**
- Produces local-visible `terminal.chunk` events and an exit code for adapter-declared `machineReadable:false` operations.
- Never exposes arbitrary argument arrays through remote RPC.

- [ ] **Step 1: Write failing local-presence, output-bound, and no-inference tests**

```js
test('unstructured output cannot mutate provider or approval state', async () => {
  await fallback.acceptChunk('Model: invented\nApprove? yes');
  assert.equal(providerService.calls.length, 0);
  assert.equal(approvalService.pending.length, 0);
});
```

- [ ] **Step 2: Run the ConPTY tests and confirm failure**

Run: `node --test gate/__tests__/cli-conpty.test.mjs`

- [ ] **Step 3: Implement visible/local-only ConPTY with bounded ANSI-stripped output**

Require desktop presence before start. Keep confirmations inside the visible terminal. Treat exit code as the only machine result; do not infer auth, health, models, approvals, or success semantics from text.

- [ ] **Step 4: Run ConPTY and adapter tests**

Run: `node --test gate/__tests__/cli-conpty.test.mjs gate/__tests__/cli-adapters.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the interactive fallback**

```powershell
git add gate/core/cli-environments/conpty.mjs gate/core/cli-environments/adapters gate/__tests__/cli-conpty.test.mjs
git commit -m "feat(gate): add local-interactive CLI fallback"
```

### Task 14: Expose CLI Environment APIs and Streaming Runs

**Files:**
- Modify: `gate/core/server.mjs`
- Modify: `gate/core/manifest.mjs`
- Create: `gate/__tests__/environments-route.test.mjs`
- Create: `gate/__tests__/environment-run-events.test.mjs`

**Interfaces:**
- HTTP: `GET /v1/environments`, `POST /v1/environments/:id/runs`, `GET /v1/environments/:id/runs/:runId/events`, `POST /v1/environments/:id/runs/:runId/cancel`, and approval resolution.
- RPC: `environments.create/update/delete/check`, `environments.commands.list`, `environments.lifecycle.start/stop`.

- [ ] **Step 1: Write failing route/auth/sequence tests**

```js
test('run events have monotonic sequence and one terminal event', async () => {
  const events = await collectRunEvents(runId);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events.filter((event) => event.type.startsWith('run.') && /completed|failed|cancelled/.test(event.type)).length, 1);
});
```

- [ ] **Step 2: Run environment route tests and confirm failure**

Run: `node --test gate/__tests__/environments-route.test.mjs gate/__tests__/environment-run-events.test.mjs`

- [ ] **Step 3: Implement authenticated APIs and SSE event replay**

Bound replay buffers and diagnostic payloads. Store artifact metadata rather than large/binary bodies. Provider outages fail the affected run with `provider_unavailable` without marking the CLI installation unhealthy.

- [ ] **Step 4: Run all Gate tests**

Run: `npm run test:gate`

Expected: PASS.

- [ ] **Step 5: Commit the environment API slice**

```powershell
git add gate/core/server.mjs gate/core/manifest.mjs gate/__tests__/environments-route.test.mjs gate/__tests__/environment-run-events.test.mjs
git commit -m "feat(gate): expose CLI environments and streamed runs"
```

### Task 15: Build Dedicated Provider and CLI Environment App Surfaces

**Files:**
- Create: `src/app/gateway/providers.tsx`
- Create: `src/app/gateway/environments.tsx`
- Create: `src/components/gateway/provider-card.tsx`
- Create: `src/components/gateway/provider-editor.tsx`
- Create: `src/components/gateway/oauth-progress-sheet.tsx`
- Create: `src/components/gateway/environment-card.tsx`
- Create: `src/components/gateway/environment-run-sheet.tsx`
- Create: `src/lib/gateway/provider-types.ts`
- Create: `src/lib/gateway/provider-client.ts`
- Create: `src/lib/gateway/provider-state.ts`
- Create: `src/lib/gateway/environment-types.ts`
- Create: `src/lib/gateway/environment-client.ts`
- Modify: `src/app/gateway/capabilities.tsx`
- Modify: `src/components/gateway/gateway-home-dashboard.tsx`
- Modify: `src/components/chat/model-picker-sheet.tsx`
- Modify: `src/lib/portal/manifest.ts`
- Modify: `src/lib/gateway/manifest-client.ts`
- Modify: `src/context/gateway-provider.tsx`
- Create: `__tests__/provider-state-test.ts`
- Create: `__tests__/provider-client-test.ts`
- Create: `__tests__/environment-client-test.ts`
- Modify: `__tests__/manifest-providers-test.ts`

**Interfaces:**
- Provider UI consumes only `ProviderSnapshot` and provider RPC.
- Environment UI consumes only sanitized environment snapshots and normalized run events.
- Model selection persists `{providerId,modelId}`.
- Produces: pure selector `groupProviderModels(snapshots: ProviderSnapshot[])`.

- [ ] **Step 1: Write failing state and client tests**

```ts
it('groups models by provider and preserves stale provenance', () => {
  const groups = groupProviderModels(snapshots);
  expect(groups[0].models[0].catalogState).toBe('stale');
});
```

- [ ] **Step 2: Run focused Jest tests and confirm failure**

Run: `npx jest __tests__/provider-state-test.ts __tests__/provider-client-test.ts __tests__/environment-client-test.ts --runInBand`

- [ ] **Step 3: Implement provider lifecycle UI**

Cards show identity, registration mode, auth state, readiness, catalog source/age/count, last error code, and actions: set/replace key, authorize/cancel, check, refresh, disconnect, disable, delete. UI states are Not configured, Authorizing, Ready, Degraded/stale, Needs sign-in, Access denied, Local service offline, and Disabled. Never display token fragments.

- [ ] **Step 4: Implement separate environment UI and provider-qualified model picker**

Environment cards show executable/version/protocol, declared capabilities, provider dependencies, workdir/sandbox, lifecycle, and active runs. Interactive-only operations state that desktop presence is required. Environment/session data never appears as provider auth or catalog data.

- [ ] **Step 5: Run app tests, typecheck, and lint**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit the app surfaces**

```powershell
git add src/app/gateway src/components/gateway src/components/chat/model-picker-sheet.tsx src/lib/gateway src/lib/portal/manifest.ts src/context/gateway-provider.tsx __tests__
git commit -m "feat(app): manage providers and CLI environments"
```

### Task 16: Install the Designated Per-User Windows Gate

**Files:**
- Create: `gate/core/service/windows-task.mjs`
- Create: `gate/core/service/instance-lock.mjs`
- Create: `gate/core/service/browser.mjs`
- Create: `gate/core/service/doctor.mjs`
- Create: `gate/__tests__/windows-service.test.mjs`
- Modify: `gate/cli.mjs`
- Modify: `gate/package.json`

**Interfaces:**
- CLI: `service install|start|stop|status|uninstall` and `doctor`.
- Scheduled Task runs at user logon under that user; one Gate instance owns the data-home lock.
- Produces: pure `buildTaskDefinition(input)` used by the installer and unit tests.

- [ ] **Step 1: Write failing task-definition, identity, lock, and browser-validation tests**

```js
test('service installation refuses SYSTEM identity', () => {
  assert.throws(() => buildTaskDefinition({ user: 'SYSTEM' }), /logged-in user/i);
});
```

- [ ] **Step 2: Run service tests and confirm failure**

Run: `node --test gate/__tests__/windows-service.test.mjs`

- [ ] **Step 3: Implement per-user Scheduled Task lifecycle and doctor output**

Bind Gate to the configured LAN/tailnet interface behind its existing bearer/pairing controls; bind OAuth callbacks and local provider interfaces strictly to loopback. Open only validated HTTPS authorization URLs in the current user's default browser.

- [ ] **Step 4: Run service tests and a manual install/restart/status/uninstall proof**

Run: `node --test gate/__tests__/windows-service.test.mjs`

Manual proof records task identity, listener address, PID, health/manifest/providers/models, DPAPI usability after restart, and clean uninstall. Do not print Gate/provider credentials.

- [ ] **Step 5: Commit the Windows service slice**

```powershell
git add gate/core/service gate/cli.mjs gate/package.json gate/__tests__/windows-service.test.mjs
git commit -m "feat(gate): install designated per-user Windows Gate"
```

### Task 17: Complete Migration, Compatibility, Documentation, and End-to-End Proof

**Files:**
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: `gate/CAPABILITY_PROMPT.md`
- Create: `docs/provider-setup.md`
- Create: `docs/cli-environments.md`
- Create: `scripts/smoke-provider-runtime.mjs`
- Create: `scripts/smoke-cli-environments.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces repeatable no-secret smoke commands for all three provider modes and all supported CLI adapters.

- [ ] **Step 1: Add smoke tests using fake API-key, fake OAuth, and fake local providers**

The provider smoke verifies registration, restart persistence, sanitized provider state, fresh catalog, qualified model routing, chat, transient degradation, recovery, and disconnect. The CLI smoke verifies adapter version, structured events, provider/model resolution, approval, workspace rejection, cancellation, and process-tree cleanup.

- [ ] **Step 2: Run the complete automated gate**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run lint`

Run: `node scripts/smoke-provider-runtime.mjs`

Run: `node scripts/smoke-cli-environments.mjs`

Expected: all commands PASS without external credentials.

- [ ] **Step 3: Perform authorized live provider proof**

Use an already-authorized official provider credential through the new vault without displaying it. Verify live catalog provenance, provider readiness, Gate restart persistence, one short model request, and correct 429/529/5xx degradation. Do not test OpenAI/xAI live access without explicit credential authorization.

- [ ] **Step 4: Perform installed CLI proof without inspecting CLI auth/session state**

Verify Hermes ACP, Codex JSONL, and Claude stream JSON through their declared adapters. Use a disposable workspace fixture, read-only first, then one approved workspace write, then cancellation. Confirm provider catalogs are unchanged by CLI output.

- [ ] **Step 5: Update documentation and commit the completion slice**

```powershell
git add README.md CONTEXT.md gate/CAPABILITY_PROMPT.md docs/provider-setup.md docs/cli-environments.md scripts/smoke-provider-runtime.mjs scripts/smoke-cli-environments.mjs package.json
git commit -m "docs: document provider and CLI environment operations"
```

---

## Failure-State Matrix

| Condition | Provider state | Environment/run state | Required behavior |
|---|---|---|---|
| Missing API key | `auth.missing`, unavailable | Run rejected | Preserve registration; prompt for credential |
| Provider 401 | `needs_reauth` | `provider_auth_failed` | No silent fallback or secret echo |
| Provider 403 entitlement | `denied` | `provider_access_denied` | Distinguish from invalid key |
| Provider 429/529/5xx | degraded, LKG retained | retryable failure | Honor retry hints and backoff |
| Catalog timeout | degraded, stale/LKG | model selection warns | Never label static/LKG as live |
| OAuth denial/cancel/expiry | prior grant unchanged | attempt terminal | Replace a working grant only after successful exchange |
| OAuth `invalid_grant` | `needs_reauth` | request rejected | Quarantine/delete unusable token material |
| Local adapter absent | unavailable | `local_service_offline` | Never fall back to Hermes or another provider |
| Local manifest mismatch | unavailable | `interface_incompatible` | Show expected/observed spec versions |
| DPAPI wrong user | unavailable | environment unaffected | Repair service identity; no old-store fallback |
| Duplicate model ID | provider-ready | request rejected | Require `providerId` |
| CLI not installed | provider unaffected | `not_installed` | Show executable path and install guidance |
| CLI version unsupported | provider unaffected | `incompatible` | Require reviewed adapter update |
| CLI protocol crash | provider unaffected | run failed, environment degraded | Kill descendants and back off restart |
| Unknown approval | provider unaffected | approval denied/run blocked | Fail closed |
| Workdir escapes roots | provider unaffected | request rejected | Return canonical policy violation |
| Unstructured CLI output | provider unaffected | terminal text only | No state inference or automation |

## Staged Rollout and Rollback

1. Land schemas, data home, DPAPI, and legacy migration while current routes remain active.
2. Route provider behavior through `ProviderService` while delegating legacy registry provider RPC for one compatibility release; then make v2 the only write path.
3. Enable API-key providers and live catalog provenance.
4. Enable local-interface providers and conformance SDK.
5. Enable generic OAuth only for provider profiles with an officially documented/approved desktop client contract.
6. Migrate app provider child profiles to parent Gate plus provider-qualified model selection.
7. Enable CLI environments in order: Codex JSONL, Claude stream JSON, Hermes ACP. Keep Codex app-server behind a schema-fingerprint feature gate while it remains experimental.
8. Install and verify the per-user Windows Gate, then retire compatibility provider RPC after one release.

At each stage, rollback disables the feature flag and reads the untouched legacy registration. Rollback never downgrades, deletes, or exports DPAPI vault contents.

## Acceptance Criteria

- Every provider has exactly one v2 registration, one credential custody declaration, one auth state, one readiness state, and one live/LKG catalog with provenance.
- No provider credential appears in config JSON, source control, app storage, agent/environment records, manifests, APIs, errors, diagnostics, or logs.
- API-key, fake OAuth, and fake local-interface providers survive Gate restart and pass catalog plus chat tests.
- OAuth rotation is race-safe; terminal failure requires reauthorization; transient failure preserves the grant; disconnect reports remote revocation versus local-only removal.
- `/v1/models` contains provider-owned live data or explicitly labeled LKG/bootstrap data.
- NVIDIA/DeepSeek migrate as `legacy_bootstrap`; the UI later shows their actual live or stale source.
- Hermes appears only as a gateway/agent/CLI environment and cannot own or proxy xAI provider credentials/catalogs.
- CLI environments reference providers and models; their output cannot create or mutate provider catalogs.
- Supported Hermes, Codex, and Claude adapters expose all adapter-declared machine capabilities; interactive-only capacity is visible and desktop-local.
- No code reads or copies CLI credential/session stores, browser state, keychains, or inherited provider-secret environment variables.
- CLI cancellation terminates the whole process tree, approvals cannot be bypassed by adapter flags, and canonical workdir policy cannot be escaped.
- Unstructured CLI output never drives provider, approval, health, or catalog state.
- The designated Windows Gate auto-starts under the same user, decrypts DPAPI state after restart, and answers health, manifest, provider, model, and environment probes.
- Full Node/Jest, TypeScript, lint, no-secret smoke, and authorized live verification gates pass.

## External Authority Gate

The implementation does not need a product decision to preserve the architecture. One external authorization remains mandatory: do not enable xAI consumer/SuperGrok OAuth for automated inference unless xAI explicitly permits that third-party use. Until then, ship official xAI API-key support and keep the generic OAuth engine verified with fake/approved provider profiles.

## Execution Handoff

Implement this plan as two review programs sharing the contracts and Gate home:

1. Provider program: Tasks 1-9, then provider portions of Tasks 15-17.
2. CLI environment program: Tasks 10-14, then environment portions of Tasks 15-17.

Use `superpowers:subagent-driven-development` for reviewer-gated task execution or `superpowers:executing-plans` for checkpointed inline execution. Do not run both programs concurrently until Tasks 1-4 are merged because they share schemas, paths, vault, and server composition.
