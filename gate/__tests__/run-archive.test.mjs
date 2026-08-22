import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { createRunArchive } from '../core/cli-environments/run-archive.mjs';
import { fakeRunner } from './fixtures/cli-protocols/fake-runner.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

/**
 * Same direct-service harness as cli-supervisor.test.mjs, plus an archiveDir
 * shared across every service built from one gate home — the point here is
 * that history written by one CliEnvironmentService instance reloads into the
 * next, which is exactly what a Gate restart does.
 */
async function makeArchivedService(archiveDir) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-run-archive-'));
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
  });
  await store.put(record);
  const children = [];
  const makeService = () =>
    new CliEnvironmentService({
      store,
      registry: new CliAdapterRegistry(),
      jobFactory: () => ({
        children: [],
        add(child) {
          this.children.push(child);
        },
        async terminate() {
          for (const child of this.children) child.kill();
        },
      }),
      spawnImpl: (command, args, options) => {
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
      archiveDir,
    });
  const service = makeService();
  return {
    gateHome,
    service,
    makeService,
    children,
    cleanup: async () => {
      const exits = children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) resolve();
        else {
          child.once('exit', () => resolve());
          // A kill can lag on Windows; never let a test hang on it.
          setTimeout(resolve, 2000).unref?.();
        }
      }));
      for (const child of children) {
        try { child.kill(); } catch { /* already gone */ }
      }
      // The spawned child holds its cwd (the temp workspace), so Windows
      // reports EBUSY if the rmdir races the process dying.
      await Promise.all(exits);
      await rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (archiveDir && archiveDir.startsWith(tmpdir())) {
        await rm(archiveDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}

test('a finished run stays discoverable and replayable after the service is rebuilt', async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), 'gate-run-archive-dir-'));
  const { service, makeService, cleanup } = await makeArchivedService(archiveDir);
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      sandbox: 'read_only',
      input: { prompt: 'say hello world back' },
    });
    const live = [];
    for await (const event of service.events(handle.runId)) {
      live.push(event);
      if (event.type === 'approval.required') {
        await service.approve(handle.runId, event.payload.approvalId, 'approve');
      }
    }
    assert.equal(live.at(-1).type, 'run.completed');

    // The restart: a brand-new service over the same store + archive, exactly
    // what createGate does after the old process died.
    const restarted = makeService();
    await restarted.init();
    const [summary] = restarted.listRuns('codex-local');
    assert.equal(summary.runId, handle.runId, 'the pre-restart run is still listed');
    assert.equal(summary.state, 'completed');
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.pid, null, 'an archived run never advertises a pid');

    const replay = [];
    for await (const event of restarted.events(handle.runId)) replay.push(event);
    assert.deepEqual(
      replay.map((event) => [event.sequence, event.type]),
      live.map((event) => [event.sequence, event.type]),
      'replay after restart matches the live stream',
    );
    const replyText = replay
      .filter((event) => event.type === 'run.output' && event.payload.stream === 'stdout')
      .map((event) => event.payload.text)
      .join('');
    assert.ok(replyText.includes('hello world'), 'the streamed reply survived the restart');

    // And the restarted service still takes new work normally.
    const next = await restarted.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      sandbox: 'read_only',
      input: {},
    });
    const nextEvents = [];
    for await (const event of restarted.events(next.runId)) nextEvents.push(event);
    assert.equal(nextEvents.at(-1).type, 'run.completed');
    assert.equal(restarted.listRuns('codex-local').length, 2, 'old and new runs both listed');
  } finally {
    await cleanup();
  }
});

test('a run that was mid-flight when the Gate died closes honestly as failed', async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), 'gate-run-archive-dir-'));
  const { service, makeService, children, cleanup } = await makeArchivedService(archiveDir);
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:60000' },
    });
    // Approve the card, stop draining at the first output: the run is now
    // genuinely mid-flight with no terminal event anywhere.
    for await (const event of service.events(handle.runId)) {
      if (event.type === 'approval.required') {
        await service.approve(handle.runId, event.payload.approvalId, 'approve');
      }
      if (event.type === 'run.output') break;
    }
    assert.ok(children.length >= 1, 'the task was really spawned');

    const restarted = makeService();
    await restarted.init();
    const [summary] = restarted.listRuns('codex-local');
    assert.equal(summary.runId, handle.runId);
    assert.equal(summary.state, 'failed', 'a run orphaned by the restart is not "completed"');
    const events = [];
    for await (const event of restarted.events(handle.runId)) events.push(event);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.failed');
    assert.match(terminal.payload.message, /Gate went down/, 'the verdict names what happened');

    // A further restart sees the same stable verdict — the synthesized
    // failure was itself persisted, not re-derived each boot.
    const again = makeService();
    await again.init();
    const eventsAgain = [];
    for await (const event of again.events(handle.runId)) eventsAgain.push(event);
    assert.equal(eventsAgain.at(-1).type, 'run.failed');
    assert.deepEqual(
      eventsAgain.map((event) => event.sequence),
      events.map((event) => event.sequence),
      'the second restart adds no duplicate verdict',
    );
  } finally {
    await cleanup();
  }
});

test('the archive drops a torn trailing line and keeps the rest usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-run-archive-torn-'));
  try {
    const archive = createRunArchive(dir);
    const meta = {
      runId: 'run-torn',
      environmentId: 'env-a',
      operation: 'prompt',
      startedAt: new Date().toISOString(),
    };
    archive.record(meta);
    archive.append('env-a', 'run-torn', {
      runId: 'run-torn', sequence: 1, timestamp: meta.startedAt, type: 'run.started', payload: {},
    });
    archive.append('env-a', 'run-torn', {
      runId: 'run-torn', sequence: 2, timestamp: meta.startedAt, type: 'run.completed', payload: { exitCode: 0 },
    });
    // Simulate an unclean shutdown mid-append: half a JSON line at the end.
    await writeFile(
      join(dir, 'env-a', 'run-torn.json'),
      '{"runId":"run-tor',
      { flag: 'a' },
    );

    const restored = await archive.load();
    const torn = restored.find((run) => run.meta.runId === 'run-torn');
    assert.ok(torn, 'the run survives a torn tail');
    assert.deepEqual(torn.events.map((event) => event.type), ['run.started', 'run.completed']);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the archive prunes beyond its cap, oldest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-run-archive-prune-'));
  try {
    const archive = createRunArchive(dir, { maxRunsPerEnvironment: 2 });
    for (let index = 1; index <= 3; index += 1) {
      const meta = {
        runId: `run-${index}`,
        environmentId: 'env-a',
        operation: 'prompt',
        startedAt: new Date(Date.now() + index).toISOString(),
      };
      archive.record(meta);
      archive.append('env-a', meta.runId, {
        runId: meta.runId, sequence: 1, timestamp: meta.startedAt, type: 'run.started', payload: {},
      });
    }
    const restored = await archive.load();
    const ids = restored.filter((run) => run.meta.environmentId === 'env-a').map((run) => run.meta.runId);
    assert.deepEqual(ids.sort(), ['run-2', 'run-3'], 'the newest two survive');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('hostile environment ids and run ids cannot escape the archive directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-run-archive-safe-'));
  try {
    const archive = createRunArchive(dir);
    const meta = {
      runId: '../../evil',
      environmentId: '..\\..\\escape',
      operation: 'prompt',
      startedAt: new Date().toISOString(),
    };
    archive.record(meta);
    archive.append(meta.environmentId, meta.runId, {
      runId: meta.runId, sequence: 1, timestamp: meta.startedAt, type: 'run.started', payload: {},
    });
    const restored = await archive.load();
    assert.equal(restored.length, 1, 'the run round-trips');
    assert.equal(restored[0].meta.runId, meta.runId, 'the logical id is preserved');
    for (const entry of restored) {
      const resolved = entry.path;
      assert.ok(resolved.startsWith(dir), `file stayed inside the archive: ${resolved}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a service without an archiveDir stays memory-only', async () => {
  const archiveDir = undefined;
  const { service, gateHome, cleanup } = await makeArchivedService(archiveDir);
  try {
    await service.init();
    assert.equal(service.archive, null, 'no archiver is constructed');
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      sandbox: 'read_only',
      input: {},
    });
    for await (const event of service.events(handle.runId)) void event;
    assert.equal(service.listRuns('codex-local').length, 1, 'in-memory listing works as before');
    let entries = [];
    try {
      entries = await readdir(gateHome);
    } catch { /* absent is what we want */ }
    assert.equal(
      entries.filter((name) => name === 'runs').length,
      0,
      'no runs directory is ever created',
    );
  } finally {
    await cleanup();
  }
});
