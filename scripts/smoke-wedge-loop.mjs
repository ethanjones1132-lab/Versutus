import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createGate } from '../gate/core/server.mjs';
import { CredentialVault } from '../gate/core/credentials/vault.mjs';
import { validEnvironment } from '../gate/__tests__/fixtures/cli-environment.mjs';
import { fakeHermesPromptExecutable } from '../gate/__tests__/fixtures/cli-protocols/fake-hermes-prompt.mjs';

const execFileAsync = promisify(execFile);

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
 *                    discovery reports it, and the run's OS process is
 *                    verified dead afterwards
 *   6. fail        — a dying task fails honestly: partial stdout stays reply
 *                    text, the error lands in stderr diagnostics, run.failed
 *                    carries the exit code, and discovery + replay agree
 *                    (always hermetic — a real CLI cannot fail on cue)
 *   7. deny        — a denied consent card is a hard stop: the run ends
 *                    run.cancelled "approval denied" before anything spawns,
 *                    and discovery + replay agree (always hermetic — denial
 *                    precedes any CLI involvement)
 *   8. credentials — a bound vault reference resolves into the spawned CLI's
 *                    real process environment (the fake echoes it back), a
 *                    reference with no value raises a run.note naming
 *                    variable + reference while the run still starts, and the
 *                    stored value never appears in any Gate-emitted event
 *                    (always hermetic — a real CLI cannot echo its env on cue)
 *   9. workspace  — a registered environment whose workspace root is not on
 *                    disk is refused at run start over HTTP: status 400,
 *                    code workspace_missing, message naming the path and the
 *                    fix, no run recorded, nothing spawned (always hermetic)
 *  10. restart    — the Gate process is killed and a new one started on the
 *                    same gate home: the finished run is still listed with its
 *                    outcome, its event log still replays from sequence 1,
 *                    and the refused start of leg 9 is still recorded nowhere
 *                    (always hermetic)
 *
 * Every workspace-writing run raises an approval card on its event stream;
 * the legs that need the CLI to actually run answer it like the phone does
 * (POST /runs/:id/approve).
 *
 * Hermetic by default: no real Hermes install needed — the executable is a
 * fake that speaks the adapter's verified argv (`--version`, `--acp`,
 * `-z <prompt>`), including a stalling mode so Cancel has a real window.
 * Set WEDGE_EXECUTABLE to prove all five steps against a real CLI instead
 * (e.g. the Gate machine's hermes.exe before a demo): the recent-runs list
 * exposes the spawned process's pid while a run is mid-flight, so the cancel
 * leg polls until the real process is live, cancels it, and asserts that
 * pid — plus every process observed beneath it — is gone. A fast answer
 * races the cancel, so the leg retries; if it never lands mid-flight the
 * smoke fails rather than passing on an unproven stop.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until `pid` is gone. EPERM means the process exists but cannot be
 * signalled, which counts as alive; anything other than EPERM/ESRCH is a
 * probe error worth surfacing, not a silent pass.
 */
async function assertEventuallyDead(step, pid, label) {
  for (let waited = 0; waited < 3000; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== 'EPERM') return;
    }
    await sleep(100);
  }
  fail(step, `${label} ${pid} still alive 3s after cancel`);
}

/**
 * One snapshot of the process table, walked to every pid descending from
 * `rootPid`. On Windows this is how the real-CLI cancel leg proves the whole
 * tree died, not just the launcher — the exact bug class terminate()'s
 * taskkill /T fix addressed. Elsewhere (or without PowerShell) returns []
 * and the root-pid proof stands alone.
 */
async function processDescendants(rootPid) {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { timeout: 15_000 },
  );
  const rows = JSON.parse(stdout);
  const childrenOf = new Map();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const parent = Number(row.ParentProcessId);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(Number(row.ProcessId));
  }
  const found = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

async function safeDescendants(rootPid) {
  try {
    return await processDescendants(rootPid);
  } catch {
    return [];
  }
}

async function authenticatedJson(response, step) {
  if (response.status !== 200) {
    const body = await response.text();
    fail(step, `status ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

/**
 * Answer an approval card the way the phone does — POST the decision to the
 * approve route. The promise is parked in `posts` so the caller can await
 * the round-trip after the stream drains; a non-200 fails the step.
 */
function answerApproval(step, base, headers, environmentId, runId, approvalId, decision, posts) {
  posts.push(
    fetch(
      `${base}/v1/environments/${encodeURIComponent(environmentId)}/runs/${encodeURIComponent(runId)}/approve`,
      { method: 'POST', headers, body: JSON.stringify({ approvalId, decision }) },
    ).then(async (response) => {
      if (response.status !== 200) {
        const body = await response.text();
        fail(step, `approve (${decision}) status ${response.status}: ${body.slice(0, 200)}`);
      }
    }),
  );
}

const kindModulePath = new URL('../gate/core/capabilities/provider/kind.mjs', import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'smoke-wedge-'));
await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
await mkdir(join(root, 'registry'), { recursive: true });
const gateHome = join(root, 'home');
const workspace = await mkdtemp(join(tmpdir(), 'smoke-wedge-ws-'));
let gate = await createGate({ root, gateHome, port: 0 });

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
  const approvalPosts = [];
  const events = await sseEvents(gate.port, gate.token, 'hermes-local', runId, (event) => {
    if (event.type === 'approval.required') {
      // A workspace-writing task asks first; the smoke answers like the phone.
      answerApproval('run + reply', base, headers, 'hermes-local', runId, event.payload.approvalId, 'approve', approvalPosts);
    }
    if (event.type === 'run.output' && event.payload?.stream === 'stdout') {
      stdoutText += event.payload.text;
    }
  });
  await Promise.all(approvalPosts);
  assertMonotonicFromOne('run + reply', events);
  if (events[0]?.type !== 'run.started') fail('run + reply', `first event was ${events[0]?.type}`);
  if (!events.some((event) => event.type === 'approval.required')) {
    fail('run + reply', 'no approval card was raised for a workspace-writing run');
  }
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
    /**
     * The fake's SLOW_REPLY stall gave the hermetic run its cancel window; a
     * real CLI answers on its own schedule. Since terminate() kills the whole
     * process tree, cancelling against the real CLI no longer risks an
     * orphan, so the stop is now proven live too: poll the recent-runs list
     * until the run is mid-flight with an exposed pid, snapshot its process
     * subtree, cancel, then re-scan for anything the root spawned in the
     * meantime and assert every watched pid is gone. A fast answer races the
     * cancel — retry up to three times, and fail loudly if none lands.
     */
    let landed = null;
    let watched = new Set();
    let landedStream = null;
    let landedPosts = [];
    for (let attempt = 1; attempt <= 3 && !landed; attempt += 1) {
      const started = await fetch(`${base}/v1/environments/hermes-local/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation: 'prompt', input: { prompt: 'Reply with exactly: pong' } }),
      });
      const { runId: attemptRunId } = await authenticatedJson(started, 'stop');

      // The consent card rides the same stream; answer it so the CLI spawns.
      const attemptPosts = [];
      const attemptStream = sseEvents(gate.port, gate.token, 'hermes-local', attemptRunId, (event) => {
        if (event.type === 'approval.required') {
          answerApproval('stop', base, headers, 'hermes-local', attemptRunId, event.payload.approvalId, 'approve', attemptPosts);
        }
      });

      let midflight = null;
      for (let waited = 0; waited < 10_000; waited += 50) {
        const list = await authenticatedJson(
          await fetch(`${base}/v1/environments/hermes-local/runs`, { headers: { Authorization: `Bearer ${gate.token}` } }),
          'stop',
        );
        const entry = list.runs?.find((run) => run.runId === attemptRunId);
        if (!entry || ['completed', 'failed', 'cancelled'].includes(entry.state)) break;
        if (entry.state === 'running' && typeof entry.pid === 'number') {
          midflight = entry;
          break;
        }
        await sleep(50);
      }
      if (!midflight) {
        // The answer beat the poll; drain the stream (and the approve POST)
        // to free the single-run slot, then try again.
        await attemptStream;
        await Promise.all(attemptPosts);
        continue;
      }

      watched = new Set(await safeDescendants(midflight.pid));
      const cancelled = await authenticatedJson(
        await fetch(`${base}/v1/environments/hermes-local/runs/${encodeURIComponent(attemptRunId)}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${gate.token}` },
        }),
        'stop',
      );
      if (cancelled.cancelled === true) {
        landed = { runId: attemptRunId, pid: midflight.pid };
        landedStream = attemptStream;
        landedPosts = attemptPosts;
      } else {
        await attemptStream;
        await Promise.all(attemptPosts);
      }
    }
    if (!landed) fail('stop', 'cancel never landed mid-flight in 3 attempts against the real CLI');

    // Windows does not reparent orphans: anything the killed root spawned in
    // the meantime still lists the dead pid as its parent, so this second
    // scan catches processes the pre-cancel snapshot missed.
    for (const pid of await safeDescendants(landed.pid)) watched.add(pid);

    const slowEvents = await landedStream;
    await Promise.all(landedPosts);
    const slowTerminal = slowEvents.at(-1);
    if (slowTerminal?.type !== 'run.cancelled') fail('stop', `terminal event was ${slowTerminal?.type}`);
    const cancelledOnce = slowEvents.filter((event) => event.type === 'run.cancelled');
    if (cancelledOnce.length !== 1) fail('stop', `${cancelledOnce.length} run.cancelled events`);

    const afterList = await authenticatedJson(
      await fetch(`${base}/v1/environments/hermes-local/runs`, { headers: { Authorization: `Bearer ${gate.token}` } }),
      'stop',
    );
    const afterEntry = afterList.runs?.find((run) => run.runId === landed.runId);
    if (afterEntry?.state !== 'cancelled') fail('stop', `discovery state after cancel was ${afterEntry?.state}`);

    await assertEventuallyDead('stop', landed.pid, 'run process');
    for (const pid of watched) await assertEventuallyDead('stop', pid, 'descendant process');
    pass('stop', `cancel landed mid-flight; run pid ${landed.pid} + ${watched.size} watched descendant(s) verified gone`);
  } else {
  const slowStart = await fetch(`${base}/v1/environments/hermes-local/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'SLOW_REPLY take your time' } }),
  });
  const { runId: slowRunId } = await authenticatedJson(slowStart, 'stop');

  let sawOutput = false;
  const approvalPosts = [];
  const slowPromise = sseEvents(gate.port, gate.token, 'hermes-local', slowRunId, (event) => {
    if (event.type === 'run.output') sawOutput = true;
    if (event.type === 'approval.required') {
      answerApproval('stop', base, headers, 'hermes-local', slowRunId, event.payload.approvalId, 'approve', approvalPosts);
    }
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
  if (typeof liveEntry.pid !== 'number') fail('stop', 'mid-flight entry exposes no pid');

  const cancelled = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-local/runs/${encodeURIComponent(slowRunId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gate.token}` },
    }),
    'stop',
  );
  if (cancelled.cancelled !== true) fail('stop', `cancel returned ${JSON.stringify(cancelled)}`);

  const slowEvents = await slowPromise;
  await Promise.all(approvalPosts);
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
  await assertEventuallyDead('stop', liveEntry.pid, 'run process');
  pass('stop', 'cancel killed the mid-flight run; exactly one run.cancelled, discovered as cancelled, process verified dead');
  }

  // ── Step 6: a dying task fails honestly ───────────────────────────────────
  /**
   * The demo killer is not a clean pong — it is a task that dies while the
   * sheet shrugs. This leg always runs against a fresh deterministic fake
   * (a real CLI cannot be made to fail on cue): the partial stdout fragment
   * still streams as reply text, the error lands in stderr diagnostics,
   * run.failed carries exit code 3, discovery lists the failure, and a
   * reattaching phone replays the same truthful log.
   */
  const failExecutable = await fakeHermesPromptExecutable('0.20.1');
  const failCreated = await fetch(`${base}/v1/capabilities/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method: 'environments.create',
      params: validEnvironment({
        id: 'hermes-fail',
        adapterId: 'hermes',
        executable: { path: failExecutable },
        workspacePolicy: {
          roots: [workspace],
          defaultRoot: workspace,
          defaultSandbox: 'read_only',
          allowAdditionalRoots: false,
        },
      }),
    }),
  });
  await authenticatedJson(failCreated, 'fail');

  const failStarted = await fetch(`${base}/v1/environments/hermes-fail/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'FAIL_REPLY break on purpose' } }),
  });
  const { runId: failRunId } = await authenticatedJson(failStarted, 'fail');
  if (!failRunId) fail('fail', 'no runId returned');

  let failStdout = '';
  let failStderr = '';
  const failApprovalPosts = [];
  const failEvents = await sseEvents(gate.port, gate.token, 'hermes-fail', failRunId, (event) => {
    if (event.type === 'approval.required') {
      answerApproval('fail', base, headers, 'hermes-fail', failRunId, event.payload.approvalId, 'approve', failApprovalPosts);
    }
    if (event.type === 'run.output' && event.payload?.stream === 'stderr') {
      failStderr += event.payload.text;
    } else if (event.type === 'run.output' && event.payload?.stream === 'stdout') {
      failStdout += event.payload.text;
    }
  });
  await Promise.all(failApprovalPosts);
  assertMonotonicFromOne('fail', failEvents);
  if (failEvents[0]?.type !== 'run.started') fail('fail', `first event was ${failEvents[0]?.type}`);
  if (!failStdout.includes('par')) fail('fail', `partial stdout missing: ${JSON.stringify(failStdout)}`);
  if (!failStderr.includes('model unreachable')) fail('fail', `stderr diagnostics missing: ${JSON.stringify(failStderr)}`);
  const failTerminal = failEvents.at(-1);
  if (failTerminal?.type !== 'run.failed') fail('fail', `terminal event was ${failTerminal?.type}`);
  if (failTerminal.payload?.exitCode !== 3) fail('fail', `exitCode was ${failTerminal.payload?.exitCode}`);

  // Discovery reports the failure with its exit code…
  const failList = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-fail/runs`, { headers }),
    'fail',
  );
  const failEntry = failList.runs?.find((run) => run.runId === failRunId);
  if (!failEntry) fail('fail', 'failed run missing from the list');
  if (failEntry.state !== 'failed' || failEntry.exitCode !== 3) {
    fail('fail', `state ${failEntry.state}, exitCode ${failEntry.exitCode}`);
  }

  // …and a reattaching phone replays the same truthful log.
  const failReplay = await sseEvents(gate.port, gate.token, 'hermes-fail', failRunId);
  if (failReplay.length !== failEvents.length) fail('fail', `${failReplay.length} replayed vs ${failEvents.length} live`);
  if (failReplay.at(-1)?.type !== 'run.failed') fail('fail', `replay ended in ${failReplay.at(-1)?.type}`);
  pass(
    'fail',
    `run.failed exit 3 — stdout kept as reply (${JSON.stringify(failStdout)}), stderr as diagnostics; discovery + replay agree`,
  );

  // ── Step 7: a denied consent never lets the task start ────────────────────
  /**
   * The other half of the safety story: Deny must be a hard stop. The card is
   * answered from the run's own event stream — nothing spawns, the terminal
   * state is run.cancelled "approval denied", the runs list reports it, and a
   * reattaching phone replays the same refusal. Always hermetic: the denial
   * happens before any CLI involvement, real or fake.
   */
  const deniedExecutable = await fakeHermesPromptExecutable('0.20.1');
  const deniedCreated = await fetch(`${base}/v1/capabilities/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method: 'environments.create',
      params: validEnvironment({
        id: 'hermes-denied',
        adapterId: 'hermes',
        executable: { path: deniedExecutable },
        workspacePolicy: {
          roots: [workspace],
          defaultRoot: workspace,
          defaultSandbox: 'read_only',
          allowAdditionalRoots: false,
        },
      }),
    }),
  });
  await authenticatedJson(deniedCreated, 'deny');

  const deniedStarted = await fetch(`${base}/v1/environments/hermes-denied/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'DENY me before I start' } }),
  });
  const { runId: deniedRunId } = await authenticatedJson(deniedStarted, 'deny');
  if (!deniedRunId) fail('deny', 'no runId returned');

  const deniedPosts = [];
  const deniedEvents = await sseEvents(gate.port, gate.token, 'hermes-denied', deniedRunId, (event) => {
    if (event.type === 'approval.required') {
      answerApproval('deny', base, headers, 'hermes-denied', deniedRunId, event.payload.approvalId, 'deny', deniedPosts);
    }
  });
  await Promise.all(deniedPosts);
  assertMonotonicFromOne('deny', deniedEvents);
  const deniedCards = deniedEvents.filter((event) => event.type === 'approval.required');
  if (deniedCards.length !== 1) fail('deny', `${deniedCards.length} approval cards`);
  const deniedTerminal = deniedEvents.at(-1);
  if (deniedTerminal?.type !== 'run.cancelled') fail('deny', `terminal event was ${deniedTerminal?.type}`);
  if (deniedTerminal.payload?.reason !== 'approval denied') {
    fail('deny', `terminal reason was ${JSON.stringify(deniedTerminal.payload?.reason)}`);
  }

  const deniedList = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-denied/runs`, { headers }),
    'deny',
  );
  const deniedEntry = deniedList.runs?.find((run) => run.runId === deniedRunId);
  if (deniedEntry?.state !== 'cancelled') fail('deny', `discovery state after denial was ${deniedEntry?.state}`);

  const deniedReplay = await sseEvents(gate.port, gate.token, 'hermes-denied', deniedRunId);
  if (deniedReplay.length !== deniedEvents.length) fail('deny', `${deniedReplay.length} replayed vs ${deniedEvents.length} live`);
  if (deniedReplay.at(-1)?.type !== 'run.cancelled') fail('deny', `replay ended in ${deniedReplay.at(-1)?.type}`);
  pass('deny', 'Deny stopped the run before anything spawned — run.cancelled "approval denied", discovery + replay agree');

  // ── Step 8: bound credentials reach the CLI; a dead binding warns ─────────
  /**
   * The setup path binds an env-var name to a credential-vault reference on
   * the environment record. This leg proves both halves of that promise at
   * run time, always hermetically (a real CLI cannot echo its environment on
   * cue): a reference WITH a value resolves into the spawned CLI's actual
   * process environment (the fake echoes WEDGE_BOUND_VAR as its reply), a
   * reference with NO value raises a run.note naming variable + reference
   * while the run still starts, and the stored value never appears in any
   * Gate-emitted event — only in the CLI's own echoed output.
   */
  const wedgeMarker = 'wedge-bound-secret-2718';
  await new CredentialVault({ gateHome }).set('provider/wedge/api-key', wedgeMarker);
  const boundExecutable = await fakeHermesPromptExecutable('0.20.1');
  const boundCreated = await fetch(`${base}/v1/capabilities/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method: 'environments.create',
      params: validEnvironment({
        id: 'hermes-bound',
        adapterId: 'hermes',
        executable: { path: boundExecutable },
        workspacePolicy: {
          roots: [workspace],
          defaultRoot: workspace,
          defaultSandbox: 'read_only',
          allowAdditionalRoots: false,
        },
        credentialBindings: {
          WEDGE_BOUND_VAR: 'provider/wedge/api-key',
          WEDGE_DEAD_VAR: 'provider/missing/api-key',
        },
      }),
    }),
  });
  await authenticatedJson(boundCreated, 'credentials');

  const boundStarted = await fetch(`${base}/v1/environments/hermes-bound/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'Reply with exactly: pong ECHO_BOUND' } }),
  });
  const { runId: boundRunId } = await authenticatedJson(boundStarted, 'credentials');
  if (!boundRunId) fail('credentials', 'no runId returned');

  let boundStdout = '';
  const boundPosts = [];
  const boundEvents = await sseEvents(gate.port, gate.token, 'hermes-bound', boundRunId, (event) => {
    if (event.type === 'approval.required') {
      answerApproval('credentials', base, headers, 'hermes-bound', boundRunId, event.payload.approvalId, 'approve', boundPosts);
    }
    if (event.type === 'run.output' && event.payload?.stream === 'stdout') {
      boundStdout += event.payload.text;
    }
  });
  await Promise.all(boundPosts);
  assertMonotonicFromOne('credentials', boundEvents);

  // The dead binding warns by name; the healthy one stays silent.
  const notes = boundEvents.filter((event) => event.type === 'run.note');
  if (notes.length !== 1) fail('credentials', `${notes.length} run.note events (expected exactly 1)`);
  if (notes[0].payload?.variable !== 'WEDGE_DEAD_VAR') fail('credentials', `note named ${notes[0].payload?.variable}`);
  if (notes[0].payload?.reference !== 'provider/missing/api-key') {
    fail('credentials', `note referenced ${notes[0].payload?.reference}`);
  }
  if (JSON.stringify(notes[0]).includes(wedgeMarker)) fail('credentials', 'the note carried a secret value');
  if (boundEvents.some((event) => event.type === 'run.note' && event.payload?.variable === 'WEDGE_BOUND_VAR')) {
    fail('credentials', 'the resolved binding was reported as unresolved');
  }

  // The stored value reached the CLI's real process environment…
  if (!boundStdout.includes(`bound=${wedgeMarker}`)) {
    fail('credentials', `CLI never saw the bound value; stdout was ${JSON.stringify(boundStdout)}`);
  }
  // …and outside the CLI's own echoed output, no event carries it.
  for (const event of boundEvents) {
    if (event.type === 'run.output') continue;
    if (JSON.stringify(event).includes(wedgeMarker)) fail('credentials', `secret leaked into ${event.type}`);
  }

  const boundTerminal = boundEvents.at(-1);
  if (boundTerminal?.type !== 'run.completed') fail('credentials', `terminal event was ${boundTerminal?.type}`);
  if (boundTerminal.payload?.exitCode !== 0) fail('credentials', `exitCode was ${boundTerminal.payload?.exitCode}`);

  // Discovery + replay agree, like every other leg.
  const boundList = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-bound/runs`, { headers }),
    'credentials',
  );
  const boundEntry = boundList.runs?.find((run) => run.runId === boundRunId);
  if (boundEntry?.state !== 'completed') fail('credentials', `discovery state was ${boundEntry?.state}`);
  const boundReplay = await sseEvents(gate.port, gate.token, 'hermes-bound', boundRunId);
  if (boundReplay.length !== boundEvents.length) fail('credentials', `${boundReplay.length} replayed vs ${boundEvents.length} live`);
  pass(
    'credentials',
    `bound value reached the CLI (${JSON.stringify(boundStdout.trim())}); dead binding warned as ${notes[0].payload.variable}=${notes[0].payload.reference}; discovery + replay agree`,
  );

  // ── Step 9: a missing workspace root is refused by name ───────────────────
  /**
   * The register form's one free-typed path is the workspace root, and a typo
   * there used to survive registration, doctor, and the executable probe —
   * then kill the first task as a bare "spawn ENOENT" on the phone. Now the
   * run start refuses over HTTP with the path and the fix, and nothing is
   * recorded. Always hermetic: the refusal precedes any CLI involvement.
   */
  const badWorkspace = join(root, 'never-created-workspace');
  const badCreated = await fetch(`${base}/v1/capabilities/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method: 'environments.create',
      params: validEnvironment({
        id: 'hermes-badws',
        adapterId: 'hermes',
        executable: { path: executable },
        workspacePolicy: {
          roots: [badWorkspace],
          defaultRoot: badWorkspace,
          defaultSandbox: 'read_only',
          allowAdditionalRoots: false,
        },
      }),
    }),
  });
  await authenticatedJson(badCreated, 'workspace');

  const badStarted = await fetch(`${base}/v1/environments/hermes-badws/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'prompt', input: { prompt: 'Reply with exactly: pong' } }),
  });
  if (badStarted.status !== 400) {
    fail('workspace', `expected a 400 refusal, got ${badStarted.status}`);
  }
  const badBody = await badStarted.json();
  if (badBody.error?.code !== 'workspace_missing') {
    fail('workspace', `error code was ${badBody.error?.code}`);
  }
  if (!badBody.error.message.includes(badWorkspace)) {
    fail('workspace', `refusal did not name the path: ${badBody.error.message}`);
  }
  if (!/create the folder|workspace root/.test(badBody.error.message)) {
    fail('workspace', `refusal carries no fix: ${badBody.error.message}`);
  }

  const badList = await authenticatedJson(
    await fetch(`${base}/v1/environments/hermes-badws/runs`, { headers }),
    'workspace',
  );
  if ((badList.runs ?? []).length !== 0) fail('workspace', 'a run was recorded for a refused start');
  pass('workspace', `start refused (400 workspace_missing) naming ${badWorkspace}; nothing spawned or recorded`);

  // ── Step 10: history survives a Gate restart ──────────────────────────────
  /**
   * Run history used to live only in the process: closing the console (or a
   * crash) emptied Recent runs and broke replay, so the buyer's acceptance
   * evidence died with the Gate. Every event is now archived under
   * <gateHome>/runs and reloaded before a new process listens. This leg kills
   * THIS gate, starts a fresh one on the same gate home, and demands the same
   * answers over HTTP+SSE the phone would get after a restart: discovery
   * still lists the completed run with its outcome, replay still returns the
   * full event history from sequence 1, and leg 9's refused start is still
   * recorded nowhere.
   */
  await gate.close();
  gate = await createGate({ root, gateHome, port: 0 });
  const restartedAuth = { Authorization: `Bearer ${gate.token}` };
  const restartedBase = `http://127.0.0.1:${gate.port}`;

  const afterRestart = await authenticatedJson(
    await fetch(`${restartedBase}/v1/environments/hermes-local/runs`, { headers: restartedAuth }),
    'restart',
  );
  const survivor = afterRestart.runs?.find((run) => run.runId === runId);
  if (!survivor) fail('restart', 'the finished run vanished from discovery after a restart');
  if (survivor.state !== 'completed' || survivor.exitCode !== 0) {
    fail('restart', `archived state ${survivor.state}, exitCode ${survivor.exitCode}`);
  }
  if (survivor.pid !== null) fail('restart', 'an archived run advertised a pid');

  const replayAfterRestart = await sseEvents(gate.port, gate.token, 'hermes-local', runId);
  if (replayAfterRestart.length !== events.length) {
    fail('restart', `${replayAfterRestart.length} events after restart vs ${events.length} live`);
  }
  if (replayAfterRestart.some((event, index) => event.type !== events[index].type)) {
    fail('restart', 'event types differ from the original live stream');
  }
  if (replayAfterRestart[0]?.sequence !== 1) {
    fail('restart', `replay did not start at sequence 1 (${replayAfterRestart[0]?.sequence})`);
  }

  const badListAfterRestart = await authenticatedJson(
    await fetch(`${restartedBase}/v1/environments/hermes-badws/runs`, { headers: restartedAuth }),
    'restart',
  );
  if ((badListAfterRestart.runs ?? []).length !== 0) {
    fail('restart', 'the refused start of leg 9 appeared in history after a restart');
  }
  pass('restart', `after killing the Gate: ${survivor.state} · exit ${survivor.exitCode} still listed, ${replayAfterRestart.length} events still replay from sequence 1, refusal still unrecorded`);

  const proven = realExecutable
    ? '5/5 wedge steps against the WEDGE_EXECUTABLE CLI + honest-failure + denied-consent + credential-binding + workspace-refusal + restart-persistence legs (deterministic fixtures)'
    : '10/10 wedge steps proven over HTTP+SSE (hermetic)';
  console.log(`\nsmoke-wedge-loop: PASS (${proven})`);
} finally {
  await gate.close().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}
