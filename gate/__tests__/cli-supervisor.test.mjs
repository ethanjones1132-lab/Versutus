import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { fakeRunner } from './fixtures/cli-protocols/fake-runner.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeService(recordOverrides = {}, serviceOverrides = {}) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-cli-sup-'));
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
  const jobs = [];
  const children = [];
  const service = new CliEnvironmentService({
    store,
    registry: new CliAdapterRegistry(),
    jobFactory: () => {
      const job = {
        terminated: false,
        children: [],
        add(child) { job.children.push(child); },
        async terminate() {
          job.terminated = true;
          for (const child of job.children) child.kill();
        },
      };
      jobs.push(job);
      return job;
    },
    spawnImpl: (command, args, options) => {
      // The real spawn, observed so tests can hold a handle to the child.
      // execute() spawns synchronously inside startRun, so by the time
      // startRun resolves the handle is here.
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    },
    ...serviceOverrides,
  });
  return {
    service,
    gateHome,
    jobs,
    children,
    cleanup: () => {
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
      return Promise.all(exits)
        .then(() => rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    },
  };
}

test('a status run really executes the CLI and completes once', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    // A read-only operation auto-approves, but the spawn resolves just
    // behind that decision — the completed stream is what proves it ran.
    const events = await collectEvents(service, handle.runId);
    assert.equal(children.length, 1, 'even a status run spawns the executable');
    assert.equal(events.filter((event) => event.type === 'approval.required').length, 0, 'read-only runs never ask');
    assert.equal(events[0].type, 'run.started');
    assert.equal(events.filter((event) => /completed|failed|cancelled/.test(event.type)).length, 1);
    assert.deepEqual(events.map((event, index) => event.sequence), events.map((_, index) => index + 1));
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.completed');
    assert.equal(terminal.payload.exitCode, 0);
  } finally {
    await cleanup();
  }
});

test('a prompt run streams the reply as run.output events before completing', async () => {
  const { service, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'say hello world back' },
    });
    const events = await collectEvents(service, handle.runId, 'approve');
    const card = events.find((event) => event.type === 'approval.required');
    assert.ok(card, 'a workspace-writing run asks before it starts');
    const firstOutput = events.findIndex((event) => event.type === 'run.output');
    assert.ok(firstOutput > events.indexOf(card), 'the card must precede any output');
    assert.equal(card.payload.risk, 'workspace_write');
    assert.equal(typeof card.payload.summary, 'string');
    const outputs = events.filter((event) => event.type === 'run.output');
    assert.ok(outputs.length > 0, 'the reply must arrive as streamed output, not only a terminal event');
    const joined = outputs.map((event) => event.payload.text).join('');
    assert.ok(joined.includes('hello world back'), `output should carry the reply, got: ${joined}`);
    const terminalIndex = events.findIndex((event) => /completed|failed|cancelled/.test(event.type));
    for (const output of outputs) {
      assert.ok(events.indexOf(output) < terminalIndex, 'output must precede the terminal event');
    }
    assert.equal(events.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('a nonzero exit surfaces as run.failed with the code and stderr text', async () => {
  const { service, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'please FAIL loudly' },
    });
    const events = await collectEvents(service, handle.runId, 'approve');
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.failed');
    assert.equal(terminal.payload.exitCode, 3);
    const stderrText = events
      .filter((event) => event.type === 'run.output' && event.payload.stream === 'stderr')
      .map((event) => event.payload.text)
      .join('');
    assert.ok(stderrText.includes('runner refused'), 'stderr must reach the operator, not vanish');
  } finally {
    await cleanup();
  }
});

test('an operation with no non-interactive invocation fails honestly, not with an empty success', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'interactive',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { command: 'vim' },
    });
    const events = await collectEvents(service, handle.runId);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.failed');
    assert.match(terminal.payload.message, /interactive/);
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 0);
    assert.equal(children.length, 0, 'nothing is spawned when there is no invocation contract');
  } finally {
    await cleanup();
  }
});

test('cancel kills the spawned child and emits run.cancelled once', async () => {
  const { service, jobs, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:30000' },
    });
    const drained = collectEvents(service, handle.runId, 'approve');
    for (let waited = 0; waited < 2000 && children.length === 0; waited += 10) {
      await sleep(10);
    }
    assert.equal(children.length, 1, 'a prompt run must spawn a real child process once approved');
    const result = await service.cancel(handle.runId);
    assert.equal(result.cancelled, true);
    const events = await drained;
    assert.equal(events.filter((event) => event.type === 'run.cancelled').length, 1);
    assert.equal(jobs[0].terminated, true);
  } finally {
    await cleanup();
  }
});

test('a workspace-writing run waits for an explicit approval before spawning', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'say hi after the gate' },
    });
    // startRun returns at once — the phone needs the runId to open the
    // stream that carries the card — while the spawn waits on the decision.
    await sleep(100);
    assert.equal(children.length, 0, 'nothing spawns while the approval is pending');
    const events = await collectEvents(service, handle.runId, 'approve');
    assert.equal(children.length, 1, 'the approval releases the spawn');
    assert.equal(events[0].type, 'run.started');
    assert.equal(events[1].type, 'approval.required');
    assert.equal(events.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('a denied approval ends the run cancelled without spawning', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'do not run me' },
    });
    const events = await collectEvents(service, handle.runId, 'deny');
    const cards = events.filter((event) => event.type === 'approval.required');
    assert.equal(cards.length, 1, 'exactly one card for one denied run');
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.cancelled');
    assert.equal(terminal.payload.reason, 'approval denied');
    assert.equal(children.length, 0, 'a denied run never spawns');
  } finally {
    await cleanup();
  }
});

test('cancelling a run that is waiting for approval ends it cancelled', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:30000' },
    });
    await sleep(50);
    assert.equal(children.length, 0, 'the run is still waiting for consent');
    const result = await service.cancel(handle.runId);
    assert.equal(result.cancelled, true);
    const events = await collectEvents(service, handle.runId);
    assert.equal(events.at(-1).type, 'run.cancelled');
    assert.equal(events.filter((event) => event.type === 'approval.required').length, 1);
  } finally {
    await cleanup();
  }
});

test('an unanswered approval times out and frees the slot', async () => {
  const { service, children, cleanup } = await makeService({}, { approvalTimeoutMs: 50 });
  // The supervisor's timeout timer is unref'd (so a real Gate can always
  // exit), which means it cannot keep this test's event loop alive on its
  // own — hold the loop with a ref'd interval until the assertions are done.
  const keepalive = setInterval(() => {}, 25);
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'nobody is watching this card' },
    });
    const events = await collectEvents(service, handle.runId);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.cancelled');
    assert.equal(terminal.payload.reason, 'approval timed out');
    assert.equal(children.length, 0, 'a timed-out run never spawned');
    // The slot is free again: a fresh read-only run completes normally.
    const next = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const nextEvents = await collectEvents(service, next.runId);
    assert.equal(nextEvents.at(-1).type, 'run.completed');
  } finally {
    clearInterval(keepalive);
    await cleanup();
  }
});

test('concurrent runs honor maxConcurrentRuns', async () => {
  const { service, cleanup } = await makeService({
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 30, maxConcurrentRuns: 1 },
  });
  try {
    await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:30000' },
    });
    await assert.rejects(() => service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    }), /busy|concurrent/i);
  } finally {
    await cleanup();
  }
});

test('a refused start names a pending approval card as the holder of the slot', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:30000' },
    });
    await sleep(100); // the card is up; nothing spawns until it is answered
    assert.equal(children.length, 0, 'the run is still waiting for consent');
    // The double-tap case: Start again while the card sits open. The refusal
    // must name the card and how to clear it — not a bare "busy".
    await assert.rejects(
      () => service.startRun({
        environmentId: 'codex-local',
        operation: 'status',
        providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
        workspaceId: 'default',
        sandbox: 'read_only',
        input: {},
      }),
      (error) => {
        assert.equal(error.code, 'busy');
        assert.match(error.message, new RegExp(`run ${handle.runId} is waiting for your approval`));
        assert.match(error.message, /approve or deny/);
        return true;
      },
    );
    // Following the message's advice frees the slot.
    const events = await collectEvents(service, handle.runId, 'deny');
    assert.equal(events.at(-1).type, 'run.cancelled');
    const next = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    const nextEvents = await collectEvents(service, next.runId);
    assert.equal(nextEvents.at(-1).type, 'run.completed');
  } finally {
    await cleanup();
  }
});

test('a refused start names the unfinished task when no card is pending', async () => {
  const { service, children, cleanup } = await makeService();
  try {
    const first = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'SLEEP:4000' },
    });
    // Approve the card out-of-band so the task actually spawns and holds the
    // slot while running, then attempt a second start mid-flight.
    const drain = collectEvents(service, first.runId, 'approve');
    for (let waited = 0; waited < 2000 && children.length === 0; waited += 20) {
      await sleep(20);
    }
    assert.equal(children.length, 1, 'the approved run spawned');
    await assert.rejects(
      () => service.startRun({
        environmentId: 'codex-local',
        operation: 'status',
        providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
        workspaceId: 'default',
        sandbox: 'read_only',
        input: {},
      }),
      (error) => {
        assert.equal(error.code, 'busy');
        assert.doesNotMatch(error.message, /waiting for your approval/);
        assert.match(error.message, new RegExp(`task ${first.runId} has not finished yet`));
        return true;
      },
    );
    await drain;
  } finally {
    await cleanup();
  }
});

test('a run whose workspace directory does not exist is refused by name', async () => {
  // The typo case from the runbook's register step: the operator fat-fingers
  // the one folder the CLI may work in. startRun must refuse before anything
  // is emitted — no run id, no events, no spawn — with a message that names
  // the path and the fix, not a bare "spawn ENOENT" after the fact.
  const missing = join(tmpdir(), 'gate-cli-sup-does-not-exist-9x');
  const { service, children, cleanup } = await makeService({
    workspacePolicy: {
      roots: [missing],
      defaultRoot: missing,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
  });
  try {
    await assert.rejects(
      () => service.startRun({
        environmentId: 'codex-local',
        operation: 'status',
        providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
        workspaceId: 'default',
        sandbox: 'read_only',
        input: {},
      }),
      (error) => {
        assert.equal(error.code, 'workspace_missing');
        assert.match(error.message, /workspace directory does not exist/);
        assert.ok(error.message.includes(missing), 'the error names the bad path');
        return true;
      },
    );
    assert.equal(children.length, 0, 'nothing spawns for a missing workspace');
    assert.equal(service.listRuns('codex-local').length, 0, 'no run is recorded');
  } finally {
    await cleanup();
  }
});

test('a workspace that vanishes mid-flight fails naming the folder, not ENOENT', async () => {
  // The race the pre-flight check cannot close: the folder is deleted after
  // startRun validated it (while its approval card sat open, say). node then
  // reports a bare "spawn ENOENT"; the supervisor must translate that into
  // the workspace truth when the pinned directory is really gone.
  const doomed = await mkdtemp(join(tmpdir(), 'gate-ws-gone-'));
  const { service, cleanup } = await makeService({
    workspacePolicy: {
      roots: [doomed],
      defaultRoot: doomed,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
  }, {
    spawnImpl: () => {
      // Simulate node's ASYNC spawn failure (a bad cwd does not throw
      // synchronously): the error arrives on a timer, after execute() has
      // registered its handlers and the test has deleted the directory.
      const child = new EventEmitter();
      // Deliberately NOT unref'd: an awaited async iterator does not hold the
      // event loop, and an unref'd timer here would let node exit before the
      // failure fires (the same trap as the approval-timeout test's note).
      setTimeout(() => {
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      }, 50);
      return child;
    },
  });
  try {
    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'status',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: {},
    });
    await rm(doomed, { recursive: true, force: true });
    const events = await collectEvents(service, handle.runId);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.failed');
    assert.match(terminal.payload.message, /workspace directory disappeared/);
    assert.ok(terminal.payload.message.includes(doomed), 'the failure names the vanished path');
  } finally {
    await cleanup();
  }
});
