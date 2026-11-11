// ─── Synthetic replay fixtures for the Gate voice harness ─────────────────
// A replay must be repeatable on a host with no third-party clips, so the
// corpus is a manifest of labels and synthesis instructions rather than
// recorded audio. `ensureFixtures` renders the WAV files from it; the replay
// harness calls that before a run, so a checkout with no fixture files still
// replays the same bytes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_SAMPLE_RATE = 16000;
export const FIXTURE_FRAME_MS = 20;
export const FIXTURE_CHANNELS = 1;
export const FIXTURE_BITS_PER_SAMPLE = 16;

/** PCM16LE mono bytes that carry one frame of audio at this rate. */
export function frameBytesFor(sampleRate = FIXTURE_SAMPLE_RATE, frameMs = FIXTURE_FRAME_MS) {
  return ((sampleRate * frameMs) / 1000) * (FIXTURE_BITS_PER_SAMPLE / 8);
}

export const FIXTURE_FRAME_BYTES = frameBytesFor(FIXTURE_SAMPLE_RATE, FIXTURE_FRAME_MS);
export const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL('./fixtures/voice-replay/manifest.json', import.meta.url),
);
export const REPLAY_OUTCOMES = Object.freeze(['answered', 'failed', 'no-final', 'timeout']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  throw new Error(`voice-replay manifest: ${message}`);
}

function requireInteger(value, field, { min = 1 } = {}) {
  if (!Number.isInteger(value) || value < min) fail(`${field} must be an integer >= ${min} (got ${value})`);
  return value;
}

/**
 * Check the labelled corpus and fill in the defaults a fixture may omit. The
 * manifest is data other people will edit, so a bad recipe fails loudly here
 * rather than rendering a WAV of the wrong length and reporting a false replay.
 */
export function validateManifest(document, source = 'manifest') {
  if (!isRecord(document)) fail(`${source} must be an object`);
  const sampleRate = requireInteger(document.sampleRate ?? FIXTURE_SAMPLE_RATE, 'sampleRate');
  const frameMs = requireInteger(document.frameMs ?? FIXTURE_FRAME_MS, 'frameMs');
  if (!Array.isArray(document.utterances) || document.utterances.length === 0) {
    fail('utterances must be a non-empty array');
  }

  const ids = new Set();
  const utterances = document.utterances.map((utterance, index) => {
    if (!isRecord(utterance)) fail(`utterances[${index}] must be an object`);
    if (typeof utterance.id !== 'string' || !/^[a-z0-9-]+$/.test(utterance.id)) {
      fail(`utterances[${index}].id must be lowercase letters, digits or dashes`);
    }
    if (ids.has(utterance.id)) fail(`duplicate utterance id: ${utterance.id}`);
    ids.add(utterance.id);
    if (typeof utterance.label !== 'string' || !utterance.label.trim()) {
      fail(`${utterance.id}.label must be a non-empty string`);
    }
    if (!Array.isArray(utterance.segments) || utterance.segments.length === 0) {
      fail(`${utterance.id}.segments must be a non-empty array`);
    }

    let totalMs = 0;
    const segments = utterance.segments.map((segment, segmentIndex) => {
      const where = `${utterance.id}.segments[${segmentIndex}]`;
      if (!isRecord(segment)) fail(`${where} must be an object`);
      if (segment.kind !== 'silence' && segment.kind !== 'tone') {
        fail(`${where}.kind must be silence or tone`);
      }
      const ms = requireInteger(segment.ms, `${where}.ms`);
      if (ms % frameMs !== 0) fail(`${where}.ms must be a multiple of ${frameMs}`);
      totalMs += ms;
      if (segment.kind === 'silence') return { kind: 'silence', ms };
      const hz = segment.hz ?? 440;
      const amplitude = segment.amplitude ?? 0.2;
      if (!Number.isFinite(hz) || hz <= 0 || hz >= sampleRate / 2) {
        fail(`${where}.hz must be between 0 and ${sampleRate / 2} (got ${hz})`);
      }
      if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 1) {
        fail(`${where}.amplitude must be greater than 0 and at most 1 (got ${amplitude})`);
      }
      return { kind: 'tone', ms, hz, amplitude };
    });

    if (totalMs % frameMs !== 0) fail(`${utterance.id} must be a whole number of ${frameMs} ms frames`);
    if (utterance.finals !== undefined && !Array.isArray(utterance.finals)) {
      fail(`${utterance.id}.finals must be an array`);
    }
    const finals = utterance.finals ?? [];
    let previousMs = 0;
    const normalizedFinals = finals.map((final, finalIndex) => {
      const where = `${utterance.id}.finals[${finalIndex}]`;
      if (!isRecord(final)) fail(`${where} must be an object`);
      const afterMs = requireInteger(final.afterMs, `${where}.afterMs`);
      if (afterMs % frameMs !== 0) fail(`${where}.afterMs must be a multiple of ${frameMs}`);
      if (afterMs > totalMs) fail(`${where}.afterMs is past the end of the fixture (${totalMs} ms)`);
      if (afterMs <= previousMs) fail(`${where}.afterMs must be later than the previous endpoint`);
      previousMs = afterMs;
      if (typeof final.text !== 'string' || !final.text.trim()) {
        fail(`${where}.text must be a non-empty string`);
      }
      return { afterMs, text: final.text.trim() };
    });

    let expect;
    if (utterance.expect !== undefined) {
      if (!isRecord(utterance.expect)) fail(`${utterance.id}.expect must be an object`);
      const outcome = utterance.expect.outcome;
      if (outcome !== undefined && !REPLAY_OUTCOMES.includes(outcome)) {
        fail(`${utterance.id}.expect.outcome must be one of ${REPLAY_OUTCOMES.join(', ')}`);
      }
      const expectedUtterances = utterance.expect.utterances;
      if (expectedUtterances !== undefined) {
        requireInteger(expectedUtterances, `${utterance.id}.expect.utterances`, { min: 0 });
      }
      expect = {
        ...(outcome !== undefined ? { outcome } : {}),
        ...(expectedUtterances !== undefined ? { utterances: expectedUtterances } : {}),
      };
    }

    return {
      ...utterance,
      segments,
      finals: normalizedFinals,
      ...(expect ? { expect } : {}),
    };
  });

  return { ...document, sampleRate, frameMs, utterances };
}

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')), path);
}

/** The frame indexes at which a scripted engine should emit this fixture's finals. */
export function finalMarkers(utterance, { frameMs = FIXTURE_FRAME_MS } = {}) {
  return (utterance.finals ?? []).map((final) => ({
    afterFrame: Math.round(final.afterMs / frameMs),
    text: final.text,
  }));
}

/** Render one utterance as raw PCM16LE mono at the manifest's sample rate. */
export function renderUtterancePcm(utterance, { sampleRate = FIXTURE_SAMPLE_RATE } = {}) {
  const samples = utterance.segments.reduce(
    (total, segment) => total + Math.round((segment.ms * sampleRate) / 1000),
    0,
  );
  const pcm = Buffer.alloc(samples * 2);
  let written = 0;
  for (const segment of utterance.segments) {
    const count = Math.round((segment.ms * sampleRate) / 1000);
    if (segment.kind === 'tone') {
      for (let index = 0; index < count; index += 1) {
        const value = Math.sin((2 * Math.PI * segment.hz * index) / sampleRate);
        // The amplitude stays at or below 1, so the clamp is only a guard
        // against a future recipe that stacks something on the tone.
        const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767 * segment.amplitude)));
        pcm.writeInt16LE(sample, (written + index) * 2);
      }
    }
    written += count;
  }
  return pcm;
}

/** Wrap raw PCM16LE mono in a 44-byte canonical WAV header. */
export function encodeWav(pcm, { sampleRate = FIXTURE_SAMPLE_RATE, channels = FIXTURE_CHANNELS } = {}) {
  if (pcm.length % 2 !== 0) throw new Error('voice-replay WAV: PCM16 data must be an even number of bytes');
  const bytesPerSample = FIXTURE_BITS_PER_SAMPLE / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(FIXTURE_BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Read back the WAV this module writes, refusing anything the harness cannot replay. */
export function decodeWav(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('voice-replay WAV: not a RIFF/WAVE file');
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) throw new Error(`voice-replay WAV: truncated ${id.trim()} chunk`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('voice-replay WAV: short fmt chunk');
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
    }
    // Chunks are word-aligned: an odd-sized chunk has one pad byte.
    offset = body + size + (size % 2);
  }
  if (!format) throw new Error('voice-replay WAV: missing fmt chunk');
  if (!data) throw new Error('voice-replay WAV: missing data chunk');
  if (format.audioFormat !== 1) throw new Error('voice-replay WAV: only PCM is supported');
  if (format.channels !== FIXTURE_CHANNELS) throw new Error('voice-replay WAV: only mono is supported');
  if (format.bitsPerSample !== FIXTURE_BITS_PER_SAMPLE) throw new Error('voice-replay WAV: only 16-bit is supported');
  return { ...format, pcm: Buffer.from(data) };
}

/**
 * Render every labelled WAV next to the manifest (or into `outDir`). A file
 * that already matches is left alone, so a run does not churn the tree; with
 * `check` nothing is written and `stale` names what a writer would replace.
 */
export function ensureFixtures({
  manifestPath = DEFAULT_MANIFEST_PATH,
  outDir = dirname(manifestPath),
  force = false,
  check = false,
} = {}) {
  const manifest = loadManifest(manifestPath);
  if (!check) mkdirSync(outDir, { recursive: true });
  const files = [];
  const written = [];
  const stale = [];
  for (const utterance of manifest.utterances) {
    const path = join(outDir, `${utterance.id}.wav`);
    const bytes = encodeWav(renderUtterancePcm(utterance, manifest), { sampleRate: manifest.sampleRate });
    files.push({ id: utterance.id, path, bytes });
    let existing = null;
    try {
      existing = readFileSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (force || !existing || !existing.equals(bytes)) {
      stale.push(path);
      if (!check) {
        writeFileSync(path, bytes);
        written.push(path);
      }
    }
  }
  return { manifest, manifestPath, outDir, files, written, stale };
}

export function parseArgs(argv) {
  const args = { force: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--force') args.force = true;
    else if (token === '--check') args.check = true;
    else if (token === '--manifest' || token === '--out') {
      if (index + 1 >= argv.length) throw new Error(`${token} needs a value`);
      const value = argv[index + 1];
      index += 1;
      if (token === '--manifest') args.manifestPath = value;
      else args.outDir = value;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = ensureFixtures({
    ...(args.manifestPath ? { manifestPath: args.manifestPath } : {}),
    ...(args.outDir ? { outDir: args.outDir } : {}),
    force: args.force,
    check: args.check,
  });
  for (const file of result.files) console.log(`voice-replay fixture ${file.id} -> ${file.path}`);
  if (result.stale.length) {
    console.error(
      args.check
        ? `voice-replay fixtures are stale: ${result.stale.join(', ')}`
        : `voice-replay rewrote ${result.stale.length} fixture(s)`,
    );
  }
  return args.check && result.stale.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
