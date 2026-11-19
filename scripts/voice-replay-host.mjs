// Release-bar replay: real worker and media socket, no backend or phone needed.
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { attachVoiceMediaSocket, VOICE_STREAM_PATH } from '../gate/core/voice/media-socket.mjs';
import { LocalEngine, spawnVoiceWorker } from '../gate/core/voice/engines/local-engine.mjs';
import { createVoiceWorkerPool } from '../gate/core/voice/engines/worker-pool.mjs';
import { VoiceSessionRegistry } from '../gate/core/voice/voice-rpc.mjs';
import { voicePaths } from '../gate/core/voice/runtime.mjs';
import { decodeWav } from './voice-replay-fixtures.mjs';
import { percentile, PhoneSim, referenceWordCount, wordErrorRate } from './voice-live.mjs';

const RATE = 16_000;
const ECHO_FRAME_BYTES = 640; // 20 ms at 16 kHz
const JITTER_BYTES = 60 * 48; // native startup watermark, 24 kHz PCM16
const ECHO_DELAY_MS = 120;
const ECHO_GAIN = 0.4;
const END_MATCH_TOLERANCE_MS = 750;
const NOISE_KINDS = ['tv', 'kitchen', 'cough', 'click'];
const REPLY = 'Here is the answer I found for you today. Let me know if there is anything else you want to look at.';
const DEVICE = 'voice-replay';
const TOKEN = 'voice-replay-token';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const round = (value) => Number.isFinite(value) ? Math.round(value) : null;

export function validateCorpus(value) {
  if (value?.version !== 1 || !Array.isArray(value.clips) || !value.clips.length) {
    throw new Error('expected a version 1 corpus with a nonempty clips array');
  }
  const ids = new Set();
  for (const clip of value.clips) {
    const { id, wav, kind } = clip ?? {};
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new Error(`invalid or duplicate clip ID: ${id}`);
    ids.add(id);
    if (typeof wav !== 'string' || !/^[\w.-]+\.wav$/i.test(wav) || basename(wav) !== wav) {
      throw new Error(`${id}: WAV must be a filename in the sidecar directory`);
    }
    if (kind === 'noise') {
      if (!NOISE_KINDS.includes(clip.noiseKind)) throw new Error(`${id}: unknown noiseKind`);
    } else if (kind === 'speech' || kind === 'echo') {
      if (typeof clip.reference !== 'string' || !referenceWordCount(clip.reference)) throw new Error(`${id}: missing reference`);
      if (!Number.isFinite(clip.speechEndMs) || clip.speechEndMs <= 0) throw new Error(`${id}: invalid speechEndMs`);
      if (clip.pauseMs !== undefined && (!Number.isFinite(clip.pauseMs) || clip.pauseMs < 500 || clip.pauseMs > 3000)) {
        throw new Error(`${id}: pauseMs must be between 500 and 3000`);
      }
    } else throw new Error(`${id}: expected speech, noise or echo`);
  }
  return value;
}

export function describeReplayCase({
  clip, durationMs, startedAtMs, commits = [], plays = [], completed = new Set(), echoBargeIns = 0,
}) {
  const base = { id: clip.id, kind: clip.kind, commits: commits.length, durationMs: round(durationMs) };
  if (clip.kind === 'noise') return { ...base, noiseKind: clip.noiseKind };
  if (clip.kind === 'echo') {
    // The first reply is the controlled exposure; any reply to the echo is
    // itself an error, not a new independent echo trial.
    return { ...base, playedReplies: plays.length ? 1 : 0, echoBargeIns };
  }
  const endAt = startedAtMs + clip.speechEndMs;
  const workerEos = (commit) => Number.isFinite(commit.eosToCommitMs) ? commit.atMs - commit.eosToCommitMs : null;
  const match = commits.findLast((commit) => {
    const eos = workerEos(commit);
    return eos !== null && Math.abs(eos - endAt) <= END_MATCH_TOLERANCE_MS;
  });
  const effective = new Set([...completed, ...plays.map(({ turnId }) => turnId)]);
  const early = commits.some((commit) => effective.has(commit.turnId)
    && (workerEos(commit) ?? commit.atMs) < endAt - END_MATCH_TOLERANCE_MS);
  const play = match && plays.find(({ turnId }) => turnId === match.turnId);
  const eos = match ? workerEos(match) : null;
  // Score what the call actually sent. Deletions count even without a commit.
  // A merged replacement already contains the early text, so don't concatenate it.
  const hyp = match?.text ?? commits.at(-1)?.text ?? '';
  const referenceWords = referenceWordCount(clip.reference);
  return {
    ...base,
    source: clip.source ?? 'unlabelled',
    pauseMs: clip.pauseMs ?? null,
    effectiveTurns: effective.size,
    split: effective.size > 1 || early,
    labelledEndToCommitMs: match ? round(match.atMs - endAt) : null,
    eosToCommitMs: match?.eosToCommitMs ?? null,
    f1OverheadMs: play && eos !== null && play.atMs >= eos ? round(play.atMs - eos) : null,
    stages: play?.stages ?? null,
    referenceWords,
    wordErrors: Math.round(wordErrorRate(clip.reference, hyp) * referenceWords),
  };
}

const count = (rows, predicate) => rows.filter(predicate).length;
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const fraction = (numerator, denominator) => denominator ? numerator / denominator : null;

export function summarizeReplay(rows, baselineWer = null) {
  const speech = rows.filter(({ kind }) => kind === 'speech');
  const clean = speech.filter(({ pauseMs }) => !pauseMs);
  const f1 = speech.map(({ f1OverheadMs }) => f1OverheadMs).filter(Number.isFinite);
  const p50 = percentile(f1, 0.5);
  const p90 = percentile(f1, 0.9);
  const pauseBand = (min, max) => {
    const band = speech.filter(({ pauseMs }) => pauseMs > min && pauseMs <= max);
    const splits = count(band, ({ split }) => split);
    return { n: band.length, splits, splitRate: fraction(splits, band.length) };
  };
  const noise = Object.fromEntries(NOISE_KINDS.map((noiseKind) => {
    const clips = rows.filter((row) => row.kind === 'noise' && row.noiseKind === noiseKind);
    const ms = sum(clips, 'durationMs');
    const commits = sum(clips, 'commits');
    return [noiseKind, { commits, durationMs: ms, commitsPer10Min: fraction(commits * 600_000, ms), enoughExposure: ms >= 600_000 }];
  }));
  const echo = rows.filter(({ kind }) => kind === 'echo');
  const replies = sum(echo, 'playedReplies');
  const bargeIns = sum(echo, 'echoBargeIns');
  const wer = (group) => fraction(sum(group, 'wordErrors'), sum(group, 'referenceWords'));
  const observedWer = wer(speech);
  const within = (ms) => count(clean, ({ eosToCommitMs }) => Number.isFinite(eosToCommitMs) && eosToCommitMs <= ms);
  return {
    F1: {
      overheadMs: { n: f1.length, p50, p90 },
      meetsHostTarget: f1.length >= 30 ? p50 <= 1500 && p90 <= 2500 : null,
      measurement: 'Worker VAD speech_end to simulated first PCM write; scripted TTFT is zero. Not device-audible.',
    },
    F4: { pauseUpTo1500Ms: pauseBand(0, 1500), pause1500To2500Ms: pauseBand(1500, 2500), pause2500To3000Ms: pauseBand(2500, 3000) },
    F5: {
      noise,
      echo: { replies, bargeIns, spuriousCommits: echo.reduce((n, row) => n + Math.max(0, row.commits - 1), 0),
        bargeInsPer20: fraction(bargeIns * 20, replies), enoughExposure: replies >= 20, simulated: true },
    },
    F6: {
      n: clean.length, matchedWorkerEnds: count(clean, ({ eosToCommitMs }) => Number.isFinite(eosToCommitMs)),
      within1200Ms: within(1200), within3000Ms: within(3000),
      rate1200: fraction(within(1200), clean.length), rate3000: fraction(within(3000), clean.length),
    },
    F7: {
      wer: observedWer, wordErrors: sum(speech, 'wordErrors'), referenceWords: sum(speech, 'referenceWords'),
      baselineWer, deltaPoints: baselineWer === null || observedWer === null ? null : (observedWer - baselineWer) * 100,
      bySource: Object.fromEntries([...new Set(speech.map(({ source }) => source))]
        .map((name) => [name, wer(speech.filter(({ source }) => source === name))])),
    },
  };
}

function numbers(line) {
  const fields = {};
  for (const [, key, value] of line.matchAll(/\b(\w+Ms)=([^\s]+)/g)) {
    fields[key] = value === 'null' || !Number.isFinite(Number(value)) ? null : Number(value);
  }
  return fields;
}

async function bounded(promise, timeoutMs, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function runClip({ clip, pcm, registry, port, observations }) {
  const callId = `replay-${clip.id}`;
  registry.create({ voiceSessionId: callId, deviceId: DEVICE, engine: 'local' });
  const epoch = Date.now() - performance.now();
  let current = null;
  let currentTurn = null;
  let sequence = 0;
  const plays = [];
  const completed = new Set();
  let pendingEcho = Buffer.alloc(0);
  let echoAt = Infinity;
  const phone = new PhoneSim(`ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=${callId}&protocol=2`, {
    token: TOKEN,
    onCapture: () => {
      if (!pendingEcho.length || performance.now() < echoAt) return undefined;
      const frame = Buffer.alloc(ECHO_FRAME_BYTES);
      pendingEcho.copy(frame, 0, 0, ECHO_FRAME_BYTES);
      pendingEcho = pendingEcho.subarray(ECHO_FRAME_BYTES);
      return frame;
    },
    onPcm: (data, at) => {
      if (!current || data.length < 10 || data.readUInt32BE(0) !== current.gen
        || data.readUInt32BE(4) !== current.startSeq) return;
      current.first ??= at;
      current.bytes += data.length - 8;
      if (!current.played && current.bytes >= JITTER_BYTES) {
        current.played = true;
        plays.push({ turnId: current.turnId, atMs: epoch + at });
        phone.ws.send(JSON.stringify({
          t: 'played', v: 2, callId, seq: ++sequence, ts: Math.round(at),
          gen: current.gen, atMs: Math.max(0, Math.round(at - current.first)),
        }));
      }
      if (clip.kind === 'echo' && (plays.length === 0 || plays[0].turnId === current.turnId)) {
        // Deterministic acoustic proxy: attenuate and downsample the actual
        // spoken output, then feed it back delayed, in capture-sized frames.
        const samples = Math.floor((data.length - 8) / 6) * 2;
        const echo = Buffer.alloc(samples * 2);
        for (let i = 0; i < samples; i++) {
          echo.writeInt16LE(Math.round(data.readInt16LE(8 + Math.floor(i * 1.5) * 2) * ECHO_GAIN), i * 2);
        }
        if (!pendingEcho.length) echoAt = at + ECHO_DELAY_MS;
        pendingEcho = Buffer.concat([pendingEcho, echo]);
      }
    },
  });
  phone.ws.on('error', () => { phone.running = false; });
  phone.trace = (event) => {
    if (event.t === 'final') currentTurn = event.turnId;
    if (event.t === 'speech' && event.state === 'start') {
      current = { turnId: currentTurn, gen: event.gen, startSeq: event.seq, bytes: 0, played: false };
    } else if (event.t === 'speech' && event.state === 'cancelled') {
      current = null;
      pendingEcho = Buffer.alloc(0);
    }
    if (event.t === 'turn' && ['done', 'failed'].includes(event.state)) completed.add(event.turnId);
  };
  try {
    await bounded(phone.open(), 10_000, 'the replay socket');
    await phone.waitFor(0, (event) => event.t === 'ready', 90_000, 'the real worker');
    await sleep(300);
    const durationMs = pcm.length / (RATE * 2) * 1000;
    const spoken = await bounded(phone.say(pcm), durationMs + 10_000, `${clip.id} capture`);
    // Empty/noise trials must be allowed to settle too. Keep real silence
    // flowing, not a skip, mute or end that could suppress phantom commits.
    await sleep(5500);
    if (phone.events.findLast(({ t }) => t === 'phase')?.phase !== 'listening') {
      await phone.waitFor(spoken.endedAt, (event) => event.t === 'phase' && event.phase === 'listening',
        20_000, 'the call to settle');
    }
    if (phone.ended() || phone.ws.readyState !== 1) throw new Error(`call ended early (${phone.ended() ?? 'socket'})`);
    const commits = phone.events.filter(({ t }) => t === 'final').map(({ turnId, text, at }) => {
      const info = observations.commits.get(turnId);
      return { turnId, text, atMs: info?.atMs ?? epoch + at, eosToCommitMs: info?.eosToCommitMs ?? null };
    });
    plays.forEach((play) => { play.stages = observations.latencies.get(play.turnId) ?? null; });
    // Registry end runs the media socket's terminal audit synchronously.
    registry.end(callId, 'user');
    return describeReplayCase({
      clip, durationMs, startedAtMs: epoch + spoken.startedAt - 20, commits, plays, completed,
      echoBargeIns: observations.echoBargeIns,
    });
  } finally {
    phone.close();
    registry.end(callId, 'user');
  }
}

export async function replayCorpus(manifestPath, { baselineWer = null } = {}) {
  const { clips } = validateCorpus(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const paths = voicePaths();
  const registry = new VoiceSessionRegistry();
  const pool = createVoiceWorkerPool({ spawn: () => spawnVoiceWorker({ paths }) });
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const observations = new Map();
  const wss = attachVoiceMediaSocket({
    server, registry,
    deviceTokens: { verify: async (auth) => auth === `Bearer ${TOKEN}` ? { deviceId: DEVICE } : null },
    createEngine: () => new LocalEngine({ paths, pool }),
    runTurn: async (_session, _text, { onDelta }) => {
      // No timer and no routing: voice overhead includes no real backend TTFT.
      onDelta(REPLY);
      return { hasContent: true };
    },
    log: (line) => {
      const id = / session=(\S+)/.exec(line)?.[1];
      const row = observations.get(id);
      if (!row) return;
      const turnId = / turn=(\S+)/.exec(line)?.[1];
      if (line.startsWith('voice.turn latency ') && turnId) row.latencies.set(turnId, numbers(line));
      if (line.startsWith('voice.utterance commit ')) {
        if (turnId) row.commits.set(turnId, { atMs: Date.now(), ...numbers(line) });
      }
      if (line.startsWith('voice.end ')) row.echoBargeIns = Number(/\bbargeIns=(\d+)/.exec(line)?.[1] ?? 0);
    },
  });
  const rows = [];
  const failures = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    for (const clip of clips) {
      const id = `replay-${clip.id}`;
      const observation = { commits: new Map(), latencies: new Map(), echoBargeIns: 0 };
      observations.set(id, observation);
      try {
        const { sampleRate, pcm } = decodeWav(readFileSync(join(dirname(manifestPath), clip.wav)));
        if (sampleRate !== RATE || !pcm.length || pcm.length % 2) throw new Error('expected 16 kHz mono PCM16 WAV');
        if (clip.speechEndMs > pcm.length / 32) throw new Error('speechEndMs exceeds WAV duration');
        rows.push(await runClip({ clip, pcm, registry, port: server.address().port, observations: observation }));
      } catch (error) {
        failures.push({ id: clip.id, error: error.message });
      } finally {
        observations.delete(id);
      }
    }
  } finally {
    wss.endAll('user');
    for (const client of wss.clients) client.terminate();
    await new Promise((done) => wss.close(done));
    if (server.listening) await new Promise((done) => server.close(done));
    await pool.shutdown();
  }
  return { version: 1, backend: { kind: 'scripted', ttftMs: 0 }, rows, failures, metrics: summarizeReplay(rows, baselineWer) };
}

export async function main(argv) {
  const option = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${flag}`);
    return resolve(argv[i + 1]);
  };
  const seed = option('--seed');
  if (seed) {
    const { python, models } = voicePaths();
    const script = fileURLToPath(new URL('./voice-replay-seed.py', import.meta.url));
    const noiseIndex = argv.indexOf('--noise-seconds');
    const seconds = noiseIndex < 0 ? 30 : Number(argv[noiseIndex + 1]);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('--noise-seconds must be 1–600');
    const result = spawnSync(python, [script, models, seed, String(seconds)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('could not generate the Kokoro seed corpus');
    return;
  }
  const manifest = option('--manifest');
  if (!manifest) throw new Error('use --seed <directory> or --manifest <corpus.json> [--out <report.json>] [--baseline <report.json>]');
  const baseline = option('--baseline');
  const baselineWer = baseline ? JSON.parse(readFileSync(baseline, 'utf8')).metrics?.F7?.wer ?? null : null;
  const report = await replayCorpus(manifest, { baselineWer });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const output = option('--out');
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json);
  }
  process.stdout.write(json);
  const { F1, F4, F5, F6, F7 } = report.metrics;
  const pct = (n) => n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
  console.error([
    'Bar   Observation (host, simulated playback)',
    `F1    ${F1.overheadMs.n} samples; p50 ${F1.overheadMs.p50 ?? 'n/a'} ms; p90 ${F1.overheadMs.p90 ?? 'n/a'} ms`,
    `F4    ${pct(F4.pauseUpTo1500Ms.splitRate)} splits (≤1500 ms); ${pct(F4.pause1500To2500Ms.splitRate)} (1500–2500 ms)`,
    `F5    noise commits/10 min: ${Object.entries(F5.noise).map(([key, row]) => `${key}=${row.commitsPer10Min?.toFixed(2) ?? 'n/a'}`).join(', ')}; echo ${F5.echo.bargeIns}/${F5.echo.replies}`,
    `F6    ${pct(F6.rate1200)} within 1.2 s; ${pct(F6.rate3000)} within 3 s (${F6.n} trials)`,
    `F7    ${pct(F7.wer)} WER (${F7.referenceWords} reference words)`,
    `${report.failures.length} harness failures (see JSON); incomplete coverage is not a pass.`,
  ].join('\n'));
  if (report.failures.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`voice-replay: ${error.message}`);
    process.exitCode = 1;
  });
}
