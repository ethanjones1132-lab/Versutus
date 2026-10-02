import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';

// The fetch-fake fixtures in opencode-backend.test.mjs answer every route with a
// JSON body, and that is exactly what the real server does NOT do: opencode
// 1.18.18 accepts a turn with `POST /session/{id}/prompt_async` and answers
// HTTP 204 with no body at all — verified live 2026-10-02 (`status 204,
// content-length absent, body bytes 0`) while the turn then ran to completion on
// the bus. A backend that reads every ok response with `response.json()` throws
// `SyntaxError: Unexpected end of JSON input` before the bus wait even starts,
// so the operator saw "SOMETHING WENT WRONG" in 0.2 s on a turn the server was
// happily running.
//
// So this fixture is a real HTTP server, driven through the real global fetch.

const SESSION_ID = 'ses_http';
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The session the fake serves, in the shape `toGatewaySession` reads. */
function session(at) {
  return {
    id: SESSION_ID,
    title: 'HTTP thread',
    parentID: null,
    time: { created: at, updated: at },
    tokens: { input: 12, output: 34, cache: { read: 0, write: 0 } },
  };
}

/** A finished assistant message, stamped when the server accepts the turn. */
function assistantMessage(at, text) {
  return {
    info: { id: 'msg_a', role: 'assistant', sessionID: SESSION_ID, time: { created: at, completed: at } },
    parts: [{ id: 'prt_a', type: 'text', text, sessionID: SESSION_ID, messageID: 'msg_a' }],
  };
}

/** The bus frames of a turn that answers: role, part type, the text, then idle. */
function turnFrames(text) {
  return [
    {
      type: 'message.updated',
      properties: {
        info: { id: 'msg_a', role: 'assistant', sessionID: SESSION_ID, tokens: { input: 12, output: 34 } },
      },
    },
    {
      type: 'message.part.updated',
      properties: {
        sessionID: SESSION_ID,
        part: { id: 'prt_a', type: 'text', text: '', messageID: 'msg_a', sessionID: SESSION_ID },
      },
    },
    {
      type: 'message.part.delta',
      properties: { sessionID: SESSION_ID, messageID: 'msg_a', partID: 'prt_a', field: 'text', delta: text },
    },
    { type: 'session.idle', properties: { sessionID: SESSION_ID } },
  ];
}

/**
 * A fake opencode 1.18.18 on a real socket.
 *
 * `promptAsync` is what the async route answers: `accept` is the real 204 with
 * no body, `missing` a server that predates the route (404, so the blocking
 * send is the answer), `boom` a 500 whose body names the failure. `silent` is a
 * turn the server accepts and then says nothing at all — the free models that
 * burned tokens behind the operator's red card. `abortResponse` is how the
 * abort route answers, which is a 200 with an empty body or a 205 on a server
 * that has nothing to say about a turn that is already over.
 */
async function startFakeOpenCode({
  promptAsync = 'accept',
  silent = false,
  abortResponse = 'json',
  text = 'the answer',
} = {}) {
  const started = Date.now();
  const state = {
    requests: [],
    aborted: [],
    session: session(started),
    messages: [],
    subscribers: new Set(),
  };
  const http = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/event') {
      // The shared bus: 200, an open body, and frames only for whoever is
      // attached now. A frame published to nobody is gone, as on a real server.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      state.subscribers.add(res);
      res.on('close', () => state.subscribers.delete(res));
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      state.requests.push({ method: req.method, path, raw: Buffer.concat(chunks).toString('utf8') });
      if (path === '/session' && req.method === 'POST') return json(res, 200, state.session);
      if (path === '/session' && req.method === 'GET') return json(res, 200, [state.session]);

      const prompt = /^\/session\/[^/]+\/prompt_async$/.exec(path);
      if (prompt && req.method === 'POST') {
        if (promptAsync === 'missing') return json(res, 404, { name: 'NotFound', data: { message: 'no such route' } });
        if (promptAsync === 'boom') return json(res, 500, { name: 'UnknownError', data: { message: 'boom' } });
        // Accepted at once, with nothing in the body to show for it. A turn that
        // goes on to answer says so on the bus; one that does not says nothing.
        if (!silent) state.messages.push(assistantMessage(Date.now(), text));
        res.writeHead(204);
        res.end();
        if (!silent) for (const event of turnFrames(text)) broadcast(event);
        return;
      }

      const message = /^\/session\/[^/]+\/message$/.exec(path);
      if (message && req.method === 'POST') {
        const answer = assistantMessage(Date.now(), text);
        state.messages.push(answer);
        return json(res, 200, answer);
      }
      if (message && req.method === 'GET') return json(res, 200, state.messages);

      // One message of one session: the bounded lookup the backend makes for a
      // part whose type never arrived.
      if (/^\/session\/[^/]+\/message\/[^/]+$/.test(path) && req.method === 'GET') {
        return json(res, 200, state.messages.at(-1) ?? null);
      }

      const abort = /^\/session\/([^/]+)\/abort$/.exec(path);
      if (abort && req.method === 'POST') {
        state.aborted.push(abort[1]);
        if (abortResponse === 'empty') {
          res.writeHead(200, { 'Content-Length': '0' });
          return res.end();
        }
        if (abortResponse === 'reset') {
          res.writeHead(205);
          return res.end();
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { name: 'NotFound', data: { message: 'no such route' } });
    });
  });

  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of state.subscribers) subscriber.write(frame);
  }

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const stopping = () => {
    http.closeAllConnections();
    return new Promise((resolve) => http.close(resolve));
  };
  servers.push({ close: stopping });
  return { baseUrl: `http://127.0.0.1:${http.address().port}`, state };
}

const MODEL = { providerId: 'opencode', modelId: 'fledge-alpha-free' };

test('a turn the server accepts with 204 and answers on the bus is that answer', async () => {
  // The 204 is the whole defect: `prompt_async` returns at once with no body, and
  // the answer is read back off the session when the turn goes idle. Read as
  // JSON, the empty body threw before the bus wait even began — a failure
  // reported while the server ran the turn.
  const { baseUrl, state } = await startFakeOpenCode();
  const backend = createOpenCodeBackend({ baseUrl });

  const result = await backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL });

  assert.equal(result.text, 'the answer');
  assert.equal(result.message.id, 'msg_a');
  const submitted = state.requests.find((request) => request.path.endsWith('/prompt_async'));
  assert.equal(submitted.method, 'POST');
  assert.deepEqual(JSON.parse(submitted.raw), {
    model: { providerID: 'opencode', modelID: 'fledge-alpha-free' },
    parts: [{ type: 'text', text: 'say hi' }],
  });
});

test('a turn the server accepts and then never answers fails with the model named', async () => {
  const { baseUrl, state } = await startFakeOpenCode({ silent: true });
  const backend = createOpenCodeBackend({ baseUrl, firstOutputIdleMs: 150, idleMs: 150 });

  await assert.rejects(
    () => backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL }),
    /opencode\/fledge-alpha-free did not answer within \d+ s\. OpenCode stopped the turn - try another model\./,
  );
  // A turn nobody is waiting for must not keep running on the server.
  assert.deepEqual(state.aborted, [SESSION_ID]);
});

test('a server that predates the async prompt still answers through the blocking send', async () => {
  const { baseUrl, state } = await startFakeOpenCode({ promptAsync: 'missing' });
  const backend = createOpenCodeBackend({ baseUrl });

  const result = await backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL });

  assert.equal(result.text, 'the answer');
  assert.deepEqual(
    state.requests.filter((request) => !request.path.includes('/event')).map((r) => `${r.method} ${r.path}`),
    [`POST /session/${SESSION_ID}/prompt_async`, `POST /session/${SESSION_ID}/message`],
  );
});

test('a 5xx on the async prompt still throws, with its status', async () => {
  const { baseUrl } = await startFakeOpenCode({ promptAsync: 'boom' });
  const backend = createOpenCodeBackend({ baseUrl });
  const turn = backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL });
  turn.catch(() => undefined);

  await assert.rejects(() => turn, (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.message, 'opencode: boom');
    return true;
  });
});

test('a body the server says is empty is a success that carries nothing', async () => {
  // A 204 is not the only empty answer: a route may answer 200 with
  // `Content-Length: 0`, or 205, and both are a server that took the request.
  // Read as JSON, either one throws `Unexpected end of JSON input`.
  for (const abortResponse of ['empty', 'reset']) {
    const { baseUrl } = await startFakeOpenCode({ abortResponse });
    const backend = createOpenCodeBackend({ baseUrl });
    await backend.abort(SESSION_ID);
  }
});

test('the routes that do answer with JSON still parse over real HTTP', async () => {
  // `call()` reads every ok response as text and parses what is there, so the
  // routes that owe JSON still have to come back as objects.
  const { baseUrl } = await startFakeOpenCode();
  const backend = createOpenCodeBackend({ baseUrl });

  const created = await backend.createSession({ title: 'HTTP thread', model: MODEL });
  assert.equal(created.id, SESSION_ID);
  assert.equal(created.input_tokens, 12);

  const listed = await backend.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, SESSION_ID);
  assert.equal(listed[0].source, 'opencode');

  await backend.sendMessage(SESSION_ID, { text: 'say hi', model: MODEL });
  const messages = await backend.listMessages(SESSION_ID);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'the answer' }]);
});
