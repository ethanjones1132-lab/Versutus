import { randomBytes } from 'node:crypto';

import { assertWorkspaceAccess } from './workspace-policy.mjs';
import { ApprovalService } from './approvals.mjs';
import { createWindowsJob } from './windows-job.mjs';
import { createEventLog } from './run-protocol.mjs';
import { buildCliEnvironment } from './process-environment.mjs';

export class CliEnvironmentService {
  constructor({ store, registry, jobFactory = createWindowsJob, approvals = new ApprovalService() } = {}) {
    this.store = store;
    this.registry = registry;
    this.jobFactory = jobFactory;
    this.approvals = approvals;
    this.runs = new Map();
    this.environmentState = new Map();
  }

  async check(id) {
    const record = await this.require(id);
    const adapter = this.registry.get(record.adapterId);
    const probe = await adapter.probe(record.executable.path);
    const state = probe.state === 'ready' ? 'ready' : probe.state;
    this.environmentState.set(id, state);
    return { id, state, probe, record };
  }

  async start(id) {
    const checked = await this.check(id);
    if (checked.state === 'ready') this.environmentState.set(id, 'ready');
    return checked;
  }

  async stop(id) {
    this.environmentState.set(id, 'stopped');
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
      this.environmentState.set(record.id, probe.state);
      const error = new Error(`environment ${probe.state}`);
      error.code = probe.state;
      throw error;
    }

    const runId = request.runId ?? `run-${randomBytes(6).toString('hex')}`;
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
      done: false,
    };
    this.runs.set(runId, run);
    this.environmentState.set(record.id, 'busy');
    log.emit({ type: 'run.started', payload: { operation: request.operation, sandbox: request.sandbox } });

    if (request.hang) {
      run.pending = true;
    } else {
      queueMicrotask(() => this.finish(run, 'run.completed', { exitCode: 0 }));
    }

    return { runId, completed: this.wait(runId) };
  }

  events(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run.log.stream();
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
    this.environmentState.set(run.request.environmentId, remaining.length ? 'busy' : 'ready');
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
