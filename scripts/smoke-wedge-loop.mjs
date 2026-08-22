import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../gate/core/server.mjs';
import { validEnvironment } from '../gate/__tests__/fixtures/cli-environment.mjs';
import { fakeHermesPromptExecutable } from '../gate/__tests__/fixtures/cli-protocols/fake-hermes-prompt.mjs';

/**
 * Live proof of the commercial wedge (docs/commercial/concierge-pilot-packet-v1.md §1):
 * phone → Gate → Hermes CLI environment → task → streamed reply — driven over
 * real HTTP + SSE against a spawned Gate, exactly the requests the app makes.
 *
 * Steps proved, each one an acceptance question:
 *   1. register    — environments.create accepts a Hermes CLI environment
 *   2. run + reply — a prompt run streams "pong" as run.output and completes
 *   3. discover    — the recent-runs list shows the finished run (state, exit)
 *   4. replay      — the event log replays from sequence 1 for a reattaching
 *                    phone (dropped connection recovery)
 *   5. stop        — Cancel kills a mid-flight run: exactly one run.cancelled,
 *                    and discovery reports it
 *
 * Hermetic by default: no real Hermes install needed — the executable is a
 * fake that speaks the adapter's verified argv (`--version`, `--acp`,
 * `-z <prompt>`), including a stalling mode so Cancel has a real window.
 * Set WEDGE_EXECUTABLE to prove steps 1–4 against a real CLI instead (e.g.
 * the Gate machine's hermes.exe before a demo); step 5's mid-flight stall is
 * a property of the fake, so with a real CLI the cancel path stays covered
 * by the hermetic run rather than being asserted against a chat that answers
 * on its own schedule.
 * Run with: npm run smoke:wedge
 */

function pass(step, detail) {
  console.log(`  ok    ${step}${detail ? ` — ${detail}` : ''}`);
}

function fail(step, message) {
  throw new Error(`wedge step "${step}" failed: ${message}`);
}

async function sseEvents(port, token, environmentId, runId, onEvent) {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/environments/${encodeURIComponent(environmentId)}/runs/${encodeURIComponent(runId)}/events`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status !== 200) fail('events', `status ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      events.push(event);
      onEvent?.(event);
    }
  }
  return events;
}

function assertMonotonicFromOne(step, events) {
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      fail(step, `sequence ${event.sequence} at position ${index} (expected ${index + 1})`);
    }
  });
}

async function authenticatedJson(response, step) {
  if (response.status !== 200) {
    const body = await response.text();
    fail(step, `status ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

const kindModulePath = new URL('../gate/core/capabilities/provider/kind.mjs', import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'smoke-wedge-'));
await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
await mkdir(join(root, 'registry'), { recursive: true });
const gateHome = join(root, 'home');
const workspace = await mkdtemp(join(tmpdir(), 'smoke-wedge-ws-'));
const gate = await createGate({ root, gateHome, port: 0 });

try {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
  const base = `http://127.0.0.1:${gate.port}`;

  // ── Step 1: register the Hermes CLI environment ──────────────────────────
  const realExecutable = process.env.WEDGE_EXECUTABLE;
  const executable = realExecutable ?? (await fakeHermesPromptExecutable('0.20.1'));
  const created = await fetch(`${base}/v1/capabilities/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method: 'environments.create',
      params: validEnvironment({
        id: 'hermes-local',
        adapterId: 'hermes',
        executable: { path: executable },
        workspacePolicy: {
          roots: [workspace],
          defaultRoot: workspace,
          defaultSandbox: 'read_only',
          allowAdditionalRoots: false,
        },
      }),
    }),
  });
  await authenticatedJson(created, 'register');
  pass('register', 'environments.create accepted hermes-local');

  // ── Step 2: one bounded task, streamed reply ──────────────────────────────
  const started = await fetch(`${base}/v1/environments/hermes-local/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'Reply with exactly: pong' } }),
  });
  const { runId } = await authenticatedJson(started, 'run');
  if (!runId) fail('run', 'no runId returned');

  let stdoutText = '';
  const events = await sseEvents(gate.port, gate.token, 'hermes-local', runId, (event) => {
    if (event.type === 'run.output' && event.payload?.stream === 'stdout') {
      stdoutText += event.payload.text;
    }
  });
  assertMonotonicFromOne('run + reply', events);
  if (events[0]?.type !== 'run.started') fail('run + reply', `first event was ${events[0]?.type}`);
  if (realExecutable) {
    // A real agent answers in its own words; the proof is that a reply streamed at all.
    if (!stdoutText.trim()) fail('run + reply', 'no stdout ever streamed from the real CLI');
  } else if (!stdoutText.includes('pong')) {
    fail('run + reply', `reply never contained "pong": ${JSON.stringify(stdoutText)}`);
  }
  const terminal = events.at(-1);
  if (terminal?.type !== 'run.completed') fail('run + reply', `terminal event was ${terminal?.type}`);
  if (terminal.payload?.exitCode !== 0) fail('run + reply', `exitCode was ${terminal.payload?.exitCode}`);
  pass('run + reply', `"${stdoutText.trim()}" streamed through run.completed exit 0`);

  // ── Step 3: discover the run from the recent-runs list ────────────────────
  const listed = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-local/runs`, { headers: { Authorization: `Bearer ${gate.token}` } }),
    'discover',
  );
  const entry = listed.runs?.find((run) => run.runId === runId);
  if (!entry) fail('discover', 'finished run missing from the list');
  if (entry.state !== 'completed' || entry.exitCode !== 0) {
    fail('discover', `state ${entry.state}, exitCode ${entry.exitCode}`);
  }
  pass('discover', `listed newest-first as ${entry.state} · exit ${entry.exitCode}`);

  // ── Step 4: replay the whole event log (reattach path) ────────────────────
  const replay = await sseEvents(gate.port, gate.token, 'hermes-local', runId);
  if (replay.length !== events.length) fail('replay', `${replay.length} events vs ${events.length} live`);
  if (replay.some((event, index) => event.type !== events[index].type)) {
    fail('replay', 'event types differ from the live stream');
  }
  if (replay[0]?.sequence !== 1) fail('replay', `replay did not start at sequence 1 (${replay[0]?.sequence})`);
  pass('replay', `${replay.length} events replays identically from sequence 1`);

  // ── Step 5: the explicit stop — cancel a mid-flight run ───────────────────
  if (realExecutable) {
    console.log('  skip  stop — real-CLI mode: cancel is proven by the hermetic run (WEDGE_EXECUTABLE set)');
  } else {
  const slowStart = await fetch(`${base}/v1/environments/hermes-local/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'SLOW_REPLY take your time' } }),
  });
  const { runId: slowRunId } = await authenticatedJson(slowStart, 'stop');

  let sawOutput = false;
  const slowPromise = sseEvents(gate.port, gate.token, 'hermes-local', slowRunId, (event) => {
    if (event.type === 'run.output') sawOutput = true;
  });
  for (let waited = 0; waited < 5000 && !sawOutput; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!sawOutput) fail('stop', 'slow run produced no output within 5s');

  const liveList = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-local/runs`, { headers: { Authorization: `Bearer ${gate.token}` } }),
    'stop',
  );
  const liveEntry = liveList.runs?.find((run) => run.runId === slowRunId);
  if (liveEntry?.state !== 'running') fail('stop', `mid-flight state was ${liveEntry?.state}`);

  const cancelled = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-local/runs/${encodeURIComponent(slowRunId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gate.token}` },
    }),
    'stop',
  );
  if (cancelled.cancelled !== true) fail('stop', `cancel returned ${JSON.stringify(cancelled)}`);

  const slowEvents = await slowPromise;
  const slowTerminal = slowEvents.at(-1);
  if (slowTerminal?.type !== 'run.cancelled') fail('stop', `terminal event was ${slowTerminal?.type}`);
  const cancelledAgain = slowEvents.filter((event) => event.type === 'run.cancelled');
  if (cancelledAgain.length !== 1) fail('stop', `${cancelledAgain.length} run.cancelled events`);

  const afterList = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-local/runs`, { headers: { Authorization: `Bearer ${gate.token}` } }),
    'stop',
  );
  const afterEntry = afterList.runs?.find((run) => run.runId === slowRunId);
  if (afterEntry?.state !== 'cancelled') fail('stop', `discovery state after cancel was ${afterEntry?.state}`);
  pass('stop', 'cancel killed the mid-flight run; exactly one run.cancelled, discovered as cancelled');
  }

  const proven = realExecutable ? '4/4 wedge steps proven over HTTP+SSE against a real CLI (cancel covered hermetically)' : '5/5 wedge steps proven over HTTP+SSE';
  console.log(`\nsmoke-wedge-loop: PASS (${proven})`);
} finally {
  await gate.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}
