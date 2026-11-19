import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createClaudeCodeBackend } from '../core/cli-environments/backends/claude-code.mjs';

function fixture() {
  const children = [];
  const backend = createClaudeCodeBackend({
    claudeHome: 'unused-transcripts', cwd: '.', executablePath: 'claude.exe',
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      children.push(child);
      return child;
    },
  });
  return { backend, children };
}

function emit(child, frame, newline = true) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}${newline ? '\n' : ''}`));
}

test('a Claude child that dies while its stdout stays open releases its turn with the partial', { timeout: 5_000 }, async () => {
  const { backend, children } = fixture();
  const events = [];
  const send = backend.sendMessage('896a9c65-7554-453a-8e20-ccf419617968', { text: 'hi' }, (event) => events.push(event));
  const failed = assert.rejects(send, { message: /exited with code null/, partialText: 'café' });
  const [child] = children;
  emit(child, { type: 'result', subtype: 'success', result: 'not a completed reply' });
  child.emit('exit', null, 'SIGTERM');
  // Exit can precede the last bytes; a descendant never closes the inherited pipe.
  emit(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'café' }] } }, false);
  await failed;
  assert.deepEqual(events.map(({ type }) => type), ['message.delta', 'run.failed']);
});

test('Claude turns run independently and a child error preserves just its own partial', { timeout: 5_000 }, async () => {
  const { backend, children } = fixture();
  const first = backend.sendMessage('896a9c65-7554-453a-8e20-ccf419617968', { text: 'first' });
  const second = backend.sendMessage('e60774b8-33c2-4792-8300-b3737de1e33a', { text: 'second' });
  const failed = assert.rejects(first, { code: 'EPIPE', partialText: 'partial first' });
  assert.equal(children.length, 2, 'a live process does not serialize unrelated chats');
  const [a, b] = children;
  emit(a, { type: 'assistant', message: { content: [{ type: 'text', text: 'partial first' }] } }, false);
  a.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }));
  emit(b, { type: 'result', subtype: 'success', result: 'second reply' }, false);
  b.emit('close', 0);
  await failed;
  assert.equal((await second).text, 'second reply');
});
