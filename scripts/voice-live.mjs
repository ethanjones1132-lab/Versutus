// ─── A call with the real models, and no phone ───────────────────────────
// `voice-replay.mjs` drives the Gate's call loop with a scripted engine: it
// proves plumbing and says nothing about how a call feels. This one runs the
// real worker (Silero, Smart Turn, Whisper, Kokoro) behind the real media
// socket and plays a phone against it: speech fixtures go in as 20 ms PCM
// frames at real time, exactly as the Android capture loop sends them, and
// every frame and audio chunk that comes back is timed on one monotonic clock.
//
// The chat backend is scripted on purpose (a first token after `--ttft-ms`, then
// words at `--token-ms`), so what is measured is the voice path's own overhead:
// how long after the person stops the turn is committed, how long until the
// first reply audio leaves, whether the reply is paced to playback, and how
// fast a barge-in stops it. Speech is synthesised on this host, not recorded.
//
// Usage:
//   node scripts/voice-live.mjs [--rounds <n>] [--ttft-ms <n>] [--token-ms <n>]
//     [--gate <checkout>] [--only <utterance id>] [--out <report.json>]
//     [--json] [--verbose]
//
// `--gate` loads the Gate's modules (and so its worker) from another checkout,
// which is how a before/after comparison is made on the same fixtures.

import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'fixtures', 'voice-live', 'manifest.json');
const FIXTURE_SCRIPT = join(HERE, 'voice-live-fixtures.py');

const CAPTURE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_BYTES = (CAPTURE_RATE * 2 * FRAME_MS) / 1000;
const PLAYBACK_BYTES_PER_MS = 48;
const CALL_ID = 'voice-live-call';
const DEVICE_ID = 'voice-live-device';
const TOKEN = 'voice-live-token';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const options = { rounds: 1, ttftMs: 0, tokenMs: 25, gate: resolve(HERE, '..'), json: false, verbose: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--rounds') options.rounds = Number(next());
    else if (arg === '--ttft-ms') options.ttftMs = Number(next());
    else if (arg === '--token-ms') options.tokenMs = Number(next());
    else if (arg === '--gate') options.gate = resolve(next());
    else if (arg === '--out') options.out = resolve(next());
    else if (arg === '--only') options.only = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const words = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Word error rate of `heard` against `said`: edits over reference words. */
export function wordErrorRate(said, heard) {
  const ref = words(said);
  const hyp = words(heard);
  if (!ref.length) return hyp.length ? 1 : 0;
  let previous = Array.from({ length: hyp.length + 1 }, (_, index) => index);
  for (let row = 1; row <= ref.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hyp.length; column += 1) {
      const cost = ref[row - 1] === hyp[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
    }
    previous = current;
  }
  return previous[hyp.length] / ref.length;
}

/** Synthesise (or reuse) the speech fixtures and load them as PCM. */
function loadFixtures(paths) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const dir = join(tmpdir(), 'versutus-voice-live');
  mkdirSync(dir, { recursive: true });
  const made = spawnSync(paths.python, [FIXTURE_SCRIPT, paths.models, MANIFEST_PATH, dir], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`fixture synthesis failed: ${made.stderr || made.stdout}`);
  const utterances = manifest.utterances.map((utterance) => {
    const parts = [];
    utterance.segments.forEach((segment, index) => {
      if (segment.gapMs) parts.push(Buffer.alloc((CAPTURE_RATE * 2 * segment.gapMs) / 1000));
      parts.push(readFileSync(join(dir, `${utterance.id}-${index}.pcm`)));
    });
    return {
      id: utterance.id,
      kind: utterance.kind,
      text: utterance.segments.map((segment) => segment.text).join(' '),
      pcm: Buffer.concat(parts),
    };
  });
  return { manifest, utterances };
}

/** The Gate under test, loaded from whichever checkout `--gate` names. */
async function loadGate(root) {
  const load = (relative) => import(pathToFileURL(join(root, relative)).href);
  const [media, local, pool, runtime, rpc] = await Promise.all([
    load('gate/core/voice/media-socket.mjs'),
    load('gate/core/voice/engines/local-engine.mjs'),
    load('gate/core/voice/engines/worker-pool.mjs'),
    load('gate/core/voice/runtime.mjs'),
    load('gate/core/voice/voice-rpc.mjs'),
  ]);
  return { media, local, pool, runtime, rpc };
}

/** A phone: one socket, a real-time capture loop, and a log of what came back. */
class PhoneSim {
  constructor(url) {
    this.events = [];
    this.audio = [];
    this.queue = [];
    this.marks = [];
    this.sent = 0;
    this.running = false;
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    this.ws.on('message', (data, binary) => {
      const at = performance.now();
      if (binary) this.audio.push({ at, ms: (data.length - 8) / PLAYBACK_BYTES_PER_MS });
      else {
        const event = { at, ...JSON.parse(data.toString()) };
        this.events.push(event);
        this.trace?.(event);
      }
    });
  }

  async open() {
    await once(this.ws, 'open');
    this.running = true;
    void this.capture();
  }

  /** 20 ms frames on a fixed schedule: speech when some is queued, else silence. */
  async capture() {
    const silence = Buffer.alloc(FRAME_BYTES);
    const startedAt = performance.now();
    let frame = 0;
    while (this.running) {
      const due = startedAt + frame * FRAME_MS;
      const wait = due - performance.now();
      if (wait > 1) await sleep(wait);
      const next = this.queue.shift();
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(next?.pcm ?? silence, { binary: true });
      if (next?.mark) next.mark(performance.now());
      frame += 1;
    }
  }

  /** Queue an utterance; resolves with when its first and last frames left. */
  say(pcm) {
    return new Promise((done) => {
      let startedAt = null;
      for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
        const frame = Buffer.alloc(FRAME_BYTES);
        pcm.copy(frame, 0, offset, Math.min(offset + FRAME_BYTES, pcm.length));
        const first = offset === 0;
        const last = offset + FRAME_BYTES >= pcm.length;
        this.queue.push({
          pcm: frame,
          mark: first || last
            ? (at) => {
                if (first) startedAt = at;
                if (last) done({ startedAt, endedAt: at });
              }
            : null,
        });
      }
    });
  }

  since(at, predicate) {
    return this.events.find((event) => event.at >= at && predicate(event)) ?? null;
  }

  async waitFor(at, predicate, timeoutMs, what) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = this.since(at, predicate);
      if (found) return found;
      // A call that ended is not a slow one: say so, and why.
      const over = this.ended();
      if (over) throw new Error(`the call ended (${over}) while waiting for ${what}`);
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  }

  /** Why the Gate ended the call, or null while it is up. */
  ended() {
    const frame = this.events.find((event) => event.t === 'ended'
      || (event.t === 'call' && event.state === 'ended')
      || (event.t === 'error' && event.fatal));
    if (!frame) return null;
    return frame.reason ?? frame.code ?? 'ended';
  }

  close() {
    this.running = false;
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

/** A backend that answers every turn with the manifest's reply, word by word. */
function scriptedBackend({ reply, ttftMs, tokenMs, turns }) {
  return (_session, text, handlers) => new Promise((resolveTurn, reject) => {
    const turn = { text, at: performance.now() };
    turns.push(turn);
    const timers = [];
    handlers.signal.addEventListener('abort', () => {
      turn.aborted = true;
      for (const timer of timers) clearTimeout(timer);
      reject(new Error('turn aborted'));
    });
    const pieces = reply.match(/\S+\s*/g) ?? [];
    pieces.forEach((piece, index) => {
      timers.push(setTimeout(() => handlers.onDelta(piece), ttftMs + index * tokenMs));
    });
    timers.push(setTimeout(() => resolveTurn({ hasContent: true }), ttftMs + pieces.length * tokenMs + 1));
  });
}

/** What the phone would be holding, at its worst, if it played at real time. */
function maxAheadMs(audio) {
  if (!audio.length) return null;
  const first = audio[0].at;
  let received = 0;
  let worst = 0;
  for (const chunk of audio) {
    received += chunk.ms;
    worst = Math.max(worst, received - (chunk.at - first));
  }
  return Math.round(worst);
}

async function runTurn(phone, utterance, { verbose }) {
  const from = performance.now();
  await sleep(500);
  const spoken = await phone.say(utterance.pcm);
  const eosAt = spoken.endedAt;
  if (verbose) console.error(`  phone> said ${utterance.id} over ${Math.round(spoken.endedAt - spoken.startedAt)}ms`);
  await phone.waitFor(spoken.startedAt, (event) => event.t === 'final', 15_000, 'the turn to be committed');
  const done = await phone.waitFor(eosAt, (event) => event.t === 'speech' && (event.state === 'end' || event.state === 'cancelled'), 45_000, 'the reply to finish');
  await phone.waitFor(done.at, (event) => event.t === 'phase' && event.phase === 'listening', 5_000, 'listening to reopen');
  // What "the reply finished" must mean: the phone has nothing left to play.
  await sleep(150);
  // A turn taken back because the person carried on is committed twice and
  // answered once: the commit that counts is the last one before the reply.
  const commits = phone.events.filter((event) => event.at >= from && event.at <= done.at && event.t === 'final');
  const committed = commits.at(-1);
  const answered = phone.events.filter((event) => event.at >= from && event.at <= done.at + 200
    && event.t === 'turn' && (event.state === 'done' || event.state === 'failed'));
  const audio = phone.audio.filter((chunk) => chunk.at >= committed.at);
  const firstReply = phone.since(committed.at, (event) => event.t === 'reply');
  const audioMs = audio.reduce((sum, chunk) => sum + chunk.ms, 0);
  const row = {
    id: utterance.id,
    heard: committed.text,
    // How many replies the person got for one thing they said, and how many
    // times it was sent before the one that was answered.
    turns: answered.length,
    withdrawn: commits.length - 1,
    wer: Number(wordErrorRate(utterance.text, committed.text).toFixed(3)),
    eosToCommitMs: Math.round(committed.at - eosAt),
    commitToFirstReplyMs: firstReply ? Math.round(firstReply.at - committed.at) : null,
    commitToFirstAudioMs: audio.length ? Math.round(audio[0].at - committed.at) : null,
    eosToFirstAudioMs: audio.length ? Math.round(audio[0].at - eosAt) : null,
    replyAudioMs: Math.round(audioMs),
    maxAheadMs: maxAheadMs(audio),
    // When the Gate said the reply was over, against when the phone would have
    // finished playing it: negative means "listening" was claimed mid-reply.
    endVsPlaybackMs: audio.length ? Math.round(done.at - (audio[0].at + audioMs)) : null,
    audioAfterEndMs: Math.round(phone.audio.filter((chunk) => chunk.at > done.at).reduce((sum, chunk) => sum + chunk.ms, 0)),
  };
  if (verbose) console.error(JSON.stringify(row));
  return row;
}

async function runBargeIn(phone, opener, interruption, { verbose }) {
  await sleep(500);
  const spoken = await phone.say(opener.pcm);
  const committed = await phone.waitFor(spoken.startedAt, (event) => event.t === 'final', 15_000, 'the turn to be committed');
  const deadline = performance.now() + 20_000;
  while (!phone.audio.some((chunk) => chunk.at >= committed.at)) {
    if (performance.now() > deadline) throw new Error('timed out waiting for reply audio');
    await sleep(10);
  }
  const firstAudioAt = phone.audio.find((chunk) => chunk.at >= committed.at).at;
  // Let the reply get going, then talk over it.
  await sleep(900);
  const barge = await phone.say(interruption.pcm);
  const cancelled = await phone.waitFor(barge.startedAt, (event) => event.t === 'speech' && event.state === 'cancelled', 10_000, 'the reply to be cancelled');
  const next = await phone.waitFor(barge.startedAt, (event) => event.t === 'final', 15_000, 'the interruption to become a turn');
  const done = await phone.waitFor(next.at, (event) => event.t === 'speech' && (event.state === 'end' || event.state === 'cancelled'), 45_000, 'the second reply to finish');
  await phone.waitFor(done.at, (event) => event.t === 'phase' && event.phase === 'listening', 5_000, 'listening to reopen');
  const queuedAtCancel = phone.audio
    .filter((chunk) => chunk.at >= firstAudioAt && chunk.at <= cancelled.at)
    .reduce((sum, chunk) => sum + chunk.ms, 0) - (cancelled.at - firstAudioAt);
  const staleAfterCancel = phone.audio
    .filter((chunk) => chunk.at > cancelled.at && chunk.at < next.at)
    .reduce((sum, chunk) => sum + chunk.ms, 0);
  const row = {
    id: 'barge-in',
    heard: next.text,
    wer: Number(wordErrorRate(interruption.text, next.text).toFixed(3)),
    // From the first frame of the interruption leaving the phone to the Gate
    // telling it to stop. The phone flushes its speaker on that frame.
    onsetToCancelMs: Math.round(cancelled.at - barge.startedAt),
    // What the phone was still holding of the old reply when told to stop.
    heldAtCancelMs: Math.max(0, Math.round(queuedAtCancel)),
    staleAudioAfterCancelMs: Math.round(staleAfterCancel),
  };
  if (verbose) console.error(JSON.stringify(row));
  return row;
}

function summarise(rows, keys) {
  const summary = {};
  for (const key of keys) {
    const values = rows.map((row) => row[key]).filter(Number.isFinite);
    summary[key] = { n: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9), max: values.length ? Math.max(...values) : null };
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const gate = await loadGate(options.gate);
  const paths = gate.runtime.voicePaths();
  const { manifest, utterances } = loadFixtures(paths);
  const log = (line) => {
    if (options.verbose) console.error(String(line));
  };

  const registry = new gate.rpc.VoiceSessionRegistry();
  registry.create({
    voiceSessionId: CALL_ID,
    deviceId: DEVICE_ID,
    engine: 'local',
    thread: { kind: 'configurable', sessionId: 'voice-live-session' },
  });
  const pool = gate.pool.createVoiceWorkerPool({
    spawn: () => gate.local.spawnVoiceWorker({ paths }),
    log,
  });
  const backendTurns = [];
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = gate.media.attachVoiceMediaSocket({
    server,
    deviceTokens: { verify: async (authorization) => (authorization === `Bearer ${TOKEN}` ? { deviceId: DEVICE_ID } : null) },
    registry,
    createEngine: () => new gate.local.LocalEngine({ paths, pool, log }),
    runTurn: scriptedBackend({ reply: manifest.reply, ttftMs: options.ttftMs, tokenMs: options.tokenMs, turns: backendTurns }),
    log,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const phone = new PhoneSim(
    `ws://127.0.0.1:${server.address().port}${gate.media.VOICE_STREAM_PATH}?voiceSessionId=${CALL_ID}&protocol=2`,
  );
  const openedAt = performance.now();
  if (options.verbose) {
    phone.trace = (event) => {
      if (event.t === 'level') return;
      const detail = event.phase ?? event.state ?? (event.text ? JSON.stringify(event.text) : '');
      console.error(`  phone< +${Math.round(event.at - openedAt)}ms ${event.t} ${detail}`);
    };
  }
  await phone.open();
  const listening = await phone.waitFor(0, (event) => event.t === 'phase' && event.phase === 'listening', 120_000, 'the engine to be ready');

  const turns = [];
  const barges = [];
  const failures = [];
  let endedEarly = null;
  const spokenTurns = utterances.filter((utterance) => utterance.kind === 'turn'
    && (!options.only || utterance.id === options.only));
  const interruption = options.only ? null : utterances.find((utterance) => utterance.kind === 'barge');
  try {
    for (let round = 0; round < options.rounds; round += 1) {
      for (const utterance of spokenTurns) {
        try {
          turns.push(await runTurn(phone, utterance, options));
        } catch (error) {
          failures.push({ id: utterance.id, round, error: error.message });
          if (phone.ended()) break;
          await sleep(3_000);
        }
      }
      if (phone.ended()) break;
      if (interruption) {
        try {
          barges.push(await runBargeIn(phone, spokenTurns[0], interruption, options));
        } catch (error) {
          failures.push({ id: 'barge-in', round, error: error.message });
          await sleep(3_000);
        }
      }
    }
  } finally {
    endedEarly = phone.ended();
    phone.close();
    registry.end(CALL_ID, 'user');
    for (const client of wss.clients) client.terminate();
    await new Promise((done) => wss.close(done));
    await new Promise((done) => server.close(done));
    await Promise.resolve(pool.shutdown?.()).catch(() => undefined);
  }

  const report = {
    gate: options.gate,
    ranAt: new Date().toISOString(),
    backend: { kind: 'scripted', ttftMs: options.ttftMs, tokenMs: options.tokenMs },
    openToListeningMs: Math.round(listening.at - openedAt),
    turns,
    barges,
    failures,
    // Null when the call was still up at the end, which is the only pass.
    callEndedEarly: endedEarly,
    controlFrames: phone.events.length,
    backendTurns: backendTurns.length,
    abortedBackendTurns: backendTurns.filter((turn) => turn.aborted).length,
    summary: {
      ...summarise(turns, ['eosToCommitMs', 'commitToFirstAudioMs', 'eosToFirstAudioMs', 'maxAheadMs', 'endVsPlaybackMs', 'audioAfterEndMs', 'wer']),
      ...summarise(barges, ['onsetToCancelMs', 'heldAtCancelMs', 'staleAudioAfterCancelMs']),
      splitTurns: turns.filter((row) => row.turns !== 1).length,
      withdrawnTurns: turns.reduce((sum, row) => sum + (row.withdrawn ?? 0), 0),
    },
  };
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`gate ${report.gate}`);
    console.log(`open → listening ${report.openToListeningMs} ms; ${turns.length} turns, ${barges.length} barge-ins, ${failures.length} failures`);
    console.log(`call ${report.callEndedEarly ? `ENDED EARLY (${report.callEndedEarly})` : 'still up at the end'} after ${report.controlFrames} control frames`);
    for (const [key, value] of Object.entries(report.summary)) {
      if (typeof value === 'number') console.log(`${key.padEnd(26)} ${value}`);
      else console.log(`${key.padEnd(26)} n=${value.n} p50=${value.p50} p90=${value.p90} max=${value.max}`);
    }
    for (const failure of failures) console.log(`FAILED ${failure.id} round ${failure.round}: ${failure.error}`);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
