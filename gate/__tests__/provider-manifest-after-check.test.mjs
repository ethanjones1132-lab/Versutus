import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

// The manifest advertises every provider's readiness, auth and models, and it
// was only rebuilt when a provider was created, updated or deleted -- the three
// calls that go through `statusAndReload`. `providers.health.check` and
// `providers.catalog.refresh`, the two calls that actually change readiness and
// models, returned and left it alone: a freshly connected phone was told a
// provider that had just failed its check was ready, and was still offered its
// models.

const CREDENTIAL_REF = 'provider/nim/api-key';

// The default vault backend is Windows DPAPI (it shells out to powershell.exe),
// so a vault built without one cannot encrypt off Windows. These tests care
// about manifest wiring, not encryption at rest, so they use the passthrough
// backend the other provider route tests use.
const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

/** A loopback port nothing is listening on, so the probe is refused at once. */
async function closedPort() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function gateWithOneProvider() {
  const root = await mkdtemp(join(tmpdir(), 'gate-provider-manifest-'));
  const gateHome = join(root, '.gate-home');
  const port = await closedPort();

  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers', 'nim.json'), JSON.stringify({
    schemaVersion: 2,
    kind: 'provider',
    id: 'nim',
    label: 'NIM',
    providerType: 'nvidia-nim',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      credentialRef: CREDENTIAL_REF,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
  }), 'utf8');

  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set(CREDENTIAL_REF, 'nvapi-test-credential');
  const gate = await createGate({ root, port: 0, gateHome, vault });
  return { gate, root };
}

async function rpc(gate, method, params) {
  const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ method, params }),
  });
  return response.json();
}

async function manifestProvider(gate) {
  const response = await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`);
  const body = await response.json();
  return body.providers.find((provider) => provider.id === 'nim');
}

test('a failed health check is what the manifest then says', async () => {
  const { gate, root } = await gateWithOneProvider();
  try {
    const checked = await rpc(gate, 'providers.health.check', { id: 'nim' });
    assert.equal(checked.result.readiness.state, 'degraded', 'the probe should have been refused');

    const advertised = await manifestProvider(gate);
    assert.equal(
      advertised.readiness.state,
      checked.result.readiness.state,
      'the manifest still advertises the readiness from before the check',
    );
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a catalog refresh is what the manifest then says', async () => {
  const { gate, root } = await gateWithOneProvider();
  try {
    const before = await manifestProvider(gate);
    assert.equal(before.catalog.count, 0);

    const refreshed = await rpc(gate, 'providers.catalog.refresh', { id: 'nim' });
    assert.equal(refreshed.result.catalog.source, 'legacy_bootstrap');

    const after = await manifestProvider(gate);
    assert.equal(after.readiness.state, refreshed.result.readiness.state);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});