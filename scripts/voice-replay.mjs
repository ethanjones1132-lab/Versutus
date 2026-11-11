// ─── Repeatable phone → Gate voice replay ────────────────────────────────
// This is harness plumbing, not tuning: it opens the real media socket
// (`attachVoiceMediaSocket`) as a phone would, sends each labelled fixture as
// 20 ms PCM frames at real time, and records what the Gate produced for that
// utterance. The engine is scripted and deterministic because the worker's
// models are not part of this slice; every stage it can time is still the
// Gate's own path — engine final → commit hold → phone final → reply → PCM →
// the phone's `played` acknowledgement.
//
// Usage:
//   node scripts/voice-replay.mjs [--manifest <json>] [--fixtures <dir>]
//     [--hold-ms <n>] [--settle-ms <n>] [--timeout-ms <n>] [--json] [--check]
//
// `--check` exits 1 when an utterance's observed outcome or turn count does
// not match its manifest label. It does not compare latencies: those are
// reported, not gated, until the corpus has a baseline.

import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WebSocket } from 'ws';

import { UTTERANCE_HOLD_MS, VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../gate/core/voice/media-socket.mjs';
import { SCRIPTED_FRAME_BYTES } from '../gate/core/voice/engines/scripted-engine.mjs';
import { VoiceSessionRegistry } from '../gate/core/voice/voice-rpc.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  FIXTURE_FRAME_MS,
  decodeWav,
  ensureFixtures,
  finalMarkers,
  frameBytesFor,
  loadManifest,
} from './voice-replay-fixtures.mjs';
import { percentile } from './voice-spikes/latency-harness.mjs';

export const REPLAY_DEVICE_ID = 'replay-device';
export const REPLAY_TOKEN = 'replay-token';
export const DEFAULT_SETTLE_MS = 500;
export const DEFAULT_TIMEOUT_MS = 20_000;

/** The stage names the report prints, in the order the call passes them. */
export const STAGE_KEYS = Object.freeze([
  'audioEndToEngineFinalMs',
  'engineFinalToCommitMs',
  'commitToFinalFrameMs',
  'finalFrameToFirstReplyMs',
  'finalFrameToFirstSpeechMs',
  'commitToFirstReplyMs',
  'commitToFirstSpeechMs',
  'eosToCommitMs',
  'decodeMs',
  'sentenceToPcmMs',
  'playedMs',
]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A deterministic stand-in for the worker's endpointing. It knows only the
 * manifest's labels: after the frame that carries an endpoint it emits the
 * final text the label names, with the same `eosMs`/`decodeMs` fields the real
 * engine emits. Speech is silence at the output rate, so nothing here needs a
 * model.
 */
export class ReplayEngine extends EventEmitter {
  constructor({ finals = [], msPerChar = 20, minSpeechMs = 200 } = {}) {
    super();
    this.id = 'replay';
    this.finals = finals;
    this.msPerChar = msPerChar;
    this.minSpeechMs = minSpeechMs;
    this.framesSeen = 0;
    this.muted = false;
    this.closed = false;
    this.cancelled = new Set();
    this.pending = [];
  }

  async open() {
    this.closed = false;
    this.framesSeen = 0;
    this.pending = [...this.finals];
    this.cancelled.clear();
  }

  pushAudio() {
    if (this.closed || this.muted) return;
    this.framesSeen += 1;
    while (this.pending.length && this.pending[0].afterFrame <= this.framesSeen) {
      const final = this.pending.shift();
      this.emit('final', { text: final.text, eosMs: Date.now(), decodeMs: 0 });
    }
  }

  durationMs(text) {
    return Math.max(this.minSpeechMs, text.length * this.msPerChar);
  }

  speak(text, { gen } = {}) {
    if (this.closed || this.muted) return;
    if (gen !== undefined && this.cancelled.has(gen)) return;
    const frames = Math.max(1, Math.ceil(this.durationMs(text) / FIXTURE_FRAME_MS));
    for (let index = 0; index < frames; index += 1) {
      if (gen !== undefined && this.cancelled.has(gen)) return;
      this.emit('speechAudio', { gen, pcm: Buffer.alloc(SCRIPTED_FRAME_BYTES) });
    }
    if (gen !== undefined && this.cancelled.has(gen)) return;
    this.emit('speechDone', { gen });
  }

  cancelSpeech(gen) {
    if (gen !== undefined) this.cancelled.add(gen);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
  }

  async close() {
    this.closed = true;
  }
}

function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`voice-replay: timed out after ${timeoutMs}ms waiting for ${label}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function requireInteger(value, flag, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${flag} must be an integer >= ${min} (got ${value})`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    holdMs: UTTERANCE_HOLD_MS,
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${token} needs a value`);
      index += 1;
      return argv[index];
    };
    if (token === '--manifest') args.manifestPath = next();
    else if (token === '--fixtures') args.fixturesDir = next();
    else if (token === '--hold-ms') args.holdMs = Number(next());
    else if (token === '--settle-ms') args.settleMs = Number(next());
    else if (token === '--timeout-ms') args.timeoutMs = Number(next());
    else if (token === '--json') args.json = true;
    else if (token === '--check') args.check = true;
    else throw new Error(`unknown option: ${token}`);
  }
  requireInteger(args.holdMs, '--hold-ms');
  requireInteger(args.settleMs, '--settle-ms');
  requireInteger(args.timeoutMs, '--timeout-ms', { min: 1 });
  return args;
}

/** Parse the Gate's one per-turn latency line into its stage numbers. */
export function parseLatencyLine(line) {
  const stages = {};
  if (!line) return stages;
  for (const key of ['eosToCommitMs', 'decodeMs', 'commitToFirstReplyMs', 'sentenceToPcmMs', 'playedMs']) {
    const match = new RegExp(` ${key}=([^ ]+)`).exec(line);
    const value = match ? Number(match[1]) : Number.NaN;
    stages[key] = Number.isFinite(value) ? value : null;
  }
  return stages;
}

function firstLog(logs, prefix) {
  return logs.find((entry) => entry.line.startsWith(prefix)) ?? null;
}

/** Build one utterance's report row from the frames and log lines it produced. */
export function describeUtterance({
  utterance,
  sessionId,
  frames,
  logs,
  firstEndpointAt,
  firstBinaryAt,
  error = null,
}) {
  const entries = frames;
  const finalEntries = entries.filter((entry) => entry.frame.t === 'final');
  const replyEntries = entries.filter((entry) => entry.frame.t === 'reply');
  const turnEntries = entries.filter((entry) => entry.frame.t === 'turn');
  const failedTurn = turnEntries.find((entry) => entry.frame.state === 'failed') ?? null;
  const fatalError = entries.find((entry) => entry.frame.t === 'error' && entry.frame.fatal) ?? null;
  const lastFinalEntry = finalEntries.at(-1) ?? null;
  const lastFinalIndex = lastFinalEntry ? entries.lastIndexOf(lastFinalEntry) : -1;
  // A turn is settled when the call returns to listening after its final, or
  // names the turn done/failed. A synchronous scripted engine finishes its
  // speech inside the reply delta, so `speech end`/listening can arrive before
  // the backend's `replyDone`; waiting only for `turn done` would miss it.
  const settledAfterFinal = lastFinalIndex >= 0
    ? entries.slice(lastFinalIndex + 1).find((entry) => (
      (entry.frame.t === 'turn' && (entry.frame.state === 'done' || entry.frame.state === 'failed'))
      || (entry.frame.t === 'phase' && entry.frame.phase === 'listening')
      || (entry.frame.t === 'speech' && entry.frame.state === 'end')
    )) ?? null
    : null;

  let outcome;
  if (error) outcome = 'error';
  else if (fatalError) outcome = 'failed';
  else if (finalEntries.length === 0) outcome = 'no-final';
  else if (failedTurn) outcome = 'failed';
  else if (settledAfterFinal) outcome = 'answered';
  else outcome = 'timeout';

  const plannedFinals = (utterance.finals ?? []).length;
  const expected = {
    outcome: utterance.expect?.outcome ?? (plannedFinals > 0 ? 'answered' : 'no-final'),
    utterances: utterance.expect?.utterances ?? (plannedFinals > 0 ? 1 : 0),
  };
  const observed = finalEntries.length;

  const engineFinal = firstLog(logs, `voice.final session=${sessionId} `);
  const commit = firstLog(logs, `voice.utterance commit session=${sessionId} `);
  const latency = firstLog(logs, `voice.turn latency session=${sessionId} `);
  const gate = parseLatencyLine(latency?.line);
  const firstFinalAt = finalEntries[0]?.at ?? null;
  const firstReplyAt = replyEntries[0]?.at ?? null;

  const stages = {
    audioEndToEngineFinalMs: engineFinal && firstEndpointAt ? engineFinal.at - firstEndpointAt : null,
    engineFinalToCommitMs: engineFinal && commit ? commit.at - engineFinal.at : null,
    commitToFinalFrameMs: commit && firstFinalAt !== null ? firstFinalAt - commit.at : null,
    finalFrameToFirstReplyMs:
      firstFinalAt !== null && firstReplyAt !== null ? firstReplyAt - firstFinalAt : null,
    finalFrameToFirstSpeechMs:
      firstFinalAt !== null && firstBinaryAt !== null ? firstBinaryAt - firstFinalAt : null,
    commitToFirstReplyMs:
      gate.commitToFirstReplyMs ?? (commit && firstReplyAt !== null ? firstReplyAt - commit.at : null),
    commitToFirstSpeechMs:
      commit && firstBinaryAt !== null ? firstBinaryAt - commit.at : null,
    eosToCommitMs: gate.eosToCommitMs ?? null,
    decodeMs: gate.decodeMs ?? null,
    sentenceToPcmMs: gate.sentenceToPcmMs ?? null,
    playedMs: gate.playedMs ?? null,
  };

  const message = error
    ?? fatalError?.frame.message
    ?? failedTurn?.frame.error
    ?? null;

  return {
    id: utterance.id,
    label: utterance.label,
    outcome,
    utterances: observed,
    expected,
    match: !error && outcome === expected.outcome && observed === expected.utterances,
    finalText: finalEntries.length ? finalEntries.map((entry) => entry.frame.text).join(' | ') : null,
    replyText: replyEntries.length ? replyEntries.map((entry) => entry.frame.delta).join('') : null,
    error: message,
    stages,
  };
}

async function closeSocket(ws) {
  const closed = once(ws, 'close').catch(() => {});
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'end' }));
  } catch {
    // the socket went away first
  }
  await Promise.race([closed, sleep(500)]);
  try {
    ws.terminate();
  } catch {
    // already closed
  }
}

async function replayOne({
  utterance,
  voiceSessionId,
  port,
  pcm,
  manifest,
  settleMs,
  timeoutMs,
  logs,
  now,
}) {
  const url = `ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=${encodeURIComponent(voiceSessionId)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${REPLAY_TOKEN}` } });
  const frames = [];
  let firstBinaryAt = null;
  let currentGen = null;
  let playedGen = null;
  let failure = null;

  ws.on('error', () => {
    // A failed connection is reported through the harness's own timeout/close
    // path; an unhandled 'error' event here would take the process with it.
  });
  ws.on('message', (data, isBinary) => {
    const at = now();
    if (isBinary) {
      if (firstBinaryAt === null) firstBinaryAt = at;
      // The phone acknowledges the first chunk of a generation once. The Gate
      // turns that into its committed→played latency, the same line a real
      // phone produces.
      if (currentGen !== null && playedGen !== currentGen) {
        playedGen = currentGen;
        try {
          ws.send(JSON.stringify({ t: 'played', gen: currentGen, atMs: at }));
        } catch {
          // the call ended while the audio was arriving
        }
      }
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    frames.push({ at, frame });
    if (frame.t === 'speech' && frame.state === 'start') {
      currentGen = frame.gen;
      playedGen = null;
    }
  });

  const sentAt = [];
  try {
    await waitUntil(
      () => frames.some((entry) => entry.frame.t === 'ready')
        && frames.some((entry) => entry.frame.t === 'phase' && entry.frame.phase === 'listening'),
      timeoutMs,
      `${utterance.id} ready`,
    );
    const frameBytes = frameBytesFor(manifest.sampleRate, manifest.frameMs);
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      ws.send(pcm.subarray(offset, offset + frameBytes), { binary: true });
      sentAt.push(now());
      await sleep(manifest.frameMs);
    }

    const expectedUtterances = utterance.expect?.utterances
      ?? ((utterance.finals ?? []).length > 0 ? 1 : 0);
    if (expectedUtterances > 0) {
      await waitUntil(
        () => {
          const finalEntries = frames.filter((entry) => entry.frame.t === 'final');
          if (finalEntries.length < expectedUtterances) return false;
          const lastFinalIndex = frames.lastIndexOf(finalEntries[finalEntries.length - 1]);
          return frames.slice(lastFinalIndex + 1).some((entry) => (
            (entry.frame.t === 'turn'
              && (entry.frame.state === 'done' || entry.frame.state === 'failed'))
            || (entry.frame.t === 'phase' && entry.frame.phase === 'listening')
            || (entry.frame.t === 'speech' && entry.frame.state === 'end')
            || (entry.frame.t === 'error' && entry.frame.fatal)
            || entry.frame.t === 'ended'
          ));
        },
        timeoutMs,
        `${utterance.id} turns`,
      ).catch(() => {
        // The row below says `timeout`; one wedged utterance must not hide the rest.
      });
    } else {
      await sleep(settleMs);
    }

    if (firstBinaryAt !== null) {
      // The Gate writes its stage line when the `played` frame arrives. It is
      // an observation, not a completion condition: a missing line leaves the
      // stages null instead of failing the replay.
      await waitUntil(
        () => logs.some((entry) => entry.line.startsWith(`voice.turn latency session=${voiceSessionId} `)),
        3_000,
        `${utterance.id} latency line`,
      ).catch(() => {});
    }
  } catch (error) {
    failure = error.message;
  } finally {
    await closeSocket(ws);
  }

  const firstMarker = (utterance.finals ?? [])[0];
  const firstEndpointFrame = firstMarker ? Math.round(firstMarker.afterMs / manifest.frameMs) : 0;
  const firstEndpointAt = firstEndpointFrame > 0 ? sentAt[firstEndpointFrame - 1] ?? null : null;

  return describeUtterance({
    utterance,
    sessionId: voiceSessionId,
    frames,
    logs,
    firstEndpointAt,
    firstBinaryAt,
    error: failure,
  });
}

export function summarizeReplay(utterances) {
  const outcomes = {};
  for (const utterance of utterances) {
    outcomes[utterance.outcome] = (outcomes[utterance.outcome] ?? 0) + 1;
  }
  const stages = {};
  for (const key of STAGE_KEYS) {
    const values = utterances
      .map((utterance) => utterance.stages?.[key])
      .filter((value) => Number.isFinite(value));
    if (values.length) {
      stages[key] = { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
    }
  }
  return {
    total: utterances.length,
    matched: utterances.filter((utterance) => utterance.match).length,
    outcomes,
    stages,
  };
}

function stageLabel(key) {
  return key.replace(/Ms$/, '');
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '-';
}

export function formatReplayReport(report) {
  const lines = [
    `voice-replay ${report.utterances.length} utterances engine=${report.engine}`
      + ` holdMs=${report.holdMs} sampleRate=${report.sampleRate} frameMs=${report.frameMs}`,
  ];
  for (const utterance of report.utterances) {
    lines.push(
      `voice-replay ${utterance.id} label=${utterance.label} outcome=${utterance.outcome}`
        + ` expected=${utterance.expected.outcome}`
        + ` utterances=${utterance.utterances}/${utterance.expected.utterances}`
        + ` match=${utterance.match ? 'yes' : 'no'}`
        + ` final=${utterance.finalText === null ? '-' : JSON.stringify(utterance.finalText)}`
        + ` reply=${utterance.replyText === null ? '-' : JSON.stringify(utterance.replyText)}`
        + ` stages ${STAGE_KEYS.map((key) => `${stageLabel(key)}=${formatMs(utterance.stages?.[key])}`).join(' ')}`,
    );
    if (utterance.error) lines.push(`voice-replay ${utterance.id} error=${utterance.error}`);
  }
  const summary = report.summary ?? summarizeReplay(report.utterances);
  const outcomes = Object.entries(summary.outcomes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `${outcome}:${count}`)
    .join(',');
  lines.push(
    `voice-replay summary total=${summary.total} matched=${summary.matched}`
      + ` outcomes=${outcomes || 'none'}`,
  );
  for (const key of STAGE_KEYS) {
    const stage = summary.stages[key];
    if (!stage) continue;
    lines.push(
      `voice-replay summary ${stageLabel(key)}`
        + ` p50=${formatMs(stage.p50)} p95=${formatMs(stage.p95)} count=${stage.count}`,
    );
  }
  return lines;
}

async function defaultRunTurn(_session, text, handlers) {
  handlers.onDelta(`Scripted reply to "${text}".`);
  return { hasContent: true };
}

/**
 * Replay every labelled utterance through one Gate media socket. Each
 * utterance gets its own call and session so the report can say which label
 * produced which outcome; the wire path is the one the phone uses.
 */
export async function runReplay({
  manifestPath = DEFAULT_MANIFEST_PATH,
  fixturesDir = undefined,
  holdMs = UTTERANCE_HOLD_MS,
  settleMs = DEFAULT_SETTLE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createEngine = null,
  runTurn = defaultRunTurn,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const manifest = loadManifest(manifestPath);
  const fixtures = ensureFixtures({
    manifestPath,
    outDir: fixturesDir ?? dirname(manifestPath),
  });
  const fixturesById = new Map(fixtures.files.map((file) => [file.id, file]));
  const logs = [];
  const registry = new VoiceSessionRegistry({ now });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const engineFor = createEngine
    ?? ((utterance) => new ReplayEngine({ finals: finalMarkers(utterance, { frameMs: manifest.frameMs }) }));
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: {
      verify: async (authorization) =>
        authorization === `Bearer ${REPLAY_TOKEN}` ? { deviceId: REPLAY_DEVICE_ID } : null,
    },
    registry,
    createEngine: (session) => engineFor(session.replayUtterance, session),
    runTurn,
    utteranceHoldMs: holdMs,
    now,
    log: (line) => {
      logs.push({ at: now(), line });
      log(line);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const results = [];

  try {
    for (let index = 0; index < manifest.utterances.length; index += 1) {
      const utterance = manifest.utterances[index];
      const voiceSessionId = `replay-${index}`;
      const fixture = fixturesById.get(utterance.id);
      if (!fixture) throw new Error(`voice-replay: no fixture was written for ${utterance.id}`);
      const decoded = decodeWav(readFileSync(fixture.path));
      if (decoded.sampleRate !== manifest.sampleRate) {
        throw new Error(
          `voice-replay: ${fixture.path} is ${decoded.sampleRate} Hz, manifest says ${manifest.sampleRate} Hz`,
        );
      }
      registry.create({
        voiceSessionId,
        deviceId: REPLAY_DEVICE_ID,
        engine: 'replay',
        replayUtterance: utterance,
      });
      results.push(await replayOne({
        utterance,
        voiceSessionId,
        port,
        pcm: decoded.pcm,
        manifest,
        settleMs,
        timeoutMs,
        logs,
        now,
      }));
    }
  } finally {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // already gone
      }
    }
    await new Promise((done) => {
      wss.close(() => server.close(done));
    });
  }

  return {
    engine: 'replay',
    holdMs,
    settleMs,
    manifestPath,
    sampleRate: manifest.sampleRate,
    frameMs: manifest.frameMs,
    startedAt: new Date(now()).toISOString(),
    utterances: results,
    summary: summarizeReplay(results),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = await runReplay({
    ...(args.manifestPath ? { manifestPath: args.manifestPath } : {}),
    ...(args.fixturesDir ? { fixturesDir: args.fixturesDir } : {}),
    holdMs: args.holdMs,
    settleMs: args.settleMs,
    timeoutMs: args.timeoutMs,
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatReplayReport(report)) console.log(line);
  return args.check && report.utterances.some((utterance) => !utterance.match) ? 1 : 0;
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
