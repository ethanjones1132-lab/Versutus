import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';
import { toCronJobView } from '../core/cron-view.mjs';

/**
 * Hermes v0.23.0 contract fixtures.
 *
 * Everything the Gate or the app parses from Hermes is pinned to one release here, so an
 * upstream rename shows up as a failing assertion rather than an empty screen. The fixtures
 * are derived from the v0.23.0 tag except `health.json` and `error-401.json`, which were
 * live-probed (see PROVENANCE.md in the fixture directory).
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hermes-v0.23.0');
const SESSION_ID = 'api_1793923200_00000000';
const RUN_ID = 'run_0123456789abcdef';

async function fixture(name) {
  const text = await readFile(join(FIXTURES, name), 'utf8');
  return name.endsWith('.json') ? JSON.parse(text) : text;
}

/** The same recording fake in hermes-backend.test.mjs: the real backend, no network. */
function backend(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return responder(url, init);
  };
  return { calls, hermes: createHermesBackend({ baseUrl: 'http://h:8642', apiKey: 'k', fetchImpl }) };
}

function byPath(routes) {
  return (url) => {
    const path = new URL(url).pathname;
    const entry = routes[path];
    if (entry === undefined) throw new Error(`unexpected Hermes path: ${path}`);
    if (entry instanceof Response) return entry;
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('the live health fixture is the v0.23.0 liveness answer the app reads', async () => {
  const health = await fixture('health.json');
  assert.deepEqual(health, { status: 'ok', platform: 'hermes-agent', version: '0.23.0' });
});

test('a 401 keeps Hermes\' own auth code and never invents a bare HTTP status', async () => {
  const refusal = await fixture('error-401.json');
  const { hermes } = backend(() => new Response(JSON.stringify(refusal), { status: 401 }));
  await assert.rejects(
    () => hermes.listSkills(),
    (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /^hermes: Invalid gateway API key/);
      return true;
    },
  );
});

test('capabilities advertises exactly the paths this backend actually requests', async () => {
  // The app reads endpoints.* to decide what it may call. A path rename on either side is a
  // silent 404 in production, so the fixture and the real request URLs are compared here.
  const caps = await fixture('capabilities.json');
  const { calls, hermes } = backend(() => Response.json({}));

  await hermes.listSessions(2);
  await hermes.createSession({ title: 'Release notes' });
  await hermes.getSession(SESSION_ID);
  await hermes.listMessages(SESSION_ID);
  await hermes.deleteSession(SESSION_ID);
  await hermes.startRun('Summarize the build.');
  await hermes.getRunStatus(RUN_ID);
  await hermes.runEvents(RUN_ID);
  await hermes.replyApproval(RUN_ID, { approved: true });
  await hermes.steerRun(RUN_ID, 'Focus on tests.');
  await hermes.stopRun(RUN_ID);
  await hermes.listSkills();
  await hermes.listToolsets();
  await hermes.listModels();
  await hermes.healthDetailed();

  const actual = calls.map((call) => {
    const path = new URL(call.url).pathname
      .replace(SESSION_ID, '{session_id}')
      .replace(RUN_ID, '{run_id}');
    return `${call.init.method ?? 'GET'} ${path}`;
  });

  for (const key of [
    'sessions', 'session_create', 'session', 'session_delete', 'session_messages',
    'runs', 'run_status', 'run_events', 'run_approval', 'run_steer', 'run_stop',
    'skills', 'toolsets', 'model_options', 'health_detailed',
  ]) {
    const endpoint = caps.endpoints[key];
    assert.ok(endpoint, `capabilities.endpoints.${key} is missing`);
    assert.ok(
      actual.includes(`${endpoint.method} ${endpoint.path}`),
      `${key} advertises ${endpoint.method} ${endpoint.path}, but the backend never requests it`,
    );
  }

  // The comments in hermes.mjs depend on this: jobs are fronted even though Hermes says no.
  assert.equal(caps.features.jobs_admin, false);
  assert.equal(caps.features.skills_api, true);
  assert.deepEqual(caps.auth, { type: 'bearer', required: true });
});

test('the /v1/models compatibility entry still names the model capabilities advertises', async () => {
  const models = await fixture('models.json');
  const caps = await fixture('capabilities.json');
  assert.equal(models.object, 'list');
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].id, caps.model);
  assert.equal(models.data[0].object, 'model');
});

test('the session list fixture maps to every gateway session field the app reads', async () => {
  const sessions = await fixture('sessions.json');
  const { calls, hermes } = backend(byPath({ '/api/sessions': sessions }));
  const rows = await hermes.listSessions(2);

  assert.equal(calls[0].url, 'http://h:8642/api/sessions?limit=2');
  assert.deepEqual(rows[0], {
    id: 'api_1793923200_00000000',
    source: 'api_server',
    user_id: null,
    model: 'anthropic/claude-sonnet-4',
    title: 'Release notes',
    started_at: 1793923200000,
    ended_at: 1793923260500,
    end_reason: 'completed',
    message_count: 12,
    tool_call_count: 3,
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 100,
    cache_write_tokens: 20,
    reasoning_tokens: 15,
    estimated_cost_usd: 0.0123,
    actual_cost_usd: null,
    api_call_count: 5,
    parent_session_id: null,
    last_active: 1793923260500,
    preview: 'Draft reply',
    has_system_prompt: true,
    has_model_config: true,
  });
  // A sparse record still lands on the gateway shape rather than undefined holes.
  assert.deepEqual(rows[1], {
    id: 'api_1793923100_11111111',
    source: 'hermes',
    user_id: null,
    model: null,
    title: null,
    started_at: 1793923100000,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: 0,
    parent_session_id: null,
    last_active: 1793923100000,
    preview: null,
    has_system_prompt: false,
    has_model_config: false,
  });
});

test('one session is read from the wrapped session object Hermes answers', async () => {
  const session = await fixture('session.json');
  const { calls, hermes } = backend(byPath({ [`/api/sessions/${SESSION_ID}`]: session }));
  const row = await hermes.getSession(SESSION_ID);

  assert.equal(calls[0].url, `http://h:8642/api/sessions/${SESSION_ID}`);
  assert.equal(row.id, SESSION_ID);
  assert.equal(row.title, 'Release notes');
  assert.equal(row.message_count, 12);
  assert.equal(row.estimated_cost_usd, 0.0123);
  assert.equal(row.ended_at, null);
});

test('session messages map content, timestamps and tool calls into gateway messages', async () => {
  const messages = await fixture('session-messages.json');
  const { calls, hermes } = backend(byPath({ [`/api/sessions/${SESSION_ID}/messages`]: messages }));
  const rows = await hermes.listMessages(SESSION_ID);

  assert.equal(calls[0].url, `http://h:8642/api/sessions/${SESSION_ID}/messages`);
  assert.deepEqual(rows, [
    {
      id: 'msg_1',
      role: 'user',
      content: [{ type: 'text', text: 'Summarize the overnight build.' }],
      timestamp: 1793923201000,
    },
    {
      id: 'msg_2',
      role: 'assistant',
      content: [],
      timestamp: 1793923202000,
      tool_calls: [{ name: 'terminal', status: 'complete', id: 'call_1' }],
    },
    {
      id: 'msg_3',
      role: 'assistant',
      content: [{ type: 'text', text: 'The build passed.' }],
      timestamp: 1793923203000,
    },
  ]);
});

test('the provider catalog carries the facts model curation needs', async () => {
  const options = await fixture('model-options.json');
  const { calls, hermes } = backend(byPath({ '/api/model/options': options }));
  const models = await hermes.listModels();

  assert.equal(calls[0].url, 'http://h:8642/api/model/options');
  assert.deepEqual(models[0], {
    id: 'nous/vendor/model:free',
    providerId: 'nous',
    modelId: 'vendor/model:free',
    provider: 'Nous Portal',
    label: 'Nous Portal · vendor/model:free',
    available: true,
    providerSource: 'built-in',
    providerUserDefined: false,
    providerAliases: [],
    providerCurrent: true,
  });
  assert.deepEqual(models[1], {
    id: 'kilo/kilo-auto/free',
    providerId: 'kilo',
    modelId: 'kilo-auto/free',
    provider: 'KiloCode',
    label: 'KiloCode · kilo-auto/free',
    available: true,
    providerSource: 'user-config',
    providerUserDefined: true,
    providerAliases: ['custom:kilo', 'kilo'],
    providerCurrent: false,
  });
  assert.equal(models[2].available, false, 'an unauthenticated provider is not offered');
});

test('a session chat turn reads the reply, usage and the model that actually ran', async () => {
  const reply = await fixture('session-chat.json');
  const { calls, hermes } = backend(byPath({ [`/api/sessions/${SESSION_ID}/chat`]: reply }));
  const result = await hermes.sendMessage(SESSION_ID, {
    text: 'Summarize the overnight build.',
    model: { providerId: 'opencode-go', modelId: 'longcat-2.0' },
  });

  assert.equal(calls[0].url, `http://h:8642/api/sessions/${SESSION_ID}/chat`);
  assert.deepEqual(calls[0].body, {
    message: 'Summarize the overnight build.',
    model: 'longcat-2.0',
    provider: 'opencode-go',
  });
  assert.equal(result.text, 'The build passed.');
  assert.deepEqual(result.message, {
    id: 'msg_9',
    role: 'assistant',
    content: [{ type: 'text', text: 'The build passed.' }],
  });
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  assert.equal(result.runtime.model, 'deepseek-v4-flash');
  assert.equal(result.runtime.requested.model, 'longcat-2.0');
});

test('a run is started with the provider split out and its receipt is returned untouched', async () => {
  const created = await fixture('run-created.json');
  const { calls, hermes } = backend(() => new Response(JSON.stringify(created), { status: 202 }));
  const run = await hermes.startRun('Summarize the overnight build.', {
    sessionId: SESSION_ID,
    model: 'nous/vendor/model:free',
  });

  assert.equal(calls[0].url, 'http://h:8642/v1/runs');
  assert.deepEqual(calls[0].body, {
    input: 'Summarize the overnight build.',
    session_id: SESSION_ID,
    model: 'vendor/model:free',
    provider: 'nous',
  });
  assert.deepEqual(run, created);
  assert.equal(run.run_id, RUN_ID);
  assert.equal(run.status, 'started');
});

test('run status keeps the fields the Activity surface reconciles against', async () => {
  const status = await fixture('run-status.json');
  const { calls, hermes } = backend(byPath({ [`/v1/runs/${RUN_ID}`]: status }));
  const run = await hermes.getRunStatus(RUN_ID);

  assert.equal(calls[0].url, `http://h:8642/v1/runs/${RUN_ID}`);
  assert.deepEqual(run, status);
  assert.equal(run.object, 'hermes.run');
  assert.equal(run.run_id, RUN_ID);
  assert.equal(run.session_id, SESSION_ID);
  assert.equal(run.status, 'completed');
  assert.equal(run.output, 'The build passed.');
  assert.equal(run.usage.cache_read_tokens, 40);
  assert.equal(run.runtime.model, 'deepseek-v4-flash');
});

test('run controls post the request fields the Gate uses for each control', async () => {
  const stopped = await fixture('stop-response.json');
  const steered = await fixture('steer-response.json');
  const approved = await fixture('approval-response.json');
  const { calls, hermes } = backend(byPath({
    [`/v1/runs/${RUN_ID}/stop`]: stopped,
    [`/v1/runs/${RUN_ID}/steer`]: steered,
    [`/v1/runs/${RUN_ID}/approval`]: approved,
  }));

  assert.equal(await hermes.stopRun(RUN_ID), undefined);
  assert.deepEqual(calls[0].body, {});
  assert.equal(await hermes.steerRun(RUN_ID, 'Focus on tests.'), undefined);
  assert.deepEqual(calls[1].body, { input: 'Focus on tests.' });
  assert.equal(await hermes.replyApproval(RUN_ID, { approved: false, feedback: 'Looks risky.' }), undefined);
  assert.deepEqual(calls[2].body, { approved: false, feedback: 'Looks risky.' });

  // The response shape upstream documents; the Gate ignores the body, the app must not need it.
  assert.equal(approved.object, 'hermes.run.approval_response');
  assert.equal(approved.run_id, RUN_ID);
  assert.equal(approved.choice, 'once');
  assert.equal(approved.resolved, 1);
});

test('the run event stream is relayed byte-for-byte and names each lifecycle event', async () => {
  const stream = await fixture('run-events.txt');
  const { calls, hermes } = backend(() => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  const response = await hermes.runEvents(RUN_ID);

  assert.equal(calls[0].url, `http://h:8642/v1/runs/${RUN_ID}/events`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(await response.text(), stream, 'the Gate relays the stream unchanged');

  const frames = stream
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice('data: '.length)));

  assert.deepEqual(frames.map((frame) => frame.event), [
    'tool.started',
    'tool.completed',
    'message.delta',
    'message.delta',
    'run.completed',
  ]);
  assert.ok(frames.every((frame) => frame.run_id === RUN_ID));
  assert.equal(frames[0].tool, 'terminal');
  assert.equal(frames[1].error, false);
  assert.equal(frames[2].delta, 'The build ');
  assert.equal(frames[4].output, 'The build passed.');
  assert.equal(frames[4].completed, true);
  assert.equal(frames[4].usage.total_tokens, 250);
  assert.equal(frames[4].runtime.model, 'deepseek-v4-flash');
});

test('skills and toolsets pass through with the fields the discovery surfaces render', async () => {
  const skillsFixture = await fixture('skills.json');
  const toolsetsFixture = await fixture('toolsets.json');
  const { calls, hermes } = backend(byPath({
    '/v1/skills': skillsFixture,
    '/v1/toolsets': toolsetsFixture,
  }));

  const skills = await hermes.listSkills();
  const toolsets = await hermes.listToolsets();
  assert.equal(calls[0].url, 'http://h:8642/v1/skills');
  assert.equal(calls[1].url, 'http://h:8642/v1/toolsets');
  assert.deepEqual(skills, skillsFixture);
  assert.deepEqual(toolsets, toolsetsFixture);
  assert.equal(skills[0].name, 'github-pr-workflow');
  assert.equal(skills[0].category, 'git');
  assert.deepEqual(toolsets[0].tools, ['read_file', 'write_file', 'terminal']);
  assert.equal(toolsets[1].enabled, false);
});

test('jobs pass through and every cron field the Gate curates survives', async () => {
  const jobsFixture = await fixture('jobs.json');
  const created = await fixture('job-created.json');
  const { calls, hermes } = backend((url, init) => {
    assert.equal(new URL(url).pathname, '/api/jobs');
    // List and create share one path; only the verb tells them apart.
    return Response.json(init.method === 'POST' ? created : jobsFixture);
  });

  const jobs = await hermes.listJobs();
  assert.equal(calls[0].url, 'http://h:8642/api/jobs');
  assert.deepEqual(jobs, jobsFixture);

  const view = toCronJobView(jobs[0]);
  assert.equal(view.id, 'job_0001');
  assert.equal(view.title, 'Nightly review');
  assert.equal(view.botId, 'researcher');
  assert.equal(view.schedule, '0 3 * * *');
  assert.equal(view.scheduleDisplay, 'Every day at 03:00');
  assert.equal(view.nextRunAt, '2026-11-11T03:00:00+00:00');
  assert.equal(view.lastStatus, 'ok');
  assert.equal(view.failureStreak, 0);
  assert.equal(view.paused, false);
  assert.equal(view.running, true);
  assert.equal(view.prompt, 'Summarize the overnight build.');
  assert.deepEqual(view.toolsets, ['core', 'web']);
  assert.equal(view.raw, jobs[0]);

  const paused = toCronJobView(jobs[1]);
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedReason, 'paused by operator');
  assert.equal(paused.running, false);
  assert.equal(paused.lastError, 'provider authentication failed');

  const body = { name: '[bot:researcher] Morning brief', prompt: 'Write the morning brief.', schedule: '0 7 * * *' };
  const newJob = await hermes.createJob(body);
  assert.deepEqual(newJob, created);
  assert.equal(newJob.id, 'job_0003');
});

test('the detailed health answer keeps the readiness keys diagnostics read', async () => {
  const detailed = await fixture('health-detailed.json');
  const { calls, hermes } = backend(byPath({ '/health/detailed': detailed }));
  const result = await hermes.healthDetailed();

  assert.equal(calls[0].url, 'http://h:8642/health/detailed');
  assert.deepEqual(result, detailed);
  assert.equal(result.version, '0.23.0');
  assert.equal(result.gateway_state, 'running');
  assert.equal(typeof result.readiness.checks, 'object');
});
