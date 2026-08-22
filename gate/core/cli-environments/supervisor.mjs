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

/**
 * The one-line summary the phone's approval card shows, per risk class.
 * Anything unmapped falls back to the launcher's generic text.
 */
const APPROVAL_SUMMARY = {
  workspace_write: 'This task can modify files in its workspace — approve to let it start.',
  host_write: 'This task can write outside its workspace — approve to let it start.',
  credential: 'This task wants access to credentials — approve to let it start.',
  install: 'This task wants to install software — approve to let it start.',
  update: 'This task wants to update software — approve to let it start.',
  plugin: 'This task wants to install a plugin — approve to let it start.',
  system: 'This task wants to change system state — approve to let it start.',
  destructive: 'This task may delete or overwrite data — approve to let it start.',
  bypass: 'This task asks to bypass safety controls — approve only if you trust it.',
};

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
  constructor({
    store,
    registry,
    jobFactory = createWindowsJob,
    approvals = new ApprovalService(),
    spawnImpl = nodeSpawn,
    approvalTimeoutMs = 120_000,
    // Resolves an environment's credentialBindings into the CLI's environment
    // at run start. Optional so existing constructions keep working; without
    // it no binding resolves and none is injected — matching backend-manager.
    vault = null,
  } = {}) {
    this.store = store;
    this.registry = registry;
    this.jobFactory = jobFactory;
    this.approvals = approvals;
    this.spawnImpl = spawnImpl;
    this.vault = vault;
    // How long a run may sit in front of an unanswered approval card before
    // it is ruled denied and its slot freed.
    this.approvalTimeoutMs = approvalTimeoutMs;
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
    // Resolve the operator's deliberate bindings before the child environment
    // is built, while a dead reference can still be named on the stream
    // before anything runs.
    const { credentials, unresolved } = await this.resolveRunCredentials(record);
    const log = createEventLog(runId);
    const job = this.jobFactory();
    const childEnv = buildCliEnvironment(process.env, {
      environmentId: record.id,
      runId,
      providerRef: request.providerRef,
      audience: 'versutus-gate',
      endpoints: request.endpoints ?? { chat: 'http://127.0.0.1/v1/chat/completions' },
      credentials,
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
    // A dead binding is not fatal (model routing can ride invocation tokens)
    // but the operator must see it in the run sheet at demo time — not only
    // in Gate-machine `gate doctor` output. References are named, never
    // values; resolved values travel only inside the child environment.
    for (const { variable, reference } of unresolved) {
      log.emit({
        type: 'run.note',
        payload: {
          level: 'warning',
          variable,
          reference,
          message:
            `${variable} is bound to ${reference} but no value is stored for that reference — ` +
            'set the key on the Providers screen or remove the binding; this task starts without it.',
        },
      });
    }

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

    /**
     * Consent is resolved in the background: the caller gets the runId at
     * once (the phone needs it to open the SSE stream that carries the
     * approval card), while nothing spawns until the operator decides.
     */
    queueMicrotask(() => {
      this.requestConsent(run, adapter)
        .then((permitted) => {
          if (permitted) this.execute(run, invocation.args);
        })
        .catch((error) => this.finish(run, 'run.failed', { message: error.message }));
    });
    return { runId, completed: this.wait(runId) };
  }

  /**
   * Human consent in front of the spawn. The operation's risk class goes
   * through the ApprovalService: read-only operations auto-approve, anything
   * that can write/execute/install emits `approval.required` and the run
   * holds (slot included) until the phone's Approve/Deny card is answered or
   * the timeout rules it denied.
   *
   * Risk comes from the adapter's declared operation table, but adapters name
   * operations natively (`exec` for Codex) while callers speak the generic
   * verbs the launcher offers (`prompt`). An undeclared verb is therefore not
   * refused outright — it asks first: only a declared read-only operation
   * skips the card, and the ApprovalService still fails closed on risk
   * classes it does not know.
   */
  async requestConsent(run, adapter) {
    const declared = adapter.operations?.[run.request.operation];
    const risk =
      typeof declared?.risk === 'string'
        ? declared.risk
        : run.request.operation === 'status'
          ? 'read'
          : 'workspace_write';
    const verdict = await this.approvals.normalize({
      type: risk,
      environmentId: run.request.environmentId,
      operation: run.request.operation,
    });
    if (verdict.decision === 'approve') return true;
    if (verdict.decision === 'deny') {
      this.finish(run, 'run.failed', {
        message: `operation "${run.request.operation}" was refused by approval policy: ${verdict.reason ?? 'denied'}`,
      });
      return false;
    }

    run.approvalId = verdict.approvalId;
    run.log.emit({
      type: 'approval.required',
      payload: {
        approvalId: verdict.approvalId,
        operation: run.request.operation,
        risk: verdict.type,
        summary: APPROVAL_SUMMARY[verdict.type] ?? 'This run needs your approval to continue.',
      },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      // Nobody answered: rule it denied so the slot frees and the run ends
      // honestly instead of waiting forever.
      timedOut = true;
      this.approvals.decide(verdict.approvalId, 'deny');
    }, this.approvalTimeoutMs);
    timer.unref?.();
    let ruling = null;
    try {
      ruling = await this.approvals.waitForDecision(verdict.approvalId);
    } finally {
      clearTimeout(timer);
    }
    run.approvalId = null;

    if (ruling?.decision === 'approve') return true;
    this.finish(run, 'run.cancelled', {
      reason: timedOut ? 'approval timed out' : 'approval denied',
    });
    return false;
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
    // Kept for the runs list: a mid-flight run advertises the OS pid of the
    // process doing the work, so a stuck run can be identified — and a
    // cancelled one proven dead — outside the Gate's own bookkeeping.
    run.child = child;

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

  /**
   * Credentials the operator deliberately bound to this environment, resolved
   * exactly like backend-manager.resolveCredentials and doctor: a binding
   * "resolves" only when the vault returns a non-empty string for its
   * reference (an absent or undecryptable read is a missing value). The
   * unresolved ones are reported, not fatal — each is named on the run
   * stream so the operator sees it in the sheet during the demo.
   */
  async resolveRunCredentials(record) {
    const bindings = Object.entries(record.credentialBindings ?? {});
    if (!bindings.length || !this.vault) return { credentials: {}, unresolved: [] };
    const credentials = {};
    const unresolved = [];
    for (const [variable, reference] of bindings) {
      const value = await this.vault.get(reference).catch(() => undefined);
      if (typeof value === 'string' && value) credentials[variable] = value;
      else unresolved.push({ variable, reference });
    }
    return { credentials, unresolved };
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
          // OS pid of the spawned CLI while the run is mid-flight; null once
          // finished so a stale pid is never mistaken for a live one.
          pid: !run.done && run.child?.pid ? run.child.pid : null,
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
    if (run.approvalId) {
      // A run waiting for consent has no process to kill yet; ruling the
      // approval denied releases the waiting supervisor, and finish() below
      // emits the (single) terminal event.
      this.approvals.decide(run.approvalId, 'deny');
    }
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
