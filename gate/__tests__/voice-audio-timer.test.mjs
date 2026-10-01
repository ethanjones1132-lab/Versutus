import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import { VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';
import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';

// The call's idle watchdog is the only interval the media socket arms, and it
// keeps one handle, so counting the live ones counts the audio timers. The patch
// is here because a leaked timer is invisible from outside: it closes the same
// socket the surviving one closes, and it is unref'd, so the process does not
// even notice it.
const liveIntervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (...args) => {
  const handle = realSetInterval(...args);
  liveIntervals.add(handle);
  return handle;
};
globalThis.clearInterval = (handle) => {
  liveIntervals.delete(handle);
  return realClearInterval(handle);
};
after(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
// A test that fails leaves its leaked timers armed, and they would then be
// counted against the next test. Stop them so each test starts from zero.
afterEach(() => {
  for (const handle of [...liveIntervals]) realClearInterval(handle);
  liveIntervals.clear();
});

const SESSION = { voiceSessionId: 'vs-1', deviceId: 'dev-1', engine: 'local' };

function makeEngine() {
  const listeners = new Map();
  return {
    open: async () => {},
    pushAudio() {},
    close: async () => {},
    on: (event, fn) => listeners.set(event, fn),
    emit: (event, payload) => listeners.get(event)?.(payload),
    speak() {},
    cancelSpeech() {},
    setMuted() {},
  };
}

/** The voice-socket harness: a scripted call over a real socket pair. */
async function startCall({ resumeTimeoutMs = 20_000 } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create(SESSION);
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const engine = makeEngine();
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => engine,
    runTurn: async () => ({ hasContent: true }),
    resumeTimeoutMs,
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const frames = [];
  const openSocket = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=vs-1`, {
      headers: { Authorization: 'Bearer tok-1' },
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse(data.toString()));
    });
    return ws;
  };
  const first = openSocket();
  await once(first, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  return {
    frames,
    first,
    openSocket,
    close: () =>
      new Promise((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(done));
      }),
  };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

test('an attached call owns exactly one audio timer', async () => {
  const call = await startCall();
  try {
    assert.equal(liveIntervals.size, 1);
  } finally {
    await call.close();
  }
});

// The half-open socket on Tailscale is why the resume window exists: the phone's
// replacement upgrade arrives while the old socket is still open, so the call
// re-attaches without ever seeing the stale socket's `close`. The stale socket's
// handler ignores itself (`ws !== newWs`), so nothing else can clear the interval
// it stopped owning — `end()` clears only the newest.
test('a re-attach over a socket that has not closed leaves exactly one audio timer', async () => {
  const call = await startCall();
  try {
    const second = call.openSocket();
    await once(second, 'open');
    await waitUntil(() => call.frames.filter((frame) => frame.t === 'ready').length >= 2);
    assert.equal(liveIntervals.size, 1, 'the second attach replaced the timer, it did not add one');

    // The stale socket closing afterwards must not leave a timer behind either.
    const staleClose = once(call.first, 'close');
    call.first.close();
    await staleClose;
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(liveIntervals.size, 1, 'the stale socket owns nothing, so its close clears nothing');

    // Ending the call from the surviving socket clears the one timer there is.
    call.frames.length = 0;
    second.send(JSON.stringify({ t: 'end' }));
    await waitUntil(() => call.frames.some((frame) => frame.t === 'ended'));
    await waitUntil(() => liveIntervals.size === 0);
  } finally {
    await call.close();
  }
});

test('ending the call clears its audio timer', async () => {
  const call = await startCall();
  try {
    assert.equal(liveIntervals.size, 1);
    call.first.send(JSON.stringify({ t: 'end' }));
    await waitUntil(() => call.frames.some((frame) => frame.t === 'ended'));
    await waitUntil(() => liveIntervals.size === 0);
  } finally {
    await call.close();
  }
});

test('a detached call clears its audio timer', async () => {
  const call = await startCall();
  try {
    assert.equal(liveIntervals.size, 1);
    const closed = once(call.first, 'close');
    call.first.close();
    await closed;
    // Detach holds the call for a re-connect, so the call lives on with no timer
    // watching the phone that is no longer there.
    await waitUntil(() => liveIntervals.size === 0);
  } finally {
    await call.close();
  }
});