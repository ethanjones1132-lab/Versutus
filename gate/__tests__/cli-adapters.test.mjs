import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeExecutable } from './fixtures/cli-protocols/fake-executable.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';

const registry = new CliAdapterRegistry();

test('unknown newer CLI version is incompatible', async () => {
  const probe = await registry.get('codex').probe(await fakeExecutable('999.0.0'));
  assert.equal(probe.state, 'incompatible');
});

test('supported Codex JSONL version is ready', async () => {
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
