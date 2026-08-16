import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  createClaudeCodeBackend,
  normalizeClaudeEvent,
  toGatewayMessage,
  transcriptDirFor,
} from '../core/cli-environments/backends/claude-code.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const SESSION_ID = '896a9c65-7554-453a-8e20-ccf419617968';

async function makeHome(lines = []) {
  const home = await mkdtemp(join(tmpdir(), 'claude-home-'));
  roots.push(home);
  const cwd = 'C:\\Projects\\Versutus';
  const dir = transcriptDirFor(home, cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return { home, cwd };
}

/** A child that emits stream-json lines then exits. */
function fakeChild(lines, exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
    child.emit('close', exitCode);
  }, 5);
  return child;
}

test('the transcript directory is derived from the workspace path', () => {
  assert.equal(
    transcriptDirFor('C:\\Users\\me\\.claude', 'C:\\Projects\\Versutus'),
    join('C:\\Users\\me\\.claude', 'projects', 'C--Projects-Versutus'),
  );
});

test('a transcript entry becomes a renderable message', () => {
  const mapped = toGatewayMessage({
    uuid: 'u1',
    timestamp: '2026-08-15T00:00:00.000Z',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hello' }] },
  });
  assert.equal(mapped.role, 'assistant');
  // Thinking blocks are not conversation content.
  assert.deepEqual(mapped.content, [{ type: 'text', text: 'hello' }]);
});

test('a tool_use block surfaces as a tool call', () => {
  const mapped = toGatewayMessage({
    uuid: 'u2',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  });
  assert.equal(mapped.tool_calls[0].name, 'Read');
});

test('stream-json events normalize', () => {
  assert.equal(
    normalizeClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }).type,
    'message.delta',
  );
  assert.equal(
    normalizeClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read' }] } }).type,
    'tool.started',
  );
  assert.equal(
    normalizeClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }).type,
    'tool.output',
  );
  assert.equal(normalizeClaudeEvent({ type: 'system', subtype: 'init' }).type, 'diagnostic');
});

test('partial message deltas normalize when enabled', () => {
  const event = normalizeClaudeEvent({
    type: 'stream_event',
    event: { delta: { type: 'text_delta', text: 'chunk' } },
  });
  assert.equal(event.type, 'message.delta');
  assert.equal(event.payload.text, 'chunk');
});

// An auth failure arrives as subtype 'success' with the error in `result` —
// treating that as a completed turn would surface the error as the answer.
test('an authentication failure is a failed run, not a successful one', () => {
  const event = normalizeClaudeEvent({
    type: 'result',
    subtype: 'success',
    result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    total_cost_usd: 0,
  });
  assert.equal(event.type, 'run.failed');
});

test('a genuine result completes the run', () => {
  const event = normalizeClaudeEvent({ type: 'result', subtype: 'success', result: 'claude ok', num_turns: 1 });
  assert.equal(event.type, 'run.completed');
  assert.equal(event.payload.text, 'claude ok');
});

test('sessions are listed from on-disk transcripts, newest first', async () => {
  const { home, cwd } = await makeHome([
    { type: 'user', uuid: 'u1', timestamp: '2026-08-15T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'first question' }] } },
  ]);
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });
  const sessions = await backend.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, SESSION_ID);
  assert.equal(sessions[0].source, 'claude-code');
  assert.equal(sessions[0].preview, 'first question');
});

test('history comes from the transcript', async () => {
  const { home, cwd } = await makeHome([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'queue-operation', operation: 'noop' },
  ]);
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });
  const messages = await backend.listMessages(SESSION_ID);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
});

test('a session id that could escape the transcript directory is refused', async () => {
  const { home, cwd } = await makeHome([]);
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });
  await assert.rejects(() => backend.listMessages('../../secrets'), /invalid session id/i);
  await assert.rejects(() => backend.deleteSession('../../secrets'), /invalid session id/i);
});

test('a turn binds the session id and assembles the reply', async () => {
  const { home, cwd } = await makeHome([]);
  let args = null;
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: (_cmd, argv) => {
      args = argv;
      return fakeChild([
        { type: 'system', subtype: 'init', session_id: SESSION_ID },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'claude ok' }] } },
        { type: 'result', subtype: 'success', result: 'claude ok', num_turns: 1 },
      ]);
    },
  });
  const result = await backend.sendMessage(SESSION_ID, { text: 'say hi', model: { modelId: 'sonnet' } });
  assert.equal(result.text, 'claude ok');
  assert.ok(args.includes('--session-id'), 'the turn must bind a session for continuity');
  assert.equal(args[args.indexOf('--session-id') + 1], SESSION_ID);
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  // Approval bypass flags are prohibited (ADR 0002/0003).
  assert.ok(!args.some((a) => /dangerously|bypassPermissions|dontAsk/i.test(a)), 'must never bypass permissions');
});

test('an auth failure during a turn rejects rather than returning the error as the answer', async () => {
  const { home, cwd } = await makeHome([]);
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => fakeChild([
      { type: 'result', subtype: 'success', result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' },
    ]),
  });
  await assert.rejects(() => backend.sendMessage(SESSION_ID, { text: 'hi' }), /authenticate|revoked/i);
});

test('tool events reach the caller during a turn', async () => {
  const { home, cwd } = await makeHome([]);
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => fakeChild([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', result: 'done' },
    ]),
  });
  const seen = [];
  await backend.sendMessage(SESSION_ID, { text: 'read a file' }, (e) => seen.push(e.type));
  assert.deepEqual(seen, ['tool.started', 'tool.output', 'message.delta', 'run.completed']);
});

test('models are the documented aliases', async () => {
  const { home, cwd } = await makeHome([]);
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });
  assert.deepEqual((await backend.listModels()).map((m) => m.id), ['opus', 'sonnet', 'haiku']);
});
