import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createStdioJsonRpc } from '../core/cli-environments/jsonrpc-stdio.mjs';

/** A child process whose stdin we can read back as the "server" side. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.stdin = { write: (text) => { child.written.push(JSON.parse(text)); return true; } };
  child.reply = (message) => child.stdout.emit('data', `${JSON.stringify(message)}\n`);
  return child;
}

test('a request resolves with the matching response', async () => {
  const child = fakeChild();
  const rpc = createStdioJsonRpc({ child });
  const promise = rpc.request('initialize', { clientInfo: { name: 'versutus' } });
  const sent = child.written[0];
  assert.equal(sent.method, 'initialize');
  child.reply({ id: sent.id, result: { codexHome: 'C:\\Users\\x\\.codex' } });
  assert.deepEqual(await promise, { codexHome: 'C:\\Users\\x\\.codex' });
});

test('responses are matched by id, not arrival order', async () => {
  const child = fakeChild();
  const rpc = createStdioJsonRpc({ child });
  const first = rpc.request('thread/list');
  const second = rpc.request('model/list');
  const [a, b] = child.written;
  child.reply({ id: b.id, result: 'models' });
  child.reply({ id: a.id, result: 'threads' });
  assert.equal(await first, 'threads');
  assert.equal(await second, 'models');
});

test('an error response rejects with the server message', async () => {
  const child = fakeChild();
  const rpc = createStdioJsonRpc({ child });
  const promise = rpc.request('thread/read', { threadId: 'nope' });
  child.reply({ id: child.written[0].id, error: { code: -32602, message: 'unknown thread' } });
  await assert.rejects(promise, /unknown thread/);
});

test('notifications reach the handler', async () => {
  const child = fakeChild();
  const seen = [];
  createStdioJsonRpc({ child, onNotification: (m) => seen.push(m.method) });
  child.reply({ method: 'turn/started', params: {} });
  child.reply({ method: 'item/agentMessage/delta', params: { delta: 'hi' } });
  assert.deepEqual(seen, ['turn/started', 'item/agentMessage/delta']);
});

test('a server request is answered, so the agent is never left blocking', async () => {
  const child = fakeChild();
  createStdioJsonRpc({ child, onServerRequest: async () => ({ decision: 'approved' }) });
  child.reply({ id: 99, method: 'execCommandApproval', params: { command: 'ls' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reply = child.written.find((m) => m.id === 99);
  assert.ok(reply, 'the server request must be answered');
  assert.deepEqual(reply.result, { decision: 'approved' });
});

test('a handler that throws still answers, with an error', async () => {
  const child = fakeChild();
  createStdioJsonRpc({ child, onServerRequest: async () => { throw new Error('denied by policy'); } });
  child.reply({ id: 7, method: 'applyPatchApproval', params: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reply = child.written.find((m) => m.id === 7);
  assert.match(reply.error.message, /denied by policy/);
});

test('a non-JSON line is a diagnostic, not a protocol failure', async () => {
  const child = fakeChild();
  const notes = [];
  const rpc = createStdioJsonRpc({ child, onDiagnostic: (d) => notes.push(d.message) });
  child.stdout.emit('data', 'Loading configuration...\n');
  const promise = rpc.request('initialize');
  child.reply({ id: child.written[0].id, result: 'ok' });
  assert.equal(await promise, 'ok');
  assert.deepEqual(notes, ['Loading configuration...']);
});

test('a message split across chunks is reassembled', async () => {
  const child = fakeChild();
  const rpc = createStdioJsonRpc({ child });
  const promise = rpc.request('thread/list');
  const id = child.written[0].id;
  const payload = JSON.stringify({ id, result: ['t1'] });
  child.stdout.emit('data', payload.slice(0, 10));
  child.stdout.emit('data', `${payload.slice(10)}\n`);
  assert.deepEqual(await promise, ['t1']);
});

test('pending requests reject when the process exits', async () => {
  const child = fakeChild();
  const rpc = createStdioJsonRpc({ child });
  const promise = rpc.request('turn/start');
  child.emit('exit', 1);
  await assert.rejects(promise, /exited with code 1/);
});
