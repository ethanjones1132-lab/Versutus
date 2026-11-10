import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { createClaudeCodeBackend } from '../core/cli-environments/backends/claude-code.mjs';
import { claudeCodeAdapter } from '../core/cli-environments/adapters/claude-code.mjs';

/**
 * A turn with a permission bridge carries the MCP server Claude Code must call
 * for a ruling, and the tool it must call; a turn without one is unchanged.
 */

const SESSION_ID = '896a9c65-7554-453a-8e20-ccf419617968';
const BRIDGE = { url: 'http://127.0.0.1:54321/permission', secret: 'bridge-secret' };
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), 'claude-approval-args-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  return { home, cwd };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    child.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', result: 'claude ok' })}\n`);
    child.emit('close', 0);
  }, 5);
  return child;
}

function spawnRecording(seen) {
  return (_command, argv) => {
    seen.push(argv);
    return fakeChild();
  };
}

test('a turn with a permission bridge names the MCP server and the approval tool', async () => {
  const { home, cwd } = await makeHome();
  const calls = [];
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: spawnRecording(calls),
    permissionBridge: BRIDGE,
  });

  await backend.sendMessage(SESSION_ID, { text: 'say hi' });

  const argv = calls[0];
  const configIndex = argv.indexOf('--mcp-config');
  const toolIndex = argv.indexOf('--permission-prompt-tool');
  assert.ok(configIndex >= 0, 'the turn must point the CLI at the bridge');
  assert.ok(toolIndex >= 0, 'the turn must name the permission prompt tool');
  assert.equal(argv[toolIndex + 1], 'mcp__gate-permissions__approve');
  // Both come before the prompt, which is the positional argument.
  assert.ok(configIndex < argv.length - 1);
  assert.ok(toolIndex < argv.length - 1);
  assert.equal(argv[argv.length - 1], 'say hi');

  const config = JSON.parse(argv[configIndex + 1]);
  const server = config.mcpServers['gate-permissions'];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.length, 1);
  assert.ok(existsSync(server.args[0]), 'the tool script is resolved to a real file');
  assert.equal(server.args[0].endsWith('claude-permission-tool.mjs'), true);
  assert.deepEqual(server.env, {
    GATE_PERMISSION_URL: BRIDGE.url,
    GATE_PERMISSION_SECRET: BRIDGE.secret,
  });
});

test('a turn with no permission bridge is byte-for-byte what it was before', async () => {
  const { home, cwd } = await makeHome();
  const calls = [];
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe', spawnImpl: spawnRecording(calls),
  });

  await backend.sendMessage(SESSION_ID, { text: 'say hi', model: { modelId: 'sonnet' } });

  assert.deepEqual(calls[0], [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'default',
    '--session-id', SESSION_ID,
    '--model', 'sonnet',
    'say hi',
  ]);
});

test('the adapter forwards a permission bridge into the turn it builds', async () => {
  const { home, cwd } = await makeHome();
  // A stand-in CLI: it records the argv it was spawned with and reports a
  // finished turn, so the adapter's real factory is what is under test.
  const executable = join(home, 'fake-claude.mjs');
  await mkdir(home, { recursive: true });
  await writeFile(executable, [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.env.CLAUDE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));',
    "process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\\n`);",
    '',
  ].join('\n'), 'utf8');
  const argvFile = join(home, 'argv.json');

  const backend = claudeCodeAdapter.createBackend({
    record: { id: 'claude-local', executable: { path: executable }, workspacePolicy: { defaultRoot: cwd } },
    claudeHome: home,
    permissionBridge: BRIDGE,
  });

  const previous = process.env.CLAUDE_ARGV_FILE;
  process.env.CLAUDE_ARGV_FILE = argvFile;
  try {
    await backend.sendMessage(SESSION_ID, { text: 'hi' });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_ARGV_FILE;
    else process.env.CLAUDE_ARGV_FILE = previous;
  }

  const argv = JSON.parse(await readFile(argvFile, 'utf8'));
  assert.ok(argv.includes('--mcp-config'), 'the adapter must pass the bridge through');
  assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'mcp__gate-permissions__approve');
});
