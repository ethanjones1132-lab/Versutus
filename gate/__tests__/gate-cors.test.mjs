import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { parseAllowedOrigins, webCors } from '../core/cors.mjs';

// The web dev-server demo target runs the app in a phone BROWSER on Metro's
// port, which is cross-origin against the Gate's port — every fetch would be
// blocked by the browser unless the operator opts in by naming origins. These
// tests pin that contract: nothing changes until an origin is named, a named
// origin can read answers and preflight, an unlisted origin stays blind.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  delete process.env.VERSUTUS_GATE_ALLOW_ORIGIN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-cors-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });

  const gate = await createGate({ root, port: 0, gateHome });
  return gate;
}

const gateBase = (gate) => `http://127.0.0.1:${gate.port}`;

test('with no allow-list configured the Gate answers exactly as before', async () => {
  const gate = await makeGate();
  try {
    const health = await fetch(`${gateBase(gate)}/health`, { headers: { Origin: 'http://192.168.1.20:8081' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('access-control-allow-origin'), null, 'no ACAO without opt-in');

    const preflight = await fetch(`${gateBase(gate)}/v1/sessions`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://192.168.1.20:8081' },
    });
    assert.notEqual(preflight.status, 204, 'no central preflight answer without opt-in');
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  } finally {
    await gate.close();
  }
});

test('a named origin can read answers across origins', async () => {
  process.env.VERSUTUS_GATE_ALLOW_ORIGIN = 'http://192.168.1.20:8081';
  const gate = await makeGate();
  try {
    const res = await fetch(`${gateBase(gate)}/.well-known/gateway.json`, {
      headers: { Origin: 'http://192.168.1.20:8081' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://192.168.1.20:8081', 'echoes the exact allowed origin');

    const body = await res.json();
    assert.equal(body.manifest, 'versutus-gateway/v1');
  } finally {
    await gate.close();
  }
});

test('the preflight is answered centrally, before routing', async () => {
  process.env.VERSUTUS_GATE_ALLOW_ORIGIN =
    'http://192.168.1.20:8081,https://gate.tailnet.example.ts.net:8081';
  const gate = await makeGate();
  try {
    const res = await fetch(`${gateBase(gate)}/v1/environments`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://192.168.1.20:8081',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://192.168.1.20:8081');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
    assert.equal(res.headers.get('access-control-allow-headers'), 'authorization, content-type');
    assert.ok(Number(res.headers.get('access-control-max-age')) > 0);
  } finally {
    await gate.close();
  }
});

test('an unlisted origin stays blind even when a list exists', async () => {
  process.env.VERSUTUS_GATE_ALLOW_ORIGIN = 'http://192.168.1.20:8081';
  const gate = await makeGate();
  try {
    const res = await fetch(`${gateBase(gate)}/.well-known/gateway.json`, {
      headers: { Origin: 'http://evil.example:8081' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no ACAO for unlisted origins');

    const preflight = await fetch(`${gateBase(gate)}/v1/environments`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example:8081' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  } finally {
    await gate.close();
  }
});

test('webCors return contract: preflight handled, requests passed through, off is invisible', () => {
  const headers = {};
  const fakeRes = {
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; },
    end() { this.ended = true; },
  };

  assert.equal(webCors({ method: 'GET', headers: {} }, fakeRes, undefined), false, 'no config -> pure passthrough');
  assert.deepEqual(Object.keys(headers), [], 'no config touches no headers');

  fakeRes.statusCode = 200;
  assert.equal(
    webCors({ method: 'OPTIONS', headers: { origin: 'http://a:8081' } }, fakeRes, 'http://a:8081'),
    true,
    'preflight for a listed origin is fully handled',
  );
  assert.equal(fakeRes.ended, true);
  assert.equal(fakeRes.statusCode, 204);

  assert.equal(
    webCors({ method: 'POST', headers: { origin: 'http://a:8081' } }, fakeRes, 'http://a:8081'),
    false,
    'normal requests continue to the router',
  );
  assert.equal(headers['Access-Control-Allow-Origin'], 'http://a:8081');
});

test('parseAllowedOrigins trims, lowercases, dedupes; empty stays empty', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins('   '), []);
  assert.deepEqual(
    parseAllowedOrigins(' HTTP://A.local:8081 , http://a.local:8081 ,, https://B.ts.net:8081 '),
    ['http://a.local:8081', 'https://b.ts.net:8081'],
  );
});
