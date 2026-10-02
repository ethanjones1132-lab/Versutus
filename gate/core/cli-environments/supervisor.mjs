import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { assertWorkspaceAccess } from './workspace-policy.mjs';
import { ApprovalService } from './approvals.mjs';
import { createWindowsJob } from './windows-job.mjs';
import { createEventLog } from './run-protocol.mjs';
import { createRunArchive, runStartedAtMs } from './run-archive.mjs';
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
 * How many finished runs stay answerable in memory per environment. The disk
 * archive is the durable copy — it keeps its own wider tail and every event of
 * every run — so what this bounds is only the heap a long-lived Gate would
 * otherwise grow forever: the event log, the workspace and, until the verdict,
 * the child environment holding the operator's decrypted provider keys.
 */
const DEFAULT_MAX_RETAINED_RUNS = 100;

/**
 * Which run is newer, for the retention and listing orders. `startedAtMs` is
 * millisecond-resolution, so a burst of runs shares it and a bare time compare
 * leaves the order to insertion; the monotonic start counter is what makes
 * "newest first" mean the same thing on every call. Run ids break a full tie so
 * hydrated history (which has no counter of its own) still orders stably.
 */
function newestFirst(a, b) {
  if (a.startedAtMs !== b.startedAtMs) return b.startedAtMs - a.startedAtMs;
  const byStart = (b.startSeq ?? 0) - (a.startSeq ?? 0);
  if (byStart !== 0) return byStart;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

function oldestFirst(a, b) {
  return -newestFirst(a, b);
}

/**
 * The chat endpoint a run gets when the caller names none. The Gate's own port
 * is the only one that can work, and a portless `http://127.0.0.1/...` resolves
 * to port 80 — a URL that is silently wrong rather than absent, so a CLI
 * following it fails somewhere else entirely. Returns null for anything that is
 * not a usable port.
 */
function chatEndpointForPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { chat: `http://127.0.0.1:${port}/v1/chat/completions` };
}

/**
 * Why startRun refused a start on an environment at its concurrency limit.
 * A bare "environment is busy" reads as a mystery on the phone exactly when
 * the operator taps Start again because nothing seems to be happening — the
 * approval card sits unanswered above. Name what holds the slot and how to
 * free it: a pending card names itself (and that silence ends it), anything
 * else is a task that has not finished yet.
 */
function describeBusy(active) {
  const pending = active.find((run) => run.approvalId);
  if (pending) {
    return (
      `environment is busy — run ${pending.runId} is waiting for your approval; ` +
      'approve or deny its card first (an unanswered card ends by itself)'
    );
  }
  return (
    `environment is busy — task ${active[0].runId} has not finished yet; ` +
    'cancel it from Recent runs or wait for it to complete'
  );
}

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

/**
 * The one line a tray notice can show for a run verdict. The supervisor
 * already had the failure message and the cancel reason; the notifier never
 * saw them, so a rich-body device got a title and a blank body.
 */
function runEventText(state, payload = {}) {
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  if (typeof payload.reason === 'string' && payload.reason.trim()) return payload.reason.trim();
  if (state === 'failed' && payload.exitCode != null) return `exited ${payload.exitCode}`;
  return null;
}

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

/**
 * Human wording for a spawn that never started. A missing cwd surfaces as a
 * bare "spawn ENOENT" — true but useless on a phone. When the workspace the
 * run was pinned to has vanished between the pre-flight check and the spawn
 * (deleted while its approval card sat open, for instance), say so and name
 * the path; otherwise pass the OS message through untouched.
 */
function spawnFailureMessage(error, workspacePath) {
  if (error?.code === 'ENOENT' && !existsSync(workspacePath)) {
    return `workspace directory disappeared before the task could start: ${workspacePath}`;
  }
  return error.message;
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
    // Directory for the durable run archive (null = memory-only, as before).
    // When set, every run's events are appended to disk and init() reloads
    // finished history at startup, so discovery + replay survive a restart.
    archiveDir = null,
    // Observer for push-worthy run transitions (Solution A): called with
    // `{ trigger: 'approval'|'run', runId, state?, environmentId, ... }`
    // when an approval card goes up and when a run reaches its verdict.
    // Fire-and-forget — a throwing or rejecting observer must never break
    // the run it reports on.
    onRunEvent = null,
    // Finished runs kept answerable in memory per environment; older ones are
    // evicted and their events keep replaying from the archive.
    maxRetainedRuns = DEFAULT_MAX_RETAINED_RUNS,
    // Endpoints for a run whose caller names none. VERSUTUS_GATE_PORT wins when
    // it names a real port; this is the escape hatch for a caller that knows
    // the port the Gate actually bound (an ephemeral one) and can say so.
    defaultEndpoints = null,
  } = {}) {
    this.store = store;
    this.registry = registry;
    this.jobFactory = jobFactory;
    this.approvals = approvals;
    this.spawnImpl = spawnImpl;
    this.vault = vault;
    this.onRunEvent = typeof onRunEvent === 'function' ? onRunEvent : null;
    // How long a run may sit in front of an unanswered approval card before
    // it is ruled denied and its slot freed.
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.runs = new Map();
    // Live (not yet finished) run ids per environment. The runs map answers
    // history questions; this one answers "is the slot free" and "is the
    // environment still busy", and both are on the start/finish path — so
    // neither may cost a walk over every run this process ever started.
    this.liveRuns = new Map();
    this.runSeq = 0;
    this.maxRetainedRuns = Math.max(1, Number(maxRetainedRuns) || 0);
    this.defaultEndpoints = defaultEndpoints;
    this.environmentState = new Map();
    this.archive = archiveDir ? createRunArchive(archiveDir) : null;
    this.initPromise = null;
  }

  /**
   * Load archived run history back into the in-memory runs map so listRuns()
   * and events() answer for runs that finished under a previous Gate process.
   * A run whose process died with the Gate — no terminal event on disk — is
   * closed honestly as run.failed naming what happened, and that verdict is
   * persisted so later restarts see a stable, terminal record. Safe (and
   * cheap) to call more than once; the server awaits it before listening.
   */
  async init() {
    if (!this.archive) return;
    if (!this.initPromise) this.initPromise = this.hydrateArchive();
    await this.initPromise;
  }

  async hydrateArchive() {
    const restored = await this.archive.load();
    for (const { meta, events } of restored) {
      if (this.runs.has(meta.runId)) continue;
      const logEvents = [...events];
      const last = logEvents.at(-1);
      if (!last || !/^run\.(completed|failed|cancelled)$/.test(last.type)) {
        logEvents.push({
          runId: meta.runId,
          sequence: (last?.sequence ?? 0) + 1,
          timestamp: new Date().toISOString(),
          type: 'run.failed',
          payload: { message: 'the Gate went down before this task finished' },
        });
        // Persist the synthesized verdict too, so the file always ends in a
        // terminal event no matter how many times the Gate restarts. Sync
        // write: it lands before load() could ever be called again.
        try {
          this.archive.append(meta.environmentId, meta.runId, logEvents.at(-1));
        } catch {
          // A persistence hiccup must not stop history from loading.
        }
      }
      this.runs.set(meta.runId, {
        runId: meta.runId,
        request: {
          environmentId: meta.environmentId,
          operation: meta.operation,
          input: meta.input,
          sandbox: meta.sandbox,
        },
        record: null,
        log: createEventLog(meta.runId, { events: logEvents }),
        startedAtMs: runStartedAtMs(meta),
        startSeq: (this.runSeq += 1),
        done: true,
        archived: true,
      });
    }
  }

  /**
   * The coarse state of one environment, with the probe that last saw it.
   * A probe merges rather than replaces: it reports what the CLI is, and says
   * nothing about the run holding the environment's slot. Overwriting `busy`
   * made a probe mid-run (`environments.check` from the phone, `start()` on a
   * reconnect) read as idle, and every reader of this Map believed it — the
   * app's Environments screen, `/env`, the manifest. A broken or missing CLI is
   * a fact about the environment itself and still wins.
   */
  recordState(id, state, probe) {
    const busy = state === 'ready' && this.activeRuns(id).length > 0;
    this.environmentState.set(id, { state: busy ? 'busy' : state, probe });
  }

  async check(id) {
    const record = await this.require(id);
    const adapter = this.registry.get(record.adapterId);
    const probe = await adapter.probe(record.executable.path);
    const state = probe.state === 'ready' ? 'ready' : probe.state;
    // The manifest and the app's backend picker (backend-manager.describe())
    // read this Map for both the coarse state and the probed CLI version, so
    // the probe travels with the state rather than being discarded.
    this.recordState(id, state, probe);
    return { id, state, probe, record };
  }

  async start(id) {
    const checked = await this.check(id);
    if (checked.state === 'ready') this.recordState(id, 'ready', checked.probe);
    return checked;
  }

  async stop(id) {
    this.environmentState.set(id, { state: 'stopped' });
    for (const run of this.activeRuns(id)) {
      await this.cancel(run.runId);
    }
    return { id, state: 'stopped' };
  }

  /**
   * The runs still in flight on one environment, in start order. Sourced from
   * the live index rather than by filtering the whole runs map: a Gate with
   * weeks of history answers "is this environment busy" on every start, and
   * that question is about live runs only.
   */
  activeRuns(environmentId) {
    const ids = this.liveRuns.get(environmentId);
    if (!ids || ids.size === 0) return [];
    const runs = [];
    for (const runId of ids) {
      const run = this.runs.get(runId);
      if (run && !run.done) runs.push(run);
    }
    return runs;
  }

  /**
   * How many runs are in flight on this Gate, across every environment. The
   * widget's work line words this as runs, so it has to be counted as runs:
   * `environmentState` is keyed by environment, and three concurrent runs on
   * one environment are one entry there. Every environment that holds live runs
   * holds at least one id, so the count never over-reports.
   */
  liveRunCount() {
    let total = 0;
    for (const ids of this.liveRuns.values()) total += ids.size;
    return total;
  }

  async startRun(request) {
    const record = await this.require(request.environmentId);
    const active = this.activeRuns(request.environmentId);
    if (active.length >= (record.lifecycle?.maxConcurrentRuns ?? 1)) {
      const error = new Error(describeBusy(active));
      error.code = 'busy';
      throw error;
    }

    const workspace = assertWorkspaceAccess(
      record.workspacePolicy,
      request.workspacePath ?? record.workspacePolicy.defaultRoot,
    );
    // A workspace root that is not on disk cannot host a spawn: node reports
    // it as a bare "spawn ENOENT" after run.started, which reads as a mystery
    // failure on the phone. Refuse here, by name, before anything is emitted —
    // the same pre-flight honesty as the executable probe below.
    if (!existsSync(workspace.canonical)) {
      const error = new Error(
        `workspace directory does not exist: ${workspace.canonical} — ` +
        'create the folder or fix the environment\u2019s workspace root, then start again',
      );
      error.code = 'workspace_missing';
      throw error;
    }
    const adapter = this.registry.get(record.adapterId);
    const probe = await adapter.probe(record.executable.path);
    if (probe.state !== 'ready') {
      this.recordState(record.id, probe.state, probe);
      // A bare state word ("environment not_installed") reads as a mystery on
      // the phone exactly when the operator must fix it blind. The probe
      // already named the reason — say it, plus the path it refers to.
      const error = new Error(
        `environment ${probe.state}: ${probe.message ?? 'not ready'} (${record.executable.path})`,
      );
      error.code = probe.state;
      throw error;
    }

    const runId = request.runId ?? `run-${randomBytes(6).toString('hex')}`;
    const startedAtMs = Date.now();
    // Resolve the operator's deliberate bindings before the child environment
    // is built, while a dead reference can still be named on the stream
    // before anything runs.
    const { credentials, unresolved } = await this.resolveRunCredentials(record);
    // Every emitted event is mirrored to the disk archive (fire-and-forget —
    // persistence must never break or stall the live run; the write itself is
    // synchronous so file order always equals emit order), so this run stays
    // discoverable and replayable after the Gate restarts.
    const log = createEventLog(runId, {
      onEmit: this.archive
        ? (event) => this.archive.append(request.environmentId, runId, event)
        : undefined,
    });
    if (this.archive) {
      try {
        this.archive.record({
          runId,
          environmentId: request.environmentId,
          operation: request.operation,
          input: request.input,
          sandbox: request.sandbox,
          startedAt: new Date(startedAtMs).toISOString(),
          startedAtMs,
        });
      } catch {
        // Persistence must never block starting a run.
      }
    }
    const job = this.jobFactory();
    const childEnv = buildCliEnvironment(process.env, {
      environmentId: record.id,
      runId,
      providerRef: request.providerRef,
      audience: 'versutus-gate',
      endpoints: this.endpointsFor(request),
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
      startSeq: (this.runSeq += 1),
      done: false,
    };
    this.runs.set(runId, run);
    this.trackLive(run);
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
      runId: run.runId,
      environmentId: run.request.environmentId,
      operation: run.request.operation,
      summary: APPROVAL_SUMMARY[risk] ?? 'This run needs your approval to continue.',
    });
    if (verdict.decision === 'approve') return true;
    if (verdict.decision === 'deny') {
      this.finish(run, 'run.failed', {
        message: `operation "${run.request.operation}" was refused by approval policy: ${verdict.reason ?? 'denied'}`,
      });
      return false;
    }

    run.approvalId = verdict.approvalId;
    const summary = APPROVAL_SUMMARY[verdict.type] ?? 'This run needs your approval to continue.';
    run.log.emit({
      type: 'approval.required',
      payload: {
        approvalId: verdict.approvalId,
        operation: run.request.operation,
        risk: verdict.type,
        summary,
      },
    });
    // The phone may be in a pocket: the approval card going up is the
    // moment a push must go out, while the run still holds its slot.
    this.emitRunEvent({
      trigger: 'approval',
      runId: run.runId,
      environmentId: run.request.environmentId,
      operation: run.request.operation,
      text: summary,
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

    /**
     * The one bound a running task has. An approval card times out on its
     * own, but once the CLI is live nothing used to stop it: a hung task
     * held the environment's single run slot forever, and the operator's
     * only signal was a "busy" refusal naming it. When the record sets
     * lifecycle.maxRunSeconds, the Gate itself stops the tree when that
     * budget is spent and says so by name. Absent = no limit, exactly as
     * before, so no existing record changes behavior.
     */
    const maxRunSeconds = run.record.lifecycle?.maxRunSeconds;
    if (Number.isInteger(maxRunSeconds) && maxRunSeconds > 0) {
      run.timeLimitTimer = setTimeout(() => {
        if (run.done || run.nativeCancel) return;
        this.stopTimedOutRun(run, maxRunSeconds);
      }, maxRunSeconds * 1000);
      run.timeLimitTimer.unref?.();
    }

    const pump = createOutputPump((stream, text) => {
      run.log.emit({ type: 'run.output', payload: { stream, text } });
    });
    child.stdout?.on('data', (chunk) => pump.push('stdout', chunk));
    child.stderr?.on('data', (chunk) => pump.push('stderr', chunk));
    child.on('error', (error) => {
      if (run.done || run.nativeCancel) return;
      this.finish(run, 'run.failed', { message: spawnFailureMessage(error, run.workspace.canonical) });
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

  /**
   * The event stream for one run.
   *
   * `signal` is the unsubscribe: abort it when the viewer goes away. `return()`
   * on the returned stream cannot do it — the log's generator re-parks at a
   * fresh await on every pass, so a queued return is never honoured and the
   * subscriber would stay parked for the life of the run.
   */
  events(runId, { signal } = {}) {
    const run = this.runs.get(runId);
    if (run) return run.log.stream(signal);
    // Retention only drops a run from memory, never from the archive, so a
    // replay of an evicted run is answered from disk. An id that is in neither
    // is still an unknown run, exactly as before.
    const evicted = this.archive?.readRun(runId);
    if (!evicted) throw new Error(`unknown run ${runId}`);
    return createEventLog(runId, { events: evicted.events }).stream(signal);
  }

  /**
   * Summaries for the runs retained on an environment, newest first. This is
   * how a phone finds its way back to a run after the SSE connection dropped:
   * the event stream replays from sequence 0 to any subscriber, but only if
   * the caller can rediscover the run id. Runs finished under this process
   * come from memory; runs from earlier Gate processes were rehydrated from
   * the disk archive by init(), so history survives a restart.
   */
  listRuns(environmentId, limit = 50) {
    // One pass, and only this environment's runs are ever copied: the map holds
    // every run this process remembers, and a phone asking for the newest page
    // has no use for the rest. Each summary reads just its run's last event
    // rather than copying its whole log.
    const matching = [];
    for (const run of this.runs.values()) {
      if (run.request.environmentId === environmentId) matching.push(run);
    }
    matching.sort(newestFirst);
    return matching.slice(0, limit).map((run) => {
      const last = run.log.lastEvent();
      const terminal = last && /^run\.(completed|failed|cancelled)$/.test(last.type) ? last : null;
      const exitCode =
        terminal && typeof terminal.payload.exitCode === 'number' ? terminal.payload.exitCode : null;
      return {
        runId: run.runId,
        environmentId: run.request.environmentId,
        operation: run.request.operation,
        state: terminal ? terminal.type.slice(4) : last ? 'running' : 'starting',
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

  /**
   * The time-limit twin of cancel(): same tree kill, different verdict. The
   * run ends failed — the task did not finish — and the message names the
   * budget and the way to change it, so the phone shows a reason instead of
   * a mystery exit code. nativeCancel goes down first so the child's own
   * close event can never win the race and report a bare nonzero exit.
   */
  async stopTimedOutRun(run, maxRunSeconds) {
    run.nativeCancel = true;
    try {
      await run.job.terminate();
    } finally {
      this.finish(run, 'run.failed', {
        message:
          `task exceeded its ${maxRunSeconds}s time limit and was stopped — ` +
          'raise or remove lifecycle.maxRunSeconds on the environment to allow longer tasks',
      });
    }
  }

  async wait(runId) {
    const events = [];
    for await (const event of this.events(runId)) events.push(event);
    return events.at(-1);
  }

  /**
   * The endpoints a run is told to route its model call through. Absent ones
   * are derived from the port the Gate is actually listening on, and when
   * nothing names one the chat variable is left out entirely: a CLI that finds
   * no endpoint stops, while one handed a portless URL believes the Gate is on
   * port 80 and fails somewhere else entirely.
   */
  endpointsFor(request) {
    return request.endpoints ?? chatEndpointForPort(process.env.VERSUTUS_GATE_PORT) ?? this.defaultEndpoints ?? undefined;
  }

  trackLive(run) {
    const environmentId = run.request.environmentId;
    let ids = this.liveRuns.get(environmentId);
    if (!ids) {
      ids = new Set();
      this.liveRuns.set(environmentId, ids);
    }
    ids.add(run.runId);
  }

  untrackLive(run) {
    const ids = this.liveRuns.get(run.request.environmentId);
    if (!ids) return;
    ids.delete(run.runId);
    if (ids.size === 0) this.liveRuns.delete(run.request.environmentId);
  }

  /**
   * Evict the oldest finished runs once an environment has more of them than
   * the retention cap. A live run is never evicted — its slot, its child and
   * its stream are still live — and an evicted run keeps replaying from the
   * archive, which holds every event of every run it kept.
   */
  retainFinishedRuns(environmentId) {
    const finished = [];
    for (const run of this.runs.values()) {
      if (run.request.environmentId === environmentId && run.done) finished.push(run);
    }
    const excess = finished.length - this.maxRetainedRuns;
    if (excess <= 0) return;
    finished.sort(oldestFirst);
    for (const stale of finished.slice(0, excess)) this.runs.delete(stale.runId);
  }

  finish(run, type, payload) {
    if (run.done) return;
    // The run reached a verdict before its time budget: disarm the watchdog
    // so a fast task never leaves a stray timer behind.
    if (run.timeLimitTimer) {
      clearTimeout(run.timeLimitTimer);
      run.timeLimitTimer = null;
    }
    run.done = true;
    this.untrackLive(run);
    run.log.emit({ type, payload });
    // A run that ends does not get to undo a state the caller set while it was
    // in flight. Stopping an environment cancels its runs, so the last of those
    // cancellations used to overwrite the `stopped` the caller was just told
    // with `ready` — and the manifest, /v1/backends and the app's Environments
    // screen all read this Map, so the state the user set was the state they
    // lost. `check`/`start` are what move an environment off `stopped`.
    const environmentId = run.request.environmentId;
    if (this.environmentState.get(environmentId)?.state !== 'stopped') {
      this.environmentState.set(environmentId, {
        state: this.activeRuns(environmentId).length ? 'busy' : 'ready',
      });
    }
    // A verdict the operator did not watch happen locally still deserves a
    // tray notice: completed, failed and cancelled all report here.
    const state = type === 'run.completed' ? 'completed'
      : type === 'run.failed' ? 'failed'
      : type === 'run.cancelled' ? 'cancelled' : null;
    if (state) {
      const text = runEventText(state, payload);
      this.emitRunEvent({
        trigger: 'run',
        runId: run.runId,
        state,
        environmentId: run.request.environmentId,
        ...(text ? { text } : {}),
      });
    }
    // Only now, with the verdict emitted and every observer notified: the run
    // needs nothing more, and `childEnv` is the operator's decrypted provider
    // keys. Nothing reads these after finish() — the child is either gone or
    // unreachable, cancel() and the watchdog return early on a finished run,
    // and listRuns reports no pid for one — so a run that finished last month
    // stops holding its secrets in the heap.
    run.childEnv = null;
    run.child = null;
    run.job = null;
    this.retainFinishedRuns(run.request.environmentId);
  }

  /** Fire-and-forget report to the push observer; never throws. */
  emitRunEvent(event) {
    if (!this.onRunEvent) return;
    try {
      const result = this.onRunEvent(event);
      result?.catch?.(() => {});
    } catch {
      // A broken observer must never break the run it reports on.
    }
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
