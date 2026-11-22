import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
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

/**
 * A loopback port the probe is refused at, that no listener can take from it.
 *
 * Port 1 is below every OS ephemeral range, so `listen(0)` -- including the
 * Gate this file starts, and every other server `test:gate` runs -- can never
 * be handed it. The helper this replaced bound an ephemeral port and released
 * it. Under the full suite the OS handed that same port straight back to
 * another listener (sometimes this file's own Gate, which then answered the
 * probe on `/v1/models` with a 401): the check settled `unavailable`/
 * `invalid_credentials` instead of `degraded`, so the expectation below failed
 * at random. A refused endpoint has to be one nothing can be given, not one
 * the OS merely has not reused yet.
 */
const REFUSED_PORT = 1;

function closedPort() {
  // The property the two checks below rest on, asserted rather than assumed:
  // a port `listen(0)` can be handed back out is not a refused endpoint.
  assert.ok(
    REFUSED_PORT > 0 && REFUSED_PORT < 1024,
    `the refused probe endpoint ${REFUSED_PORT} is inside the ephemeral range and can be taken by another listener`,
  );
  return REFUSED_PORT;
}

/** A listener that accepts and then never answers: a half-dead vendor. */
async function unresponsiveEndpoint() {
  const server = createServer(() => { /* accept the connection, answer nothing */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * The premise the refused-probe checks rest on, checked at the moment they
 * rest on it: a TCP connect to the endpoint must not be answered. A connect
 * that is refused and one that is dropped before an answer both count -- both
 * leave the probe with no vendor response. A connect that *is accepted* fails:
 * that is another listener answering where the probe expects nobody.
 */
async function assertUnreachable(port) {
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });
      socket.setTimeout(1000, () => socket.destroy(
        Object.assign(new Error(`connect to ${port} timed out`), { code: 'ETIMEDOUT' }),
      ));
      socket.on('error', reject);
    }),
    (error) => {
      assert.ok(
        ['ECONNREFUSED', 'EACCES', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code),
        `the probe endpoint ${port} did not settle as unreachable (${error.code ?? error.message})`,
      );
      return true;
    },
    `the probe endpoint ${port} accepted a connection`,
  );
}

async function gateWithOneProvider({ providerPort = closedPort(), requestTimeoutMs = 5000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-provider-manifest-'));
  const gateHome = join(root, '.gate-home');

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
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      credentialRef: CREDENTIAL_REF,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: requestTimeoutMs },
  }), 'utf8');

  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set(CREDENTIAL_REF, 'nvapi-test-credential');
  const gate = await createGate({ root, port: 0, gateHome, vault });
  // The Gate binds `port: 0`; if it were ever handed the provider's endpoint
  // the probe would be asking the Gate, not a vendor. Port 1 makes that
  // impossible, and this says so at the point the two ports meet.
  assert.notEqual(gate.port, providerPort, 'the Gate took the endpoint the probe is supposed to reach');
  return { gate, root, providerPort };
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
  const { gate, root, providerPort } = await gateWithOneProvider();
  try {
    await assertUnreachable(providerPort);
    const checked = await rpc(gate, 'providers.health.check', { id: 'nim' });
    assert.equal(checked.result.readiness.state, 'degraded', 'the probe should have been refused');
    assert.equal(
      checked.result.readiness.code,
      'transient_network',
      'a refused connection is a transient network fault, not a credential verdict',
    );

    const advertised = await manifestProvider(gate);
    assert.equal(
      advertised.readiness.state,
      checked.result.readiness.state,
      'the manifest still advertises the readiness from before the check',
    );
    assert.equal(advertised.readiness.code, checked.result.readiness.code);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a catalog refresh is what the manifest then says', async () => {
  const { gate, root, providerPort } = await gateWithOneProvider();
  try {
    await assertUnreachable(providerPort);
    const before = await manifestProvider(gate);
    assert.equal(before.catalog.count, 0);

    const refreshed = await rpc(gate, 'providers.catalog.refresh', { id: 'nim' });
    assert.equal(refreshed.result.catalog.source, 'legacy_bootstrap');
    assert.equal(refreshed.result.readiness.state, 'degraded', 'the refresh probed the refused endpoint');

    const after = await manifestProvider(gate);
    assert.equal(after.readiness.state, refreshed.result.readiness.state);
    assert.equal(after.readiness.code, refreshed.result.readiness.code);
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unresponsive probe is what the manifest then says', async () => {
  // A vendor that accepts the connection and never answers, on a port this
  // test holds for the whole test: nothing else can answer in its place, and
  // the registration's own request budget is what ends the probe. A refusal
  // and a timeout are both transient network faults, so both settle
  // `degraded` -- the readiness the test and the manifest contract promise.
  const endpoint = await unresponsiveEndpoint();
  let gate;
  let root;
  try {
    ({ gate, root } = await gateWithOneProvider({ providerPort: endpoint.port, requestTimeoutMs: 150 }));
    const checked = await rpc(gate, 'providers.health.check', { id: 'nim' });
    assert.equal(checked.result.readiness.state, 'degraded', 'an unanswered probe is a transient network fault');
    assert.equal(checked.result.readiness.code, 'transient_network');

    const advertised = await manifestProvider(gate);
    assert.equal(advertised.readiness.state, checked.result.readiness.state);
    assert.equal(advertised.readiness.code, checked.result.readiness.code);
  } finally {
    if (gate) await gate.close();
    await closeServer(endpoint.server);
    if (root) await rm(root, { recursive: true, force: true });
  }
});
