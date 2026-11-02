import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';

// A v2 OpenCode server's SPA catch-all answers an unknown path with a web page,
// and a proxy in front of a v1 server can answer one too. Read as JSON that was
// `SyntaxError: Unexpected token '<'`, which names neither the route nor the
// content type, and the roster surface reported it as an engine sentence rather
// than as a server that has no Bot inventory. These tests pin the named answer,
// and the empty-body and non-2xx behaviour the naming must not disturb.
//
// The fake is a real HTTP server so a genuine `Content-Type` reaches the read.

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A fake server whose `/agent` route is `answer`, and 404 JSON everywhere else. */
async function startFakeOpenCode(answer = { status: 200, body: '[]' }) {
  const state = { requests: [] };
  const http = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    state.requests.push(`${req.method} ${path}`);
    if (path !== '/agent') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'NotFound', data: { message: 'no such route' } }));
      return;
    }
    if (answer.type === 'html') {
      res.writeHead(answer.status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><div id="root"></div></body></html>');
      return;
    }
    if (answer.type === 'empty') {
      res.writeHead(answer.status, { 'Content-Length': '0' });
      res.end();
      return;
    }
    if (answer.type === 'status') {
      res.writeHead(answer.status);
      res.end();
      return;
    }
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(answer.body);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () => {
      http.closeAllConnections();
      return new Promise((resolve) => http.close(resolve));
    },
  });
  return { baseUrl: `http://127.0.0.1:${http.address().port}`, state };
}

const SCOUT = {
  name: 'scout',
  native: false,
  mode: 'primary',
  description: 'Scout, a test agent',
  model: { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
};

test('an HTML page where the Bot roster should be is a named server answer, not a parser sentence', async () => {
  const { baseUrl } = await startFakeOpenCode({ type: 'html', status: 200 });
  const backend = createOpenCodeBackend({ baseUrl });

  const error = await backend.listBots().then(
    () => null,
    (failure) => failure,
  );

  assert.ok(error, 'a web page must not be believed as an empty Bot roster');
  assert.equal(error.constructor.name, 'Error', `the raw parser error leaked: ${error.message}`);
  assert.equal(error.code, 'backend_not_json');
  assert.equal(error.status, 502);
  assert.match(error.message, /\/agent/, 'the message names the route');
  assert.match(error.message, /text\/html/, 'the message names the content type');
  assert.doesNotMatch(error.message, /Unexpected token/, 'no parser sentence speaks for the server');
});

test('a non-2xx answer keeps its upstream status and is not renamed', async () => {
  const { baseUrl } = await startFakeOpenCode({
    type: 'json',
    status: 404,
    body: JSON.stringify({ name: 'NotFound', data: { message: 'no such route' } }),
  });
  const backend = createOpenCodeBackend({ baseUrl });

  await assert.rejects(backend.listBots(), (error) => {
    assert.equal(error.status, 404);
    assert.notEqual(error.code, 'backend_not_json');
    assert.equal(error.message, 'opencode: no such route');
    return true;
  });
});

test('204, 205 and an empty 200 body are still a success that carries nothing', async () => {
  // The guard names a body that is not JSON; an absent body must not become one.
  // A server that answers the roster route with nothing is read as no agents.
  for (const answer of [
    { type: 'status', status: 204 },
    { type: 'status', status: 205 },
    { type: 'empty', status: 200 },
  ]) {
    const { baseUrl } = await startFakeOpenCode(answer);
    const roster = await createOpenCodeBackend({ baseUrl }).listBots();
    assert.deepEqual(roster, { object: 'list', data: [] });
  }
});

test('a JSON array roster is delivered byte-identically', async () => {
  const { baseUrl } = await startFakeOpenCode({
    type: 'json',
    status: 200,
    body: JSON.stringify([{ name: 'build', native: true, mode: 'primary' }, SCOUT]),
  });
  const roster = await createOpenCodeBackend({ baseUrl }).listBots();
  assert.deepEqual(roster, {
    object: 'list',
    data: [{
      id: 'scout',
      displayName: 'scout',
      routable: true,
      routingIssue: null,
      description: 'Scout, a test agent',
      model: { default: 'mimo-v2.6-flash-free', provider: 'opencode' },
      runtime: 'opencode',
    }],
  });
});
