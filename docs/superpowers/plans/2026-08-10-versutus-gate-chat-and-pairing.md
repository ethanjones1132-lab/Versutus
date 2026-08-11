# Versutus Gate — Chat Proxy, Anthropic Flavor & Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Versutus Gate actually serve a conversation. Plan 1 built a Gate that advertises providers and lists their models but has no route that talks to one. This plan adds the chat proxy with SSE streaming, a second flavor (Anthropic Messages API) to prove the flavor abstraction holds for a non-OpenAI dialect, and the signed Ed25519 pairing flow from the design spec §8 — replacing the single static bootstrap token with device-bound, revocable ones. It also fixes two defects found while verifying Plan 1 on a reconciled tree (see below).

**Architecture:** The chat route resolves a provider, picks its flavor module by `config.flavor`, builds the upstream request, and either proxies a single JSON response or pipes upstream SSE through a normalizer so every provider looks the same to the caller regardless of dialect. Pairing adds two small disk-backed stores (`PairingStore` for pending requests and the operator's approval window, `DeviceTokenStore` for issued per-device tokens) because the Gate server and the `cli.mjs pair` commands that approve or revoke are separate processes — state has to live on disk, not in memory.

**Tech Stack:** Node 20+ ESM + `node --test`, matching Plan 1. Ed25519 via `node:crypto` only — no new dependency. Verified in this session that a raw 32-byte Ed25519 public key can be wrapped in a fixed SPKI DER header (`302a300506032b6570032100` + the 32 raw bytes) and verified with `crypto.verify(null, message, keyObject, signature)`, and that a signature produced by the app's `@noble/ed25519` library verifies correctly against `node:crypto` — the two sides of the pairing handshake are compatible.

**Scope boundary:** The `custom` flavor (provider-authored `listModels`/`streamChat`) is out of scope here. The chat route only dispatches `openai` and `anthropic` flavors; a `custom`-flavored provider's chat requests get a `501` naming the gap, not a silent failure.

---

## Defects found reconciling Plan 1 (fixed in Task 1 and Task 2)

Plan 1's two branches were merged and independently verified (47 app tests, 31 gate tests, typecheck, lint, both smoke suites, `smoke:live` against the real Hermes gateway — all passing on one tree for the first time). Reading the *delivered* code during that verification — not the plan text, which several tasks quietly diverged from — surfaced two defects that the next tasks build directly on top of, so they're fixed first:

1. **`gate/core/server.mjs` persists the bearer token to the OS temp directory**, not the Gate's own directory: `join(tmpdir(), 'versutus-gate-tokens.json')`. The `.gitignore` entry from Plan 1 Task 4 (`gate/.tokens.json`) protects a path nothing writes to, and every Gate on the machine collides on one shared token file outside the project entirely.
2. **The provider scaffold and `PROVIDER_PROMPT.md` never mention `capabilities`**, and have no `─── CONFIG ───` markers, while `gate/core/manifest.mjs:27` reads `provider.config.capabilities` directly. A provider filled in exactly as instructed ships into the manifest with a missing `capabilities` key.

Both root from the same cause: `createGate()` was built taking a `providersDir` parameter instead of a single `root` (the plan's original design), so there was never a natural place to put the token file next to the providers.

---

## File Structure

**Gate (modified):**
- `gate/core/server.mjs` — *modified.* `root`-based construction; chat proxy routes; flavor + pairing wiring.
- `gate/cli.mjs` — *modified.* `root`-based `start`; fixed scaffold template; new `pair` subcommands.
- `gate/PROVIDER_PROMPT.md` — *modified.* documents `capabilities`.
- `gate/flavors/openai.mjs` — *modified.* adds `parseResponseText` for the non-streaming path.
- `gate/__tests__/server.test.mjs` — *modified.* `root`-based fixtures; chat route tests.
- `gate/__tests__/openai-flavor.test.mjs` — *modified.* `parseResponseText` tests.
- `.gitignore` — *modified.* adds `gate/.pairing.json`, `gate/.device-tokens.json`.

**Gate (new):**
- `gate/core/signature.mjs` — Ed25519 verification of the app's signed access payload.
- `gate/core/device-tokens.mjs` — per-device bearer tokens, revocable, uncached reads.
- `gate/core/pairing.mjs` — pending requests + operator approval window, disk-backed.
- `gate/flavors/anthropic.mjs` — Messages API translation.
- `gate/__tests__/signature.test.mjs`
- `gate/__tests__/device-tokens.test.mjs`
- `gate/__tests__/pairing.test.mjs`
- `gate/__tests__/anthropic-flavor.test.mjs`
- `gate/__tests__/chat-route.test.mjs`

No app-side files change in this plan — `ManifestClient` and `providers[]` child sync are Plan 2b.

---

## Task 1: Fix the Gate root convention and token store path

**Files:**
- Modify: `gate/core/server.mjs`
- Modify: `gate/cli.mjs`
- Modify: `gate/__tests__/server.test.mjs`

- [ ] **Step 1: Update the failing assertion first**

Replace the whole of `gate/__tests__/server.test.mjs` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

async function testGateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'gate-server-test-'));
  await mkdir(join(root, 'providers', 'test-provider'), { recursive: true });
  await writeFile(
    join(root, 'providers', 'test-provider', 'provider.mjs'),
    `
export const id = 'test-provider';
export const label = 'Test Provider';
export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'TEST_KEY',
  models: ['test-model-1', 'test-model-2'],
  capabilities: { chat: true, streaming: true },
};
`,
    'utf8'
  );
  return root;
}

test('health endpoint is unauthenticated', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  } finally {
    await gate.close();
  }
});

test('manifest endpoint is unauthenticated', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/.well-known/gateway.json`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.manifest);
    assert.ok(data.kind);
    assert.ok(Array.isArray(data.providers));
  } finally {
    await gate.close();
  }
});

test('models endpoint requires authentication', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/models`);
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('authenticated models endpoint returns all provider models', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const modelIds = (await response.json()).data.map((m) => m.id);
    assert.ok(modelIds.includes('test-model-1'));
    assert.ok(modelIds.includes('test-model-2'));
  } finally {
    await gate.close();
  }
});

test('scoped models endpoint returns provider-specific models', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/test-provider/v1/models`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(response.status, 200);
    const modelIds = (await response.json()).data.map((m) => m.id);
    assert.ok(modelIds.includes('test-model-1'));
    assert.ok(modelIds.includes('test-model-2'));
  } finally {
    await gate.close();
  }
});

test('unknown route returns 404', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/unknown`);
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
  }
});

test('token store persists under the gate root, not the OS temp directory', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const info = await stat(join(root, '.tokens.json'));
    assert.ok(info.isFile());
  } finally {
    await gate.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/server.test.mjs`
Expected: FAIL — `createGate` still expects `providersDir`, so provider loading and the new root-token test both fail.

- [ ] **Step 3: Change `createGate` to take `root`**

In `gate/core/server.mjs`, change the destructured config and the two paths built from it:

```js
export async function createGate(config = {}) {
  const {
    root,
    port = 0,
    name = 'Versutus Gate',
    version,
  } = config;

  const providersDir = join(root, 'providers');
  const tokenPath = join(root, '.tokens.json');

  const { providers } = await loadProviders(providersDir);

  const tokenStore = new TokenStore(tokenPath);
  const token = await tokenStore.ensureToken();
```

(This replaces the existing `providersDir` destructure and the `join(tmpdir(), 'versutus-gate-tokens.json')` line. Remove the now-unused `import { tmpdir } from 'node:os';` at the top of the file.)

- [ ] **Step 4: Update the CLI to pass `root`**

In `gate/cli.mjs`, in `handleStart`, replace:

```js
  const providersDir = join(__dirname, 'providers');

  try {
    console.log(`Starting ${gateName}...`);
    const gate = await createGate({
      providersDir,
      port: 8760,
      name: gateName,
    });
```

with:

```js
  try {
    console.log(`Starting ${gateName}...`);
    const gate = await createGate({
      root: __dirname,
      port: 8760,
      name: gateName,
    });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/server.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 6: Verify the token file lands in the right place manually**

Run: `cd gate && node cli.mjs start` (Ctrl-C after it prints the token), then check `ls gate/.tokens.json` exists and `ls "$TEMP"/versutus-gate-tokens.json` (or `$TMPDIR` on macOS/Linux) does **not**.

- [ ] **Step 7: Commit**

```bash
git add gate/core/server.mjs gate/cli.mjs gate/__tests__/server.test.mjs
git commit -m "fix(gate): persist the token store under the gate root, not the OS temp dir"
```

---

## Task 2: Fix the provider scaffold and prompt to cover `capabilities`

**Files:**
- Modify: `gate/cli.mjs`
- Modify: `gate/PROVIDER_PROMPT.md`

- [ ] **Step 1: Fix the scaffold template**

In `gate/cli.mjs`, replace `getProviderTemplate`:

```js
function getProviderTemplate(id, flavor) {
  const label = id.charAt(0).toUpperCase() + id.slice(1);
  return `export const id = '${id}';
export const label = '${label}';

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
```

- [ ] **Step 2: Document `capabilities` in the prompt**

In `gate/PROVIDER_PROMPT.md`, under `### config (object, exported)`, after the `#### models` subsection, add:

```markdown
#### `capabilities`
What the provider actually supports. `chat` must be `true`. Set `streaming: true`
only if the upstream API supports server-sent events for this endpoint — the
Gate will refuse a streaming request to a provider that didn't declare it.

Example:
```javascript
capabilities: { chat: true, streaming: true }
```
```

Then add `capabilities: { chat: true, streaming: true },` to every `config` block in the "Full Example" section (OpenAI, Anthropic, and Custom providers) and to the JSON manifest example under "Accessing the Gateway".

- [ ] **Step 3: Verify manually**

Run: `cd gate && node cli.mjs add testprov2 --flavor openai`
Expected: `gate/providers/testprov2/provider.mjs` contains the `─── CONFIG ───` markers and a `capabilities` field.

Clean up: `rm -rf gate/providers/testprov2`

- [ ] **Step 4: Commit**

```bash
git add gate/cli.mjs gate/PROVIDER_PROMPT.md
git commit -m "fix(gate): scaffold and document the capabilities field"
```

---

## Task 3: Ed25519 signature verification

**Files:**
- Create: `gate/core/signature.mjs`
- Test: `gate/__tests__/signature.test.mjs`

This verifies the exact payload the app already sends from `src/lib/portal/access.ts`:
`['v4', deviceId, clientId, role, scopes.join(','), String(signedAtMs)].join('|')`, signed with the device's Ed25519 private key, public key carried as base64url in the request body.

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/signature.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { buildSignedPayload, verifySignedAccessRequest } from '../core/signature.mjs';

/** Node-only Ed25519 fixture — no dependency on the app's signing library. */
function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64Url = der.subarray(der.length - 32).toString('base64url');

  const request = {
    deviceId: 'device-1',
    publicKeyB64Url,
    clientId: 'versutus-mobile',
    role: 'operator',
    scopes: ['chat:send', 'chat:read'],
    signedAtMs: Date.now(),
    ...overrides,
  };
  const payload = buildSignedPayload(request);
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
  return { request: { ...request, signature }, privateKey };
}

test('accepts a correctly signed, fresh request', () => {
  const { request } = fixture();
  const result = verifySignedAccessRequest(request, { now: request.signedAtMs });
  assert.equal(result.ok, true);
});

test('rejects a tampered field', () => {
  const { request } = fixture();
  const tampered = { ...request, role: 'admin' };
  const result = verifySignedAccessRequest(tampered, { now: tampered.signedAtMs });
  assert.equal(result.ok, false);
});

test('rejects a signature outside the clock-skew window', () => {
  const { request } = fixture();
  const farFuture = request.signedAtMs + 301_000;
  const result = verifySignedAccessRequest(request, { now: farFuture, maxSkewMs: 300_000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /skew/);
});

test('rejects a signature already used within the replay window', () => {
  const { request } = fixture();
  const replayCache = new Set();
  const first = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  const second = verifySignedAccessRequest(request, { now: request.signedAtMs, replayCache });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.reason, /replay|already used/);
});

test('rejects a malformed public key rather than throwing', () => {
  const { request } = fixture({ publicKeyB64Url: 'not-a-key' });
  const result = verifySignedAccessRequest(request, { now: request.signedAtMs });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/signature.test.mjs`
Expected: FAIL — cannot find module `../core/signature.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/signature.mjs`:

```js
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// Fixed ASN.1 SPKI header for a 32-byte raw Ed25519 public key. Node's
// crypto module has no "raw" import format for OKP keys, so a bare public
// key has to be wrapped in this DER envelope before crypto.createPublicKey
// will accept it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromB64Url(b64url) {
  const raw = Buffer.from(b64url, 'base64url');
  if (raw.length !== 32) throw new Error('public key must decode to 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The exact string the app signs — see src/lib/portal/access.ts. */
export function buildSignedPayload({ deviceId, clientId, role, scopes, signedAtMs }) {
  return ['v4', deviceId, clientId, role, scopes.join(','), String(signedAtMs)].join('|');
}

/**
 * Verify a signed access request from the app's device-pairing handshake.
 *
 * Rejects a payload whose `signedAtMs` is more than `maxSkewMs` from `now` in
 * either direction, and — when a `replayCache` is supplied — rejects a
 * signature already seen. Never throws: a malformed key or signature is a
 * verification failure, not a crash.
 */
export function verifySignedAccessRequest(request, { now = Date.now(), maxSkewMs = 300_000, replayCache } = {}) {
  const { deviceId, publicKeyB64Url, clientId, role, scopes, signedAtMs, signature } = request;

  if (typeof signedAtMs !== 'number' || Math.abs(now - signedAtMs) > maxSkewMs) {
    return { ok: false, reason: 'signedAtMs is outside the allowed clock skew' };
  }

  if (replayCache?.has(signature)) {
    return { ok: false, reason: 'signature already used (replay)' };
  }

  let publicKey;
  try {
    publicKey = publicKeyFromB64Url(publicKeyB64Url);
  } catch (error) {
    return { ok: false, reason: `invalid public key: ${error.message}` };
  }

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'signature is not valid base64url' };
  }

  const message = Buffer.from(buildSignedPayload({ deviceId, clientId, role, scopes, signedAtMs }), 'utf8');

  let valid;
  try {
    valid = cryptoVerify(null, message, publicKey, signatureBytes);
  } catch {
    valid = false;
  }

  if (!valid) return { ok: false, reason: 'signature does not match the payload' };

  replayCache?.add(signature);
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/signature.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add gate/core/signature.mjs gate/__tests__/signature.test.mjs
git commit -m "feat(gate): verify the app's signed Ed25519 access requests"
```

---

## Task 4: Device token store with revocation

**Files:**
- Create: `gate/core/device-tokens.mjs`
- Test: `gate/__tests__/device-tokens.test.mjs`

Unlike `TokenStore` (Plan 1's single bootstrap secret, cached after first read), this store is keyed by device and never caches — revocation happens from a separate `cli.mjs pair revoke` process, and a cached copy here would keep honoring a revoked token until the Gate restarted.

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/device-tokens.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceTokenStore } from '../core/device-tokens.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-device-tokens-'));
  return new DeviceTokenStore(join(dir, 'devices.json'));
}

test('issues a token and verifies it back to the device identity', async () => {
  const tokens = await store();
  const token = await tokens.issue('device-1', { role: 'operator', scopes: ['chat:send'] });
  const verified = await tokens.verify(`Bearer ${token}`);

  assert.equal(verified?.deviceId, 'device-1');
  assert.equal(verified?.role, 'operator');
  assert.deepEqual(verified?.scopes, ['chat:send']);
});

test('rejects an unknown token', async () => {
  const tokens = await store();
  await tokens.issue('device-1', { role: 'operator', scopes: [] });
  assert.equal(await tokens.verify('Bearer not-issued'), null);
});

test('revoke stops the token from verifying', async () => {
  const tokens = await store();
  const token = await tokens.issue('device-1', { role: 'operator', scopes: [] });
  const found = await tokens.revoke('device-1');

  assert.equal(found, true);
  assert.equal(await tokens.verify(`Bearer ${token}`), null);
});

test('revoking an unknown device reports not found', async () => {
  const tokens = await store();
  assert.equal(await tokens.revoke('nope'), false);
});

test('reissuing a device replaces its previous token', async () => {
  const tokens = await store();
  const first = await tokens.issue('device-1', { role: 'operator', scopes: [] });
  const second = await tokens.issue('device-1', { role: 'operator', scopes: [] });

  assert.notEqual(first, second);
  assert.equal(await tokens.verify(`Bearer ${first}`), null);
  assert.ok(await tokens.verify(`Bearer ${second}`));
});

test('list reports every device including revoked ones', async () => {
  const tokens = await store();
  await tokens.issue('device-1', { role: 'operator', scopes: [] });
  await tokens.issue('device-2', { role: 'operator', scopes: [] });
  await tokens.revoke('device-2');

  const all = await tokens.list();
  assert.equal(all.length, 2);
  assert.equal(all.find((d) => d.deviceId === 'device-2')?.revoked, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/device-tokens.test.mjs`
Expected: FAIL — cannot find module `../core/device-tokens.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/core/device-tokens.mjs`:

```js
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Tokens issued to individual paired devices — spec §8: "Device tokens are
 * bound to the device id that requested them and are revocable." Reads are
 * never cached: `cli.mjs pair revoke` runs as a separate process from the
 * long-lived Gate server, so a cache here would keep honoring a revoked
 * token until restart.
 */
export class DeviceTokenStore {
  constructor(path) {
    this.path = path;
  }

  async #readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
      return [];
    }
  }

  async #writeAll(devices) {
    await writeFile(this.path, JSON.stringify({ devices }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /** Issue (or reissue) a token for a device, replacing any prior one. */
  async issue(deviceId, { role, scopes }) {
    const devices = await this.#readAll();
    const token = randomBytes(32).toString('base64url');
    const next = devices.filter((entry) => entry.deviceId !== deviceId);
    next.push({ deviceId, token, role, scopes, issuedAtMs: Date.now(), revoked: false });
    await this.#writeAll(next);
    return token;
  }

  async revoke(deviceId) {
    const devices = await this.#readAll();
    let found = false;
    const next = devices.map((entry) => {
      if (entry.deviceId !== deviceId) return entry;
      found = true;
      return { ...entry, revoked: true };
    });
    if (found) await this.#writeAll(next);
    return found;
  }

  async list() {
    return this.#readAll();
  }

  /** Constant-time check against every non-revoked token on file. */
  async verify(authorizationHeader) {
    if (typeof authorizationHeader !== 'string') return null;
    const [scheme, presented] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !presented) return null;

    const presentedBuf = Buffer.from(presented);
    for (const entry of await this.#readAll()) {
      if (entry.revoked) continue;
      const expectedBuf = Buffer.from(entry.token);
      if (expectedBuf.length !== presentedBuf.length) continue;
      if (timingSafeEqual(presentedBuf, expectedBuf)) {
        return { deviceId: entry.deviceId, role: entry.role, scopes: entry.scopes };
      }
    }
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/device-tokens.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add gate/core/device-tokens.mjs gate/__tests__/device-tokens.test.mjs
git commit -m "feat(gate): add revocable per-device bearer tokens"
```

---

## Task 5: Pairing store and the signed-access route

**Files:**
- Create: `gate/core/pairing.mjs`
- Modify: `gate/core/server.mjs`
- Test: `gate/__tests__/pairing.test.mjs`

`PairingStore` is disk-backed for the same reason as `DeviceTokenStore`: `cli.mjs pair open|approve` runs as a separate process from the Gate server.

- [ ] **Step 1: Write the failing test for the store**

Create `gate/__tests__/pairing.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PairingStore } from '../core/pairing.mjs';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-pairing-'));
  return new PairingStore(join(dir, 'pairing.json'));
}

test('window is closed by default', async () => {
  const pairing = await store();
  assert.equal(await pairing.isWindowOpen(), false);
});

test('opening a window makes it open until it expires', async () => {
  const pairing = await store();
  await pairing.openWindow(1000);
  assert.equal(await pairing.isWindowOpen(), true);
});

test('adds a pending request and lists it', async () => {
  const pairing = await store();
  const requestId = await pairing.addPending({
    deviceId: 'device-1',
    publicKeyB64Url: 'key',
    clientId: 'versutus-mobile',
    role: 'operator',
    scopes: ['chat:send'],
  });

  const pending = await pairing.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, requestId);
  assert.equal(pending[0].deviceId, 'device-1');
});

test('a second request from the same device replaces the first', async () => {
  const pairing = await store();
  await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key', clientId: 'c', role: 'operator', scopes: [] });
  await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key2', clientId: 'c', role: 'operator', scopes: [] });

  const pending = await pairing.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].publicKeyB64Url, 'key2');
});

test('takePending removes and returns the request', async () => {
  const pairing = await store();
  const requestId = await pairing.addPending({ deviceId: 'device-1', publicKeyB64Url: 'key', clientId: 'c', role: 'operator', scopes: [] });

  const taken = await pairing.takePending(requestId);
  assert.equal(taken.deviceId, 'device-1');
  assert.deepEqual(await pairing.listPending(), []);
});

test('takePending returns null for an unknown id', async () => {
  const pairing = await store();
  assert.equal(await pairing.takePending('nope'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/pairing.test.mjs`
Expected: FAIL — cannot find module `../core/pairing.mjs`

- [ ] **Step 3: Write the store implementation**

Create `gate/core/pairing.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Pending access requests and the operator-controlled pairing window.
 * Persisted to disk: `cli.mjs pair open|approve` runs as a separate,
 * short-lived process from the long-lived Gate server.
 */
export class PairingStore {
  constructor(path) {
    this.path = path;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      return {
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        windowOpenUntilMs: typeof parsed.windowOpenUntilMs === 'number' ? parsed.windowOpenUntilMs : 0,
      };
    } catch {
      return { pending: [], windowOpenUntilMs: 0 };
    }
  }

  async #write(state) {
    await writeFile(this.path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  async isWindowOpen() {
    return Date.now() < (await this.#read()).windowOpenUntilMs;
  }

  async openWindow(durationMs) {
    const state = await this.#read();
    state.windowOpenUntilMs = Date.now() + durationMs;
    await this.#write(state);
  }

  /** Record a pending request, replacing any earlier one from the same device. */
  async addPending({ deviceId, publicKeyB64Url, clientId, role, scopes }) {
    const state = await this.#read();
    const requestId = randomUUID();
    state.pending = state.pending.filter((entry) => entry.deviceId !== deviceId);
    state.pending.push({ requestId, deviceId, publicKeyB64Url, clientId, role, scopes, requestedAtMs: Date.now() });
    await this.#write(state);
    return requestId;
  }

  async listPending() {
    return (await this.#read()).pending;
  }

  /** Remove and return a pending request by id, or null if it isn't there. */
  async takePending(requestId) {
    const state = await this.#read();
    const index = state.pending.findIndex((entry) => entry.requestId === requestId);
    if (index === -1) return null;
    const [entry] = state.pending.splice(index, 1);
    await this.#write(state);
    return entry;
  }
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `cd gate && node --test __tests__/pairing.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Wire the route into the server**

In `gate/core/server.mjs`, add imports:

```js
import { PairingStore } from './pairing.mjs';
import { DeviceTokenStore } from './device-tokens.mjs';
import { verifySignedAccessRequest } from './signature.mjs';
```

Inside `createGate`, after the existing `tokenStore`/`token` setup, add:

```js
  const pairing = new PairingStore(join(root, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const replayCache = new Set();
```

In the request handler, before the existing bootstrap-token auth check (so `/.well-known/gateway/access` stays reachable without a token), add a branch for the pairing POST. Read the body first:

```js
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
```

Then, inside the handler, right after the `/.well-known/gateway.json` branch:

```js
    if (pathname === '/.well-known/gateway/access' && method === 'POST') {
      const body = await readJsonBody(req);
      const device = body?.device;
      if (!body || !device?.id || !device?.publicKey || !body.signature || typeof body.signedAtMs !== 'number') {
        res.writeHead(400);
        res.end(JSON.stringify({ status: 'denied', reason: 'Malformed access request.' }));
        return;
      }

      const verification = verifySignedAccessRequest(
        {
          deviceId: device.id,
          publicKeyB64Url: device.publicKey,
          clientId: device.clientId,
          role: body.role ?? 'operator',
          scopes: Array.isArray(body.scopes) ? body.scopes : [],
          signedAtMs: body.signedAtMs,
          signature: body.signature,
        },
        { replayCache },
      );

      if (!verification.ok) {
        res.writeHead(403);
        res.end(JSON.stringify({ status: 'denied', reason: verification.reason }));
        return;
      }

      const existing = await deviceTokens.list();
      const already = existing.find((entry) => entry.deviceId === device.id && !entry.revoked);
      if (already) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'granted', token: already.token, role: already.role, scopes: already.scopes }));
        return;
      }

      const role = body.role ?? 'operator';
      const scopes = Array.isArray(body.scopes) ? body.scopes : [];

      if (await pairing.isWindowOpen()) {
        const grantedToken = await deviceTokens.issue(device.id, { role, scopes });
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'granted', token: grantedToken, role, scopes }));
        return;
      }

      const requestId = await pairing.addPending({
        deviceId: device.id,
        publicKeyB64Url: device.publicKey,
        clientId: device.clientId,
        role,
        scopes,
      });
      res.writeHead(202);
      res.end(JSON.stringify({ status: 'pending', requestId }));
      return;
    }
```

Finally, change the existing bootstrap-token auth check so a request also succeeds when it carries a valid *device* token. The current check reads:

```js
      const authHeader = req.headers.authorization;
      const isAuthenticated = await tokenStore.verify(authHeader);

      if (!isAuthenticated) {
        res.writeHead(401);
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Bearer token required',
        }));
        return;
      }
```

Change the second line to also accept a device token:

```js
      const authHeader = req.headers.authorization;
      const isAuthenticated = (await tokenStore.verify(authHeader)) || Boolean(await deviceTokens.verify(authHeader));
```

(The rest of the block — the `if (!isAuthenticated)` 401 response — is unchanged.)

- [ ] **Step 6: Write the route-level test**

Add to `gate/__tests__/server.test.mjs` (needs a real Ed25519 keypair, same Node-only technique as Task 3's fixture):

```js
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

function signedAccessBody(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64Url = der.subarray(der.length - 32).toString('base64url');
  const deviceId = overrides.deviceId ?? 'device-test';
  const clientId = 'versutus-mobile';
  const role = 'operator';
  const scopes = ['chat:send'];
  const signedAtMs = Date.now();
  const payload = ['v4', deviceId, clientId, role, scopes.join(','), String(signedAtMs)].join('|');
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');

  return {
    manifest: 'versutus-gateway/v1',
    device: { id: deviceId, publicKey: publicKeyB64Url, clientId, clientMode: 'ui' },
    role,
    scopes,
    signedAtMs,
    signature,
  };
}

test('a fresh device gets pending-approval when the pairing window is closed', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${gate.port}/.well-known/gateway/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedAccessBody()),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'pending');
  } finally {
    await gate.close();
  }
});

test('a bad signature is denied, not queued', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    const body = signedAccessBody();
    body.signature = 'aW52YWxpZA'; // valid base64url, wrong signature
    const response = await fetch(`http://localhost:${gate.port}/.well-known/gateway/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).status, 'denied');
  } finally {
    await gate.close();
  }
});

test('a device token issued via pairing authenticates like the bootstrap token', async () => {
  const root = await testGateRoot();
  const gate = await createGate({ root, port: 0 });
  try {
    // Approve directly through the same store the server reads, standing in
    // for `cli.mjs pair approve` running as a separate process.
    const { PairingStore } = await import('../core/pairing.mjs');
    const { DeviceTokenStore } = await import('../core/device-tokens.mjs');
    const { join } = await import('node:path');
    const pairing = new PairingStore(join(root, '.pairing.json'));
    const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));

    const accessBody = signedAccessBody();
    await fetch(`http://localhost:${gate.port}/.well-known/gateway/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accessBody),
    });
    const [pending] = await pairing.listPending();
    const token = await deviceTokens.issue(pending.deviceId, { role: pending.role, scopes: pending.scopes });
    await pairing.takePending(pending.requestId);

    const response = await fetch(`http://localhost:${gate.port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await gate.close();
  }
});
```

- [ ] **Step 7: Run the full server suite**

Run: `cd gate && node --test __tests__/server.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 8: Add secrets to `.gitignore`**

Append to `.gitignore`:

```
gate/.pairing.json
gate/.device-tokens.json
```

- [ ] **Step 9: Commit**

```bash
git add gate/core/pairing.mjs gate/core/server.mjs gate/__tests__/server.test.mjs .gitignore
git commit -m "feat(gate): serve the signed Ed25519 pairing handshake"
```

---

## Task 6: CLI `pair` subcommands

**Files:**
- Modify: `gate/cli.mjs`

No unit tests for this task — it's operator tooling over stores already covered in Tasks 4–5. Verified manually.

- [ ] **Step 1: Add the pair command handlers**

In `gate/cli.mjs`, add imports and handlers:

```js
import { PairingStore } from './core/pairing.mjs';
import { DeviceTokenStore } from './core/device-tokens.mjs';

async function handlePair(args) {
  const [sub, ...rest] = args;
  const pairing = new PairingStore(join(__dirname, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(__dirname, '.device-tokens.json'));

  if (sub === 'open') {
    const minutesIndex = rest.indexOf('--minutes');
    const minutes = minutesIndex >= 0 ? Number(rest[minutesIndex + 1]) : 5;
    await pairing.openWindow(minutes * 60_000);
    console.log(`Pairing window open for ${minutes} minute(s). The next device to connect is granted automatically.`);
    return;
  }

  if (sub === 'approve') {
    const requestId = rest[0];
    if (!requestId) {
      console.error('Usage: node gate/cli.mjs pair approve <requestId>');
      process.exit(1);
    }
    const entry = await pairing.takePending(requestId);
    if (!entry) {
      console.error(`No pending request "${requestId}". Run "pair list" to see open requests.`);
      process.exit(1);
    }
    const token = await deviceTokens.issue(entry.deviceId, { role: entry.role, scopes: entry.scopes });
    console.log(`Approved device ${entry.deviceId}. Token: ${token}`);
    return;
  }

  if (sub === 'revoke') {
    const deviceId = rest[0];
    if (!deviceId) {
      console.error('Usage: node gate/cli.mjs pair revoke <deviceId>');
      process.exit(1);
    }
    const found = await deviceTokens.revoke(deviceId);
    console.log(found ? `Revoked device ${deviceId}.` : `No device "${deviceId}" on file.`);
    return;
  }

  if (sub === 'list') {
    const pending = await pairing.listPending();
    const devices = await deviceTokens.list();
    console.log('Pending requests:');
    for (const entry of pending) console.log(`  ${entry.requestId}  device=${entry.deviceId}  role=${entry.role}`);
    if (pending.length === 0) console.log('  (none)');
    console.log('Paired devices:');
    for (const entry of devices) console.log(`  ${entry.deviceId}  role=${entry.role}  ${entry.revoked ? '(revoked)' : ''}`);
    if (devices.length === 0) console.log('  (none)');
    return;
  }

  console.error('Usage: node gate/cli.mjs pair <open|approve|revoke|list>');
  process.exit(1);
}
```

Wire it into `main()` alongside the existing `add`/`start` dispatch:

```js
  } else if (command === 'pair') {
    await handlePair(args);
  } else {
```

- [ ] **Step 2: Verify manually end to end**

```bash
cd gate && node cli.mjs start &
```

In another shell, write a tiny signing script (Node-only, matching the test fixture) to `/tmp/sign-access.mjs`:

```js
import { generateKeyPairSync, sign } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ type: 'spki', format: 'der' });
const publicKeyB64Url = der.subarray(der.length - 32).toString('base64url');
const deviceId = 'manual-test-device';
const clientId = 'versutus-mobile';
const role = 'operator';
const scopes = ['chat:send'];
const signedAtMs = Date.now();
const payload = ['v4', deviceId, clientId, role, scopes.join(','), String(signedAtMs)].join('|');
const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
console.log(JSON.stringify({
  manifest: 'versutus-gateway/v1',
  device: { id: deviceId, publicKey: publicKeyB64Url, clientId, clientMode: 'ui' },
  role, scopes, signedAtMs, signature,
}));
```

```bash
node /tmp/sign-access.mjs > /tmp/access-body.json
curl -s -X POST http://127.0.0.1:8760/.well-known/gateway/access -H 'Content-Type: application/json' -d @/tmp/access-body.json
```

Expected: `{"status":"pending","requestId":"..."}`.

```bash
node gate/cli.mjs pair list          # shows the pending request
node gate/cli.mjs pair approve <id>  # prints a token
curl -s http://127.0.0.1:8760/v1/models -H "Authorization: Bearer <token>"   # 200
node gate/cli.mjs pair revoke manual-test-device
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8760/v1/models -H "Authorization: Bearer <token>"  # 401
```

Stop the Gate (`kill %1` or Ctrl-C in its shell), then remove scratch state: `rm -f gate/.pairing.json gate/.device-tokens.json`.

- [ ] **Step 3: Commit**

```bash
git add gate/cli.mjs
git commit -m "feat(gate): add pair open/approve/revoke/list CLI commands"
```

---

## Task 7: `parseResponseText` for the OpenAI flavor

**Files:**
- Modify: `gate/flavors/openai.mjs`
- Modify: `gate/__tests__/openai-flavor.test.mjs`

The chat route (Task 9) needs a flavor-agnostic way to pull the final text out of a non-streaming upstream response, symmetric with `parseDelta` for streaming.

- [ ] **Step 1: Write the failing test**

Append to `gate/__tests__/openai-flavor.test.mjs`:

```js
import { parseResponseText } from '../flavors/openai.mjs';

test('extracts the message text from a non-streaming response', () => {
  const json = { choices: [{ message: { role: 'assistant', content: 'hello there' } }] };
  assert.equal(parseResponseText(json), 'hello there');
});

test('returns empty string when the response has no message content', () => {
  assert.equal(parseResponseText({ choices: [] }), '');
  assert.equal(parseResponseText({}), '');
});
```

(Add `parseResponseText` to the existing `import { buildChatRequest, parseDelta } from '../flavors/openai.mjs';` line at the top of the file instead of a second import line.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/openai-flavor.test.mjs`
Expected: FAIL — `parseResponseText` is not exported

- [ ] **Step 3: Add the implementation**

In `gate/flavors/openai.mjs`, add:

```js
/** Extract the assistant's text from a non-streaming chat completion. */
export function parseResponseText(json) {
  return json?.choices?.[0]?.message?.content ?? '';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/openai-flavor.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add gate/flavors/openai.mjs gate/__tests__/openai-flavor.test.mjs
git commit -m "feat(gate): add parseResponseText to the openai flavor"
```

---

## Task 8: Anthropic flavor

**Files:**
- Create: `gate/flavors/anthropic.mjs`
- Test: `gate/__tests__/anthropic-flavor.test.mjs`

The Messages API differs from the OpenAI dialect in three ways: a required `max_tokens`, a top-level `system` field instead of a `role: "system"` message, and `x-api-key` / `anthropic-version` headers instead of a bearer token. Proving the flavor abstraction survives these differences is the point of building this second flavor now rather than later.

- [ ] **Step 1: Write the failing test**

Create `gate/__tests__/anthropic-flavor.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChatRequest, parseDelta, parseResponseText } from '../flavors/anthropic.mjs';

const config = {
  flavor: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  models: ['claude-opus-5'],
  capabilities: { chat: true, streaming: true },
};

test('targets the messages endpoint with x-api-key and anthropic-version', () => {
  const request = buildChatRequest(config, 'test-key', {
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.headers['x-api-key'], 'test-key');
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.init.headers['Authorization'], undefined);
});

test('moves a system message out of messages and into the system field', () => {
  const request = buildChatRequest(config, 'k', {
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.system, 'be terse');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('applies a default max_tokens when none is given', () => {
  const request = buildChatRequest(config, 'k', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(JSON.parse(request.init.body).max_tokens, 4096);
});

test('rejects a model the provider did not declare', () => {
  assert.throws(
    () => buildChatRequest(config, 'k', { model: 'gpt-5', messages: [] }),
    /gpt-5/,
  );
});

test('extracts text from a content_block_delta event', () => {
  const chunk = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } });
  assert.equal(parseDelta(chunk), 'hi');
});

test('ignores non-text-delta events', () => {
  assert.equal(parseDelta(JSON.stringify({ type: 'message_start' })), '');
  assert.equal(parseDelta(JSON.stringify({ type: 'ping' })), '');
  assert.equal(parseDelta('not json'), '');
});

test('joins text blocks from a non-streaming response', () => {
  const json = { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'there' }] };
  assert.equal(parseResponseText(json), 'hello there');
});

test('parseResponseText returns empty string for a response with no text blocks', () => {
  assert.equal(parseResponseText({ content: [] }), '');
  assert.equal(parseResponseText({}), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gate && node --test __tests__/anthropic-flavor.test.mjs`
Expected: FAIL — cannot find module `../flavors/anthropic.mjs`

- [ ] **Step 3: Write the implementation**

Create `gate/flavors/anthropic.mjs`:

```js
/**
 * Anthropic Messages API flavor.
 *
 * Three differences from the openai.mjs dialect: `max_tokens` is required,
 * a system prompt is a top-level `system` field rather than a
 * `role: "system"` message, and auth is `x-api-key` / `anthropic-version`
 * headers instead of a bearer token.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export function buildChatRequest(config, apiKey, { model, messages, stream = false, maxTokens }) {
  const target = model ?? config.models[0];
  if (!config.models.includes(target)) {
    throw new Error(
      `model "${target}" is not declared by this provider (declared: ${config.models.join(', ')})`,
    );
  }

  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');

  const body = {
    model: target,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: rest,
    stream,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');

  return {
    url: `${config.baseUrl.replace(/\/+$/, '')}/messages`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    },
  };
}

/** Extract the text delta from one Messages API SSE event's data payload. */
export function parseDelta(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      return parsed.delta.text ?? '';
    }
    return '';
  } catch {
    return '';
  }
}

/** Join the text blocks of a non-streaming Messages API response. */
export function parseResponseText(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gate && node --test __tests__/anthropic-flavor.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add gate/flavors/anthropic.mjs gate/__tests__/anthropic-flavor.test.mjs
git commit -m "feat(gate): add the Anthropic Messages API flavor"
```

---

## Task 9: Chat proxy route with SSE streaming

**Files:**
- Modify: `gate/core/server.mjs`
- Test: `gate/__tests__/chat-route.test.mjs`

Routes: `POST /p/{id}/v1/chat/completions` (scoped) and `POST /v1/chat/completions` (unscoped — resolves the provider from `body.model`). Both require auth (existing bearer-or-device-token check). Response is normalized to an OpenAI-shaped chunk/JSON regardless of the upstream flavor, so a caller doesn't need to know which provider answered.

- [ ] **Step 1: Write the failing tests against a stub upstream**

Create `gate/__tests__/chat-route.test.mjs`. It starts a tiny local HTTP server standing in for the upstream provider — no real API key, no network call, matching spec §10 ("No live provider calls in CI"):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';

async function startStubUpstream({ stream } = {}) {
  const server = createServer((req, res) => {
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

async function gateWithStubProvider(upstreamBaseUrl, capabilities = { chat: true, streaming: true }) {
  const root = await mkdtemp(join(tmpdir(), 'gate-chat-'));
  await mkdir(join(root, 'providers', 'stub'), { recursive: true });
  await writeFile(
    join(root, 'providers', 'stub', 'provider.mjs'),
    `
export const id = 'stub';
export const label = 'Stub';
export const config = {
  flavor: 'openai',
  baseUrl: '${upstreamBaseUrl}',
  apiKeyEnv: 'STUB_KEY',
  models: ['stub-1'],
  capabilities: ${JSON.stringify(capabilities)},
};
`,
    'utf8',
  );
  process.env.STUB_KEY = 'fake-key-for-tests';
  const gate = await createGate({ root, port: 0 });
  return gate;
}

test('non-streaming chat proxies and normalizes the upstream response', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'Hello');
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('streaming chat pipes normalized SSE chunks through', async () => {
  const upstream = await startStubUpstream({ stream: true });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Hel/);
    assert.match(text, /lo/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('unscoped chat resolves the provider from the requested model', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('rejects an unauthenticated chat request', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'stub-1', messages: [] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('rejects streaming when the provider did not declare it', async () => {
  const upstream = await startStubUpstream({ stream: true });
  const gate = await gateWithStubProvider(upstream.baseUrl, { chat: true, streaming: false });
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/stub/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'stub-1', messages: [], stream: true }),
    });
    assert.equal(response.status, 400);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test('returns 404 for a scoped route naming an unknown provider', async () => {
  const upstream = await startStubUpstream({ stream: false });
  const gate = await gateWithStubProvider(upstream.baseUrl);
  try {
    const response = await fetch(`http://localhost:${gate.port}/p/nope/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 404);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd gate && node --test __tests__/chat-route.test.mjs`
Expected: FAIL — no route matches `/v1/chat/completions` or `/p/stub/v1/chat/completions`, both currently 404.

- [ ] **Step 3: Add flavor dispatch and the chat routes**

In `gate/core/server.mjs`, add imports:

```js
import * as openaiFlavor from '../flavors/openai.mjs';
import * as anthropicFlavor from '../flavors/anthropic.mjs';

const FLAVOR_MODULES = { openai: openaiFlavor, anthropic: anthropicFlavor };
```

Add a helper that proxies one chat request, streaming or not:

```js
async function proxyChat(provider, requestBody, res) {
  const flavorModule = FLAVOR_MODULES[provider.config.flavor];
  if (!flavorModule) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Chat is not implemented for flavor "${provider.config.flavor}"`, code: 'flavor_not_implemented' },
    }));
    return;
  }

  const wantsStream = requestBody.stream === true;
  if (wantsStream && provider.config.capabilities?.streaming !== true) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Provider "${provider.id}" does not support streaming`, code: 'streaming_unsupported' },
    }));
    return;
  }

  const apiKey = process.env[provider.config.apiKeyEnv] ?? '';
  let upstreamRequest;
  try {
    upstreamRequest = flavorModule.buildChatRequest(provider.config, apiKey, {
      model: requestBody.model,
      messages: requestBody.messages ?? [],
      stream: wantsStream,
    });
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, code: 'invalid_model' } }));
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest.url, upstreamRequest.init);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream request failed: ${error.message}`, code: 'upstream_unreachable' } }));
    return;
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: text || 'Upstream rejected the request', code: 'upstream_error' } }));
    return;
  }

  if (!wantsStream) {
    const json = await upstreamResponse.json();
    const text = flavorModule.parseResponseText(json);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gate-${Date.now()}`,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const text = flavorModule.parseDelta(data);
        if (text) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
```

The file gates every path through an allowlist *before* authentication — anything not on it 404s immediately, regardless of where a handler is defined further down:

```js
      const isKnownAuthenticatedRoute =
        (pathname === '/v1/models' && method === 'GET') ||
        /^\/p\/[^\/]+\/v1\/models$/.test(pathname);
```

Extend it to include both new chat routes, or the routes below are dead code:

```js
      const isKnownAuthenticatedRoute =
        (pathname === '/v1/models' && method === 'GET') ||
        /^\/p\/[^/]+\/v1\/models$/.test(pathname) ||
        (pathname === '/v1/chat/completions' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/chat\/completions$/.test(pathname);
```

Now add the route handlers themselves, after the auth check (in the "Authenticated endpoints" section, alongside the existing `/v1/models` and scoped-models handlers):

```js
    if (pathname === '/v1/chat/completions' && method === 'POST') {
      const body = await readJsonBody(req);
      const provider = providers.find((p) => p.config.models.includes(body?.model));
      if (!provider) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `No provider declares model "${body?.model}"`, code: 'unknown_model' } }));
        return;
      }
      await proxyChat(provider, body ?? {}, res);
      return;
    }

    const scopedChatMatch = pathname.match(/^\/p\/([^/]+)\/v1\/chat\/completions$/);
    if (scopedChatMatch && method === 'POST') {
      const providerId = decodeURIComponent(scopedChatMatch[1]);
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, code: 'unknown_provider' } }));
        return;
      }
      const body = await readJsonBody(req);
      await proxyChat(provider, body ?? {}, res);
      return;
    }
```

(This matches the existing scoped `/p/{id}/v1/models` route's lookup pattern in the file — `providers.find((p) => p.id === providerId)` — rather than a map, since the delivered code has no `byId` map.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd gate && node --test __tests__/chat-route.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Run the full Gate suite**

Run: `cd gate && npm test`
Expected: PASS — every file under `gate/__tests__/` green (config, manifest, providers, tokens, openai-flavor, anthropic-flavor, signature, device-tokens, pairing, server, chat-route).

- [ ] **Step 6: Commit**

```bash
git add gate/core/server.mjs gate/__tests__/chat-route.test.mjs
git commit -m "feat(gate): proxy chat requests with normalized SSE streaming"
```

---

## Task 10: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Run every suite**

Run: `npm test`
Expected: app tests unaffected (47, unchanged — this plan touches nothing under `src/` or `__tests__/`), Gate tests grown from 31 to include Tasks 1–9's additions.

- [ ] **Step 2: Typecheck and lint the app**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output from either — confirms this plan's Gate-only changes didn't touch anything TypeScript picks up.

- [ ] **Step 3: Confirm no secrets are tracked**

Run: `git status --porcelain && git ls-files gate/ | grep -E '\.env|\.tokens|\.pairing|\.device-tokens' || echo "no secrets tracked"`
Expected: clean tree, `no secrets tracked`

- [ ] **Step 4: Manual live acceptance — a real conversation from a real provider**

This step needs a real API key and is not run in CI (spec §10). The operator (you) runs it once by hand:

```bash
cd gate
echo "OPENAI_API_KEY=sk-..." >> .env   # or whichever provider you have a key for
node cli.mjs add smoketest --flavor openai
# edit gate/providers/smoketest/provider.mjs: set baseUrl, apiKeyEnv, a real model id
node --env-file=.env cli.mjs start &
sleep 1
curl -N -X POST http://127.0.0.1:8760/p/smoketest/v1/chat/completions \
  -H "Authorization: Bearer $(node -e "console.log(require('fs').readFileSync('.tokens.json','utf8').match(/"token":"([^"]+)"/)[1])")" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi in five words."}],"stream":true}'
```

Expected: a stream of `data: {"choices":[{"delta":{"content":"..."}}]}` frames ending in `data: [DONE]`, forming a real response from the real provider.

Clean up: `kill %1`, `rm -rf gate/providers/smoketest`, remove the key line from `gate/.env`.

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "chore(gate): chat proxy and pairing complete" || echo "nothing to commit"
```

---

## Done when

- The two Plan 1 defects (token path, missing `capabilities`) are fixed and covered by tests.
- A signed access request from a fresh device is queued pending approval; `cli.mjs pair approve` issues it a working, revocable token; `cli.mjs pair revoke` immediately stops that token from authenticating.
- `POST /p/{id}/v1/chat/completions` and the unscoped `/v1/chat/completions` both work against a stub upstream in automated tests, streaming and non-streaming, for the `openai` flavor.
- The `anthropic` flavor passes the same shape of tests as `openai`, proving the abstraction holds for a materially different upstream dialect.
- A provider requesting `stream: true` without having declared `capabilities.streaming` gets a `400`, not a broken stream.
- The manual live acceptance step (Task 10, Step 4) produces a real streamed response from a real provider.

**Next:** Plan 2b — `ManifestClient`, manifest `providers[]` parsing and child profile sync in the app, and extending `smoke:live` to run identical assertions against both Hermes and the Gate.
