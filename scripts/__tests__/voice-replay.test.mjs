import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UTTERANCE_HOLD_MS } from '../../gate/core/voice/media-socket.mjs';
import {
  FIXTURE_FRAME_BYTES,
  FIXTURE_SAMPLE_RATE,
  decodeWav,
  encodeWav,
  ensureFixtures,
  finalMarkers,
  loadManifest,
  renderUtterancePcm,
  validateManifest,
} from '../voice-replay-fixtures.mjs';
import {
  ReplayEngine,
  formatReplayReport,
  main,
  parseArgs,
  runReplay,
} from '../voice-replay.mjs';

async function withCorpus(utterances, run) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-replay-'));
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ sampleRate: FIXTURE_SAMPLE_RATE, frameMs: 20, utterances }));
  try {
    return await run({ dir, manifestPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ONE_TONE = {
  id: 'one-tone',
  label: 'tone',
  segments: [{ kind: 'tone', ms: 200, hz: 440, amplitude: 0.2 }],
  finals: [{ afterMs: 200, text: 'hello replay' }],
  expect: { outcome: 'answered', utterances: 1 },
};

const ONE_SILENCE = {
  id: 'one-silence',
  label: 'silence',
  segments: [{ kind: 'silence', ms: 200 }],
  finals: [],
  expect: { outcome: 'no-final', utterances: 0 },
};

const ONE_PAUSE = {
  id: 'one-pause',
  label: 'thinking-pause',
  segments: [
    { kind: 'tone', ms: 60, hz: 440, amplitude: 0.2 },
    { kind: 'silence', ms: 200 },
    { kind: 'tone', ms: 60, hz: 440, amplitude: 0.2 },
  ],
  finals: [
    { afterMs: 60, text: 'first half' },
    { afterMs: 320, text: 'second half' },
  ],
  expect: { outcome: 'answered', utterances: 1 },
};

test('the labelled corpus names each fixture and what its replay should produce', () => {
  const manifest = loadManifest();
  assert.equal(manifest.sampleRate, FIXTURE_SAMPLE_RATE);
  assert.deepEqual(
    manifest.utterances.map((utterance) => utterance.id),
    ['silence-200ms', 'tone-300ms', 'tone-pause-tone'],
  );
  assert.equal(manifest.utterances[0].expect.outcome, 'no-final');
  assert.equal(manifest.utterances[2].finals.length, 2);
  assert.equal(manifest.utterances[2].expect.utterances, 1);
  assert.deepEqual(finalMarkers(manifest.utterances[2], { frameMs: manifest.frameMs }), [
    { afterFrame: 13, text: 'first half' },
    { afterFrame: 86, text: 'second half' },
  ]);
  assert.throws(() => validateManifest({ utterances: [] }), /non-empty/);
});

test('a generated tone is repeatable and round-trips through the WAV the harness reads', () => {
  const manifest = loadManifest();
  const utterance = manifest.utterances.find((candidate) => candidate.id === 'tone-300ms');
  const pcm = renderUtterancePcm(utterance, manifest);

  assert.equal(pcm.length, (manifest.sampleRate * 300 / 1000) * 2);
  assert.deepEqual(renderUtterancePcm(utterance, manifest), pcm);
  assert.ok(pcm.some((byte) => byte !== 0), 'a tone is not silence');

  const wav = encodeWav(pcm, manifest);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, manifest.sampleRate);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.bitsPerSample, 16);
  assert.deepEqual(decoded.pcm, pcm);
  assert.throws(() => decodeWav(Buffer.from('not a wav')), /not a RIFF/);
});

test('ensureFixtures writes each labelled WAV once and rewrites only a changed one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-replay-fixtures-'));
  try {
    const first = ensureFixtures({ outDir: dir });
    assert.deepEqual(
      first.files.map((file) => basename(file.path)),
      ['silence-200ms.wav', 'tone-300ms.wav', 'tone-pause-tone.wav'],
    );
    assert.equal(first.written.length, 3);

    const second = ensureFixtures({ outDir: dir });
    assert.deepEqual(second.written, []);

    const target = join(dir, 'tone-300ms.wav');
    await writeFile(target, 'changed');
    const checked = ensureFixtures({ outDir: dir, check: true });
    assert.deepEqual(checked.stale, [target]);
    assert.deepEqual(checked.written, []);
    assert.equal(readFileSync(target, 'utf8'), 'changed');

    const repaired = ensureFixtures({ outDir: dir });
    assert.deepEqual(repaired.written, [target]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the replay engine emits a final at each labelled endpoint and nowhere else', async () => {
  const engine = new ReplayEngine({
    finals: [
      { afterFrame: 2, text: 'one' },
      { afterFrame: 4, text: 'two' },
    ],
  });
  const finals = [];
  engine.on('final', (event) => finals.push(event));
  await engine.open();
  for (let frame = 0; frame < 5; frame += 1) engine.pushAudio(Buffer.alloc(FIXTURE_FRAME_BYTES));

  assert.deepEqual(finals.map((event) => event.text), ['one', 'two']);
  assert.ok(finals.every((event) => Number.isFinite(event.eosMs) && event.decodeMs === 0));
});

test('a labelled tone replays through the Gate and reports every stage', async () => {
  await withCorpus([ONE_TONE], async ({ dir, manifestPath }) => {
    const report = await runReplay({
      manifestPath,
      fixturesDir: dir,
      holdMs: 0,
      settleMs: 50,
      timeoutMs: 5000,
    });
    assert.equal(report.utterances.length, 1);
    const row = report.utterances[0];

    assert.equal(row.outcome, 'answered');
    assert.equal(row.match, true);
    assert.equal(row.utterances, 1);
    assert.equal(row.finalText, 'hello replay');
    assert.match(row.replyText, /hello replay/);
    assert.equal(row.error, null);

    for (const key of [
      'audioEndToEngineFinalMs',
      'engineFinalToCommitMs',
      'commitToFinalFrameMs',
      'finalFrameToFirstReplyMs',
      'finalFrameToFirstSpeechMs',
      'commitToFirstReplyMs',
      'commitToFirstSpeechMs',
      'eosToCommitMs',
      'sentenceToPcmMs',
      'playedMs',
    ]) {
      assert.ok(Number.isFinite(row.stages[key]), `${key} should be measured, got ${row.stages[key]}`);
      assert.ok(row.stages[key] >= 0, `${key} should not be negative, got ${row.stages[key]}`);
    }
    assert.equal(row.stages.decodeMs, 0);
  });
});

test('a labelled silence produces no final and no turn', async () => {
  await withCorpus([ONE_SILENCE], async ({ dir, manifestPath }) => {
    const report = await runReplay({
      manifestPath,
      fixturesDir: dir,
      holdMs: 0,
      settleMs: 100,
      timeoutMs: 5000,
    });
    const row = report.utterances[0];

    assert.equal(row.outcome, 'no-final');
    assert.equal(row.utterances, 0);
    assert.equal(row.match, true);
    assert.equal(row.finalText, null);
  });
});

test('a fixture whose outcome contradicts its label is reported as a mismatch', async () => {
  const mismatched = { ...ONE_SILENCE, expect: { outcome: 'answered', utterances: 0 } };
  await withCorpus([mismatched], async ({ dir, manifestPath }) => {
    const report = await runReplay({
      manifestPath,
      fixturesDir: dir,
      holdMs: 0,
      settleMs: 100,
      timeoutMs: 5000,
    });
    const row = report.utterances[0];

    assert.equal(row.outcome, 'no-final');
    assert.equal(row.match, false);
    assert.equal(report.summary.matched, 0);
  });
});

test('a pause is gathered into one turn by the hold and split into two when the hold is zero', async () => {
  await withCorpus([ONE_PAUSE], async ({ dir, manifestPath }) => {
    const merged = await runReplay({
      manifestPath,
      fixturesDir: dir,
      holdMs: 800,
      settleMs: 50,
      timeoutMs: 5000,
    });
    assert.equal(merged.utterances[0].utterances, 1);
    assert.equal(merged.utterances[0].finalText, 'first half second half');
    assert.equal(merged.utterances[0].match, true);
  });

  await withCorpus([{ ...ONE_PAUSE, expect: { outcome: 'answered', utterances: 2 } }], async ({ dir, manifestPath }) => {
    const split = await runReplay({
      manifestPath,
      fixturesDir: dir,
      holdMs: 0,
      settleMs: 50,
      timeoutMs: 5000,
    });
    assert.equal(split.utterances[0].utterances, 2);
    assert.equal(split.utterances[0].finalText, 'first half | second half');
    assert.equal(split.utterances[0].match, true);
  });
});

test('the report prints one labelled line per utterance and a stage summary', () => {
  const report = {
    engine: 'replay',
    holdMs: 0,
    sampleRate: FIXTURE_SAMPLE_RATE,
    frameMs: 20,
    utterances: [
      {
        id: 'a',
        label: 'tone',
        outcome: 'answered',
        utterances: 1,
        expected: { outcome: 'answered', utterances: 1 },
        match: true,
        finalText: 'one',
        replyText: 'reply',
        error: null,
        stages: { finalFrameToFirstSpeechMs: 10, playedMs: 20 },
      },
      {
        id: 'b',
        label: 'silence',
        outcome: 'no-final',
        utterances: 0,
        expected: { outcome: 'no-final', utterances: 0 },
        match: true,
        finalText: null,
        replyText: null,
        error: null,
        stages: {},
      },
    ],
  };

  const lines = formatReplayReport(report).join('\n');
  assert.match(lines, /voice-replay a label=tone outcome=answered expected=answered utterances=1\/1 match=yes/);
  assert.match(lines, /voice-replay b label=silence outcome=no-final expected=no-final utterances=0\/0 match=yes/);
  assert.match(lines, /voice-replay summary total=2 matched=2 outcomes=answered:1,no-final:1/);
  assert.match(lines, /voice-replay summary finalFrameToFirstSpeech p50=10ms p95=10ms count=1/);
});

test('replay options reject missing, negative or non-integer values', () => {
  assert.throws(() => parseArgs(['--hold-ms']), /needs a value/);
  for (const argv of [
    ['--hold-ms', '-1'],
    ['--hold-ms', '2.5'],
    ['--settle-ms', 'abc'],
    ['--timeout-ms', '0'],
  ]) {
    assert.throws(() => parseArgs(argv), /must be an integer/, `argv ${JSON.stringify(argv)}`);
  }
  assert.equal(parseArgs([]).holdMs, UTTERANCE_HOLD_MS);
  assert.equal(parseArgs(['--hold-ms', '0']).holdMs, 0);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('the CLI prints the report for a replay', async (t) => {
  const logged = [];
  t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));

  await withCorpus([ONE_TONE], async ({ dir, manifestPath }) => {
    const code = await main([
      '--manifest', manifestPath,
      '--fixtures', dir,
      '--hold-ms', '0',
      '--settle-ms', '50',
      '--timeout-ms', '5000',
    ]);
    assert.equal(code, 0);
  });

  assert.ok(
    logged.some((line) => /voice-replay one-tone label=tone outcome=answered/.test(line)),
    logged.join('\n'),
  );
});
