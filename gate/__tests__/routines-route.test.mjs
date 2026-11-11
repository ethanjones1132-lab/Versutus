import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { withRoutineTimeout } from '../core/routines.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One Hermes job record, in the snake_case shape /api/jobs answers. */
function job(id, name, extras = {}) {
  return { id, name, schedule: '0 3 * * *', enabled: true, ...extras };
}

async function makeGate({ environments = ['backend-a', 'backend-b'], jobs = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-routines-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });

  for (const id of environments) {
    await writeFile(join(gateHome, 'config', 'environments', `${id}.json`), JSON.stringify({
      schemaVersion: 1, kind: 'cli-environment', id, label: id.toUpperCase(),
      adapterId: id, executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
      versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
      workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
      enabled: true,
    }), 'utf8');
  }

  const registry = {
    get(id) {
      return {
        adapterId: id,
        adapterRevision: '1',
        supportedCliVersions: '1.x',
        protocolVersions: { acp: '1' },
        capabilities: ['sessions'],
        server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
        async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
        createBackend: (options = {}) => {
          // An environment with no routine listing at all — OpenCode's shape.
          if (id === 'backend-unavailable') return {};
          // A backend whose method list cannot be proved without starting it:
          // the inert probe throws, exactly like a factory that reads its
          // transport. Once started it still has no routine listing — Claude
          // Code and Codex's shape behind a factory that needs a live server.
          if (id === 'backend-unknown') {
            if (options?.baseUrl === 'http://127.0.0.1:0') throw new Error('cannot probe without a server');
            return {};
          }
          return {
            async listJobs() {
              if (id === 'backend-failing') throw new Error('fake backend is offline');
              return jobs[id] ?? [];
            },
          };
        },
      };
    },
    list() { return environments.map((id) => this.get(id)); },
  };
  const gate = await createGate({
    root, gateHome, port: 0, environmentRegistry: registry,
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return gate;
}

const auth = (gate) => ({ Authorization: `Bearer ${gate.token}` });
const url = (gate, query = '') => `http://127.0.0.1:${gate.port}/v1/routines${query ? `?${query}` : ''}`;
const statuses = (body) => body.backends.map((backend) => [backend.id, backend.status]);

test('GET /v1/routines merges every backend and carries only proven facts', async () => {
  const gate = await makeGate({ jobs: {
    'backend-a': [
      job('job-1', '[bot:researcher] Nightly digest', {
        next_run_at: '2026-11-11T03:00:00.000Z',
        last_run_at: '2026-11-10T03:00:00.000Z',
        last_status: 'ok',
      }),
      job('job-2', 'Gateway sweep', { schedule: 'daily', enabled: false }),
    ],
    // A host may wrap its rows in an envelope; /api/jobs answers { data: [] }.
    'backend-b': { data: [job('job-9', '[bot:writer] Weekly roundup', { schedule: 'weekly', last_status: 'error' })] },
  } });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.generatedAt, 'string');
    assert.deepEqual(statuses(body), [['backend-a', 'complete'], ['backend-b', 'complete']]);
    // Host order within a backend, backends in the Gate's own list order.
    assert.deepEqual(body.routines.map((routine) => routine.id), ['job-1', 'job-2', 'job-9']);
    assert.deepEqual(body.routines[0], {
      id: 'job-1',
      backendId: 'backend-a',
      botId: 'researcher',
      name: 'Nightly digest',
      schedule: '0 3 * * *',
      paused: false,
      lastRunAt: '2026-11-10T03:00:00.000Z',
      lastStatus: 'ok',
      nextRunAt: '2026-11-11T03:00:00.000Z',
    });
    assert.equal(body.routines[1].paused, true);
    assert.equal(Object.hasOwn(body.routines[1], 'lastStatus'), false);
    assert.equal(Object.hasOwn(body.routines[1], 'nextRunAt'), false);
    assert.equal(body.routines[2].backendId, 'backend-b');
  } finally {
    await gate.close();
  }
});

test('a backend without listJobs is unavailable, never an empty success', async () => {
  const gate = await makeGate({
    environments: ['backend-a', 'backend-unavailable'],
    jobs: { 'backend-a': [job('job-1', 'Nightly digest')] },
  });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    const body = await response.json();
    assert.deepEqual(statuses(body), [['backend-a', 'complete'], ['backend-unavailable', 'unavailable']]);
    assert.equal(Object.hasOwn(body.backends[1], 'error'), false);
    assert.deepEqual(body.routines.map((routine) => routine.id), ['job-1']);
  } finally {
    await gate.close();
  }
});

test('a failing backend is named without hiding the healthy backend routines', async () => {
  const gate = await makeGate({
    environments: ['backend-a', 'backend-failing'],
    jobs: { 'backend-a': [job('job-1', 'Nightly digest')] },
  });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    const body = await response.json();
    assert.deepEqual(statuses(body), [['backend-a', 'complete'], ['backend-failing', 'failed']]);
    assert.match(body.backends[1].error, /offline/);
    assert.deepEqual(body.routines.map((routine) => routine.id), ['job-1']);
  } finally {
    await gate.close();
  }
});

test('a backend whose method list is unknown and that has no listJobs is unavailable', async () => {
  const gate = await makeGate({
    environments: ['backend-a', 'backend-unknown'],
    jobs: { 'backend-a': [job('job-1', 'Nightly digest')] },
  });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    const body = await response.json();
    // Unknown methods used to count as servable, so the started backend's
    // missing listJobs became a "failed" read. It has no routine concept.
    assert.deepEqual(statuses(body), [['backend-a', 'complete'], ['backend-unknown', 'unavailable']]);
    assert.equal(Object.hasOwn(body.backends[1], 'error'), false);
    assert.deepEqual(body.routines.map((routine) => routine.id), ['job-1']);
  } finally {
    await gate.close();
  }
});

test('botId appears only when the job name proves its owner', async () => {
  const gate = await makeGate({ environments: ['backend-a'], jobs: {
    'backend-a': [
      job('owned', '[bot:researcher] Nightly digest'),
      job('unowned', 'Gateway sweep'),
      // An empty Bot name proves nothing, even though it is bracketed.
      job('no-owner', '[bot:] Looks owned'),
      // Ownership without a title: the row falls back to the job id.
      job('untitled', '[bot:researcher]'),
    ],
  } });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    const body = await response.json();
    const byId = Object.fromEntries(body.routines.map((routine) => [routine.id, routine]));
    assert.equal(byId.owned.botId, 'researcher');
    assert.equal(byId.owned.name, 'Nightly digest');
    assert.equal(Object.hasOwn(byId.unowned, 'botId'), false);
    assert.equal(byId.unowned.name, 'Gateway sweep');
    assert.equal(Object.hasOwn(byId['no-owner'], 'botId'), false);
    assert.equal(byId['no-owner'].name, '[bot:] Looks owned');
    assert.equal(byId.untitled.botId, 'researcher');
    assert.equal(byId.untitled.name, 'untitled');
  } finally {
    await gate.close();
  }
});

test('routine rows that cannot be read are reported, not counted as coverage', async () => {
  const gate = await makeGate({
    environments: ['backend-a', 'backend-broken', 'backend-garbage', 'backend-partial'],
    jobs: {
      'backend-a': [job('job-1', 'Nightly digest')],
      // Every row is unreadable: nothing that exists could be read.
      'backend-broken': [{ name: 'no id', schedule: 'daily' }],
      // Answered 200 with something that is not a routine list at all.
      'backend-garbage': { oops: true },
      // One row readable, two not: some of it could be read.
      'backend-partial': [job('job-2', 'Weekly roundup'), { name: 'no id' }, { name: 'also no id' }],
    },
  });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    const body = await response.json();
    assert.deepEqual(statuses(body), [
      ['backend-a', 'complete'],
      ['backend-broken', 'failed'],
      ['backend-garbage', 'failed'],
      ['backend-partial', 'partial'],
    ]);
    assert.match(body.backends[1].error, /1 routine row could not be read/);
    assert.match(body.backends[2].error, /no routine list/);
    assert.match(body.backends[3].error, /2 routine rows could not be read/);
    assert.deepEqual(body.routines.map((routine) => routine.id), ['job-1', 'job-2']);
  } finally {
    await gate.close();
  }
});

test('backendId narrows both coverage and routines', async () => {
  const gate = await makeGate({ jobs: {
    'backend-a': [job('job-1', 'Nightly digest')],
    'backend-b': [job('job-9', 'Weekly roundup')],
  } });
  try {
    const response = await fetch(url(gate, 'backendId=backend-b'), { headers: auth(gate) });
    const body = await response.json();
    assert.deepEqual(body.backends.map((backend) => backend.id), ['backend-b']);
    assert.deepEqual(body.routines.map((routine) => [routine.id, routine.backendId]), [['job-9', 'backend-b']]);
  } finally {
    await gate.close();
  }
});

test('a routine read is bounded so one hung backend cannot hold the list', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve([]), 50));
  await assert.rejects(withRoutineTimeout(slow, 10), /timed out/);
});

test('GET /v1/routines requires Gate authentication', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(url(gate));
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});
