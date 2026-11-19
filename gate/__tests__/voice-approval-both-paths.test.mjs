import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBackendTurn } from '../core/voice/turn-runner.mjs';
import { runVoiceTurn } from '../core/server.mjs';
import { parseGateFrame } from '../core/voice/protocol.mjs';
import { createVoiceHandoff } from '../core/voice/handoff.mjs';
import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';
import { createCodexBackend } from '../core/cli-environments/backends/codex.mjs';
import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';
import { createClaudeCodeBackend, transcriptDirFor } from '../core/cli-environments/backends/claude-code.mjs';
import { createOpenCodePermissionBridge } from '../core/cli-environments/opencode-permissions.mjs';
import { createPermissionBridge } from '../core/cli-environments/claude-permissions.mjs';
import { ApprovalService } from '../core/cli-environments/approvals.mjs';
import { createApprovalRpc } from '../core/approvals/rpc.mjs';
import { createDecisionLedger } from '../core/approvals/decision-ledger.mjs';
import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';
import { codexAdapter } from '../core/cli-environments/adapters/codex.mjs';

const noContent = () => new Response(null, { status: 204 });
const encoder = new TextEncoder();
const sse = (payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const reply = (writer, text) => {
  writer.enqueue(sse({ choices: [{ delta: { content: text } }] }));
  writer.enqueue(encoder.encode('data: [DONE]\n\n'));
  writer.close();
};
const owner = { deviceId: 'owner' };
const result = { approve: 'approved', deny: 'denied', expire: 'expired' };
const voice = (backend, thread, text, handlers, options) => runVoiceTurn(null, {
  thread, deviceId: owner.deviceId, backendLease: { backend: () => backend },
}, text, handlers, options);

async function waitFor(check) {
  const before = Date.now() + 3000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > before) throw new Error('Timed out waiting for the backend fixture');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-native-'));
  const ledger = createDecisionLedger({ dir: join(dir, 'approvals') });
  const approvals = new ApprovalService({ ledger });
  t.after(async () => {
    approvals.close();
    await rm(dir, { recursive: true, force: true });
  });
  const rpc = createApprovalRpc({ approvals }).methods;
  return {
    dir, approvals, rpc,
    async verify(approvalId, backend, expected) {
      const rows = (await readFile(ledger.path, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(rows.filter((row) => row.approvalId === approvalId).map((row) => ({
        source: row.source, decision: row.decision, backend: row.backend,
      })), [{ source: 'voice', decision: expected, backend }]);
    },
  };
}

for (const decision of ['approve', 'deny', 'expire']) {
  test(`Hermes scoped native streaming approval: ${decision}, once, on the same typed session`, async (t) => {
    const { approvals, rpc, verify } = await fixture(t);
    const turns = [];
    const answers = [];
    const cards = [];
    const emitted = [];
    let writer;
    let writes = 0;
    const backend = createHermesBackend({
      baseUrl: 'http://hermes.test/p/scout', botId: 'scout',
      executablePath: 'hermes', runCliImpl() { assert.fail('not a second Hermes runtime'); },
      async fetchImpl(url, init) {
        const body = JSON.parse(init.body);
        if (url === 'http://hermes.test/p/scout/v1/runs/r1/approval') {
          answers.push(body);
          if (body.choice === 'once') writes++;
          reply(writer, 'Here is my answer.');
          return noContent();
        }
        assert.equal(url, 'http://hermes.test/p/scout/v1/chat/completions');
        const source = init.headers['X-Versutus-Turn-Source'];
        turns.push({ source, session: init.headers['X-Hermes-Session-Id'], body });
        return new Response(new ReadableStream({
          start(stream) {
            if (!source) { reply(stream, 'Typed answer.'); return; }
            writer = stream;
            const frame = sse({ event: 'approval.request', run_id: 'r1', request_id: 'p1',
              execution_generation: 2, command: 'Create the disposable marker' });
            stream.enqueue(frame);
            stream.enqueue(frame); // one native question, even on replay
          },
        }));
      },
    });
    const thread = { backendId: 'hermes-local', botId: 'scout', sessionId: 'existing', model: 'nous/test-model' };
    await runBackendTurn(backend, thread.sessionId, { text: 'Write draft.txt', model: { providerId: 'nous', modelId: 'test-model' } });
    const running = voice(backend, thread, 'Write draft.txt', {
      onDelta: (delta) => emitted.push(delta), onApproval: (card) => cards.push(card),
    }, { approvals, approvalTimeoutMs: decision === 'expire' ? 100 : 5000 });
    const pending = await waitFor(() => cards.find((card) => card.state === 'pending'));
    assert.deepEqual(emitted, [], 'there is no Gate notice posing as an answer');
    assert.equal(writes, 0);
    assert.deepEqual(answers, []);
    if (decision !== 'expire') {
      await assert.rejects(rpc[`approval.${decision}`]({ approvalId: pending.approvalId }, { deviceId: 'foreign' }),
        { code: 'approval_owner_mismatch' });
      await rpc[`approval.${decision}`]({ approvalId: pending.approvalId }, owner);
    }
    await waitFor(() => answers.length);
    assert.equal((await running).hasContent, true);
    assert.equal(writes, Number(decision === 'approve'));
    assert.deepEqual(emitted, ['Here is my answer.']);
    assert.deepEqual(answers, [{ request_id: 'p1', execution_generation: 2, choice: decision === 'approve' ? 'once' : 'deny' }]);
    assert.deepEqual(cards.map((card) => card.state), ['pending', result[decision]]);
    assert.deepEqual(turns, [undefined, 'voice'].map((source) => ({
      source, session: 'existing',
      body: { model: 'test-model', provider: 'nous', messages: [{ role: 'user', content: 'Write draft.txt' }], stream: true },
    })));
    await verify(pending.approvalId, thread.backendId, result[decision]);
  });
}

test('Hermes uses the native route without an executable or approval capability', async () => {
  const thread = { sessionId: 's1' };
  const backend = createHermesBackend({ baseUrl: 'http://remote.test', fetchImpl: async (url, init) => {
    assert.equal(url, 'http://remote.test/v1/chat/completions');
    assert.equal(init.headers['X-Versutus-Turn-Source'], 'voice');
    return new Response(new ReadableStream({ start: (stream) => reply(stream, 'Hello from the gateway.') }));
  } });
  assert.equal((await voice(backend, thread, 'Hello')).hasContent, true);
});

test('Hermes whole-turn fallback marks voice on the same native session', async () => {
  const backend = createHermesBackend({ baseUrl: 'http://hermes.test', fetchImpl: async (url, init) => {
    assert.equal(url, 'http://hermes.test/api/sessions/s1/chat');
    assert.equal(init.headers['X-Versutus-Turn-Source'], 'voice');
    assert.deepEqual(JSON.parse(init.body), { message: 'Hello' });
    return Response.json({ message: { content: 'Hi' } });
  } });
  assert.equal((await backend.sendMessage('s1', { text: 'Hello', source: 'voice' })).text, 'Hi');
});

test('OpenCode V2 uses the Bot and its model on the normal server, where native edits still ask', async (t) => {
  const { approvals, rpc, verify } = await fixture(t);
  const permissionBridge = createOpenCodePermissionBridge({ approvals, backendId: 'open' });
  const streams = new Set();
  const broadcast = (event) => { for (const writer of streams) writer.enqueue(sse(event)); };
  const requests = [];
  const cards = [];
  let finish;
  const approved = new Promise((resolve) => { finish = resolve; });
  let answerAt;
  let writes = 0;
  const backend = await createOpenCodeBackend({
    baseUrl: 'http://normal.test', permissionBridge,
    async fetchImpl(url, init = {}) {
      const { origin, pathname } = new URL(url);
      assert.equal(origin, 'http://normal.test');
      if (pathname === '/api/info') return Response.json({ version: '2.2.6' });
      if (pathname === '/api/agent') return Response.json({ data: [{
        id: 'reviewer', mode: 'primary', hidden: false, request: {}, permissions: [{ action: 'edit', resource: '*', effect: 'ask' }],
        model: { providerID: 'opencode', id: 'free-model' },
      }] });
      if (pathname === '/api/model') return Response.json({ data: [{
        id: 'free-model', providerID: 'opencode', status: 'active', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      }] });
      if (pathname === '/api/event') {
        let owned;
        return new Response(new ReadableStream({
          start(writer) { owned = writer; streams.add(writer); },
          cancel() { streams.delete(owned); },
        }));
      }
      if (pathname === '/api/session/ses_original/permission') return Response.json({ data: [] });
      if (init.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}');
        const source = init.headers?.['X-Versutus-Turn-Source'];
        if (pathname.endsWith('/agent') || pathname.endsWith('/model') || pathname.endsWith('/prompt')) {
          requests.push({ pathname, body, source });
          if (pathname.endsWith('/prompt')) {
            answerAt = Date.now();
            if (source === 'voice') broadcast({ type: 'permission.asked', data: { sessionID: 'ses_original', id: 'edit-1', action: 'edit' } });
          }
          return noContent();
        }
        if (pathname === '/api/session/ses_original/permission/edit-1/reply') {
          assert.equal(body.reply, 'once');
          writes++;
          finish();
          return noContent();
        }
        if (pathname === '/api/experimental/session/ses_original/wait') {
          if (requests.at(-1).source) await approved;
          return noContent();
        }
        assert.fail(`Unexpected OpenCode mutation: ${pathname}`);
      }
      if (pathname === '/api/session/ses_original/message') return Response.json({ data: [{
        id: 'reply', type: 'assistant', time: { created: answerAt + 1 }, content: [{ type: 'text', text: 'Done.' }],
      }] });
      return new Response(null, { status: 404 });
    },
  }).forBot('reviewer');
  const model = { providerId: 'opencode', modelId: 'free-model' };
  await runBackendTurn(backend, 'ses_original', { text: 'Edit draft.txt', model });
  const running = voice(backend, { sessionId: 'ses_original', botId: 'reviewer', backendId: 'open', model: 'opencode/free-model' },
    'Edit draft.txt', { onApproval: (card) => cards.push(card) }, { approvals });
  const pending = await waitFor(() => cards.find((card) => card.state === 'pending'));
  assert.notEqual(pending.approvalId, 'edit-1');
  assert.equal(writes, 0);
  await rpc['approval.approve']({ approvalId: pending.approvalId }, owner);
  assert.equal((await running).hasContent, true);
  assert.equal(writes, 1);
  assert.deepEqual(requests.slice(3).map(({ pathname, body }) => ({ pathname, body })),
    requests.slice(0, 3).map(({ pathname, body }) => ({ pathname, body })));
  assert.deepEqual(requests[1].body, { model: { providerID: 'opencode', id: 'free-model' } });
  assert.equal(requests.at(-1).source, 'voice');
  await verify(pending.approvalId, 'open', 'approved');
});

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
  test(`Codex uses the original thread and configured tool policy for ${method}`, async (t) => {
    const { approvals, rpc, verify } = await fixture(t);
    const record = { id: 'codex-local', adapterId: 'codex', enabled: true, workspacePolicy: { defaultRoot: '.' } };
    let nativeDecision;
    const starts = [];
    const manager = createBackendManager({
      store: { get: async () => record }, registry: { get: () => codexAdapter }, approvals,
      createServer({ onServerRequest, onNotification }) {
        return { ensureRunning: async () => ({ rpc: { async request(name, params) {
          assert.equal(name, 'turn/start', 'no ephemeral thread or config override');
          const turnId = `c${starts.push(params)}`;
          if (starts.length === 2) nativeDecision = await onServerRequest({ method, params: {
            threadId: params.threadId, turnId, itemId: 'tool', availableDecisions: ['accept', 'decline'],
          } });
          onNotification({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, delta: 'Done.' } });
          onNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
          return { turn: { id: turnId } };
        } }, generation: 1 }) };
      },
    });
    const backend = await manager.get(record.id);
    const cards = [];
    await runBackendTurn(backend, 'original', { text: 'Change draft.txt', model: { modelId: 'agent-model' } });
    const running = voice(backend, { sessionId: 'original', backendId: record.id, model: 'agent-model' },
      'Change draft.txt', { onApproval: (card) => cards.push(card) }, { approvals });
    const pending = await waitFor(() => cards.find((card) => card.state === 'pending'));
    assert.equal(nativeDecision, undefined);
    await rpc['approval.deny']({ approvalId: pending.approvalId }, owner);
    assert.equal((await running).hasContent, true);
    assert.deepEqual(nativeDecision, { decision: 'decline' });
    assert.deepEqual(starts, Array(2).fill({
      threadId: 'original', cwd: '.', model: 'agent-model', input: [{ type: 'text', text: 'Change draft.txt' }],
    }));
    await verify(pending.approvalId, record.id, 'denied');
  });
}

test('Claude Code resumes the same transcript for typed, voice and typed turns, with a scoped voice approval', { timeout: 10_000 }, async (t) => {
  const { approvals, rpc, verify, dir } = await fixture(t);
  const bridge = await createPermissionBridge({ approvals, environmentId: 'claude-local' });
  t.after(() => bridge.close());
  const sessionId = '896a9c65-7554-453a-8e20-ccf419617968';
  const cwd = join(dir, 'workspace');
  const transcripts = transcriptDirFor(dir, cwd);
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(transcripts, `${sessionId}.jsonl`), '{}\n');
  await mkdir(join(dir, 'agents'));
  await writeFile(join(dir, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review drafts\n---\nReview drafts.\n');
  const launches = [];
  let toolDecision;
  const backend = await createClaudeCodeBackend({
    cwd, claudeHome: dir, executablePath: 'claude', permissionMode: 'acceptEdits', permissionBridge: bridge,
    jobFactory: () => ({ add() {}, terminate() {} }),
    spawnImpl(_command, args) {
      launches.push(args);
      const { env } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['gate-permissions'];
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      const turn = launches.length;
      void Promise.resolve().then(async () => {
        if (turn === 2) {
          const response = await fetch(env.GATE_PERMISSION_URL, {
            method: 'POST', headers: { 'x-gate-bridge': env.GATE_PERMISSION_SECRET },
            body: JSON.stringify({ tool_name: 'Bash', input: { command: 'write disposable marker' } }),
          });
          toolDecision = await response.json();
        }
        child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' }));
        child.emit('close', 0);
      }).catch((error) => child.emit('error', error));
      return child;
    },
  }).forBot('claude-code:reviewer');
  const cards = [];
  const thread = { sessionId, backendId: 'claude-local', botId: 'claude-code:reviewer', model: 'sonnet' };
  await runBackendTurn(backend, sessionId, { text: 'Update draft', model: { modelId: 'sonnet' } });
  const running = voice(backend, thread, 'Update draft', { onApproval: (card) => cards.push(card) }, { approvals });
  const pending = await waitFor(() => cards.find((card) => card.state === 'pending'));
  assert.equal(toolDecision, undefined);
  await rpc['approval.approve']({ approvalId: pending.approvalId }, owner);
  assert.equal((await running).hasContent, true);
  assert.equal(toolDecision.behavior, 'allow');
  await runBackendTurn(backend, sessionId, { text: 'Update draft', model: { modelId: 'sonnet' } });
  assert.equal(launches.length, 3, 'each turn starts a child, not a different conversation');
  for (const args of launches) {
    assert.equal(args[args.indexOf('--resume') + 1], sessionId);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.equal(args[args.indexOf('--agent') + 1], 'reviewer');
    assert.ok(!args.some((arg) => ['--session-id', '--restricted', '--tools', '--no-session-persistence'].includes(arg)));
    assert.equal(args.at(-1), 'Update draft');
  }
  const [first, scoped, next] = launches.map((args) =>
    JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['gate-permissions'].env);
  assert.deepEqual(first, next, 'ordinary turns still use the shared typed bridge');
  assert.notEqual(scoped.GATE_PERMISSION_SECRET, first.GATE_PERMISSION_SECRET);
  const stale = await fetch(scoped.GATE_PERMISSION_URL, {
    method: 'POST', headers: { 'x-gate-bridge': scoped.GATE_PERMISSION_SECRET },
    body: JSON.stringify({ tool_name: 'Bash' }),
  });
  assert.equal(stale.status, 403, 'the voice scope closes with its child');
  await stale.body?.cancel();
  await verify(pending.approvalId, 'claude-local', 'approved');
});

test('legacy and Gate-owned approval frames read without changing the wire', () => {
  const old = { t: 'approval', turnId: 't1', summary: 'Run it?' };
  const current = { ...old, approvalId: 'a1', state: 'pending', gateDecision: true };
  assert.deepEqual(parseGateFrame(old), old);
  assert.deepEqual(parseGateFrame(current), current);
});

test('Codex fallback handoff does not retry an uncertain append or repeat context', async (t) => {
  const gateHome = await mkdtemp(join(tmpdir(), 'voice-old-codex-'));
  t.after(() => rm(gateHome, { recursive: true, force: true }));
  const log = [];
  const handoff = createVoiceHandoff({ gateHome, log: (line) => log.push(line) });
  let loseAck;
  const calls = [];
  const backend = createCodexBackend({
    rpc: { request(method, params) {
      calls.push([method, params]);
      return new Promise((_resolve, reject) => { loseAck = () => reject(new Error('echo: call canary')); });
    } },
  });
  const scope = { backend, environmentId: 'codex-local', sessionId: 'original' };
  const append = handoff.commit(scope, { user: 'call canary', assistant: 'noted' });
  const texts = [];
  const send = (text) => { texts.push(text); return true; };
  const typed = handoff.sendTyped({ ...scope, botId: 'codex' }, 'typed one', send, Boolean);
  await waitFor(() => loseAck);
  assert.deepEqual(texts, [], 'typed send must not race an unacknowledged append');
  loseAck();
  await Promise.all([append, typed]);
  await handoff.sendTyped(scope, 'typed two', send, Boolean);
  assert.deepEqual(calls.map(([method, params]) => [method, params.threadId]), [['thread/inject_items', 'original']]);
  assert.deepEqual(log, ['voice.handoff append_failed']);
  assert.match(texts[0], /Earlier in a voice call[\s\S]+User: "call canary"[\s\S]+Assistant: "noted"[\s\S]+typed one$/);
  assert.equal(texts[0].match(/call canary/g).length, 1);
  assert.equal(texts[1], 'typed two');
});

test('a Codex thread not loaded by this app-server resumes its original ID without tool overrides', async () => {
  const calls = [];
  const listeners = new Set();
  function notify(method, params) {
    for (const listener of listeners) listener({ method, params });
  }
  const backend = createCodexBackend({
    cwd: '.',
    subscribe(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    rpc: { async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/resume') return { thread: { id: 'original' } };
      assert.equal(method, 'turn/start');
      if (calls.length === 1) throw Object.assign(new Error('thread not found: original'), { rpcCode: -32600 });
      notify('item/agentMessage/delta', { threadId: 'original', turnId: 't1', delta: 'Native reply.' });
      notify('turn/completed', { threadId: 'original', turn: { id: 't1', status: 'completed' } });
      return { turn: { id: 't1' } };
    } },
  });
  const text = [];
  const turn = await voice(backend, { sessionId: 'original', model: 'fixture' }, 'Hello', { onDelta: (delta) => text.push(delta) });
  assert.equal(turn.hasContent, true);
  assert.deepEqual(text, ['Native reply.']);
  assert.deepEqual(calls.map(([method]) => method), ['turn/start', 'thread/resume', 'turn/start']);
  assert.deepEqual(calls[1][1], { threadId: 'original', excludeTurns: true });
  assert.deepEqual(calls[0][1], calls[2][1]);
});

for (const supported of [true, false]) {
  test(`an explicit OpenCode fallback ${supported ? 'appends once' : 'leaves one typed continuation'}`, async (t) => {
    const gateHome = await mkdtemp(join(tmpdir(), 'voice-old-open-'));
    t.after(() => rm(gateHome, { recursive: true, force: true }));
    const handoff = createVoiceHandoff({ gateHome });
    const writes = [];
    const backend = createOpenCodeBackend({
      baseUrl: 'http://normal.test',
      async fetchImpl(raw, init = {}) {
        const { pathname } = new URL(raw);
        if (pathname === '/api/info') return Response.json({ version: '2.2.6' });
        if (pathname === '/openapi.json') return Response.json({
          paths: { '/api/session/{sessionID}/synthetic': { post: {
            operationId: 'session.synthetic',
            requestBody: { content: { 'application/json': {
              schema: { properties: supported ? { resume: { anyOf: [{ type: 'boolean' }, { type: 'null' }] } } : {} },
            } } },
          } } },
        });
        if (init.method === 'POST') {
          writes.push([pathname, JSON.parse(init.body)]);
          return Response.json({ data: { type: 'synthetic', id: 'msg_synthetic', sessionID: 'ses_original' } });
        }
        return new Response(null, { status: 404 });
      },
    });
    const scope = { backend, environmentId: 'opencode-local', sessionId: 'ses_original' };
    // The exchange could not be written natively. No normal voice turn goes
    // through this helper; this covers the legacy/fallback behavior only.
    await handoff.commit(scope, { user: 'Voice question.', assistant: 'Voice answer.' });
    const input = await handoff.sendTyped(scope, 'next', (text) => text, () => true);
    if (supported) {
      assert.deepEqual(writes, [['/api/session/ses_original/synthetic', {
        text: 'Earlier in a voice call (quoted context, not a new request):\nUser: "Voice question."\nAssistant: "Voice answer."',
        description: 'Versutus voice exchange', resume: false,
      }]]);
      assert.equal(input, 'next');
    } else {
      assert.deepEqual(writes, []);
      assert.match(input, /Earlier in a voice call[\s\S]+Voice question\.[\s\S]+Voice answer\.[\s\S]+next$/);
    }
  });
}
