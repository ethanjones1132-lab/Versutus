import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { createClaudeCodeBackend } from '../core/cli-environments/backends/claude-code.mjs';

// A Claude Code agent file is a Bot the Gate can start a chat with, and the
// turn it sends must run as that agent — `--agent <name>` — not as the CLI's
// default one. The agent is passed per turn rather than held on the backend, so
// these tests read the argv the stub spawn actually received.

const SESSION_ID = '896a9c65-7554-453a-8e20-ccf419617968';
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeClaudeHome(agents = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-agent-turns-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  for (const [name, text] of Object.entries(agents)) {
    const dir = join(home, 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), text, 'utf8');
  }
  return { home, cwd };
}

function agentText({ name, description, model }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(model ? [`model: ${model}`] : []),
    '---',
    'Standing instructions.',
    '',
  ].join('\n');
}

/** A child that answers and exits, the way a finished turn does. */
function fakeChild(lines = [{ type: 'result', subtype: 'success', result: 'claude ok' }]) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
    child.emit('close', 0);
  }, 5);
  return child;
}

function spawnRecording(argvSeen) {
  return (_command, argv) => {
    argvSeen.push(argv);
    return fakeChild();
  };
}

const REVIEWER = agentText({ name: 'reviewer', description: 'Reviews diffs before they land.', model: 'opus' });

test('a turn on the built-in Bot passes no --agent', async () => {
  const { home, cwd } = await makeClaudeHome({ reviewer: REVIEWER });
  const calls = [];
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe', spawnImpl: spawnRecording(calls),
  });

  await backend.sendMessage(SESSION_ID, { text: 'say hi' });

  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('--agent'), 'the built-in Bot is the CLI default agent');
});

test('a turn through the agent Bot passes --agent <name>, after --session-id and before --model', async () => {
  const { home, cwd } = await makeClaudeHome({ reviewer: REVIEWER });
  const calls = [];
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe', spawnImpl: spawnRecording(calls),
  });

  const scoped = await backend.forBot('claude-code:reviewer');
  assert.equal(scoped.bot, 'claude-code:reviewer');
  await scoped.sendMessage(SESSION_ID, { text: 'review this', model: { modelId: 'sonnet' } });

  const argv = calls[0];
  assert.deepEqual(argv.slice(argv.indexOf('--agent'), argv.indexOf('--agent') + 2), ['--agent', 'reviewer']);
  assert.ok(argv.indexOf('--agent') > argv.indexOf('--session-id'));
  assert.ok(argv.indexOf('--agent') < argv.indexOf('--model'));
  assert.equal(argv[argv.indexOf('--session-id') + 1], SESSION_ID);
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
});

test('a scoped turn does not change what the built-in Bot runs as', async () => {
  const { home, cwd } = await makeClaudeHome({ reviewer: REVIEWER });
  const calls = [];
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe', spawnImpl: spawnRecording(calls),
  });

  const scoped = await backend.forBot('claude-code:reviewer');
  await scoped.sendMessage(SESSION_ID, { text: 'as the reviewer' });
  await backend.sendMessage(SESSION_ID, { text: 'as the agent' });

  assert.ok(calls[0].includes('--agent'));
  assert.ok(!calls[1].includes('--agent'));
});

test('forBot refuses an agent file the scan does not find', async () => {
  const { home, cwd } = await makeClaudeHome({ reviewer: REVIEWER });
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  await assert.rejects(() => backend.forBot('claude-code:nobody'), { code: 'unknown_bot', status: 404 });
  await assert.rejects(() => backend.getBot({ id: 'claude-code:nobody' }), { code: 'unknown_bot', status: 404 });
});

test('the roster carries every agent file after the built-in Bot', async () => {
  const { home, cwd } = await makeClaudeHome({
    'vs093-reviewer': agentText({ name: 'vs093-reviewer', description: 'Reviews diffs before they land.', model: 'opus' }),
    'vs093-researcher': agentText({ name: 'vs093-researcher', description: 'Reads before answering.' }),
  });
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const roster = await backend.listBots();
  assert.equal(roster.object, 'list');
  assert.equal(roster.data[0].id, 'claude-code');

  const rows = roster.data.filter((row) => row.id.startsWith('claude-code:'));
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.get('claude-code:vs093-reviewer'), {
    id: 'claude-code:vs093-reviewer',
    displayName: 'vs093-reviewer',
    routable: true,
    routingIssue: null,
    description: 'Reviews diffs before they land.',
    // The app's `PublicBot.model` is a pin, not a bare alias.
    model: { default: 'opus', provider: null },
    runtime: 'claude-code',
  });
  assert.equal(byId.get('claude-code:vs093-researcher').model, null);
});

test('an agent Bot reads back with its row and no soul', async () => {
  const { home, cwd } = await makeClaudeHome({
    'vs093-reviewer': agentText({ name: 'vs093-reviewer', description: 'Reviews diffs before they land.' }),
  });
  const backend = createClaudeCodeBackend({ claudeHome: home, cwd, executablePath: 'claude.exe' });

  const row = await backend.getBot({ id: 'claude-code:vs093-reviewer' });
  assert.equal(row.displayName, 'vs093-reviewer');
  assert.equal(row.description, 'Reviews diffs before they land.');
  assert.equal(row.runtime, 'claude-code');
  // The instructions are the file's body, which only Claude Code reads.
  assert.equal(row.soul, null);
});
