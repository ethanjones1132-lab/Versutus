import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { createGate } from '../core/server.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';

// A turn can die after some text has already been relayed. Anthropic announces
// that as an ordinary `data:` frame carrying `{"type":"error",...}`, and the
// flavor codecs answer '' for anything that is not a text delta -- the same
// answer as "no text this frame". So the relay kept reading, the body closed
// cleanly, the client saw the partial text and a normal `[DONE]`, and
// `noteTurnOutcome(providerId, null)` promoted the provider to `ready`.

const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

/** An upstream that streams one delta, announces a failure, and closes. */
async function startFailingUpstream() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hel' },
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A Gate holding one `anthropic_messages` provider pointed at `baseUrl`, with a
 * key in the vault. The loopback baseUrl keeps the origin allowlist out of it.
 */
async function gateWithAnthropicProvider(baseUrl, { timeoutMs = 120000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-stream-err-'));
  const gateHome = join(root, '.gate-home');

  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers', 'claude.json'), JSON.stringify({
    schemaVersion: 2,
    kind: 'provider',
    id: 'claude',
    label: 'Claude',
    providerType: 'anthropic',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'anthropic_messages',
      baseUrl,
      credentialRef: 'provider-claude-api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs },
  }), 'utf8');

  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('provider-claude-api-key', 'test-key');
  return createGate({ root, port: 0, gateHome, vault });
}

test('an error frame mid-stream ends the turn with the failure, not a [DONE]', async () => {
  const upstream = await startFailingUpstream();
  let gate;
  try {
    gate = await gateWithAnthropicProvider(upstream.baseUrl);
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        providerId: 'claude',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    const text = await response.text();

    // The text that did arrive is still relayed — it was real output.
    assert.match(text, /Hel/);
    // What must not be there: a success marker, or silence about the failure.
    assert.doesNotMatch(text, /\[DONE\]/);
    const errorFrame = JSON.parse(
      text.split('\n\n').find((part) => part.includes('"error"')).split('data: ')[1],
    );
    assert.match(errorFrame.error.message, /Overloaded/);
    assert.equal(errorFrame.error.code, 'overloaded_error');
  } finally {
    if (gate) await gate.close();
    await upstream.close();
  }
});

test('a vendor that goes silent after its headers does not hold the turn open', async () => {
  const upstream = await startStallingUpstream();
  let gate;
  try {
    // A short idle budget so the test does not wait the production default; the
    // relay reads the registration's own timeoutMs, the same number the header
    // watchdog used.
    gate = await gateWithAnthropicProvider(upstream.baseUrl, { timeoutMs: 400 });
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        providerId: 'claude',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    // Without an idle deadline this never settles: the header watchdog is
    // cleared once the Response object exists, and `reader.read()` has no bound
    // of its own -- so the turn, its journal record and both sockets were held
    // for the life of the process while the keepalive told the phone it lived.
    const settled = await Promise.race([
      response.text(),
      new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 5000); timer.unref?.(); }),
    ]);
    assert.ok(settled !== null, 'the turn settled instead of hanging on a silent vendor');
    assert.match(settled, /Hel/, 'the text that did arrive is still relayed');
    assert.doesNotMatch(settled, /\[DONE\]/, 'a stalled turn is not a success');
    assert.match(settled, /"error"/, 'the client is told why the turn ended');
  } finally {
    if (gate) await gate.close();
    await upstream.close();
  }
});

/**
 * An upstream that streams one delta and then goes silent forever: 200 with
 * headers, a body that never closes and never sends another byte. The header
 * watchdog is already cleared by the time the body is read, so only an idle
 * deadline on the relay itself can end this turn.
 */
async function startStallingUpstream() {
  const sockets = new Set();
  const server = createServer((_req, res) => {
    sockets.add(res.socket);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hel' },
    })}\n\n`);
    // Deliberately no res.end(): the vendor has stopped talking.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * The turn's verdict is recorded after the response has been sent, so the read
 * gives that write a bounded moment to land rather than racing it.
 */
async function readVerdict(gate, id) {
  const deadline = Date.now() + 2000;
  let snapshot;
  do {
    snapshot = await (
      await fetch(`http://127.0.0.1:${gate.port}/v1/providers/${id}`, {
        headers: { Authorization: `Bearer ${gate.token}` },
      })
    ).json();
    if (snapshot.readiness?.code) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return snapshot;
}

test('the failed turn is recorded as a failure, not promoted to ready', async () => {
  const upstream = await startFailingUpstream();
  let gate;
  try {
    gate = await gateWithAnthropicProvider(upstream.baseUrl);
    await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({
        providerId: 'claude',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }).then((response) => response.text());

    const snapshot = await readVerdict(gate, 'claude');

    // The exact inversion the finding describes: a turn that died was recorded
    // as `{ ok: true }`, and `noteChatOutcome` reads that as proof the provider
    // can complete a turn — so it stamped both readiness and auth `ready`.
    assert.notEqual(snapshot.readiness.state, 'ready');
    assert.equal(snapshot.readiness.code, 'overloaded');
    assert.match(snapshot.readiness.message, /Overloaded/);
    // An overloaded vendor is not a credential problem, so auth stays ready:
    // what must not happen is both readings being `ready`.
    assert.equal(snapshot.auth.state, 'ready');
  } finally {
    if (gate) await gate.close();
    await upstream.close();
  }
});
