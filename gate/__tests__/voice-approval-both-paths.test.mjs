import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { runBackendTurn } from '../core/voice/turn-runner.mjs';
import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { parseGateFrame } from '../core/voice/protocol.mjs';
import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const APPROVAL = { approvalId: 'approval-1', summary: 'Run the requested command?' };

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
