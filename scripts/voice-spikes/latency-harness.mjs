/**
 * M6 latency harness — end of speech → first audio over the Gate media socket.
 *
 * This is a spike, not product code. `main()` opens `/v1/voice/stream` as a
 * phone would, pushes fixture PCM in 20 ms frames, and times the `final` frame
 * (the Gate's end of speech) to the first binary audio frame. The pure helpers
 * are unit-tested; nothing here is imported by the app or the Gate.
 *
 * Usage:
 *   node scripts/voice-spikes/latency-harness.mjs \
 *     --url ws://127.0.0.1:8787/v1/voice/stream?voiceSessionId=vs-1 \
 *     --token <device-token> --fixture <pcm16le-16k-mono-file> [--runs 5] \
 *     [--engine local] [--save] [--check]
 *
 * Baseline: docs/plans/voice-spikes/latency-baseline.json. `--check` exits 1
 * when the measured p50/p95 exceeds the baseline beyond the tolerance.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const DEFAULT_BASELINE = resolve(repoRoot, 'docs/plans/voice-spikes/latency-baseline.json');
const FRAME_MS = 20;
const INPUT_SAMPLE_RATE = 16000;

/** Linear-interpolated percentile (the numpy default). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Turn `{ endOfSpeechAt, firstAudioAt }` samples into the two numbers. */
export function summarize(samples) {
  const deltas = samples.map((sample) => sample.firstAudioAt - sample.endOfSpeechAt);
  return { count: deltas.length, p50: percentile(deltas, 50), p95: percentile(deltas, 95) };
}

/** Compare a measurement against a `{ p50, p95 }` baseline within a tolerance. */
export function compareToBaseline(measured, baseline, tolerance = 0.25) {
  const allowed = {
    p50: baseline.p50 * (1 + tolerance),
    p95: baseline.p95 * (1 + tolerance),
  };
  const regressed = measured.p50 > allowed.p50 || measured.p95 > allowed.p95;
  return { regressed, measured, baseline, tolerance, allowed };
}

function parseArgs(argv) {
  const args = { runs: 1, engine: 'local', tolerance: 0.25 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--save') args.save = true;
    else if (token === '--check') args.check = true;
    else if (token === '--url') args.url = argv[++i];
    else if (token === '--token') args.token = argv[++i];
    else if (token === '--fixture') args.fixture = argv[++i];
    else if (token === '--runs') args.runs = Number(argv[++i]);
    else if (token === '--engine') args.engine = argv[++i];
    else if (token === '--baseline') args.baseline = argv[++i];
    else if (token === '--tolerance') args.tolerance = Number(argv[++i]);
  }
  return args;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function readBaseline(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function baselineFor(document, engine) {
  return document?.engines?.[engine] ?? document;
}

/** One call: send the fixture, then time `final` → the first binary frame. */
async function measureOne({ WebSocket, url, token, fixture }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    let satisfied = false;
    let endOfSpeechAt = null;
    const sample = { endOfSpeechAt: null, firstAudioAt: null };

    const finish = (error) => {
      if (satisfied) return;
      satisfied = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      if (error) rejectPromise(error);
      else resolvePromise(sample);
    };

    ws.on('open', async () => {
      const frameBytes = (INPUT_SAMPLE_RATE * FRAME_MS) / 1000 * 2;
      for (let offset = 0; offset < fixture.length; offset += frameBytes) {
        ws.send(fixture.subarray(offset, offset + frameBytes), { binary: true });
        await sleep(FRAME_MS);
      }
      setTimeout(() => finish(new Error('timed out waiting for the final/audio')), 20_000);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (endOfSpeechAt !== null && sample.firstAudioAt === null) {
          sample.firstAudioAt = Date.now();
          finish(null);
        }
        return;
      }
      try {
        const frame = JSON.parse(data.toString());
        if (frame.t === 'final' && endOfSpeechAt === null) endOfSpeechAt = Date.now();
      } catch {
        // ignore frames that are not JSON
      }
    });

    ws.on('error', (error) => finish(error));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.url || !args.token || !args.fixture) {
    throw new Error('usage: latency-harness --url <ws-url> --token <token> --fixture <pcm16le-file>');
  }
  const { WebSocket } = await import('ws');
  const fixture = readFileSync(resolve(args.fixture));

  const samples = [];
  for (let run = 0; run < Math.max(1, args.runs); run += 1) {
    samples.push(await measureOne({ WebSocket, url: args.url, token: args.token, fixture }));
  }
  const measured = { ...summarize(samples), engine: args.engine };
  console.log(JSON.stringify({ engine: args.engine, samples, measured }, null, 2));

  const baselinePath = args.baseline ? resolve(args.baseline) : DEFAULT_BASELINE;
  if (args.save) {
    const document = {
      source: `measured by latency-harness.mjs on ${new Date().toISOString()}`,
      status: 'PENDING-DEVICE',
      tolerance: args.tolerance,
      engines: { [args.engine]: { p50: measured.p50, p95: measured.p95 } },
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(`[latency] wrote baseline to ${baselinePath}`);
  }
  if (args.check) {
    const baseline = baselineFor(readBaseline(baselinePath), args.engine);
    const verdict = compareToBaseline(measured, baseline, args.tolerance);
    console.log(`[latency] ${verdict.regressed ? 'REGRESSED' : 'ok'} ${JSON.stringify(verdict)}`);
    return verdict.regressed ? 1 : 0;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}
