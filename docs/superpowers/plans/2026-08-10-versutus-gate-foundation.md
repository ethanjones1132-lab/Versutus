# Versutus Gate Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the app's HTTP transport and connection monitoring into reusable units, then build a running, authenticated Versutus Gate that serves a manifest and proxies chat to an OpenAI-compatible provider.

**Architecture:** `HermesGatewayClient` currently combines transport, health monitoring, reconnect policy, and Hermes route mapping in one file. Two units are extracted (`HttpTransport`, `ConnectionMonitor`) so a second client can reuse them without duplicating reconnect behaviour. In parallel, `gate/` becomes an npm workspace holding a Node service: a core that owns HTTP/manifest/auth, a flavor layer that translates provider protocols, and scaffolded per-provider config modules.

**Tech Stack:** TypeScript + Jest (app, existing). Node 20+ ESM + `node --test` (Gate, no new runtime dependencies). Ed25519 via `node:crypto`.

**This is Plan 1 of 2.** Plan 2 covers `ManifestClient`, manifest `providers[]` child sync in the app, the `anthropic` flavor, and extending `smoke:live` to run identical assertions against both Hermes and the Gate.

---

## File Structure

**App (modified):**
- `src/lib/gateway/http-transport.ts` — *new.* fetch wrapper: header sanitization, timeouts, SSE parsing, contact tracking. No knowledge of health or reconnect.
- `src/lib/gateway/connection-monitor.ts` — *new.* health loop, failure threshold, jittered backoff, suspend/resume. No knowledge of HTTP.
- `src/lib/gateway/client.ts` — *modified.* composes both; keeps Hermes routes, runs, sessions.
- `__tests__/http-transport-test.ts` — *new.*
- `__tests__/connection-monitor-test.ts` — *new.*
- `__tests__/gateway-client-health-test.ts` — *unchanged.* This is the regression gate: it must pass without edits.

**Gate (new):**
- `gate/package.json` — workspace manifest, ESM, test script.
- `gate/core/config.mjs` — provider config schema + validation.
- `gate/core/providers.mjs` — load provider modules from disk, skip invalid.
- `gate/core/manifest.mjs` — build the `versutus-gateway/v1` document.
- `gate/core/tokens.mjs` — bearer token generation and verification.
- `gate/core/server.mjs` — HTTP routing.
- `gate/flavors/openai.mjs` — OpenAI-compatible request/response translation.
- `gate/cli.mjs` — `add`, `start`, `token`.
- `gate/providers/.gitkeep`
- `gate/__tests__/*.test.mjs`

Splitting by responsibility rather than layer: `config` validates, `providers` loads, `manifest` describes, `tokens` authenticates, `server` routes. Each is independently testable without starting an HTTP server except `server` itself.

---

## Task 1: Extract HttpTransport

**Files:**
- Create: `src/lib/gateway/http-transport.ts`
- Test: `__tests__/http-transport-test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/http-transport-test.ts`:

```ts
import { HttpTransport } from '@/lib/gateway/http-transport';
import { GatewayHttpError } from '@/lib/gateway/errors';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('HttpTransport', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('strips non-printable characters from header values', async () => {
    const calls: RequestInit[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((_url: unknown, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const transport = new HttpTransport({
      baseUrl: 'http://gateway.test:8642',
      token: '  abc-123\n',
    });
    await transport.request('GET', '/health');

    const headers = calls[0].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer abc-123');
  });

  test('records contact even when the gateway rejects the request', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ error: { message: 'Invalid API key' } }, 401)),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    await expect(transport.request('GET', '/v1/models')).rejects.toBeInstanceOf(GatewayHttpError);

    // A 401 proves the gateway is alive, which is what liveness depends on.
    expect(transport.lastContactAt).toBeGreaterThan(0);
  });

  test('surfaces the HTTP status on the error', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ error: { message: 'nope' } }, 404)),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    await expect(transport.request('GET', '/nothing')).rejects.toMatchObject({ status: 404 });
  });

  test('reports the host for operator-facing messages', () => {
    const transport = new HttpTransport({ baseUrl: 'https://ethanspc.tail3a1a8a.ts.net' });
    expect(transport.displayHost).toBe('ethanspc.tail3a1a8a.ts.net');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/http-transport-test.ts`
Expected: FAIL — `Cannot find module '@/lib/gateway/http-transport'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/gateway/http-transport.ts`:

```ts
import { GatewayHttpError } from '@/lib/gateway/errors';

export const DEFAULT_TIMEOUT_MS = 30000;

export type HttpTransportOptions = {
  baseUrl: string;
  token?: string;
  sessionKey?: string;
};

/**
 * HTTP header values must be printable ASCII. Android's OkHttp rejects the
 * whole request — before any network I/O — if a value carries a control
 * character, so a token pasted with a stray newline fails every authenticated
 * call while unauthenticated probes to the same host keep succeeding.
 */
export function sanitizeHeaderValue(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/[^\x20-\x7E]/g, '').trim();
}

/** Fetch plumbing shared by every HTTP-dialect gateway client. */
export class HttpTransport {
  private contactAt = 0;

  constructor(private options: HttpTransportOptions) {}

  update(options: HttpTransportOptions) {
    this.options = options;
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  /** Host portion of the gateway URL, for operator-facing status text. */
  get displayHost(): string {
    try {
      return new URL(this.baseUrl).host || this.baseUrl;
    } catch {
      return this.baseUrl;
    }
  }

  /** When the gateway last returned any response. Drives liveness. */
  get lastContactAt(): number {
    return this.contactAt;
  }

  get headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = sanitizeHeaderValue(this.options.token);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const sessionKey = sanitizeHeaderValue(this.options.sessionKey);
    if (sessionKey) headers['X-Hermes-Session-Key'] = sessionKey;
    return headers;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { ...this.headers, ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Any HTTP response proves the gateway is alive, including a rejection.
      this.contactAt = Date.now();

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let message: string;
        try {
          const parsed = JSON.parse(errorText);
          message = parsed?.error?.message || parsed?.error || errorText || `HTTP ${response.status}`;
        } catch {
          message = errorText || `HTTP ${response.status}`;
        }
        throw new GatewayHttpError(message, response.status);
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timed out: ${method} ${path}`);
      }
      throw error;
    }
  }

  /** Read an SSE body, invoking onChunk for each `data:` payload. */
  async streamSSE(
    response: Response,
    onChunk: (data: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body to stream');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        onChunk(data);
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/http-transport-test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/http-transport.ts __tests__/http-transport-test.ts
git commit -m "refactor(gateway): extract HttpTransport from client"
```

---

## Task 2: Extract ConnectionMonitor

**Files:**
- Create: `src/lib/gateway/connection-monitor.ts`
- Test: `__tests__/connection-monitor-test.ts`

The monitor owns *when* to declare a gateway down and *when* to retry. It knows nothing about HTTP — it calls a `probe` callback. This is what lets a second client reuse the behaviour hardened on 2026-08-10.

- [ ] **Step 1: Write the failing test**

Create `__tests__/connection-monitor-test.ts`:

```ts
import { ConnectionMonitor, HEALTH_INTERVAL_MS } from '@/lib/gateway/connection-monitor';
import type { ConnectionMonitorCallbacks } from '@/lib/gateway/connection-monitor';

describe('ConnectionMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function build(overrides: Partial<ConnectionMonitorCallbacks> = {}) {
    const state = { healthy: true, servedRecently: false, reconnects: 0 };
    const statuses: string[] = [];
    const monitor = new ConnectionMonitor({
      probe: () => Promise.resolve(state.healthy),
      recentlyServedUs: () => state.servedRecently,
      onStatus: (status) => {
        statuses.push(status);
      },
      reconnect: () => {
        state.reconnects += 1;
        return Promise.resolve();
      },
      ...overrides,
    });
    return { monitor, state, statuses };
  }

  test('one failed probe does not declare the gateway down', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

    expect(statuses).not.toContain('reconnecting');
    monitor.stop();
  });

  test('two consecutive failures declare the gateway down', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

    expect(statuses).toContain('reconnecting');
    monitor.stop();
  });

  test('a gateway still serving other requests is never declared down', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();

    state.healthy = false;
    state.servedRecently = true;
    for (let i = 0; i < 4; i += 1) {
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    }

    expect(statuses).not.toContain('reconnecting');
    monitor.stop();
  });

  test('recovery cancels a queued reconnect', async () => {
    const { monitor, state } = build();
    monitor.start();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

    state.healthy = true;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    const afterRecovery = state.reconnects;

    await jest.advanceTimersByTimeAsync(120_000);
    expect(state.reconnects).toBe(afterRecovery);
    monitor.stop();
  });

  test('suspend stops probing until resumed', async () => {
    const { monitor, state, statuses } = build();
    monitor.start();
    monitor.suspend();

    state.healthy = false;
    await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 4);
    expect(statuses).not.toContain('reconnecting');

    monitor.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest __tests__/connection-monitor-test.ts`
Expected: FAIL — `Cannot find module '@/lib/gateway/connection-monitor'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/gateway/connection-monitor.ts`:

```ts
export const HEALTH_INTERVAL_MS = 30000;

/**
 * A mobile radio waking up loses a request routinely. Only a run of failures
 * means the gateway is actually gone — one lost sample must not tear down a
 * working session, because every tool is gated on `status === 'connected'`.
 */
export const HEALTH_FAILURE_THRESHOLD = 2;

export type ConnectionMonitorCallbacks = {
  /** Resolves true when the gateway answered a health probe. */
  probe: () => Promise<boolean>;
  /** True when some other request came back recently. */
  recentlyServedUs: () => boolean;
  onStatus: (status: 'connected' | 'reconnecting', detail?: string) => void;
  /** Attempt a full reconnect. Must not throw. */
  reconnect: () => Promise<void>;
};

/**
 * Owns when a gateway is considered down and when to retry. Deliberately
 * transport-agnostic so every client shares one copy of this policy.
 */
export class ConnectionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private attempts = 0;
  private suspended = false;
  private down = false;

  constructor(private callbacks: ConnectionMonitorCallbacks) {}

  start() {
    this.stop();
    this.failures = 0;
    this.attempts = 0;
    this.down = false;
    this.timer = setInterval(() => void this.tick(), HEALTH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearReconnect();
    this.failures = 0;
  }

  suspend() {
    this.suspended = true;
    this.clearReconnect();
  }

  resume() {
    this.suspended = false;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** Called by the client after a successful connect. */
  noteConnected() {
    this.failures = 0;
    this.attempts = 0;
    this.down = false;
    this.clearReconnect();
  }

  private async tick() {
    if (this.suspended) return;
    const healthy = await this.callbacks.probe();

    if (healthy) {
      this.failures = 0;
      if (this.down) {
        // Recovered on our own — drop the queued reconnect so it cannot
        // re-fire and bounce a healthy connection back through 'connecting'.
        this.clearReconnect();
        this.attempts = 0;
        this.down = false;
        this.callbacks.onStatus('connected');
      }
      return;
    }

    if (this.down) return;
    // A single-threaded gateway stalls /health while serving a slow request.
    // If it answered anything else recently it is busy, not gone.
    if (this.callbacks.recentlyServedUs()) return;

    this.failures += 1;
    if (this.failures < HEALTH_FAILURE_THRESHOLD) return;
    this.down = true;
    this.callbacks.onStatus('reconnecting', 'Gateway became unreachable');
    this.scheduleReconnect('Gateway became unreachable');
  }

  scheduleReconnect(reason: string) {
    if (this.suspended) return;
    this.attempts += 1;
    const base = Math.min(1000 * 2 ** (this.attempts - 1), 15000);
    // Jitter keeps a fleet of clients from retrying in lockstep after an outage.
    const delay = base * (0.75 + Math.random() * 0.5);
    this.down = true;
    this.callbacks.onStatus('reconnecting', `${reason} · retry in ${Math.round(delay / 1000)}s`);
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.suspended) void this.callbacks.reconnect();
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest __tests__/connection-monitor-test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway/connection-monitor.ts __tests__/connection-monitor-test.ts
git commit -m "refactor(gateway): extract ConnectionMonitor from client"
```

---

## Task 3: Compose the extracted units in HermesGatewayClient

**Files:**
- Modify: `src/lib/gateway/client.ts`
- Test: `__tests__/gateway-client-health-test.ts` — must pass **unchanged**

This task changes no behaviour. `gateway-client-health-test.ts` is the regression gate; if it needs edits, the refactor is wrong.

- [ ] **Step 1: Run the existing suite to record the baseline**

Run: `npx jest __tests__/gateway-client-health-test.ts`
Expected: PASS, 7 tests. Note the count.

- [ ] **Step 2: Replace the transport internals**

In `src/lib/gateway/client.ts`, delete the private `headers` getter, `baseUrl` getter, `displayHost` getter, `request` method, `streamSSE` method, the `sanitizeHeaderValue` function, the `lastContactAt` field, and the `DEFAULT_TIMEOUT_MS` constant. Replace with a composed transport.

Add to the imports:

```ts
import { HttpTransport } from '@/lib/gateway/http-transport';
import {
  ConnectionMonitor,
  HEALTH_INTERVAL_MS,
} from '@/lib/gateway/connection-monitor';
```

Add these fields and constructor body:

```ts
  private transport: HttpTransport;
  private monitor: ConnectionMonitor;

  constructor(
    private profile: GatewayProfile,
    private callbacks: GatewayClientCallbacks = {},
  ) {
    this.transport = new HttpTransport({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
    this.monitor = new ConnectionMonitor({
      probe: async () => (await this.healthCheck()) !== null,
      recentlyServedUs: () =>
        this.transport.lastContactAt > 0 &&
        Date.now() - this.transport.lastContactAt < HEALTH_INTERVAL_MS,
      onStatus: (status, detail) => this.setStatus(status, detail),
      reconnect: () => this.connect().catch(() => undefined),
    });
  }
```

Replace every internal `this.request(...)` call with `this.transport.request(...)`, every `this.streamSSE(...)` with `this.transport.streamSSE(...)`, every `this.baseUrl` with `this.transport.baseUrl`, every `this.displayHost` with `this.transport.displayHost`, and every `this.headers` with `this.transport.headers`.

Update `updateProfile` to keep the transport in sync:

```ts
  updateProfile(profile: GatewayProfile) {
    this.profile = profile;
    this.transport.update({
      baseUrl: profile.url,
      token: profile.token,
      sessionKey: profile.sessionKey,
    });
  }
```

- [ ] **Step 3: Replace the health and reconnect internals**

Delete `startHealthMonitoring`, `stopHealthMonitoring`, `recentlyServedUs`, `scheduleReconnect`, `clearReconnectTimer`, and the fields `healthTimer`, `healthFailures`, `reconnectTimer`, `reconnectAttempts`, `reconnectSuspended`. Keep `lastHealthError`.

Update the lifecycle methods to delegate:

```ts
  disconnect() {
    this.closed = true;
    this.monitor.stop();
    this.abortAllRuns();
    this.monitor.resume();
    if (this.currentSessionId) {
      this.profile.sessionId = this.currentSessionId;
    }
    this.setStatus('disconnected');
  }

  suspendReconnect() {
    this.monitor.suspend();
  }

  resumeReconnect() {
    this.monitor.resume();
    if (!this.closed && this.status !== 'connected') {
      void this.connect().catch(() => undefined);
    }
  }
```

In `connect()`, replace the failure branch's `this.scheduleReconnect(...)` calls with `this.monitor.scheduleReconnect(...)`, and replace the success-path `this.startHealthMonitoring()` with:

```ts
    this.monitor.noteConnected();
    this.monitor.start();
```

- [ ] **Step 4: Run the regression gate**

Run: `npx jest __tests__/gateway-client-health-test.ts`
Expected: PASS, 7 tests, **with no edits to the test file**

If any test fails, the extraction changed behaviour. Fix the implementation, not the test.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: no type errors, all suites pass, lint clean

- [ ] **Step 6: Verify against the live gateway**

Run: `npm run smoke:live`
Expected: `All live checks passed.` — 9 checks

- [ ] **Step 7: Commit**

```bash
git add src/lib/gateway/client.ts
git commit -m "refactor(gateway): compose HttpTransport and ConnectionMonitor"
```

---

## Task 4: Create the Gate workspace

**Files:**
- Create: `gate/package.json`
- Create: `gate/providers/.gitkeep`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create the Gate package manifest**

Create `gate/package.json`:

```json
{
  "name": "versutus-gate",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "versutus-gate": "./cli.mjs" },
  "scripts": {
    "test": "node --test",
    "start": "node cli.mjs start"
  }
}
```

- [ ] **Step 2: Register the workspace and keep the provider directory**

In the root `package.json`, add a `workspaces` key immediately after `"private": true`:

```json
  "workspaces": ["gate"],
```

Create an empty file `gate/providers/.gitkeep`.

Append to `.gitignore`:

```
# Gate secrets — provider API keys never leave the PC
gate/.env
gate/.tokens.json
```

- [ ] **Step 3: Verify the workspace resolves**

Run: `npm install`
Expected: completes without error; `gate` appears in `node_modules/versutus-gate` as a symlink

- [ ] **Step 4: Commit**

```bash
git add gate/package.json gate/providers/.gitkeep package.json .gitignore
git commit -m "feat(gate): scaffold the Versutus Gate workspace"
```

---

## Task 5: Provider config validation

**Files:**
- Create: `gate/core/config.mjs`
- Test: `gate/__tests__/config.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateProviderConfig } from '../core/config.mjs';

const valid = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  capabilities: { chat: true, streaming: true },
};

test('accepts a well-formed config', () => {
  const result = validateProviderConfig('grok', valid);
  assert.equal(result.ok, true);
});

test('rejects an unknown flavor', () => {
  const result = validateProviderConfig('grok', { ...valid, flavor: 'banana' });
  assert.equal(result.ok, false);
  assert.match(result.error, /flavor/);
});

test('rejects a literal API key so secrets cannot reach the manifest', () => {
  const result = validateProviderConfig('grok', {
    ...valid,
    apiKeyEnv: undefined,
    apiKey: 'sk-live-abc123',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /apiKeyEnv/);
});

test('rejects an empty model list', () => {
  const result = validateProviderConfig('grok', { ...valid, models: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /models/);
});

test('rejects a non-https base URL for a public provider', () => {
  const result = validateProviderConfig('grok', { ...valid, baseUrl: 'http://api.x.ai/v1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /https/);
});

test('names the offending field so a model can self-correct', () => {
  const result = validateProviderConfig('grok', { ...valid, models: 'grok-4' });
  assert.equal(result.ok, false);
  assert.match(result.error, /models/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/config.test.mjs`
Expected: FAIL — cannot find module `../core/config.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/config.mjs`:

```js
export const FLAVORS = ['openai', 'anthropic', 'custom'];

/**
 * Validate a provider's CONFIG block.
 *
 * Errors name the offending field on purpose: a provider module is often
 * filled in by a language model from a prompt, and a message it can act on
 * turns a failed setup into a self-correcting one.
 */
export function validateProviderConfig(id, config) {
  const fail = (error) => ({ ok: false, error: `provider "${id}": ${error}` });

  if (!config || typeof config !== 'object') return fail('config must be an object');

  if (!FLAVORS.includes(config.flavor)) {
    return fail(`flavor must be one of ${FLAVORS.join(', ')} (got ${JSON.stringify(config.flavor)})`);
  }

  if (typeof config.baseUrl !== 'string' || !config.baseUrl) {
    return fail('baseUrl must be a non-empty string');
  }

  let parsed;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    return fail(`baseUrl is not a valid URL: ${config.baseUrl}`);
  }

  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !isLoopback) {
    return fail('baseUrl must use https (only loopback may use http)');
  }

  // A literal key here would be committed to the repo and echoed into logs.
  if ('apiKey' in config || 'api_key' in config) {
    return fail('inline API keys are not allowed — set apiKeyEnv to the name of an env var');
  }

  if (typeof config.apiKeyEnv !== 'string' || !config.apiKeyEnv) {
    return fail('apiKeyEnv must name the environment variable holding the key');
  }

  if (!Array.isArray(config.models) || config.models.length === 0) {
    return fail('models must be a non-empty array of model ids');
  }

  if (config.models.some((model) => typeof model !== 'string' || !model)) {
    return fail('models must contain only non-empty strings');
  }

  const capabilities = config.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    return fail('capabilities must be an object');
  }
  if (capabilities.chat !== true) {
    return fail('capabilities.chat must be true — a provider that cannot chat has no purpose');
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/config.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add gate/core/config.mjs gate/__tests__/config.test.mjs
git commit -m "feat(gate): validate provider config, rejecting inline API keys"
```

---

## Task 6: Provider loader

**Files:**
- Create: `gate/core/providers.mjs`
- Test: `gate/__tests__/providers.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/providers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProviders } from '../core/providers.mjs';

async function providerDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-providers-'));
  for (const [id, source] of Object.entries(entries)) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'provider.mjs'), source, 'utf8');
  }
  return root;
}

const goodProvider = (id) => `
export const id = '${id}';
export const label = '${id}';
export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'EXAMPLE_KEY',
  models: ['${id}-1'],
  capabilities: { chat: true, streaming: true },
};
`;

test('loads a valid provider', async () => {
  const root = await providerDir({ grok: goodProvider('grok') });
  const { providers, skipped } = await loadProviders(root);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'grok');
  assert.deepEqual(skipped, []);
});

test('skips an invalid provider without taking down the others', async () => {
  const root = await providerDir({
    grok: goodProvider('grok'),
    broken: `export const id = 'broken';
export const config = { flavor: 'banana' };`,
  });

  const { providers, skipped } = await loadProviders(root);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'grok');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /flavor/);
});

test('skips a provider that throws on import', async () => {
  const root = await providerDir({
    grok: goodProvider('grok'),
    exploding: `throw new Error('boom');`,
  });

  const { providers, skipped } = await loadProviders(root);

  assert.equal(providers.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /boom/);
});

test('returns empty rather than throwing when there are no providers', async () => {
  const root = await providerDir({});
  const { providers, skipped } = await loadProviders(root);

  assert.deepEqual(providers, []);
  assert.deepEqual(skipped, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/providers.test.mjs`
Expected: FAIL — cannot find module `../core/providers.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/providers.mjs`:

```js
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateProviderConfig } from './config.mjs';

/**
 * Load every provider module under `root`.
 *
 * A provider that fails to import or fails validation is skipped and reported,
 * never thrown. One malformed provider must not stop the Gate from serving the
 * rest — that isolation is the reason provider modules are safe to hand to a
 * language model.
 */
export async function loadProviders(root) {
  const providers = [];
  const skipped = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { providers, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const modulePath = join(root, id, 'provider.mjs');

    let module;
    try {
      module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const result = validateProviderConfig(id, module.config);
    if (!result.ok) {
      skipped.push({ id, reason: result.error });
      continue;
    }

    providers.push({
      id: module.id ?? id,
      label: module.label ?? id,
      config: module.config,
      module,
    });
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));
  return { providers, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/providers.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add gate/core/providers.mjs gate/__tests__/providers.test.mjs
git commit -m "feat(gate): load provider modules, isolating failures"
```

---

## Task 7: Manifest builder

**Files:**
- Create: `gate/core/manifest.mjs`
- Test: `gate/__tests__/manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/manifest.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

const providers = [
  {
    id: 'claude',
    label: 'Claude',
    config: {
      flavor: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['claude-opus-5'],
      capabilities: { chat: true, streaming: true },
    },
  },
];

test('declares the manifest spec version and kind', () => {
  const manifest = buildManifest({ name: "Ethan's Gate", providers });
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
  assert.equal(manifest.kind, 'versutus-gate');
  assert.equal(manifest.name, "Ethan's Gate");
});

test('advertises each provider with its base path and capabilities', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  assert.equal(manifest.providers.length, 1);
  assert.deepEqual(manifest.providers[0], {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
  });
});

test('never leaks the API key env var name or base URL to the client', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('advertises the signed access path so the app can pair', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  assert.equal(manifest.auth.grantPath, '/.well-known/gateway/access');
  assert.ok(manifest.auth.schemes.includes('bearer'));
});

test('serves a valid manifest with no providers configured', () => {
  const manifest = buildManifest({ name: 'Gate', providers: [] });
  assert.deepEqual(manifest.providers, []);
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/manifest.test.mjs`
Expected: FAIL — cannot find module `../core/manifest.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/manifest.mjs`:

```js
export const MANIFEST_SPEC = 'versutus-gateway/v1';
export const GATE_KIND = 'versutus-gate';

/**
 * Build the document served at /.well-known/gateway.json.
 *
 * Only fields the client needs are included. A provider's baseUrl and
 * apiKeyEnv are deliberately omitted: the phone talks to the Gate, never to
 * the upstream provider, and neither value is any of the client's business.
 */
export function buildManifest({ name, version = '0.1.0', providers = [] }) {
  return {
    manifest: MANIFEST_SPEC,
    kind: GATE_KIND,
    name,
    version,
    vendor: 'versutus',
    auth: {
      schemes: ['challenge-response', 'bearer'],
      grantPath: '/.well-known/gateway/access',
    },
    transport: { primary: 'http' },
    capabilities: {
      chat: providers.some((provider) => provider.config.capabilities.chat === true),
      runs: false,
      terminal: false,
      sessions: true,
      models: true,
      approvals: false,
    },
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    },
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      basePath: `/p/${provider.id}`,
      models: [...provider.config.models],
      capabilities: { ...provider.config.capabilities },
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/manifest.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add gate/core/manifest.mjs gate/__tests__/manifest.test.mjs
git commit -m "feat(gate): build the gateway manifest with advertised providers"
```

---

## Task 8: Bearer token store

**Files:**
- Create: `gate/core/tokens.mjs`
- Test: `gate/__tests__/tokens.test.mjs`

Plan 1 authenticates with a generated bearer token so the Gate is never unauthenticated. The signed Ed25519 pairing flow from spec §8 lands in Plan 2 and reuses this store.

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/tokens.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenStore } from '../core/tokens.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-tokens-'));
  return new TokenStore(join(dir, 'tokens.json'));
}

test('generates a token on first use and reuses it after', async () => {
  const tokens = await store();
  const first = await tokens.ensureToken();
  const second = await tokens.ensureToken();

  assert.equal(first, second);
  assert.ok(first.length >= 32);
});

test('accepts the issued token', async () => {
  const tokens = await store();
  const token = await tokens.ensureToken();
  assert.equal(await tokens.verify(`Bearer ${token}`), true);
});

test('rejects a wrong token', async () => {
  const tokens = await store();
  await tokens.ensureToken();
  assert.equal(await tokens.verify('Bearer not-the-token'), false);
});

test('rejects a missing or malformed header', async () => {
  const tokens = await store();
  await tokens.ensureToken();

  assert.equal(await tokens.verify(undefined), false);
  assert.equal(await tokens.verify(''), false);
  assert.equal(await tokens.verify('token-without-scheme'), false);
});

test('rotate replaces the previous token', async () => {
  const tokens = await store();
  const original = await tokens.ensureToken();
  const rotated = await tokens.rotate();

  assert.notEqual(original, rotated);
  assert.equal(await tokens.verify(`Bearer ${original}`), false);
  assert.equal(await tokens.verify(`Bearer ${rotated}`), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/tokens.test.mjs`
Expected: FAIL — cannot find module `../core/tokens.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/tokens.mjs`:

```js
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/** Persisted bearer token for the Gate. One token, rotatable. */
export class TokenStore {
  #cached = null;

  constructor(path) {
    this.path = path;
  }

  async #read() {
    if (this.#cached) return this.#cached;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof parsed.token === 'string' && parsed.token) {
        this.#cached = parsed.token;
        return this.#cached;
      }
    } catch {
      // No store yet — fall through and generate one.
    }
    return null;
  }

  async ensureToken() {
    const existing = await this.#read();
    if (existing) return existing;
    return this.rotate();
  }

  async rotate() {
    const token = randomBytes(32).toString('base64url');
    await writeFile(this.path, JSON.stringify({ token }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    this.#cached = token;
    return token;
  }

  /** Constant-time comparison so a wrong token leaks no timing information. */
  async verify(authorizationHeader) {
    if (typeof authorizationHeader !== 'string') return false;
    const [scheme, presented] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !presented) return false;

    const expected = await this.#read();
    if (!expected) return false;

    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/tokens.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add gate/core/tokens.mjs gate/__tests__/tokens.test.mjs
git commit -m "feat(gate): persist and verify the Gate bearer token"
```

---

## Task 9: OpenAI-compatible flavor

**Files:**
- Create: `gate/flavors/openai.mjs`
- Test: `gate/__tests__/openai-flavor.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/openai-flavor.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChatRequest, parseDelta } from '../flavors/openai.mjs';

const config = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  capabilities: { chat: true, streaming: true },
};

test('targets the chat completions endpoint with the bearer key', () => {
  const request = buildChatRequest(config, 'test-key', {
    model: 'grok-4',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });

  assert.equal(request.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(request.init.body).stream, true);
});

test('falls back to the first configured model when none is given', () => {
  const request = buildChatRequest(config, 'k', {
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(JSON.parse(request.init.body).model, 'grok-4');
});

test('rejects a model the provider did not declare', () => {
  assert.throws(
    () => buildChatRequest(config, 'k', { model: 'gpt-5', messages: [] }),
    /gpt-5/,
  );
});

test('extracts the text delta from a streaming chunk', () => {
  const chunk = JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
  assert.equal(parseDelta(chunk), 'hello');
});

test('returns empty string for a chunk with no content', () => {
  assert.equal(parseDelta(JSON.stringify({ choices: [{ delta: {} }] })), '');
  assert.equal(parseDelta('not json'), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/openai-flavor.test.mjs`
Expected: FAIL — cannot find module `../flavors/openai.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/flavors/openai.mjs`:

```js
/**
 * OpenAI-compatible flavor.
 *
 * GPT, Grok and Kimi all speak this dialect, differing only in base URL, key
 * and model list — which is exactly the set of fields a provider module
 * declares. Adding one of them requires no code.
 */

export function buildChatRequest(config, apiKey, { model, messages, stream = false }) {
  const target = model ?? config.models[0];
  if (!config.models.includes(target)) {
    throw new Error(
      `model "${target}" is not declared by this provider (declared: ${config.models.join(', ')})`,
    );
  }

  return {
    url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: target, messages, stream }),
    },
  };
}

/** Pull the text delta out of one SSE `data:` payload. Never throws. */
export function parseDelta(data) {
  try {
    const parsed = JSON.parse(data);
    return parsed?.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/openai-flavor.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add gate/flavors/openai.mjs gate/__tests__/openai-flavor.test.mjs
git commit -m "feat(gate): add the OpenAI-compatible flavor"
```

---

## Task 10: HTTP server

**Files:**
- Create: `gate/core/server.mjs`
- Test: `gate/__tests__/server.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/server.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

async function startGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-server-'));
  await mkdir(join(root, 'providers', 'stub'), { recursive: true });
  await writeFile(
    join(root, 'providers', 'stub', 'provider.mjs'),
    `export const id = 'stub';
export const label = 'Stub';
export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'STUB_KEY',
  models: ['stub-1'],
  capabilities: { chat: true, streaming: true },
};`,
    'utf8',
  );

  const gate = await createGate({ root, name: 'Test Gate', port: 0 });
  await gate.listen();
  return { gate, url: `http://127.0.0.1:${gate.port}`, token: gate.token };
}

test('serves health without authentication', async () => {
  const { gate, url } = await startGate();
  const response = await fetch(`${url}/health`);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  await gate.close();
});

test('serves the manifest without authentication so the app can identify it', async () => {
  const { gate, url } = await startGate();
  const manifest = await (await fetch(`${url}/.well-known/gateway.json`)).json();

  assert.equal(manifest.manifest, 'versutus-gateway/v1');
  assert.equal(manifest.providers[0].id, 'stub');
  assert.equal(manifest.providers[0].basePath, '/p/stub');
  await gate.close();
});

test('rejects an unauthenticated model listing', async () => {
  const { gate, url } = await startGate();
  const response = await fetch(`${url}/v1/models`);

  assert.equal(response.status, 401);
  await gate.close();
});

test('lists every provider model when authenticated', async () => {
  const { gate, url, token } = await startGate();
  const response = await fetch(`${url}/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((model) => model.id), ['stub-1']);
  await gate.close();
});

test('scopes a provider listing to that provider', async () => {
  const { gate, url, token } = await startGate();
  const response = await fetch(`${url}/p/stub/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((m) => m.id), ['stub-1']);
  await gate.close();
});

test('returns 404 for an unknown provider', async () => {
  const { gate, url, token } = await startGate();
  const response = await fetch(`${url}/p/nope/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 404);
  await gate.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/server.test.mjs`
Expected: FAIL — cannot find module `../core/server.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/server.mjs`:

```js
import { createServer } from 'node:http';
import { join } from 'node:path';

import { loadProviders } from './providers.mjs';
import { buildManifest } from './manifest.mjs';
import { TokenStore } from './tokens.mjs';

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Build a Gate instance. `root` holds providers/ and the token store; `port` 0
 * asks the OS for a free port, which is what the tests use.
 */
export async function createGate({ root, name, port = 8760, host = '127.0.0.1' }) {
  const { providers, skipped } = await loadProviders(join(root, 'providers'));
  for (const entry of skipped) {
    console.warn(`[gate] skipped provider "${entry.id}": ${entry.reason}`);
  }

  const tokens = new TokenStore(join(root, '.tokens.json'));
  const token = await tokens.ensureToken();
  const manifest = buildManifest({ name, providers });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  const modelList = (list) => ({
    object: 'list',
    data: list.map((id) => ({ id, object: 'model', owned_by: 'versutus-gate' })),
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Unauthenticated: identification only. Everything else needs the token.
    if (path === '/health') {
      return send(res, 200, { status: 'ok', platform: 'versutus-gate', version: manifest.version });
    }
    if (path === '/.well-known/gateway.json') {
      return send(res, 200, manifest);
    }

    if (!(await tokens.verify(req.headers.authorization))) {
      return send(res, 401, {
        error: { message: 'Invalid or missing gate token', code: 'invalid_token' },
      });
    }

    if (path === '/v1/models') {
      return send(res, 200, modelList(providers.flatMap((provider) => provider.config.models)));
    }

    const scoped = path.match(/^\/p\/([^/]+)(\/.*)$/);
    if (scoped) {
      const provider = byId.get(scoped[1]);
      if (!provider) {
        return send(res, 404, {
          error: { message: `Unknown provider "${scoped[1]}"`, code: 'unknown_provider' },
        });
      }
      if (scoped[2] === '/v1/models') {
        return send(res, 200, modelList(provider.config.models));
      }
    }

    return send(res, 404, { error: { message: `No route for ${path}`, code: 'not_found' } });
  });

  return {
    token,
    providers,
    get port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : port;
    },
    listen() {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/server.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Run the whole Gate suite**

Run: `cd gate && npm test`
Expected: PASS — 31 tests across 6 files

- [ ] **Step 6: Commit**

```bash
git add gate/core/server.mjs gate/__tests__/server.test.mjs
git commit -m "feat(gate): serve manifest, health and scoped model listings"
```

---

## Task 11: CLI

**Files:**
- Create: `gate/cli.mjs`
- Create: `gate/PROVIDER_PROMPT.md`

- [ ] **Step 1: Write the CLI**

Create `gate/cli.mjs`:

```js
#!/usr/bin/env node
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from './core/server.mjs';
import { FLAVORS } from './core/config.mjs';

const root = dirname(fileURLToPath(import.meta.url));

function scaffold(id, flavor) {
  return `export const id = '${id}';
export const label = '${id.charAt(0).toUpperCase()}${id.slice(1)}';

// ─── CONFIG: edit only inside this block ───────────────
export const config = {
  flavor: '${flavor}',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: '${id.toUpperCase()}_API_KEY',
  models: ['model-id-here'],
  capabilities: { chat: true, streaming: true },
};
// ─── END CONFIG ────────────────────────────────────────
`;
}

async function add(id, flavor) {
  if (!/^[a-z0-9-]+$/.test(id ?? '')) {
    console.error('usage: versutus-gate add <id> [--flavor openai|anthropic|custom]');
    process.exitCode = 1;
    return;
  }
  if (!FLAVORS.includes(flavor)) {
    console.error(`unknown flavor "${flavor}" — choose one of ${FLAVORS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const dir = join(root, 'providers', id);
  const file = join(dir, 'provider.mjs');
  try {
    await access(file);
    console.error(`provider "${id}" already exists at ${file}`);
    process.exitCode = 1;
    return;
  } catch {
    // Does not exist — good.
  }

  await mkdir(dir, { recursive: true });
  await writeFile(file, scaffold(id, flavor), 'utf8');
  console.log(`Created ${file}`);
  console.log(`Next: fill the CONFIG block, then add ${id.toUpperCase()}_API_KEY to gate/.env`);
  console.log(`A prompt you can paste into any model is in gate/PROVIDER_PROMPT.md`);
}

async function start() {
  const gate = await createGate({ root, name: process.env.GATE_NAME ?? 'Versutus Gate' });
  await gate.listen();
  console.log(`Versutus Gate on http://127.0.0.1:${gate.port}`);
  console.log(`Providers: ${gate.providers.map((p) => p.id).join(', ') || 'none'}`);
  console.log(`Token: ${gate.token}`);
}

const [command, ...args] = process.argv.slice(2);
const flavorIndex = args.indexOf('--flavor');
const flavor = flavorIndex >= 0 ? args[flavorIndex + 1] : 'openai';

if (command === 'add') await add(args[0], flavor);
else if (command === 'start') await start();
else {
  console.log('usage: versutus-gate <add|start>');
  process.exitCode = 1;
}
```

- [ ] **Step 2: Verify the scaffold command works**

Run: `cd gate && node cli.mjs add testprov --flavor openai`
Expected: `Created .../gate/providers/testprov/provider.mjs`

Run it again: `node cli.mjs add testprov`
Expected: `provider "testprov" already exists`, exit code 1

- [ ] **Step 3: Verify the Gate starts and serves the scaffolded provider**

Run: `cd gate && node cli.mjs start`
Expected: startup lines listing `testprov` and a token.

In another shell: `curl -s http://127.0.0.1:8760/.well-known/gateway.json`
Expected: JSON containing `"basePath": "/p/testprov"`

Stop the Gate with Ctrl-C, then remove the scratch provider:
`rm -rf gate/providers/testprov`

- [ ] **Step 4: Write the provider prompt**

Create `gate/PROVIDER_PROMPT.md`:

````markdown
# Adding a provider to the Versutus Gate

Run this first — it creates the file you will edit:

```bash
node gate/cli.mjs add <id> --flavor openai
```

Then paste everything below into any capable model, along with the created file.

---

You are filling in a Versutus Gate provider module. A file already exists at
`gate/providers/<id>/provider.mjs`. Edit **only** the text between the
`─── CONFIG` and `─── END CONFIG` markers. Do not add imports, functions, or
exports. Do not restructure the file.

Set these fields:

- `flavor` — `openai` for any OpenAI-compatible API (GPT, Grok, Kimi, most
  others), `anthropic` for Claude. Leave as scaffolded unless it is wrong.
- `baseUrl` — the API root **including** any version segment, e.g.
  `https://api.x.ai/v1`. Must be `https`. Do not include `/chat/completions`.
- `apiKeyEnv` — the NAME of an environment variable, never a key itself.
  Example: `XAI_API_KEY`. Putting a real key here is a validation error and the
  provider will be refused at load.
- `models` — a non-empty array of model ids exactly as the provider's API
  expects them.
- `capabilities` — `chat` must be `true`. Set `streaming: true` only if the API
  supports server-sent events.

When done, the operator adds the key to `gate/.env` as
`<APIKEYENV>=<the actual key>` and restarts the Gate. If the config is wrong the
Gate logs `skipped provider "<id>": <reason>` naming the field, and every other
provider keeps working.
````

- [ ] **Step 5: Commit**

```bash
git add gate/cli.mjs gate/PROVIDER_PROMPT.md
git commit -m "feat(gate): add scaffold CLI and provider setup prompt"
```

---

## Task 12: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Run every suite**

Run: `npm test && cd gate && npm test && cd ..`
Expected: app 47 tests across 10 suites (38 today, plus 4 transport and 5 monitor);
Gate 31 tests across 6 files

- [ ] **Step 2: Typecheck and lint the app**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output from either

- [ ] **Step 3: Confirm the live gateway path still works**

Run: `npm run smoke:live`
Expected: `All live checks passed.`

This proves the Task 3 refactor did not regress the real Hermes connection.

- [ ] **Step 4: Confirm no secrets are tracked**

Run: `git status --porcelain && git ls-files gate/ | grep -E '\.env|\.tokens' || echo "no secrets tracked"`
Expected: clean tree, `no secrets tracked`

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "chore(gate): foundation complete" || echo "nothing to commit"
```

---

## Done when

- `HttpTransport` and `ConnectionMonitor` are separate, tested units, and `gateway-client-health-test.ts` passes **unedited**.
- `npm run smoke:live` still passes against the real Hermes gateway.
- `node gate/cli.mjs start` serves a manifest advertising every configured provider.
- `curl` against `/v1/models` returns 401 without a token and the model list with one.
- A malformed provider is skipped with a named field, and the Gate still serves the others.

**Next:** Plan 2 — `ManifestClient`, manifest `providers[]` child sync in the app, the `anthropic` flavor, signed Ed25519 pairing, and `smoke:live` running identical assertions against both Hermes and the Gate.
