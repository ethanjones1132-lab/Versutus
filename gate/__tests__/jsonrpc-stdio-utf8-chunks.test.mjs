import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createStdioJsonRpc } from '../core/cli-environments/jsonrpc-stdio.mjs';

// Accented, CJK, an em dash and astral emoji: 2-, 3- and 4-byte UTF-8 code
// points. Pipe reads stop at arbitrary byte offsets, so splitting the wire at
// any offset inside one of these is exactly the case `String(chunk)` got wrong.
const TEXT = 'café 漢字 — 🚀😀';

/** A child process whose stdin we read back as the "server" side. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.write = (text) => { child.written.push(JSON.parse(text)); return true; };
  child.stdin = stdin;
  return child;
}

/** One JSON-RPC line as a single UTF-8 Buffer, terminator included. */
function wire(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Byte offsets strictly inside a multi-byte UTF-8 sequence. A read that ends
 * at one of these offsets cuts a code point in half.
 */
function innerByteOffsets(bytes) {
  const offsets = [];
  for (let at = 0; at < bytes.length; at += 1) {
    const lead = bytes[at];
    const width = lead < 0x80 ? 1
      : (lead & 0xe0) === 0xc0 ? 2
        : (lead & 0xf0) === 0xe0 ? 3
          : 4;
    for (let k = 1; k < width; k += 1) offsets.push(at + k);
    at += width - 1;
  }
  return offsets;
}

function chunksAt(bytes, at) {
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

/**
 * Await a promise but fail fast with a useful message instead of parking on
 * the transport's request timeout when a corrupted line was silently dropped.
 */
function settled(promise, ms = 500) {
  return Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), ms).unref?.();
    }),
  ]);
}

test('a response cut inside every multi-byte code point resolves with exact text', async () => {
  // Every fresh transport starts its ids at 1, so this line has the same byte
  // layout as the reply built in each iteration below.
  const offsets = innerByteOffsets(wire({ id: 1, result: { text: TEXT } }));
  assert.ok(offsets.length > 0, 'the sample has multi-byte boundaries to cut');

  for (const at of offsets) {
    const child = fakeChild();
    const notes = [];
    const rpc = createStdioJsonRpc({ child, onDiagnostic: (note) => notes.push(note.message) });
    const promise = rpc.request('model/read');
    const { id } = child.written[0];
    const bytes = wire({ id, result: { text: TEXT } });
    const [head, tail] = chunksAt(bytes, at);
    child.stdout.emit('data', head);
    child.stdout.emit('data', tail);

    const outcome = await settled(promise);
    assert.equal(
      outcome.timedOut,
      undefined,
      `the reply line still parses when cut at byte ${at}: ${outcome.error?.message ?? ''}`,
    );
    assert.equal(outcome.error, undefined, `the reply resolved when cut at byte ${at}`);
    assert.equal(outcome.value.text, TEXT, `the text is intact when cut at byte ${at}`);
    assert.ok(!JSON.stringify(outcome.value).includes('\uFFFD'), 'no replacement character survives');
    assert.deepEqual(notes, [], 'the split line is never reported as a protocol diagnostic');
  }
});

test('an error response cut inside a multi-byte code point rejects with exact text', async () => {
  const child = fakeChild();
  const rpc = createStdioJsonRpc({ child });
  const promise = rpc.request('thread/read', { threadId: 'utf8' });
  const { id } = child.written[0];
  const message = { id, error: { code: -32602, message: `unknown ${TEXT}` } };
  const bytes = wire(message);
  const [head, tail] = chunksAt(bytes, innerByteOffsets(bytes)[0]);
  child.stdout.emit('data', head);
  child.stdout.emit('data', tail);

  const outcome = await settled(promise);
  assert.equal(outcome.timedOut, undefined, 'an error reply is not lost to a split code point');
  assert.equal(outcome.value, undefined, 'an error response never resolves the request');
  assert.equal(outcome.error.message, `unknown ${TEXT}`);
});

test('a notification cut inside every multi-byte code point is routed once', () => {
  const message = {
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { delta: TEXT },
  };
  const bytes = wire(message);
  const offsets = innerByteOffsets(bytes);
  assert.ok(offsets.length > 0, 'the sample has multi-byte boundaries to cut');

  for (const at of offsets) {
    const child = fakeChild();
    const seen = [];
    createStdioJsonRpc({ child, onNotification: (note) => seen.push(note) });
    const [head, tail] = chunksAt(bytes, at);
    child.stdout.emit('data', head);
    child.stdout.emit('data', tail);

    assert.equal(seen.length, 1, `exactly one notification when cut at byte ${at}`);
    assert.equal(seen[0].params.delta, TEXT);
    assert.ok(!JSON.stringify(seen[0]).includes('\uFFFD'));
  }
});

test('a server request cut inside every multi-byte code point is answered once', async () => {
  const message = {
    jsonrpc: '2.0',
    id: 42,
    method: 'execCommandApproval',
    params: { command: `printf "${TEXT}"` },
  };
  const bytes = wire(message);
  const offsets = innerByteOffsets(bytes);
  assert.ok(offsets.length > 0, 'the sample has multi-byte boundaries to cut');

  for (const at of offsets) {
    const child = fakeChild();
    const received = [];
    const notes = [];
    createStdioJsonRpc({
      child,
      onDiagnostic: (note) => notes.push(note.message),
      onServerRequest: async (request) => {
        received.push(request);
        return { decision: 'approved', echo: request.params.command };
      },
    });
    const [head, tail] = chunksAt(bytes, at);
    child.stdout.emit('data', head);
    child.stdout.emit('data', tail);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1, `the server request is handled once when cut at byte ${at}`);
    assert.equal(received[0].params.command, `printf "${TEXT}"`);
    const replies = child.written.filter((sent) => sent.id === 42);
    assert.equal(replies.length, 1, `the server request is answered once when cut at byte ${at}`);
    assert.equal(replies[0].result.echo, `printf "${TEXT}"`);
    assert.deepEqual(notes, [], 'a split line is never reported as a protocol diagnostic');
  }
});

test('stdout and stderr decode independently while their chunks interleave', () => {
  const child = fakeChild();
  const notes = [];
  const seen = [];
  createStdioJsonRpc({
    child,
    onDiagnostic: (note) => notes.push(note.message),
    onNotification: (note) => seen.push(note),
  });

  const stdoutBytes = wire({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { delta: '🎉 done' },
  });
  const stderrBytes = Buffer.from('警告✓🚀', 'utf8');
  // stdout cuts inside the emoji, stderr inside the CJK character and then
  // inside the emoji: both pipes carry stalled decoder state at the same time.
  const stdoutAt = innerByteOffsets(stdoutBytes)
    .find((at) => (stdoutBytes[at] & 0xc0) === 0x80);
  assert.equal(typeof stdoutAt, 'number', 'the stdout split lands inside a code point');
  const [stderrHead] = chunksAt(stderrBytes, 1);
  const laterStderr = stderrBytes.subarray(1);
  const stderrAt = laterStderr.length - 2;
  const [stderrMiddle, stderrTail] = chunksAt(laterStderr, stderrAt);

  child.stdout.emit('data', stdoutBytes.subarray(0, stdoutAt));
  child.stderr.emit('data', stderrHead);
  child.stdout.emit('data', stdoutBytes.subarray(stdoutAt));
  child.stderr.emit('data', stderrMiddle);
  child.stderr.emit('data', stderrTail);

  assert.equal(seen.length, 1, 'the stdout notification is routed exactly once');
  assert.deepEqual(seen[0].params, { delta: '🎉 done' });
  assert.equal(notes.join(''), '警告✓🚀', 'stderr text is intact across its own splits');
  assert.equal(notes.length, 2, 'one diagnostic per non-empty decoded stderr read, no empty phantom');
  assert.ok(!notes.some((note) => note.includes('\uFFFD')), 'no replacement character in diagnostics');
});

test('several complete lines in one chunk are each routed once and in order', () => {
  const child = fakeChild();
  const seen = [];
  const notes = [];
  createStdioJsonRpc({
    child,
    onDiagnostic: (note) => notes.push(note.message),
    onNotification: (note) => seen.push(note),
  });

  const payload = Buffer.concat([
    wire({ jsonrpc: '2.0', method: 'turn/started', params: { text: TEXT } }),
    Buffer.from('  \n', 'utf8'),
    wire({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: '漢字' } }),
    wire({ jsonrpc: '2.0', method: 'turn/completed', params: {} }),
  ]);
  child.stdout.emit('data', payload);

  assert.deepEqual(
    seen.map((note) => note.method),
    ['turn/started', 'item/agentMessage/delta', 'turn/completed'],
  );
  assert.equal(seen[0].params.text, TEXT);
  assert.deepEqual(notes, [], 'whitespace-only lines are not diagnostics');
});

test('a line terminator arriving in a later chunk still frames the message', () => {
  const child = fakeChild();
  const seen = [];
  createStdioJsonRpc({ child, onNotification: (note) => seen.push(note.method) });

  const first = Buffer.from(JSON.stringify({ method: 'turn/started', params: { text: 'é' } }), 'utf8');
  const second = Buffer.from(JSON.stringify({ method: 'turn/completed', params: {} }), 'utf8');
  // A CRLF pair and both line ends fall in different reads. Until the final
  // newline arrives neither line is complete.
  child.stdout.emit('data', Buffer.concat([first, Buffer.from('\r', 'utf8')]));
  child.stdout.emit('data', Buffer.concat([Buffer.from('\n', 'utf8'), second, Buffer.from('\r', 'utf8')]));
  assert.deepEqual(seen, ['turn/started']);

  child.stdout.emit('data', Buffer.from('\n', 'utf8'));
  assert.deepEqual(seen, ['turn/started', 'turn/completed']);
});

test('already-decoded string chunks keep working, alone and beside Buffer chunks', () => {
  const child = fakeChild();
  const seen = [];
  const notes = [];
  createStdioJsonRpc({
    child,
    onDiagnostic: (note) => notes.push(note.message),
    onNotification: (note) => seen.push(note.params.delta),
  });

  const text = `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { delta: TEXT },
  })}\n`;
  // A string chunk may even end between the surrogate halves of an astral
  // character; concatenation reassembles it before the line is parsed.
  const at = text.indexOf('🚀') + 1;
  child.stdout.emit('data', text.slice(0, at));
  child.stdout.emit('data', text.slice(at));
  child.stdout.emit('data', `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { delta: 'café' },
  })}\n`);
  child.stderr.emit('data', 'déjà vu');

  assert.deepEqual(seen, [TEXT, 'café']);
  assert.deepEqual(notes, ['déjà vu']);
});

test('stream completion flushes decoders without duplicating text or diagnostics', () => {
  const child = fakeChild();
  const seen = [];
  const notes = [];
  createStdioJsonRpc({
    child,
    onDiagnostic: (note) => notes.push(note.message),
    onNotification: (note) => seen.push(note.method),
  });

  const line = wire({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { delta: TEXT },
  });
  child.stdout.emit('data', line);
  child.stderr.emit('data', Buffer.from('diagnostic 漢字', 'utf8'));
  child.stdout.emit('end');
  child.stderr.emit('end');

  assert.deepEqual(seen, ['item/agentMessage/delta'], 'the line is routed once, not again on end');
  assert.deepEqual(notes, ['diagnostic 漢字'], 'one diagnostic, and no empty phantom on end');
});

test('an unterminated trailing line is not dispatched when its stream ends', () => {
  const child = fakeChild();
  const seen = [];
  const notes = [];
  createStdioJsonRpc({
    child,
    onDiagnostic: (note) => notes.push(note.message),
    onNotification: (note) => seen.push(note.method),
  });

  child.stdout.emit('data', wire({ jsonrpc: '2.0', method: 'turn/started', params: {} }));
  child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"turn/completed"', 'utf8'));
  child.stdout.emit('end');

  assert.deepEqual(seen, ['turn/started'], 'framing stays newline-delimited at end of stream');
  assert.deepEqual(notes, [], 'an incomplete line is not a diagnostic either');
});

test('an end in the middle of a code point adds no phantom text', () => {
  const child = fakeChild();
  const seen = [];
  createStdioJsonRpc({ child, onNotification: (note) => seen.push(note) });

  child.stdout.emit('data', wire({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { delta: 'ok' },
  }));
  const tail = Buffer.from('{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"🚀', 'utf8');
  child.stdout.emit('data', tail.subarray(0, tail.length - 1));
  child.stdout.emit('end');

  assert.equal(seen.length, 1, 'the complete line is still the only message');
  assert.equal(seen[0].params.delta, 'ok');
  assert.ok(!JSON.stringify(seen).includes('\uFFFD'), 'the unfinished tail never leaks into a message');
});
