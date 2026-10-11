import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareToBaseline, measureOne, percentile, summarize } from '../voice-spikes/latency-harness.mjs';

/**
 * A stand-in for the `ws` client. The Gate's side of the conversation is the
 * `script`, which runs once the socket opens and emits frames on its own clock.
 */
function fakeWebSocketClass(script) {
  return class FakeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.sent = [];
      this.closed = false;
      setImmediate(() => {
        this.emit('open');
        script(this);
      });
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.closed = true;
    }
  };
}

test('a measured call records end of speech on the sample and yields a small positive delta', async () => {
  let socket = null;
  const WebSocket = fakeWebSocketClass((ws) => {
    socket = ws;
    // A binary frame before the final is not the answer: the harness must not
    // count it as the first audio.
    setTimeout(() => ws.emit('message', Buffer.from([0, 0]), true), 5);
    setTimeout(() => ws.emit('message', Buffer.from('{"t":"final"}'), false), 10);
    setTimeout(() => ws.emit('message', Buffer.from([0, 0]), true), 40);
  });

  const sample = await measureOne({
    WebSocket,
    url: 'ws://gate.test/v1/voice/stream?voiceSessionId=vs-1',
    token: 'tok',
    fixture: Buffer.alloc(640 * 2),
  });

  assert.equal(typeof sample.endOfSpeechAt, 'number');
  assert.equal(typeof sample.firstAudioAt, 'number');
  const delta = sample.firstAudioAt - sample.endOfSpeechAt;
  // The bug left endOfSpeechAt null, so the delta was an epoch timestamp.
  assert.ok(delta > 0 && delta < 1000, `expected a small positive delta, got ${delta}`);
  assert.ok(Math.abs(summarize([sample]).p50 - delta) < 1e-9);
  assert.equal(socket.closed, true);
  assert.equal(socket.options.headers.Authorization, 'Bearer tok');
});

test('percentile is exact on a known series', () => {
  const series = [10, 20, 30, 40, 50];
  assert.equal(percentile(series, 0), 10);
  assert.equal(percentile(series, 50), 30);
  assert.equal(percentile(series, 100), 50);
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 50), 0);
});

test('the latency samples turn into p50 and p95', () => {
  const samples = [
    { endOfSpeechAt: 1000, firstAudioAt: 1100 },
    { endOfSpeechAt: 2000, firstAudioAt: 2090 },
    { endOfSpeechAt: 3000, firstAudioAt: 3120 },
    { endOfSpeechAt: 4000, firstAudioAt: 4080 },
  ];
  assert.deepEqual(summarize(samples), { count: 4, p50: 95, p95: 117 });
});

test('a measurement within tolerance passes and a worse p95 regresses', () => {
  const baseline = { p50: 100, p95: 200 };
  const tolerance = 0.2;

  const ok = compareToBaseline({ p50: 110, p95: 230 }, baseline, tolerance);
  assert.equal(ok.regressed, false);

  const slowP95 = compareToBaseline({ p50: 100, p95: 241 }, baseline, tolerance);
  assert.equal(slowP95.regressed, true);

  const slowP50 = compareToBaseline({ p50: 121, p95: 200 }, baseline, tolerance);
  assert.equal(slowP50.regressed, true);
});
