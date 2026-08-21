import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { assertWorkspaceAccess } from './workspace-policy.mjs';
import { ApprovalService } from './approvals.mjs';
import { createWindowsJob } from './windows-job.mjs';
import { createEventLog } from './run-protocol.mjs';
import { buildCliEnvironment } from './process-environment.mjs';
import { spawnCommand } from './adapters/shared.mjs';

/**
 * Upper bound on one run.output event's text, in characters. The cap bounds
 * frame size, not data: output past it is sliced into further events rather
 * than dropped (the terminal module made that mistake once already), and a
 * streaming decoder carries a multi-byte sequence that straddles two 'data'
 * events so the split point never becomes U+FFFD.
 */
const MAX_OUTPUT_CHARS = 16_000;

function createOutputPump(emit) {
  const decoders = new Map();

  function decodeInto(stream, buffer, final = false) {
    let decoder = decoders.get(stream);
    if (!decoder) {
      decoder = new TextDecoder('utf-8');
      decoders.set(stream, decoder);
    }
    const text = decoder.decode(buffer, { stream: !final });
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + MAX_OUTPUT_CHARS, text.length);
      // Never cut between the halves of a surrogate pair.
      if (end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      emit(stream, text.slice(i, end));
      i = end;
    }
  }

  return {
    push(stream, buffer) {
      decodeInto(stream, buffer);
    },
    flush() {
      for (const stream of decoders.keys()) decodeInto(stream, undefined, true);
    },
  };
}

export class CliEnvironmentService {
  constructor({ store, registry, jobFactory = createWindowsJob, approvals = new ApprovalService(), spawnImpl = nodeSpawn } = {}) {
    this.store = store;
    this.registry = registry;
    this.jobFactory = jobFactory;
    this.approvals = approvals;
    this.spawnImpl = spawnImpl;
    this.runs = new Map();
    this.environmentState = new Map();
  }

  async check(id) {
    const record = await this.require(id);
    const adapter = this.registry.get(record.adapterId);
    const probe = await adapter.probe(record.executable.path);
    const state = probe.state === 'ready' ? 'ready' : probe.state;
    // The manifest and the app's backend picker (backend-manager.describe())
    // read this Map for both the coarse state and the probed CLI version, so
    // the probe travels with the state rather than being discarded.
    this.environmentState.set(id, { state, probe });
    return { id, state, probe, record };
  }

  async start(id) {
    const checked = await this.check(id);
    if (checked.state === 'ready') this.environmentState.set(id, { state: 'ready', probe: checked.probe });
    return checked;
  }

  async stop(id) {
    this.environmentState.set(id, { state: 'stopped' });
    for (const run of this.runs.values()) {
      if (run.request.environmentId === id && !run.done) {
        await this.cancel(run.runId);
      }
    }
    return { id, state: 'stopped' };
  }

  async startRun(request) {
    const record = await this.require(request.environmentId);
    const active = [...this.runs.values()].filter((run) => run.request.environmentId === request.environmentId && !run.done);
    if (active.length >= (record.lifecycle?.maxConcurrentRuns ?? 1)) {
      const error = new Error('environment is busy');
      error.code = 'busy';
      throw error;
    }

    const workspace = assertWorkspaceAccess(
      record.workspacePolicy,
      request.workspacePath ?? record.workspacePolicy.defaultRoot,
    );
    const adapter = this.registry.get(record.adapterId);
    const probe = await adapter.probe(record.executable.path);
    if (probe.state !== 'ready') {
      this.environmentState.set(record.id, { state: probe.state, probe });
      const error = new Error(`environment ${probe.state}`);
      error.code = probe.state;
      throw error;
    }

    const runId = request.runId ?? `run-${randomBytes(6).toString('hex')}`;
    const startedAtMs = Date.now();
    const log = createEventLog(runId);
    const job = this.jobFactory();
    const childEnv = buildCliEnvironment(process.env, {
      environmentId: record.id,
      runId,
      providerRef: request.providerRef,
      audience: 'versutus-gate',
      endpoints: request.endpoints ?? { chat: 'http://127.0.0.1/v1/chat/completions' },
    });
    const run = {
      runId,
      request,
      record,
      log,
      job,
      childEnv,
      workspace,
      adapter,
      startedAtMs,
      done: false,
    };
    this.runs.set(runId, run);
    this.environmentState.set(record.id, { state: 'busy' });
    log.emit({ type: 'run.started', payload: { operation: request.operation, sandbox: request.sandbox } });

    /**
     * The invocation is the adapter's own contract — `codex exec`, `claude -p`,
     * `hermes -z`, `opencode run` — verified against each CLI's usage line.
     * Without it this service used to emit run.completed exitCode 0 without
     * ever spawning anything: a phone operator watched a task "succeed" with
     * no reply in it, which is exactly the silent-empty failure the Gate
     * exists to prevent.
     */
    const invocation = adapter.runInvocation?.(request.operation, request.input);
    if (!invocation) {
      queueMicrotask(() =>
        this.finish(run, 'run.failed', {
          message: `"${request.operation}" on adapter "${record.adapterId}" has no non-interactive invocation`,
        }),
      );
      return { runId, completed: this.wait(runId) };
    }

    this.execute(run, invocation.args);
    return { runId, completed: this.wait(runId) };
  }

  execute(run, args) {
    const { command, prefix } = spawnCommand(run.record.executable.path);
    let child;
    try {
      child = this.spawnImpl(command, [...prefix, ...args], {
        cwd: run.workspace.canonical,
        env: run.childEnv,
        windowsHide: true,
      });
    } catch (error) {
      this.finish(run, 'run.failed', { message: error.message });
      return;
    }
    // Registered before any event can fire so cancel() kills this child.
    run.job.add(child);

    const pump = createOutputPump((stream, text) => {
      run.log.emit({ type: 'run.output', payload: { stream, text } });
    });
    child.stdout?.on('data', (chunk) => pump.push('stdout', chunk));
    child.stderr?.on('data', (chunk) => pump.push('stderr', chunk));
    child.on('error', (error) => {
      if (run.done || run.nativeCancel) return;
      this.finish(run, 'run.failed', { message: error.message });
    });
    child.on('close', (code) => {
      pump.flush();
      // A killed child reports a nonzero/null code; cancel() already emitted
      // the terminal event, and finish() would refuse a second one anyway.
      if (run.done || run.nativeCancel) return;
      if (code === 0) this.finish(run, 'run.completed', { exitCode: 0 });
      else this.finish(run, 'run.failed', { exitCode: code ?? null });
    });
  }

  events(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run.log.stream();
  }

  /**
   * Summaries for the runs retained on an environment, newest first. This is
   * how a phone finds its way back to a run after the SSE connection dropped:
   * the event stream replays from sequence 0 to any subscriber, but only if
   * the caller can rediscover the run id. Runs live in memory with the Gate,
   * so this is a recovery window, not an archive.
   */
  listRuns(environmentId, limit = 50) {
    return [...this.runs.values()]
      .filter((run) => run.request.environmentId === environmentId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .slice(0, limit)
      .map((run) => {
        const events = run.log.events();
        const last = events.at(-1);
        const terminal = last && /^run\.(completed|failed|cancelled)$/.test(last.type) ? last : null;
        const exitCode =
          terminal && typeof terminal.payload.exitCode === 'number' ? terminal.payload.exitCode : null;
        return {
          runId: run.runId,
          environmentId: run.request.environmentId,
          operation: run.request.operation,
          state: terminal ? terminal.type.slice(4) : events.length ? 'running' : 'starting',
          startedAt: new Date(run.startedAtMs).toISOString(),
          endedAt: terminal ? terminal.timestamp : null,
          exitCode,
        };
      });
  }

  async approve(runId, approvalId, decision) {
    return this.approvals.decide(approvalId, decision);
  }

  async cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || run.done) return { cancelled: false };
    run.nativeCancel = true;
    await run.job.terminate();
    this.finish(run, 'run.cancelled', { reason: 'cancelled' });
    return { cancelled: true };
  }

  async wait(runId) {
    const events = [];
    for await (const event of this.events(runId)) events.push(event);
    return events.at(-1);
  }

  finish(run, type, payload) {
    if (run.done) return;
    run.done = true;
    run.log.emit({ type, payload });
    const remaining = [...this.runs.values()].filter((item) => item.request.environmentId === run.request.environmentId && !item.done);
    this.environmentState.set(run.request.environmentId, { state: remaining.length ? 'busy' : 'ready' });
  }

  async require(id) {
    const record = await this.store.get(id);
    if (!record) {
      const error = new Error(`environment "${id}" not found`);
      error.code = 'environment_not_found';
      throw error;
    }
    return record;
  }
}
