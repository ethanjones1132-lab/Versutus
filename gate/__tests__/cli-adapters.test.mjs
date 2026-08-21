import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeExecutable } from './fixtures/cli-protocols/fake-executable.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';

const registry = new CliAdapterRegistry();

test('unknown newer CLI version is incompatible', async () => {
  const probe = await registry.get('codex').probe(await fakeExecutable('999.0.0'));
  assert.equal(probe.state, 'incompatible');
});

// Real version lines are decorated differently per CLI. Claude Code prints
// "2.1.140 (Claude Code)", which a last-token parse read as "Code)".
test('a decorated version line is parsed, not the trailing word', async () => {
  for (const [line, expected] of [
    ['2.1.140 (Claude Code)', '2.1.140'],
    ['codex-cli 0.147.0', '0.147.0'],
    ['1.17.9', '1.17.9'],
  ]) {
    const probe = await registry.get('claude-code').probe(await fakeExecutable(line));
    assert.equal(probe.cliVersion, expected, `"${line}" should parse as ${expected}`);
  }
});

test('supported Codex JSONL version is ready', async () => {
  // Both ends of the supported range must probe ready.
  const upper = await registry.get('codex').probe(await fakeExecutable('0.147.0'));
  assert.equal(upper.state, 'ready', 'the upper bound of the supported range must be accepted');
  const probe = await registry.get('codex').probe(await fakeExecutable('0.142.1'));
  assert.equal(probe.state, 'ready');
  assert.equal(probe.protocol, 'jsonl');
});

test('supported Claude stream JSON version is ready', async () => {
  const probe = await registry.get('claude-code').probe(await fakeExecutable('2.1.88'));
  assert.equal(probe.state, 'ready');
  assert.equal(probe.protocol, 'jsonl');
});

test('supported Hermes ACP version is ready', async () => {
  const probe = await registry.get('hermes').probe(await fakeExecutable('0.18.0'));
  assert.equal(probe.state, 'ready');
  assert.equal(probe.protocol, 'acp');
});

test('Hermes Bot inventory follows the configured HERMES_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-adapter-home-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'forge'), { recursive: true });
  await writeFile(join(home, 'profiles', 'forge', '.env'), 'API_SERVER_KEY=forge-listen\n');
  const previousHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  try {
    const hermes = registry.get('hermes').createBackend({
      baseUrl: 'http://127.0.0.1:8642',
      credentials: { API_SERVER_KEY: 'default-listen' },
    });
    const bots = await hermes.listBots();
    assert.deepEqual(bots.data.map((bot) => bot.id), ['default', 'forge']);
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
  }
});

test('supported OpenCode ACP version is ready', async () => {
  const probe = await registry.get('opencode').probe(await fakeExecutable('1.17.9'));
  assert.equal(probe.state, 'ready');
  assert.equal(probe.protocol, 'acp');
});

test('unknown newer OpenCode version is incompatible', async () => {
  const probe = await registry.get('opencode').probe(await fakeExecutable('999.0.0'));
  assert.equal(probe.state, 'incompatible');
});

test('missing executable is not_installed', async () => {
  const probe = await registry.get('codex').probe('C:\\\\missing\\\\codex.exe');
  assert.equal(probe.state, 'not_installed');
});

test('adapters declare exact operations and never scrape --help', async () => {
  for (const id of ['hermes', 'codex', 'claude-code', 'opencode']) {
    const adapter = registry.get(id);
    assert.ok(adapter.operations);
    for (const operation of Object.values(adapter.operations)) {
      assert.ok(operation.inputSchema);
      assert.ok(['read', 'workspace_write', 'host_write', 'network_external', 'credential', 'destructive'].includes(operation.risk));
      assert.equal(typeof operation.machineReadable, 'boolean');
    }
  }
});
