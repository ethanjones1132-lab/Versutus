import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * The MCP server Claude Code spawns for `--permission-prompt-tool`: it must
 * speak enough JSON-RPC to be discovered, forward the call to the Gate's
 * bridge, and answer a denial — not a crash — when the bridge is not there.
 */

const SCRIPT = fileURLToPath(new URL('../core/cli-environments/claude-permission-tool.mjs', import.meta.url));

/** Start the script and talk to it over its stdin/stdout. */
function startTool(env = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  let buffer = '';
  let nextId = 1;
  const waiters = new Map();
  // A kill during teardown can make a pending write fail; that is the end of
  // the test, not something to report as an unhandled stream error.
  child.stdin.on('error', () => {});
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    child,
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    request(method, params) {
      const id = nextId++;
      send({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiters.delete(id)) reject(new Error(`no answer to ${method}`));
        }, 5_000);
        timer.unref();
        waiters.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

/** A stand-in for the Gate's loopback bridge, recording what it was sent. */
async function stubBridge() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ path: req.url, secret: req.headers['x-gate-bridge'], body: raw });
      const arguments_ = JSON.parse(raw);
      const text = JSON.stringify({ behavior: 'allow', updatedInput: arguments_ });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/permission`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A port nothing is listening on, so a connect is refused rather than hung. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the tool handshakes, lists itself, and forwards a call to the Gate', async () => {
  const bridge = await stubBridge();
  const tool = startTool({
    GATE_PERMISSION_URL: bridge.url,
    GATE_PERMISSION_SECRET: 'test-secret',
  });
  try {
    const initialized = await tool.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2.1.0' },
    });
    assert.equal(initialized.result.protocolVersion, '2024-11-05');
    assert.deepEqual(initialized.result.capabilities, { tools: {} });
    assert.equal(initialized.result.serverInfo.name, 'gate-permissions');

    tool.notify('notifications/initialized');

    const listed = await tool.request('tools/list');
    assert.equal(listed.result.tools.length, 1);
    assert.equal(listed.result.tools[0].name, 'approve');
    assert.deepEqual(listed.result.tools[0].inputSchema, { type: 'object', additionalProperties: true });
    assert.match(listed.result.tools[0].description, /approve/i);

    const arguments_ = { command: 'rm -rf build', reason: 'clean the tree' };
    const called = await tool.request('tools/call', { name: 'approve', arguments: arguments_ });
    assert.equal(called.result.content.length, 1);
    assert.equal(called.result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(called.result.content[0].text), {
      behavior: 'allow',
      updatedInput: arguments_,
    });

    assert.equal(bridge.seen.length, 1);
    assert.equal(bridge.seen[0].secret, 'test-secret');
    assert.deepEqual(JSON.parse(bridge.seen[0].body), arguments_, 'the arguments go over verbatim');

    // A notification was never answered: the next reply is the ping's.
    const pinged = await tool.request('ping');
    assert.deepEqual(pinged.result, {});
  } finally {
    tool.close();
    await bridge.close();
  }
});

test('an unknown method is a JSON-RPC error, not a dropped request', async () => {
  const bridge = await stubBridge();
  const tool = startTool({ GATE_PERMISSION_URL: bridge.url, GATE_PERMISSION_SECRET: 'test-secret' });
  try {
    await tool.request('initialize', { protocolVersion: '2024-11-05' });
    const answer = await tool.request('resources/list');
    assert.equal(answer.error.code, -32601);
  } finally {
    tool.close();
    await bridge.close();
  }
});

test('an unreachable bridge answers a denial and the tool stays alive', async () => {
  const port = await closedPort();
  const tool = startTool({
    GATE_PERMISSION_URL: `http://127.0.0.1:${port}/permission`,
    GATE_PERMISSION_SECRET: 'test-secret',
  });
  try {
    await tool.request('initialize', { protocolVersion: '2024-11-05' });
    const called = await tool.request('tools/call', { name: 'approve', arguments: { command: 'ls' } });
    const decision = JSON.parse(called.result.content[0].text);
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /did not answer/i);

    const pinged = await tool.request('ping');
    assert.deepEqual(pinged.result, {});
    assert.equal(tool.child.exitCode, null, 'a denial must not end the process');
  } finally {
    tool.close();
  }
});

test('a bridge that answers non-200 or nonsense is a denial too', async () => {
  const responses = [
    { status: 500, body: 'boom' },
    { status: 200, body: 'not json' },
  ];
  const seen = [];
  const server = createServer((req, res) => {
    req.resume();
    const next = responses[seen.length] ?? responses[responses.length - 1];
    seen.push(true);
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(next.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const tool = startTool({
    GATE_PERMISSION_URL: `http://127.0.0.1:${port}/permission`,
    GATE_PERMISSION_SECRET: 'test-secret',
  });
  try {
    await tool.request('initialize', { protocolVersion: '2024-11-05' });
    for (const expected of [/answered 500/, /not a decision/]) {
      const called = await tool.request('tools/call', { name: 'approve', arguments: {} });
      const decision = JSON.parse(called.result.content[0].text);
      assert.equal(decision.behavior, 'deny');
      assert.match(decision.message, expected);
    }
  } finally {
    tool.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('with no bridge configured the tool denies instead of failing', async () => {
  const tool = startTool({
    GATE_PERMISSION_URL: '',
    GATE_PERMISSION_SECRET: '',
  });
  try {
    await tool.request('initialize', { protocolVersion: '2024-11-05' });
    const called = await tool.request('tools/call', { name: 'approve', arguments: {} });
    assert.equal(JSON.parse(called.result.content[0].text).behavior, 'deny');
  } finally {
    tool.close();
  }
});
