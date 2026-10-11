import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import {
  compareToBaseline,
  main,
  mergeBaselineDocument,
  measureOne,
  parseArgs,
  percentile,
  summarize,
} from '../voice-spikes/latency-harness.mjs';

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

test('--runs must be a positive integer, so a missing, zero, fractional or non-numeric value is a usage error', () => {
  for (const argv of [['--runs'], ['--runs', '0'], ['--runs', '2.5'], ['--runs', 'many'], ['--runs', '']]) {
    assert.throws(() => parseArgs(argv), /--runs must be a positive integer/, `argv ${JSON.stringify(argv)}`);
  }
  assert.equal(parseArgs(['--runs', '5']).runs, 5);
  assert.equal(parseArgs([]).runs, 1);
});

test('--tolerance must be a finite number of zero or more, or --check could never fail', () => {
  for (const argv of [['--tolerance'], ['--tolerance', 'loose'], ['--tolerance', '-0.1'], ['--tolerance', 'Infinity']]) {
    assert.throws(() => parseArgs(argv), /--tolerance must be a finite number >= 0/, `argv ${JSON.stringify(argv)}`);
  }
  assert.equal(parseArgs(['--tolerance', '0']).tolerance, 0);
  assert.equal(parseArgs([]).tolerance, 0.25);
});

test('a bad --runs or --tolerance stops main before any call is made', async () => {
  const base = ['--url', 'ws://127.0.0.1:9/v1/voice/stream', '--token', 'tok', '--fixture', 'unused.pcm', '--check'];
  await assert.rejects(main([...base, '--runs']), /--runs must be a positive integer/);
  await assert.rejects(main([...base, '--tolerance', 'abc']), /--tolerance must be a finite number/);
});

const NOW = '2026-10-11T09:00:00.000Z';

test('a new measurement replaces only its own engine, and keeps the other engines and the status', () => {
  const existing = {
    source: 'measured on the device',
    status: 'MEASURED-ON-DEVICE',
    tolerance: 0.25,
    engines: { local: { p50: 900, p95: 1300 }, cloud: { p50: 300, p95: 500 } },
  };
  const snapshot = structuredClone(existing);

  const merged = mergeBaselineDocument(existing, 'local', { p50: 800, p95: 1100 }, 0.3, NOW);

  assert.deepEqual(merged, {
    source: `measured by latency-harness.mjs on ${NOW}`,
    status: 'MEASURED-ON-DEVICE',
    tolerance: 0.3,
    engines: { local: { p50: 800, p95: 1100 }, cloud: { p50: 300, p95: 500 } },
  });
  assert.deepEqual(existing, snapshot, 'the stored document is not modified in place');
});

test('with no stored document, the first measurement starts a PENDING-DEVICE baseline', () => {
  assert.deepEqual(mergeBaselineDocument(null, 'local', { p50: 800, p95: 1100 }, 0.25, NOW), {
    source: `measured by latency-harness.mjs on ${NOW}`,
    status: 'PENDING-DEVICE',
    tolerance: 0.25,
    engines: { local: { p50: 800, p95: 1100 } },
  });
});

/** A fixture file in a scratch directory, removed afterwards. */
async function withScratch(run) {
  const dir = await mkdtemp(join(tmpdir(), 'latency-harness-'));
  try {
    const fixture = join(dir, 'fixture.pcm');
    await writeFile(fixture, Buffer.alloc(640));
    return await run({ fixture, baseline: join(dir, 'latency-baseline.json') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A stand-in Gate: answers the first binary frame with a `final`, then audio. */
async function withFakeGate(run) {
  const gate = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(gate, 'listening');
  gate.on('connection', (socket) => {
    let answered = false;
    socket.on('message', (_data, isBinary) => {
      if (!isBinary || answered) return;
      answered = true;
      socket.send(JSON.stringify({ t: 'final' }));
      socket.send(Buffer.alloc(320), { binary: true });
    });
  });
  try {
    return await run(`ws://127.0.0.1:${gate.address().port}/v1/voice/stream?voiceSessionId=vs-1`);
  } finally {
    for (const client of gate.clients) client.terminate();
    await new Promise((done) => gate.close(done));
  }
}

test('--save keeps the other engines and the stored status of an existing baseline', async (t) => {
  t.mock.method(console, 'log', () => {});
  await withScratch(({ fixture, baseline }) =>
    withFakeGate(async (url) => {
      await writeFile(
        baseline,
        JSON.stringify({
          source: 'device run',
          status: 'MEASURED-ON-DEVICE',
          tolerance: 0.25,
          engines: { cloud: { p50: 300, p95: 500 }, local: { p50: 900, p95: 1300 } },
        }),
      );
      await main(['--url', url, '--token', 'tok', '--fixture', fixture, '--engine', 'local', '--baseline', baseline, '--save']);

      const saved = JSON.parse(await readFile(baseline, 'utf8'));
      assert.equal(saved.status, 'MEASURED-ON-DEVICE');
      assert.deepEqual(saved.engines.cloud, { p50: 300, p95: 500 });
      assert.equal(typeof saved.engines.local.p50, 'number');
      assert.equal(typeof saved.engines.local.p95, 'number');
      assert.match(saved.source, /^measured by latency-harness\.mjs on /);
    }),
  );
});

test('--save into a missing baseline file writes a PENDING-DEVICE document for this engine', async (t) => {
  t.mock.method(console, 'log', () => {});
  await withScratch(({ fixture, baseline }) =>
    withFakeGate(async (url) => {
      await main(['--url', url, '--token', 'tok', '--fixture', fixture, '--engine', 'local', '--baseline', baseline, '--save']);

      const saved = JSON.parse(await readFile(baseline, 'utf8'));
      assert.equal(saved.status, 'PENDING-DEVICE');
      assert.equal(saved.tolerance, 0.25);
      assert.deepEqual(Object.keys(saved.engines), ['local']);
    }),
  );
});

test('--save refuses a baseline that does not parse, and leaves the file as it was', async () => {
  await withScratch(async ({ fixture, baseline }) => {
    const original = '{"engines": {"cloud": ';
    await writeFile(baseline, original);

    await assert.rejects(
      main(['--url', 'ws://127.0.0.1:9/v1/voice/stream', '--token', 'tok', '--fixture', fixture, '--baseline', baseline, '--save']),
      /refusing to overwrite .* it does not parse/,
    );
    assert.equal(await readFile(baseline, 'utf8'), original);
  });
});
