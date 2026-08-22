import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diagnoseEnvironmentRecords, probeLocalGate } from '../core/service/diagnostics.mjs';
import { doctor } from '../core/service/doctor.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

async function withEnvironmentsDir(recordFiles) {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-doctor-'));
  const envDir = join(gateHome, 'config', 'environments');
  await mkdir(envDir, { recursive: true });
  for (const [name, contents] of Object.entries(recordFiles)) {
    await writeFile(join(envDir, name), contents, 'utf8');
  }
  return { gateHome, envDir };
}

test('reports ok for a healthy record whose executable exists on disk', async () => {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-doctor-'));
  const envDir = join(gateHome, 'config', 'environments');
  await mkdir(envDir, { recursive: true });
  // The fixture's C:\Tools path does not exist here, so point the record at a
  // real file inside the temp home — doctor must check the disk, not the string.
  const executable = join(gateHome, 'fake-cli.exe');
  await writeFile(executable, '', 'utf8');
  const record = validEnvironment({ executable: { path: executable } });
  await writeFile(join(envDir, 'hermes-local.json'), JSON.stringify(record), 'utf8');

  const findings = await diagnoseEnvironmentRecords(envDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'ok');
  assert.equal(findings[0].environment, 'hermes-local');

  await rm(gateHome, { recursive: true, force: true });
});

test('flags the path-shredding corruption signature found on disk', async () => {
  const corrupted = validEnvironment({
    executable: { path: 'C:UsersethanAppDataLocalhermeshermes-agent\u000benvScriptspython.exe' },
  });
  const { envDir } = await withEnvironmentsDir({
    'hermes-local.json': JSON.stringify(corrupted),
  });

  const findings = await diagnoseEnvironmentRecords(envDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /control characters/);
});

test('flags an unparseable record', async () => {
  const { envDir } = await withEnvironmentsDir({
    'broken.json': '{ not json',
  });

  const findings = await diagnoseEnvironmentRecords(envDir);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /does not parse as JSON/);
});

test('flags a record whose executable is missing from disk', async () => {
  const record = validEnvironment();
  const { envDir } = await withEnvironmentsDir({
    'codex-dev.json': JSON.stringify(record),
  });

  const findings = await diagnoseEnvironmentRecords(envDir);
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /does not exist on disk/);
  assert.match(findings[0].message, /C:\\Tools\\hermes\.exe/);
});

test('reports an absent environments directory as info, not failure', async () => {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-doctor-'));
  const findings = await diagnoseEnvironmentRecords(join(gateHome, 'config', 'environments'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  await rm(gateHome, { recursive: true, force: true });
});

test('doctor renders environment findings without leaking secrets', () => {
  const report = doctor({
    user: 'DESKTOP\\ethan',
    gateHome: 'C:\\Users\\ethan\\AppData\\Local\\Versutus\\Gate',
    listen: 'http://127.0.0.1:8760',
    pid: 4242,
    serverProbe: { reachable: false, detail: 'ECONNREFUSED' },
    environmentFindings: [
      { severity: 'ok', environment: 'hermes-local', message: 'record valid, executable present (hermes)' },
      { severity: 'error', environment: 'codex-dev', message: 'record failed validation: executable.path contains control characters' },
    ],
  });
  assert.match(report, /environment records:/);
  assert.match(report, /hermes-local: ok/);
  assert.match(report, /codex-dev: ERROR — record failed validation/);
  assert.match(report, /NOT REACHABLE/);
  assert.equal(report.includes('token'), false);
});

test('doctor keeps the legacy report shape when no diagnostics are passed', () => {
  const report = doctor({
    user: 'DESKTOP\\ethan',
    gateHome: 'C:\\Users\\ethan\\AppData\\Local\\Versutus\\Gate',
    listen: 'http://127.0.0.1:8760',
    pid: 4242,
  });
  assert.match(report, /probes: health manifest providers models environments/);
  assert.doesNotMatch(report, /environment records:/);
});

test('local probe reports a running Gate and an unreachable one honestly', async () => {
  const running = await probeLocalGate('http://127.0.0.1:8760/.well-known/gateway.json', async () => ({
    ok: true,
    status: 200,
  }));
  assert.deepEqual(running, { reachable: true, detail: 'manifest answered 200' });

  const down = await probeLocalGate('http://127.0.0.1:8760/.well-known/gateway.json', async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8760');
  });
  assert.equal(down.reachable, false);
  assert.match(down.detail, /ECONNREFUSED/);

  const wrong = await probeLocalGate('http://127.0.0.1:8760/.well-known/gateway.json', async () => ({
    ok: false,
    status: 502,
  }));
  assert.equal(wrong.reachable, false);
  assert.match(wrong.detail, /502/);
});
