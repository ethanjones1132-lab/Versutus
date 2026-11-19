import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import { runBackendTurn } from '../core/voice/turn-runner.mjs';
import { mirrorVoiceApprovals } from '../core/voice/voice-approvals.mjs';
import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { parseGateFrame } from '../core/voice/protocol.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';
import { createCodexBackend } from '../core/cli-environments/backends/codex.mjs';
import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';
import { createClaudeCodeBackend } from '../core/cli-environments/backends/claude-code.mjs';
import { createOpenCodePermissionBridge } from '../core/cli-environments/opencode-permissions.mjs';
import { createPermissionBridge } from '../core/cli-environments/claude-permissions.mjs';
import { ApprovalService } from '../core/cli-environments/approvals.mjs';
import { createApprovalRpc } from '../core/approvals/rpc.mjs';
import { createBackendManager } from '../core/cli-environments/backend-manager.mjs';
import { codexAdapter } from '../core/cli-environments/adapters/codex.mjs';
import { runOpenCodeVoice, VOICE_AGENT } from '../core/cli-environments/opencode-voice.mjs';
import { runVoiceTurn } from '../core/server.mjs';
import { createVoiceHandoff } from '../core/voice/handoff.mjs';

const APPROVAL = { approvalId: 'approval-1', summary: 'Run the requested command?' };

for (const decision of ['approve', 'deny', 'timeout']) {
  test(`the Hermes native streaming approval mirror ${decision === 'timeout' ? 'denies on the Gate deadline' : `answers ${decision} once`}`, async (t) => {
    const observed = [];
    const upstream = [];
    const approvals = new ApprovalService();
    const { methods } = createApprovalRpc({ approvals });
    const controller = new AbortController();
    const mirror = mirrorVoiceApprovals({
      approvals, deviceId: 'owner', onApproval: (entry) => observed.push(entry),
      signal: controller.signal, timeoutMs: decision === 'timeout' ? 100 : 3000,
    });
    t.after(() => {
      controller.abort();
      mirror.close();
    });
    let writer;
    const encoder = new TextEncoder();
    const backend = createHermesBackend({
      baseUrl: 'http://hermes.test',
      fetchImpl: async (url, init) => {
        assert.equal(init.method, 'POST');
        if (url === 'http://hermes.test/v1/runs/r1/approval') {
          upstream.push(JSON.parse(init.body));
          if (upstream.length === 1 && writer) {
            writer.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n'));
            writer.close();
          }
          return new Response(null, { status: 204 });
        }
        assert.equal(url, 'http://hermes.test/v1/chat/completions');
        assert.equal(init.headers['X-Versutus-Turn-Source'], 'voice');
        assert.equal(init.headers['X-Hermes-Session-Id'], 'thread-1');
        return new Response(new ReadableStream({
          start(stream) {
            writer = stream;
            const frame = 'event: approval.request\n'
              + 'data: {"run_id":"r1","request_id":"p1","execution_generation":2,"command":"Rename draft"}\n\n';
            // A repeated native request must not open a second card or reply.
            stream.enqueue(encoder.encode(frame + frame));
          },
          cancel() { writer = null; },
        }));
      },
    });
    // Exercise the legacy protocol seam directly. Typed streams don't install
    // this mirror, and a production Hermes voice turn uses the safe-mode CLI.
    const running = runBackendTurn(backend, 'thread-1', { text: 'rename it' }, {
      source: 'voice', onApproval: mirror.open, signal: controller.signal,
    });
    await until(() => observed.length > 0);
    const { approvalId, state, summary } = observed[0];
    assert.equal(state, 'pending');
    assert.equal(summary, 'Rename draft');
    assert.deepEqual(upstream, []);
    if (decision !== 'timeout') {
      const respond = methods[`approval.${decision}`];
      await assert.rejects(respond({ approvalId }, { deviceId: 'other' }), { code: 'approval_owner_mismatch' });
      assert.deepEqual(upstream, []);
      await respond({ approvalId }, { deviceId: 'owner' });
    }
    await until(() => upstream.length > 0);
    assert.equal((await running).hasContent, true);
    assert.deepEqual(upstream, [{
      request_id: 'p1', execution_generation: 2, choice: decision === 'approve' ? 'once' : 'deny',
    }]);
    assert.equal(approvals.get(approvalId), null);
    assert.equal(observed.at(-1).state, { approve: 'approved', deny: 'denied', timeout: 'expired' }[decision]);
    assert.equal(observed.filter((entry) => entry.state === 'pending').length, 1);
    await assert.rejects(methods['approval.approve']({ approvalId }, { deviceId: 'owner' }), { code: 'unknown_approval' });
  });
}

test('Hermes whole-turn requests mark voice without modifying the spoken text', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://hermes.test',
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers['X-Versutus-Turn-Source'], 'voice');
      assert.deepEqual(JSON.parse(init.body), { message: 'Hello' });
      return Response.json({ message: { content: 'Hi' } });
    },
  });
  assert.equal((await backend.sendMessage('s1', { text: 'Hello', source: 'voice' })).text, 'Hi');
});

test('Codex routes approval notices from its Gate bridge only to the matching voice feed', async () => {
  const listeners = new Set();
  const emit = (value) => { for (const listener of listeners) listener(value); };
  const backend = createCodexBackend({
    subscribe(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    rpc: {
      async request(method) {
        assert.equal(method, 'turn/start');
        emit({ method: 'versutus/approval', params: { threadId: 'other', ...APPROVAL } });
        emit({ method: 'versutus/approval', params: { threadId: 's1', ...APPROVAL, state: 'pending' } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 's1', delta: 'Hi' } });
        emit({ method: 'turn/completed', params: { threadId: 's1' } });
        return { turnId: 'c1' };
      },
    },
  });
  const cards = [];
  const input = { text: 'hi', model: { modelId: 'model' } };
  await runBackendTurn(backend, 's1', input, { source: 'voice', onApproval: (card) => cards.push(card) });
  await runBackendTurn(backend, 's1', input, { onApproval: (card) => cards.push(card) });
  assert.deepEqual(cards, [{ threadId: 's1', ...APPROVAL, state: 'pending' }]);
});

test('OpenCode voice uses the Gate permission ID and sends deny to the native request', async (t) => {
  const approvals = new ApprovalService();
  const permissionBridge = createOpenCodePermissionBridge({ approvals, backendId: 'open' });
  const streams = [];
  const encoder = new TextEncoder();
  const broadcast = (event) => {
    for (const writer of streams) {
      try { writer.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* closed */ }
    }
  };
  const replies = [];
  let sentSource;
  const backend = createOpenCodeBackend({
    baseUrl: 'http://open.test',
    permissionBridge,
    readTimeoutMs: 250,
    fetchImpl: async (url, init = {}) => {
      const { pathname } = new URL(url);
      if (pathname === '/event') return new Response(new ReadableStream({
        start(writer) { streams.push(writer); },
      }));
      if (pathname === '/session/s1/permission') return Response.json([]);
      if (pathname === '/session/s1/prompt_async') {
        sentSource = init.headers['X-Versutus-Turn-Source'];
        broadcast({ type: 'permission.asked', properties: { id: 'native-id', sessionID: 's1', permission: 'edit' } });
        return new Response(null, { status: 204 });
      }
      if (pathname === '/session/s1/permission/native-id/reply') {
        replies.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  const signal = new AbortController();
  t.after(() => signal.abort());
  const cards = [];
  const running = runBackendTurn(backend, 's1', { text: 'rename it' }, {
    source: 'voice', signal: signal.signal, onApproval: (card) => cards.push(card),
  });
  await until(() => cards.some((card) => card.state === 'pending'));
  assert.equal(sentSource, 'voice');
  const id = cards[0].approvalId;
  assert.notEqual(id, 'native-id');
  assert.ok(approvals.get(id));
  await createApprovalRpc({ approvals }).methods['approval.deny']({ approvalId: id }, { deviceId: 'owner' });
  assert.deepEqual(replies, [{ reply: 'reject' }]);
  await until(() => cards.some((card) => card.state === 'denied'));
  signal.abort();
  assert.equal((await running).aborted, true);
});

test('Claude Code keeps voice prompts on the turn-scoped bridge even with a permissive typed mode', async (t) => {
  const approvals = new ApprovalService();
  const bridge = await createPermissionBridge({ approvals, environmentId: 'claude' });
  t.after(() => bridge.close());
  const SESSION = '896a9c65-7554-453a-8e20-ccf419617968';
  let childAsk;
  let writes = 0;
  const voiceSessions = [];
  const backend = createClaudeCodeBackend({
    cwd: '.',
    claudeHome: '.',
    executablePath: 'claude',
    permissionMode: 'acceptEdits',
    permissionBridge: bridge,
    jobFactory: () => ({ add() {}, terminate() {} }),
    spawnImpl(_command, args) {
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
      assert.deepEqual(settings.permissions.ask, ['*']);
      assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
      assert.ok(args.includes('--restricted'));
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(args.includes('--no-session-persistence'));
      assert.ok(!args.includes('--resume'));
      const voiceId = args[args.indexOf('--session-id') + 1];
      assert.match(voiceId, /^[0-9a-f-]{36}$/i);
      assert.notEqual(voiceId, SESSION);
      voiceSessions.push(voiceId);
      const { env } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['gate-permissions'];
      assert.notEqual(env.GATE_PERMISSION_URL, bridge.url);
      assert.notEqual(env.GATE_PERMISSION_SECRET, bridge.secret);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      childAsk = fetch(env.GATE_PERMISSION_URL, {
        method: 'POST', headers: { 'x-gate-bridge': env.GATE_PERMISSION_SECRET },
        body: JSON.stringify({ tool_name: 'Edit', input: { file: 'draft.txt' } }),
      }).then(async (response) => {
        const ruling = await response.json();
        if (ruling.behavior === 'allow') writes++;
        return ruling;
      }).finally(() => {
        child.stdout.emit('data', '{"type":"result","subtype":"success","result":"Done."}\n');
        child.emit('close', 0);
      });
      return child;
    },
  });
  const cards = [];
  const running = runVoiceTurn(null, {
    deviceId: 'owner',
    thread: { sessionId: SESSION },
    backendLease: { backend: () => backend },
  }, 'rename it', { onApproval: (card) => cards.push(card) }, { approvals });
  await until(() => cards.some((card) => card.state === 'pending'));
  assert.equal(writes, 0);
  const id = cards[0].approvalId;
  await createApprovalRpc({ approvals }).methods['approval.deny']({ approvalId: id }, { deviceId: 'owner' });
  assert.equal((await childAsk).behavior, 'deny');
  assert.equal((await running).hasContent, true);
  assert.equal(writes, 0);

  const second = runVoiceTurn(null, {
    deviceId: 'owner', thread: { sessionId: SESSION }, backendLease: { backend: () => backend },
  }, 'rename it', { onApproval: (card) => cards.push(card) }, { approvals });
  await until(() => cards.filter((card) => card.state === 'pending').length === 2);
  assert.equal(writes, 0);
  await createApprovalRpc({ approvals }).methods['approval.approve']({ approvalId: cards.at(-1).approvalId }, { deviceId: 'owner' });
  assert.equal((await childAsk).behavior, 'allow');
  assert.equal((await second).hasContent, true);
  assert.equal(writes, 1);
  assert.equal(new Set(voiceSessions).size, 2);
});

test('OpenCode starts an isolated permission-configured session and parks a would-be auto-approved write', async (t) => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'vs143-opencode-'));
  t.after(() => rm(scratchDir, { recursive: true, force: true }));
  const approvals = new ApprovalService();
  const writers = new Set();
  const encoder = new TextEncoder();
  const replies = [];
  const approvalsSeen = [];
  let config;
  let writes = 0;
  let stopped = false;
  let finish;
  const idle = new Promise((resolve) => { finish = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/info') return Response.json({ version: '2.2.6' });
    if (path === '/api/config') return Response.json({ data: config });
    if (path === `/api/agent/${VOICE_AGENT}`) return Response.json({ data: { permissions: config.agents[VOICE_AGENT].permissions } });
    if (path === '/api/session') {
      assert.equal(JSON.parse(init.body).agent, VOICE_AGENT);
      return Response.json({ data: { id: 'private' } });
    }
    if (path === '/api/event') return new Response(new ReadableStream({
      start(writer) { writers.add(writer); },
      cancel() { /* the fake private server owns writers until stop */ },
    }));
    if (path === '/api/session/private/agent') return new Response(null, { status: 204 });
    if (path === '/api/session/private/prompt') {
      assert.equal(init.headers['X-Versutus-Turn-Source'], 'voice');
      const rule = config.agents[VOICE_AGENT].permissions.findLast((rule) => ['*', 'edit'].includes(rule.action));
      if (rule?.effect !== 'ask') { writes++; finish(); }
      else {
        const event = { type: 'permission.asked', data: { sessionID: 'private', id: 'edit-1', action: 'edit' } };
        for (const writer of writers) writer.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      return new Response(null, { status: 204 });
    }
    if (path === '/api/session/private/permission/edit-1/reply') {
      const { reply } = JSON.parse(init.body);
      replies.push(reply);
      if (reply === 'once') writes++;
      finish();
      return new Response(null, { status: 204 });
    }
    if (path === '/api/experimental/session/private/wait') {
      await idle;
      return new Response(null, { status: 204 });
    }
    if (path === '/api/session/private/message') {
      return Response.json({ data: [{ type: 'assistant', time: { created: Date.now() }, content: [{ type: 'text', text: 'Done.' }] }] });
    }
    return new Response(null, { status: 404 });
  };
  const backend = createOpenCodeBackend({
    baseUrl: 'http://typed-never-dispatched.test',
    runVoice: (sessionId, input, onEvent) => runOpenCodeVoice({
      sessionId, input, onEvent, record: { id: 'opencode-1' }, scratchDir, fetchImpl,
      checkManaged: async () => {},
      buildEnvironment: async () => ({ OPENCODE_CONFIG_CONTENT: '{"permissions":[{"effect":"allow"}]}' }),
      serverFactory({ allowAttach, buildEnvironment }) {
        assert.equal(allowAttach, false);
        return {
          isOwned: () => true,
          async ensureRunning() {
            const env = await buildEnvironment();
            assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
            assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
            assert.equal(env.OPENCODE_DB, ':memory:');
            assert.ok(env.XDG_DATA_HOME.startsWith(scratchDir));
            config = JSON.parse(await readFile(env.OPENCODE_CONFIG, 'utf8'));
            return { baseUrl: 'http://isolated.test', attached: false };
          },
          async stop() { stopped = true; },
        };
      },
    }),
  });
  const running = runVoiceTurn(null, {
    deviceId: 'owner', thread: {}, backendLease: { backend: () => backend },
  }, 'Write draft.txt', { onApproval: (card) => approvalsSeen.push(card) }, { approvals });
  await until(() => approvalsSeen.some((card) => card.state === 'pending'));
  assert.equal(writes, 0);
  assert.deepEqual(replies, []);
  await createApprovalRpc({ approvals }).methods['approval.approve']({ approvalId: approvalsSeen[0].approvalId }, { deviceId: 'owner' });
  assert.equal((await running).hasContent, true);
  assert.equal(writes, 1);
  assert.deepEqual(replies, ['once']);
  assert.equal(stopped, true);
});

test('Codex disables ungated tool classes and its app-server cannot apply a patch before the Gate reply', async (t) => {
  const gateHome = await mkdtemp(join(tmpdir(), 'vs167-codex-'));
  t.after(() => rm(gateHome, { recursive: true, force: true }));
  const handoff = createVoiceHandoff({ gateHome });
  const approvals = new ApprovalService();
  const record = { id: 'codex-1', adapterId: 'codex', enabled: true, workspacePolicy: { defaultRoot: '.' } };
  let writes = 0;
  let reply;
  const cards = [];
  const injections = [];
  const manager = createBackendManager({
    store: { get: async () => record }, registry: { get: () => codexAdapter }, approvals,
    createServer({ onServerRequest, onNotification }) {
      const rpc = { async request(method, params) {
        if (method === 'config/read') return { config: { mcp_servers: { permissive: { enabled: true } } } };
        if (method === 'configRequirements/read') return { requirements: null };
        if (method === 'thread/read') return { thread: { turns: [] } };
        if (method === 'thread/start') {
          assert.equal(params.ephemeral, true);
          assert.equal(params.config.features.shell_tool, false);
          assert.equal(params.config.features.apps, false);
          assert.equal(params.config.features.plugins, false);
          assert.equal(params.config.features.hooks, false);
          assert.deepEqual(params.config.mcp_servers, { permissive: { enabled: false } });
          return { thread: { id: 'voice-thread' }, approvalPolicy: 'on-request',
            approvalsReviewer: 'user', sandbox: { type: 'readOnly' } };
        }
        if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
        if (method === 'thread/unsubscribe') return {};
        if (method === 'thread/inject_items') {
          injections.push(params);
          return {};
        }
        if (method === 'turn/start') {
          assert.equal(params.threadId, 'voice-thread');
          if (params.sandboxPolicy?.type !== 'readOnly') writes++;
          else {
            reply = await onServerRequest({ method: 'item/fileChange/requestApproval',
              params: { threadId: 'voice-thread', turnId: 'voice-turn', itemId: 'patch-1' } });
            if (reply.decision === 'accept') writes++;
          }
          onNotification({ method: 'item/agentMessage/delta', params: { threadId: 'voice-thread', delta: 'Done.' } });
          onNotification({ method: 'turn/completed', params: { threadId: 'voice-thread', turn: { id: 'voice-turn' } } });
          return { turn: { id: 'voice-turn' } };
        }
        assert.fail(`Unexpected fake Codex method: ${method}`);
      } };
      return { ensureRunning: async () => ({ rpc, generation: 1 }) };
    },
  });
  const backend = await manager.get(record.id);
  const running = runVoiceTurn(null, {
    deviceId: 'owner', thread: { backendId: record.id, sessionId: 'typed-thread', model: 'fixture' },
    backendLease: { backend: () => backend },
  }, 'Write draft.txt', { onApproval: (card) => cards.push(card) }, { approvals, handoff });
  await until(() => cards.some((card) => card.state === 'pending'));
  assert.equal(reply, undefined);
  assert.equal(writes, 0);
  assert.deepEqual(injections, [], 'a voice turn waiting for approval is not an exchange');
  await createApprovalRpc({ approvals }).methods['approval.deny']({ approvalId: cards[0].approvalId }, { deviceId: 'owner' });
  assert.equal((await running).hasContent, true);
  assert.equal(writes, 0);
  assert.deepEqual(reply, { decision: 'decline' });
  const scope = { backend, environmentId: record.id, sessionId: 'typed-thread' };
  assert.equal(await handoff.sendTyped(scope, 'next', (text) => text, () => true), 'next');
  assert.deepEqual(injections, [{
    threadId: 'typed-thread',
    items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write draft.txt' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    ],
  }]);
});

test('Codex cannot retry an uncertain append; the waiting typed send receives one handoff', async (t) => {
  const gateHome = await mkdtemp(join(tmpdir(), 'vs167-codex-ack-'));
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
  await until(() => Boolean(loseAck));
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

for (const supported of [true, false]) {
  test(`OpenCode continuity ${supported ? 'uses one native synthetic append' : 'uses the handoff without synthetic support'}`, async (t) => {
    const gateHome = await mkdtemp(join(tmpdir(), 'vs167-opencode-'));
    t.after(() => rm(gateHome, { recursive: true, force: true }));
    const handoff = createVoiceHandoff({ gateHome });
    const writes = [];
    const backend = createOpenCodeBackend({
      baseUrl: 'http://typed.test',
      directory: '/work',
      password: 'fixture',
      async runVoice() { return { text: 'Voice answer.' }; },
      async fetchImpl(raw, init = {}) {
        const url = new URL(raw);
        if (url.pathname === '/api/info') return Response.json({ version: '2.2.6' });
        if (url.pathname === '/api/session/ses_original/message') return Response.json({ data: [] });
        if (url.pathname === '/openapi.json') return Response.json({
          paths: { '/api/session/{sessionID}/synthetic': { post: {
            operationId: 'session.synthetic',
            requestBody: { content: { 'application/json': {
              schema: { properties: supported ? { resume: { anyOf: [{ type: 'boolean' }, { type: 'null' }] } } : {} },
            } } },
          } } },
        });
        if ((init.method ?? 'GET') !== 'GET') {
          writes.push([url.pathname, init.method, JSON.parse(init.body)]);
          assert.equal(init.headers.Authorization, `Basic ${Buffer.from('opencode:fixture').toString('base64')}`);
          assert.equal(url.searchParams.get('location[directory]'), '/work');
          return Response.json({ data: { type: 'synthetic', id: 'msg_synthetic', sessionID: 'ses_original' } });
        }
        return new Response(null, { status: 404 });
      },
    });
    const scope = { backend, environmentId: 'opencode-local', sessionId: 'ses_original' };
    await runVoiceTurn(null, {
      thread: { backendId: scope.environmentId, sessionId: scope.sessionId },
      backendLease: { backend: () => backend },
    }, 'Voice question.', {}, { handoff });
    const input = await handoff.sendTyped(scope, 'next', (text) => text, () => true);
    if (supported) {
      assert.deepEqual(writes, [['/api/session/ses_original/synthetic', 'POST', {
        text: 'Earlier in a voice call (quoted context, not a new request):\nUser: "Voice question."\nAssistant: "Voice answer."',
        description: 'Versutus voice exchange',
        resume: false,
      }]]);
      assert.equal(input, 'next');
    } else {
      assert.deepEqual(writes, []);
      assert.match(input, /Earlier in a voice call[\s\S]+Voice question\.[\s\S]+Voice answer\.[\s\S]+next$/);
    }
  });
}

test('Hermes keeps conversation available with the read-only CLI toolset and never sends unrestricted HTTP chat', async () => {
  const requests = [];
  let cliCalls = 0;
  const backend = createHermesBackend({
    baseUrl: 'http://hermes.test', executablePath: 'hermes', botId: 'scout',
    fetchImpl: async (url, init) => {
      requests.push([init.method ?? 'GET', new URL(url).pathname]);
      return Response.json({ data: [] });
    },
    async runCliImpl(executable, args, { input }) {
      cliCalls++;
      assert.equal(executable, 'hermes');
      // Pin the entire launch: fresh session, no file/shell tools in the
      // allowlist, and safe mode disables configured hooks, plugins and MCP.
      assert.deepEqual(args, [
        '-p', 'scout', 'chat', '--safe-mode', '--quiet', '--toolsets', 'session_search',
        '--model=model', '--provider=nous', '--query-file', '-',
      ]);
      assert.match(input, /Write draft\.txt/);
      return { code: 0, stdout: 'I can discuss the change with you.' };
    },
  });
  const deltas = [];
  const result = await runVoiceTurn(null, {
    deviceId: 'owner', thread: { sessionId: 's1', model: 'nous/model' },
    backendLease: { backend: () => backend },
  }, 'Write draft.txt', { onDelta: (delta) => deltas.push(delta) }, { approvals: new ApprovalService() });
  assert.equal(result.hasContent, true);
  assert.equal(cliCalls, 1);
  assert.deepEqual(requests, [['GET', '/api/sessions/s1/messages']]);
  assert.deepEqual(deltas, ['Use typed chat for actions that aren’t available in this call. ', 'I can discuss the change with you.']);
});

test('Hermes refuses voice without falling back to HTTP when the local safe-mode CLI fails', async () => {
  let httpCalls = 0;
  const backend = createHermesBackend({
    baseUrl: 'http://hermes.test', executablePath: 'hermes',
    fetchImpl: async () => {
      httpCalls++;
      assert.fail('no HTTP request should be made for this turn');
    },
    async runCliImpl(_executable, args) {
      assert.ok(args.includes('--safe-mode'));
      return { code: 2, stdout: '' };
    },
  });
  await assert.rejects(runVoiceTurn(null, {
    deviceId: 'owner', thread: { model: 'nous/model' },
    backendLease: { backend: () => backend },
  }, 'Write draft.txt', {}, { approvals: new ApprovalService() }), {
    code: 'voice_approval_policy_unavailable',
    message: 'Hermes could not start a read-only call. Check that this PC’s Hermes supports safe mode and the Bot’s model.',
  });
  assert.equal(httpCalls, 0);
});

for (const kind of ['hermes', 'opencode', 'codex', 'claude-code']) {
  test(`${kind}: Gate refuses an unattested voice path before a permissive native turn can write`, async () => {
    // The upstream fixture represents a configured allow/always-allow rule:
    // no permission request, with a write as soon as the backend is invoked.
    // The real adapters, not kind-only stubs, must not start these turns.
    const writes = [];
    const allowWrite = () => { writes.push('draft.txt'); throw new Error('unapproved write reached'); };
    const backend = {
      hermes: () => createHermesBackend({ baseUrl: 'http://hermes.test', fetchImpl: allowWrite }),
      opencode: () => createOpenCodeBackend({ baseUrl: 'http://open.test', fetchImpl: allowWrite }),
      codex: () => createCodexBackend({
        subscribe: () => () => undefined,
        rpc: { async request(method) {
          if (method === 'turn/start') allowWrite();
          return {};
        } },
      }),
      'claude-code': () => createClaudeCodeBackend({
        cwd: '.', claudeHome: '.', executablePath: 'claude', permissionMode: 'acceptEdits',
        permissionBridge: { registerVoiceTurn: () => ({ url: 'http://no-bridge.test', close() {} }) },
        spawnImpl: allowWrite,
      }),
    }[kind]();
    assert.equal(backend.kind, kind);
    const stages = [];
    await assert.rejects(runVoiceTurn(null, {
      deviceId: 'owner',
      thread: { sessionId: '896a9c65-7554-453a-8e20-ccf419617968', model: 'fixture' },
      backendLease: { backend: () => backend },
    }, 'Write draft.txt', { onStage: (stage) => stages.push(stage.stage) }), {
      code: 'voice_approval_policy_unavailable',
      message: 'Use typed chat because this call can’t ask before every action.',
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(stages, ['resolve.start', 'resolve.ready']);
  });
}

test('Gate approval parsing remains compatible with old and additive frame shapes', () => {
  assert.deepEqual(parseGateFrame({ t: 'approval', turnId: 't1', summary: 'Run it?' }), {
    t: 'approval', turnId: 't1', summary: 'Run it?',
  });
  assert.deepEqual(parseGateFrame({
    t: 'approval', turnId: 't1', summary: 'Run it?', approvalId: 'a1', state: 'pending',
  }), {
    t: 'approval', turnId: 't1', summary: 'Run it?', approvalId: 'a1', state: 'pending',
  });
});

function approvalStream() {
  const encoder = new TextEncoder();
  const frame = `event: approval.required\ndata: ${JSON.stringify({
    type: 'approval.required',
    payload: APPROVAL,
  })}\n\ndata: [DONE]\n\n`;
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
  };
}

function fakeBackend(path) {
  const inputs = [];
  const backend = {
    inputs,
    async sendMessage(_sessionId, input) {
      inputs.push(input);
      return { text: '' };
    },
    streamEvents(_sessionId, onEvent, signal) {
      onEvent({ type: 'approval.required', payload: APPROVAL });
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  if (path === 'streaming') {
    delete backend.streamEvents;
    delete backend.sendMessage;
    backend.sendMessageStreaming = async (_sessionId, input) => {
      inputs.push(input);
      return approvalStream();
    };
  }
  return backend;
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the approval frame');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const path of ['streaming', 'feed']) {
  test(`voice approvals include their id and pending state on the ${path} backend path`, async (t) => {
    const registry = new VoiceSessionRegistry();
    registry.create({ voiceSessionId: `vs-${path}`, deviceId: 'device-1', engine: 'local' });
    const listeners = new Map();
    const engine = {
      open: async () => {},
      close: async () => {},
      pushAudio: () => {},
      on(event, listener) { listeners.set(event, listener); return this; },
      emit(event, payload) { listeners.get(event)?.(payload); },
    };
    const backend = fakeBackend(path);
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = attachVoiceMediaSocket({
      server,
      deviceTokens: { verify: async () => ({ deviceId: 'device-1' }) },
      registry,
      createEngine: () => engine,
      utteranceHoldMs: 0,
      runTurn: (session, text, handlers) => runBackendTurn(
        backend,
        session.thread?.sessionId ?? 'thread-1',
        { text },
        { ...handlers, source: 'voice' },
      ),
    });
    server.listen(0);
    await once(server, 'listening');
    const frames = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-${path}`,
      { headers: { Authorization: 'Bearer paired-device' } },
    );
    ws.on('message', (data, binary) => { if (!binary) frames.push(JSON.parse(data.toString())); });
    t.after(() => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(resolve));
    }));
    await once(ws, 'open');
    await until(() => frames.some((frame) => frame.t === 'ready'));
    engine.emit('final', { text: 'run the command' });
    await until(() => frames.some((frame) => frame.t === 'approval'));

    assert.equal(backend.inputs.length, 1);
    assert.equal(backend.inputs[0].text, 'run the command');
    assert.equal(backend.inputs[0].source, 'voice');
    assert.deepEqual(frames.find((frame) => frame.t === 'approval'), {
      t: 'approval',
      turnId: 'vs-' + path,
      approvalId: APPROVAL.approvalId,
      summary: APPROVAL.summary,
      state: 'pending',
    });
  });
}
