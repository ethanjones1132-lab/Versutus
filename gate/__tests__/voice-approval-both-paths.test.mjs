import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';

import { WebSocket } from 'ws';

import { runBackendTurn } from '../core/voice/turn-runner.mjs';
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
import { runVoiceTurn } from '../core/server.mjs';

const APPROVAL = { approvalId: 'approval-1', summary: 'Run the requested command?' };

for (const decision of ['approve', 'deny', 'timeout']) {
  test(`a native Hermes streaming approval is ${decision === 'timeout' ? 'denied on the Gate deadline' : `answered by ${decision} once`}`, async () => {
    const observed = [];
    const upstream = [];
    const approvals = new ApprovalService();
    const { methods } = createApprovalRpc({ approvals });
    let writer;
    const encoder = new TextEncoder();
    const backend = createHermesBackend({
      baseUrl: 'http://hermes.test',
      fetchImpl: async (url, init) => {
        if (url.endsWith('/approval')) {
          upstream.push(JSON.parse(init.body));
          setImmediate(() => {
            writer.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n'));
            writer.close();
          });
          return new Response(null, { status: 204 });
        }
        assert.equal(init.headers['X-Versutus-Turn-Source'], 'voice');
        return new Response(new ReadableStream({
          start(controller) {
            writer = controller;
            controller.enqueue(encoder.encode(
              'event: approval.request\n'
              + 'data: {"run_id":"r1","request_id":"p1","execution_generation":2,"command":"Rename draft"}\n\n',
            ));
          },
        }));
      },
    });
    const running = runVoiceTurn(null, {
      deviceId: 'owner',
      thread: { sessionId: 'thread-1' },
      backendLease: { backend: async () => backend },
    }, 'rename it', {
      onApproval: (entry) => observed.push(entry),
    }, { approvals, approvalTimeoutMs: decision === 'timeout' ? 100 : 3000 });
    await until(() => observed.length > 0);
    const { approvalId, state, summary } = observed[0];
    assert.equal(state, 'pending');
    assert.equal(summary, 'Rename draft');
    assert.deepEqual(upstream, []);
    if (decision !== 'timeout') {
      const respond = methods[`approval.${decision}`];
      await assert.rejects(respond({ approvalId }, { deviceId: 'other' }), { code: 'approval_owner_mismatch' });
      await respond({ approvalId }, { deviceId: 'owner' });
    }
    await until(() => upstream.length > 0);
    assert.equal((await running).hasContent, true);
    assert.deepEqual(upstream, [{
      request_id: 'p1', execution_generation: 2, choice: decision === 'approve' ? 'once' : 'deny',
    }]);
    assert.equal(approvals.get(approvalId), null);
    assert.equal(observed.at(-1).state, { approve: 'approved', deny: 'denied', timeout: 'expired' }[decision]);
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
  const backend = createClaudeCodeBackend({
    cwd: '.',
    claudeHome: '.',
    executablePath: 'claude',
    permissionMode: 'acceptEdits',
    permissionBridge: bridge,
    jobFactory: () => ({ add() {}, terminate() {} }),
    spawnImpl(_command, args) {
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
      const { env } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['gate-permissions'];
      assert.notEqual(env.GATE_PERMISSION_URL, bridge.url);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      childAsk = fetch(env.GATE_PERMISSION_URL, {
        method: 'POST', headers: { 'x-gate-bridge': env.GATE_PERMISSION_SECRET },
        body: JSON.stringify({ tool_name: 'Edit', input: { file: 'draft.txt' } }),
      }).then((response) => response.json()).finally(() => {
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
  const id = cards[0].approvalId;
  await createApprovalRpc({ approvals }).methods['approval.deny']({ approvalId: id }, { deviceId: 'owner' });
  assert.equal((await childAsk).behavior, 'deny');
  assert.equal((await running).hasContent, true);
});

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
