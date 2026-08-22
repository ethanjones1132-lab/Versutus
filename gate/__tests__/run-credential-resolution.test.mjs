import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';
import { fakeRunner } from './fixtures/cli-protocols/fake-runner.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

/**
 * Passthrough DPAPI stand-in: the vault bytes are stored and read back
 * verbatim, so tests exercise real vault files without Windows DPAPI.
 */
const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

const SECRET = 'sk-wedge-bound-value';

/**
 * The run path must resolve an environment's credentialBindings exactly like
 * the chat-backend path and doctor do: a binding counts only when the vault
 * returns a non-empty string. Resolved values are injected into the spawned
 * CLI's environment; a dead binding is named on the run stream (references
 * only — a value must never appear in any event) and the run still proceeds.
 */
async function makeService(recordOverrides = {}, serviceOverrides = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-run-cred-'));
  const store = new CliEnvironmentStore(gateHome);
  const executable = await fakeRunner('0.142.1');
  const record = validEnvironment({
    id: 'codex-local',
    adapterId: 'codex',
    executable: { path: executable },
    workspacePolicy: {
      roots: [gateHome],
      defaultRoot: gateHome,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    ...recordOverrides,
  });
  await store.put(record);
  const spawnedEnvironments = [];
  const children = [];
  const service = new CliEnvironmentService({
    store,
    registry: new CliAdapterRegistry(),
    jobFactory: () => ({
      add() {},
      async terminate() {},
    }),
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      spawnedEnvironments.push(options?.env ?? null);
      children.push(child);
      return child;
    },
    ...serviceOverrides,
  });
  return {
    service,
    gateHome,
    spawnedEnvironments,
    children,
    cleanup: async () => {
      for (const child of children) {
        try { child.kill(); } catch { /* already gone */ }
      }
      await rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function collectEvents(service, runId, decision) {
  const events = [];
  for await (const event of service.events(runId)) {
    events.push(event);
    if (decision && event.type === 'approval.required') {
      // Answer the card mid-stream, exactly like the phone's launcher does.
      await service.approve(runId, event.payload.approvalId, decision);
    }
  }
  return events;
}

test('a resolved binding is injected into the spawned CLI environment', async () => {
  const { service, gateHome, spawnedEnvironments, cleanup } = await makeService({
    credentialBindings: { OPENCODE_API_KEY: 'provider/openai-main/api-key' },
  });
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('provider/openai-main/api-key', SECRET);
  service.vault = vault;
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const events = await collectEvents(service, handle.runId);
    assert.equal(events.at(-1).type, 'run.completed', 'the run still completes');
    assert.equal(spawnedEnvironments.length, 1, 'the CLI spawned once');
    assert.equal(
      spawnedEnvironments[0].OPENCODE_API_KEY,
      SECRET,
      'the bound value must reach the CLI environment',
    );
    assert.equal(
      events.filter((event) => event.type === 'run.note').length,
      0,
      'a fully resolved binding sheet raises no warnings',
    );
  } finally {
    await cleanup();
  }
});

test('a bound reference with no vault value warns on the stream and the run still starts', async () => {
  const { service, gateHome, spawnedEnvironments, cleanup } = await makeService({
    credentialBindings: {
      OPENCODE_API_KEY: 'provider/openai-main/api-key',
      OPENCODE_SERVER_PASSWORD: 'provider/other/api-key',
    },
  });
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('provider/openai-main/api-key', SECRET);
  // provider/other/api-key was never set — the "chip showed no ✓" case.
  service.vault = vault;
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const events = await collectEvents(service, handle.runId);
    assert.equal(events[0].type, 'run.started');
    const notes = events.filter((event) => event.type === 'run.note');
    assert.equal(notes.length, 1, 'only the dead binding warns');
    assert.equal(notes[0].payload.level, 'warning');
    assert.equal(notes[0].payload.variable, 'OPENCODE_SERVER_PASSWORD');
    assert.equal(notes[0].payload.reference, 'provider/other/api-key');
    assert.match(notes[0].payload.message, /OPENCODE_SERVER_PASSWORD/);
    assert.match(notes[0].payload.message, /provider\/other\/api-key/);
    assert.match(notes[0].payload.message, /no value is stored/);
    // The healthy binding still injects; the dead one is absent, not undefined-string.
    assert.equal(spawnedEnvironments[0].OPENCODE_API_KEY, SECRET);
    assert.equal(spawnedEnvironments[0].OPENCODE_SERVER_PASSWORD, undefined);
    // The note precedes the terminal event and the run completes anyway.
    assert.equal(events.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('an undecryptable vault entry warns exactly like an absent one', async () => {
  const { service, gateHome, spawnedEnvironments, cleanup } = await makeService({
    credentialBindings: { OPENCODE_API_KEY: 'provider/openai-main/api-key' },
  });
  const vault = new CredentialVault({
    gateHome,
    backend: {
      protect: async (buffer) => buffer,
      unprotect: async () => { throw new Error('DPAPI decrypt failed'); },
    },
  });
  await vault.set('provider/openai-main/api-key', SECRET);
  service.vault = vault;
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const events = await collectEvents(service, handle.runId);
    const notes = events.filter((event) => event.type === 'run.note');
    assert.equal(notes.length, 1, 'an unreadable value is a missing value');
    assert.equal(notes[0].payload.variable, 'OPENCODE_API_KEY');
    assert.equal(spawnedEnvironments[0].OPENCODE_API_KEY, undefined);
    assert.equal(events.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('resolved values never appear in any event payload', async () => {
  const { service, gateHome, cleanup } = await makeService({
    credentialBindings: {
      OPENCODE_API_KEY: 'provider/openai-main/api-key',
      OPENCODE_SERVER_PASSWORD: 'provider/other/api-key',
    },
  });
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('provider/openai-main/api-key', SECRET);
  service.vault = vault;
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'say hi' },
    });
    const events = await collectEvents(service, handle.runId, 'approve');
    for (const event of events) {
      assert.equal(
        JSON.stringify(event).includes(SECRET),
        false,
        `secret leaked into event ${event.type}`,
      );
    }
    assert.equal(events.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('no vault and no bindings change nothing about the run path', async () => {
  const { service, spawnedEnvironments, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const events = await collectEvents(service, handle.runId);
    assert.equal(events.filter((event) => event.type === 'run.note').length, 0);
    assert.equal(events.at(-1).type, 'run.completed');
    assert.equal(spawnedEnvironments[0].OPENCODE_API_KEY, undefined);
  } finally {
    await cleanup();
  }
});

test('a service without a vault ignores bindings instead of failing the run', async () => {
  const { service, spawnedEnvironments, cleanup } = await makeService({
    credentialBindings: { OPENCODE_API_KEY: 'provider/openai-main/api-key' },
  });
  // service.vault stays null — an older Gate construction. The run must
  // behave exactly as before this feature existed.
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const events = await collectEvents(service, handle.runId);
    assert.equal(events.filter((event) => event.type === 'run.note').length, 0);
    assert.equal(events.at(-1).type, 'run.completed');
    assert.equal(spawnedEnvironments[0].OPENCODE_API_KEY, undefined);
  } finally {
    await cleanup();
  }
});
