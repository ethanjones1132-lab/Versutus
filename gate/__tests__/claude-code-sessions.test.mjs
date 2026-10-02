import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeCodeBackend, transcriptDirFor } from '../core/cli-environments/backends/claude-code.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// Claude Code writes one transcript per conversation and nothing prunes them, so
// a project of any age holds hundreds. Listing them meant reading and JSON.parsing
// every one of them, serially, to build previews for rows the caller then threw
// away — which is how /v1/sessions missed the phone's 8s read budget.
const TRANSCRIPTS = 200;
const STEP_MS = 60_000;

const sessionId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** A transcript whose first user message identifies its index. */
async function writeTranscript(dir, index, at, text = `question ${index}`) {
  const file = join(dir, `${sessionId(index)}.jsonl`);
  const line = JSON.stringify({
    type: 'user',
    uuid: `u${index}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  await writeFile(file, `${line}\n`, 'utf8');
  await utimes(file, at, at);
  return file;
}

/** `count` transcripts, oldest first, plus a home to list them from. */
async function makeHome(count = TRANSCRIPTS) {
  const home = await mkdtemp(join(tmpdir(), 'claude-home-sessions-'));
  roots.push(home);
  const cwd = 'C:\\Projects\\Versutus';
  const dir = transcriptDirFor(home, cwd);
  await mkdir(dir, { recursive: true });
  const base = Date.now() - (count + 1) * STEP_MS;
  for (let index = 0; index < count; index += 1) {
    await writeTranscript(dir, index, new Date(base + index * STEP_MS));
  }
  return { home, cwd, dir, base };
}

test('only the newest transcripts are read, so a long-lived project stays cheap', async () => {
  const { home, cwd } = await makeHome();
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const sessions = await backend.listSessions(20);

  assert.equal(sessions.length, 20, 'the caller asked for twenty rows');
  // A row carries a preview only if its file was opened, so this is the read
  // count: the twenty newest, and nothing older.
  assert.deepEqual(
    sessions.map((session) => session.preview),
    Array.from({ length: 20 }, (_, index) => `question ${TRANSCRIPTS - 1 - index}`),
  );
});

test('a session list is ordered newest first', async () => {
  const { home, cwd } = await makeHome();
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const sessions = await backend.listSessions(10);

  const lastActive = sessions.map((session) => session.last_active);
  assert.deepEqual(lastActive, [...lastActive].sort((a, b) => b - a));
});

test('a caller that passes no limit still gets the documented default page', async () => {
  const { home, cwd } = await makeHome();
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const sessions = await backend.listSessions();

  assert.equal(sessions.length, 50);
  assert.equal(sessions[0].preview, `question ${TRANSCRIPTS - 1}`);
});

test('a transcript that cannot be parsed lists without a preview', async () => {
  const { home, cwd, dir, base } = await makeHome();
  // Newer than every readable transcript, and not JSON at all.
  const corrupt = join(dir, `${sessionId(900)}.jsonl`);
  await writeFile(corrupt, 'this is not a transcript\n', 'utf8');
  await utimes(corrupt, new Date(base + (TRANSCRIPTS + 5) * STEP_MS), new Date(base + (TRANSCRIPTS + 5) * STEP_MS));
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const sessions = await backend.listSessions(2);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, sessionId(900));
  assert.equal(sessions[0].preview, null, 'an unreadable transcript is listed, not previewed');
  assert.equal(sessions[1].preview, `question ${TRANSCRIPTS - 1}`);
});

test('a reserved session the caller just created is still findable', async () => {
  const { home, cwd } = await makeHome();
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const created = await backend.createSession({ title: 'Bot Chat' });
  const sessions = await backend.listSessions(5);

  assert.equal(sessions[0].id, created.id, 'it is the newest thing there is');
  assert.ok(sessions.some((session) => session.id === created.id));
});

// A reservation is an id the Gate has handed out, not a conversation: Claude
// Code writes the transcript only when a turn runs, so every chat the app opened
// and the operator never typed into — and every first turn that failed — left one
// behind with `last_active` set to its creation. Nothing ever retired them, so
// they sorted above every real conversation forever and a few dozen of them
// filled the first page.
test('a reservation that no turn ever used stops being listed', async () => {
  let clock = Date.now();
  const { home, cwd, dir } = await makeHome(3);
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe', now: () => clock,
  });

  const stale = await backend.createSession({ title: 'opened and walked away from' });
  assert.ok(
    (await backend.listSessions(50)).some((session) => session.id === stale.id),
    'a chat the app has just opened is listed, or it cannot recognise its own thread',
  );

  // Minutes later the app reconnects and opens another chat. Nothing ever
  // retired the first one, and its `last_active` is its creation — so it sorts
  // above every conversation that really happened, for the life of the Gate.
  await writeTranscript(dir, 500, new Date(clock + 6 * 60_000 - 1_000), 'the real question');
  clock += 6 * 60_000;
  const fresh = await backend.createSession({ title: 'typed into now' });

  const sessions = await backend.listSessions(50);

  assert.ok(!sessions.some((session) => session.id === stale.id), 'an outlived reservation is not a conversation');
  assert.ok(sessions.some((session) => session.id === fresh.id), 'a reservation within its lifetime is listed');
  assert.ok(sessions.some((session) => session.id === sessionId(500)), 'and the transcripts still are');
  assert.equal(sessions[0].id, fresh.id, 'the page leads with what really happened most recently');
});

test('a page is never longer than the limit, however many reservations are live', async () => {
  const { home, cwd } = await makeHome(2);
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  for (const title of ['one', 'two', 'three']) await backend.createSession({ title });

  const sessions = await backend.listSessions(2);

  assert.equal(sessions.length, 2, 'the caller asked for two rows and is owed two');
});

test('a reservation the transcripts have caught up with is retired on the next read', async () => {
  const { home, cwd, dir } = await makeHome(0);
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const created = await backend.createSession({ title: 'Bot Chat' });
  assert.deepEqual(await backend.listMessages(created.id), [], 'a reserved id opens as an empty chat');

  // The turn ran: Claude Code has written the transcript the id was reserved for.
  const line = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'text', text: 'the question that was asked' }] },
  });
  await writeFile(join(dir, `${created.id}.jsonl`), `${line}\n`, 'utf8');
  const messages = await backend.listMessages(created.id);

  assert.equal(messages.length, 1, 'the reservation hands over to the transcript it was waiting for');
  assert.equal(messages[0].content[0].text, 'the question that was asked');
  const sessions = await backend.listSessions(50);
  assert.equal(
    sessions.filter((session) => session.id === created.id).length,
    1,
    'and it is listed once, from its transcript',
  );
});

test('the row shape is unchanged', async () => {
  const { home, cwd } = await makeHome();
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const [session] = await backend.listSessions(1);

  assert.deepEqual(Object.keys(session), [
    'id', 'source', 'user_id', 'model', 'title', 'started_at', 'ended_at', 'end_reason',
    'message_count', 'tool_call_count', 'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_write_tokens', 'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd',
    'api_call_count', 'parent_session_id', 'last_active', 'preview', 'has_system_prompt',
    'has_model_config',
  ]);
  assert.equal(session.source, 'claude-code');
  assert.equal(session.title, session.preview);
});
