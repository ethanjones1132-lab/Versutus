import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';

import { createClaudeCodeBackend } from '../core/cli-environments/backends/claude-code.mjs';

const SESSION_ID = '896a9c65-7554-453a-8e20-ccf419617968';

// A turn reads `claude --print --output-format stream-json` stdout as raw
// Buffers, and the pipe hands them over whenever they arrive. Every code point
// in this sample is multi-byte (accented, CJK, astral, skin-tone), so slicing
// the payload at one byte per chunk puts its boundaries exactly where the code
// points would break if the bytes were decoded one chunk at a time.
const ORIGINAL = 'café naïve — 中國字简化字 — 漢字 — 🚀👍🏽😀';

/** The stream-json stdout a turn would write, as a single UTF-8 Buffer. */
function stdoutBytes(lines) {
  const payload = lines
    .map(([line, newline]) => `${JSON.stringify(line)}${newline ? '\n' : ''}`)
    .join('');
  return Buffer.from(payload, 'utf8');
}

/** One Buffer per byte of the stdout, the worst way a pipe could ever chunk it. */
function splitPerByte(buffer) {
  return Array.from({ length: buffer.length }, (_none, at) => buffer.subarray(at, at + 1));
}

/**
 * A `claude --print` child whose stdout is Buffer chunks delivered one read
 * apart, then either exits cleanly or fails like a dying process does.
 */
function chunkedChild(chunks, { exitCode = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let at = 0;
  child.start = () => new Promise((delivered) => {
    const step = () => {
      if (at < chunks.length) {
        child.stdout.emit('data', chunks[at]);
        at += 1;
        setImmediate(step);
        return;
      }
      if (error) child.emit('error', error);
      else child.emit('close', exitCode);
      delivered();
    };
    step();
  });
  return child;
}

/** Jobs handed to the backend, so a test can watch what a turn would stop. */
function recordingJobs() {
  const jobs = [];
  return {
    jobs,
    factory: () => {
      const job = {
        children: [],
        terminateCalls: 0,
        add(entry) { this.children.push(entry); },
        async terminate() {
          this.terminateCalls += 1;
          for (const entry of this.children) entry.kill?.();
        },
      };
      jobs.push(job);
      return job;
    },
  };
}

const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

/**
 * Drive one turn byte by byte. Turns touch no transcript directory, so no
 * filesystem is needed: the cwd path is only joined at construction.
 */
async function runChunkedTurn(chunks, { exitCode = 0, error = null, signal, jobs = recordingJobs() } = {}) {
  const child = chunkedChild(chunks, { exitCode, error });
  const events = [];
  const backend = createClaudeCodeBackend({
    claudeHome: 'unused-transcripts',
    cwd: 'C:\\Projects\\Versutus',
    executablePath: 'claude.exe',
    spawnImpl: () => child,
    jobFactory: jobs.factory,
  });
  const turn = settled(backend.sendMessage(
    SESSION_ID,
    { text: 'hi', signal },
    (event) => events.push(event),
  ));
  await child.start();
  return { backend, child, events, jobs, out: await turn };
}

// The scan defect: `buffer += String(chunk)` decoded every stdout chunk on its
// own, so UTF-8 sequences straddling a chunk boundary became U+FFFD on both
// sides before the JSON line was ever parsed.

test('multi-byte text split at every byte of stdout survives the turn intact', async () => {
  const chunks = splitPerByte(stdoutBytes([
    [{ type: 'system', subtype: 'init', session_id: SESSION_ID }, true],
    [{ type: 'stream_event', session_id: SESSION_ID, event: {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ORIGINAL },
    } }, true],
    [{ type: 'assistant', session_id: SESSION_ID, message: {
      role: 'assistant', content: [{ type: 'text', text: ORIGINAL }] } }, true],
    [{ type: 'result', subtype: 'success', result: ORIGINAL, num_turns: 1, session_id: SESSION_ID }, false],
  ]));

  const { events, out } = await runChunkedTurn(chunks);

  assert.ok(!ORIGINAL.includes('\uFFFD'), 'the sample itself contains no replacement character');
  assert.equal(out.error, undefined, `the turn completes: ${out.error?.message}`);
  assert.equal(
    events.map((event) => event.type).join(','),
    'diagnostic,message.delta,run.completed',
    'event order survives chunking',
  );
  // The whole answer streamed as partials arrives whole; the repeated complete
  // assistant message must not double it.
  assert.deepEqual(
    events.filter((event) => event.type === 'message.delta')
      .map((event) => event.payload.text),
    [ORIGINAL],
  );
  assert.equal(out.value.text, ORIGINAL, 'the assembled reply is the exact original Unicode');
  assert.equal(out.value.message?.content?.[0]?.text, ORIGINAL);
});

test('ascii-only stdout with an unterminated final line still assembles exactly', async () => {
  const chunks = splitPerByte(stdoutBytes([
    [{ type: 'assistant', session_id: SESSION_ID, message: {
      role: 'assistant', content: [{ type: 'text', text: 'plain ascii reply' }] } }, true],
    [{ type: 'result', subtype: 'success', result: 'plain ascii reply', num_turns: 1 }, false],
  ]));

  const { events, out } = await runChunkedTurn(chunks);

  assert.equal(out.error, undefined, `the turn completes: ${out.error?.message}`);
  assert.deepEqual(
    events.filter((event) => event.type === 'message.delta')
      .map((event) => event.payload.text),
    ['plain ascii reply'],
  );
  assert.equal(out.value.text, 'plain ascii reply', 'the final un-newlined line is handled');
});

test('a child that writes nothing resolves clean with no message and no events', async () => {
  const { events, out } = await runChunkedTurn([]);

  assert.equal(out.error, undefined, `the turn completes: ${out.error?.message}`);
  assert.deepEqual(out.value, { message: null, text: '' });
  assert.deepEqual(events, [], 'an empty stdout emits nothing');
});

test('a turn that ends normally cleans up: no signal listener, no kills', async () => {
  const chunks = splitPerByte(stdoutBytes([
    [{ type: 'result', subtype: 'success', result: 'done', num_turns: 1 }, false],
  ]));
  const caller = new AbortController();
  const { jobs, out } = await runChunkedTurn(chunks, { signal: caller.signal });

  assert.equal(out.error, undefined, `the turn completes: ${out.error?.message}`);
  assert.equal(out.value.text, 'done');
  assert.equal(
    getEventListeners(caller.signal, 'abort').length,
    0,
    'nothing is left listening on the caller signal',
  );
  assert.equal(jobs.jobs[0]?.terminateCalls ?? 0, 0, 'a normal exit never kills anything');
});

test('a mid-stream process error rejects the turn and leaves nothing to stop', async () => {
  const chunks = splitPerByte(stdoutBytes([
    [{ type: 'system', subtype: 'init', session_id: SESSION_ID }, true],
    [{ type: 'stream_event', session_id: SESSION_ID, event: {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' },
    } }, true],
  ]));
  const failure = Object.assign(new Error('EPIPE write after end'), { code: 'EPIPE' });

  const { backend, jobs, events, out } = await runChunkedTurn(chunks, { error: failure });

  assert.equal(out.value, undefined, 'a dying child is an error, not a reply');
  assert.equal(out.error.code, 'EPIPE', 'the same error the child raised is what rejects');
  assert.ok(!events.some((event) => event.type === 'run.completed'), 'no run ever completes');
  assert.equal(jobs.jobs[0]?.terminateCalls ?? 0, 0, 'nothing was killed behind the rejection');

  // And once the turn is over, stopping the backend is a clean no-op.
  await backend.abort();
});
