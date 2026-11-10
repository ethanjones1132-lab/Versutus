// `voice doctor` must prove the three call models load, not just imports and
// Whisper: a worker with no Silero, no Smart Turn (the degraded "pause is a
// turn" judge) or no Kokoro still answers the Gate, so the doctor is the only
// place that can fail loudly. The probe's stdout is faked the same way the
// existing doctor tests fake it (voice-runtime.test.mjs), so no Python runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { voiceDoctor, voicePaths } from '../core/voice/runtime.mjs';

function doctorPaths() {
  const home = mkdtempSync(join(tmpdir(), 'voice-doctor-models-'));
  const paths = voicePaths({ VERSUTUS_GATE_HOME: home }, 'linux');
  mkdirSync(join(paths.venv, 'bin'), { recursive: true });
  mkdirSync(paths.models, { recursive: true });
  writeFileSync(paths.python, '#!/bin/sh');
  // The models the lock requires, so the separate `models` check passes and a
  // failure in these tests can only come from the load probes.
  for (const name of ['kokoro-v1.0.onnx', 'voices-v1.0.bin', 'smart-turn-v3.2-cpu.onnx']) {
    writeFileSync(join(paths.models, name), 'model');
  }
  return paths;
}

const HEALTHY_PROBE = {
  versions: { faster_whisper: '1.2.1', kokoro_onnx: '0.6.1', onnxruntime: '1.30.0' },
  vram: { usedMb: 100, totalMb: 8000 },
  whisperCuda: { ok: true },
  silero: { ok: true, error: null },
  smartTurn: { ok: true, error: null },
  kokoro: { ok: true, error: null },
  error: null,
};

function probeSpawn(info) {
  return () => ({ status: 0, stdout: JSON.stringify(info), stderr: '' });
}

function checkNamed(report, name) {
  const check = report.checks.find((entry) => entry.name === name);
  assert.ok(check, `expected a check named ${name}`);
  return check;
}

test('voice doctor passes when Silero VAD, Smart Turn and Kokoro all load', () => {
  const report = voiceDoctor({ paths: doctorPaths(), spawnSync: probeSpawn(HEALTHY_PROBE), log: () => {} });
  for (const name of ['silero', 'smartTurn', 'kokoro']) {
    const check = checkNamed(report, name);
    assert.equal(check.ok, true, `${name} should pass`);
    assert.ok(typeof check.detail === 'string' && check.detail.length > 0, `${name} has a detail`);
    assert.ok(!check.detail.includes('\n'), `${name}'s detail is one line`);
  }
  assert.equal(report.ok, true);
});

test('one model failing names itself while the other two still report', () => {
  let spawns = 0;
  const report = voiceDoctor({
    paths: doctorPaths(),
    spawnSync: () => {
      spawns += 1;
      return probeSpawn({
        ...HEALTHY_PROBE,
        kokoro: { ok: false, error: 'Kokoro model/voices not found under C:/voice/models' },
      })();
    },
    log: () => {},
  });
  const kokoro = checkNamed(report, 'kokoro');
  assert.equal(kokoro.ok, false);
  assert.match(kokoro.detail, /Kokoro model\/voices not found/);
  assert.match(kokoro.detail, /voice install/);
  // A failed model must not take the healthy ones down with it.
  assert.equal(checkNamed(report, 'silero').ok, true);
  assert.equal(checkNamed(report, 'smartTurn').ok, true);
  assert.equal(report.ok, false);
  assert.equal(spawns, 1, 'one probe run reports every model');
});

test('invalid probe JSON is a named failure and never a model pass', () => {
  const report = voiceDoctor({
    paths: doctorPaths(),
    spawnSync: () => ({ status: 0, stdout: 'not json at all', stderr: '' }),
    log: () => {},
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.at(-1), { name: 'probe', ok: false, detail: 'not json at all' });
  const modelNames = ['silero', 'smartTurn', 'kokoro'];
  assert.equal(
    report.checks.some((check) => modelNames.includes(check.name)),
    false,
    'nothing unmeasured is reported as loaded',
  );
});

test('a model the probe never reported fails instead of passing', () => {
  const report = voiceDoctor({
    paths: doctorPaths(),
    // JSON.stringify drops undefined keys: the probe answered, without smartTurn.
    spawnSync: probeSpawn({ ...HEALTHY_PROBE, smartTurn: undefined }),
    log: () => {},
  });
  const smartTurn = checkNamed(report, 'smartTurn');
  assert.equal(smartTurn.ok, false);
  assert.match(smartTurn.detail, /did not run/);
  assert.equal(checkNamed(report, 'silero').ok, true);
  assert.equal(checkNamed(report, 'kokoro').ok, true);
  assert.equal(report.ok, false);
});
