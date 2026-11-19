import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeReplayCase, summarizeReplay, validateCorpus } from '../../scripts/voice-replay-host.mjs';

test('real PCM sidecars name an utterance, not a scripted recognition result', () => {
  const clip = { id: 'read-1', wav: 'recorded.wav', kind: 'speech', reference: 'Hello world.', speechEndMs: 1200 };
  assert.deepEqual(validateCorpus({ version: 1, clips: [clip] }).clips, [clip]);
  assert.throws(() => validateCorpus({ version: 1, clips: [{ ...clip, wav: '../outside.wav' }] }), /WAV/);
  assert.throws(() => validateCorpus({ version: 1, clips: [{ ...clip, reference: '' }] }), /reference/);
});

test('timings use the worker EoS and post-gap playback; a cancelled early answer is counted only if played', () => {
  const clip = { id: 'pause-1', kind: 'speech', reference: 'Hi there', pauseMs: 1500, speechEndMs: 3000 };
  const commits = [
    { turnId: 'turn-1', text: 'Hi', atMs: 1800, eosToCommitMs: 600 },
    { turnId: 'turn-2', text: 'Hi there', atMs: 3800, eosToCommitMs: 700 },
  ];
  const base = { clip, durationMs: 3000, startedAtMs: 0, commits, completed: new Set(['turn-2']) };
  const reply = { turnId: 'turn-2', atMs: 4200 };
  const merged = describeReplayCase({ ...base, plays: [reply] });
  assert.equal(merged.split, false);
  assert.equal(merged.f1OverheadMs, 1100);
  assert.equal(merged.eosToCommitMs, 700);
  assert.equal(describeReplayCase({ ...base, plays: [{ turnId: 'turn-1', atMs: 2400 }, reply] }).split, true);
});

test('missed speech counts toward F6 and F7; rates use exposure, not case count', () => {
  const clean = { id: 'clean', kind: 'speech', reference: 'Hello world', speechEndMs: 1600 };
  const miss = describeReplayCase({ clip: clean, durationMs: 1600, startedAtMs: 0 });
  const rows = [miss,
    { kind: 'noise', noiseKind: 'tv', durationMs: 300_000, commits: 1 },
    { kind: 'echo', playedReplies: 1, echoBargeIns: 1, commits: 0 },
  ];
  const result = summarizeReplay(rows);
  assert.equal(result.F1.overheadMs.n, 0);
  assert.equal(result.F6.within1200Ms, 0);
  assert.equal(result.F7.wer, 1);
  assert.equal(result.F5.noise.tv.commitsPer10Min, 2);
  assert.equal(result.F5.noise.tv.enoughExposure, false);
  assert.equal(result.F5.echo.bargeInsPer20, 20);
});
