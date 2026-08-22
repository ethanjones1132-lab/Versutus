import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateDir = join(__dirname, '..');
const cliPath = join(gateDir, 'cli.mjs');

/**
 * remove-environment is the headless counterpart of the phone's Remove and the
 * recovery path for a corrupt record. Every case runs the real CLI against an
 * isolated VERSUTUS_GATE_HOME so nothing here can touch a developer's real
 * environment records.
 */
async function makeGateHome() {
  return mkdtemp(join(tmpdir(), 'versutus-remove-env-'));
}

async function runCli(args, gateHome) {
  return new Promise((resolve) => {
    const proc = spawn('node', [cliPath, ...args], {
      cwd: gateDir,
      env: { ...process.env, VERSUTUS_GATE_HOME: gateHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeRecord(gateHome, id, body) {
  const dir = join(gateHome, 'config', 'environments');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  await writeFile(file, body, 'utf8');
  return file;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('removes an existing record and names the deleted file', async () => {
  const gateHome = await makeGateHome();
  try {
    const file = await writeRecord(gateHome, 'test-env', JSON.stringify({
      schemaVersion: 1, kind: 'cli-environment', id: 'test-env',
    }));

    const result = await runCli(['remove-environment', 'test-env'], gateHome);

    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stdout, /Removed CLI environment "test-env"/);
    assert.match(result.stdout, /no Gate restart needed/);
    assert.equal(await exists(file), false, 'record file should be gone');
  } finally {
    await rm(gateHome, { recursive: true, force: true });
  }
});

test('removes a record whose JSON is corrupt — the recovery path', async () => {
  // Presence is checked by filename, not by parse: a shredded record is the
  // incident this command exists for, and it must not be refused because the
  // app and doctor cannot read it.
  const gateHome = await makeGateHome();
  try {
    const file = await writeRecord(gateHome, 'shredded-env', '{"id": "shredded-env", "execut');

    const result = await runCli(['remove-environment', 'shredded-env'], gateHome);

    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stdout, /Removed CLI environment "shredded-env"/);
    assert.equal(await exists(file), false, 'corrupt record file should be gone');
  } finally {
    await rm(gateHome, { recursive: true, force: true });
  }
});

test('an unknown environment fails and names where it looked', async () => {
  const gateHome = await makeGateHome();
  try {
    const result = await runCli(['remove-environment', 'ghost'], gateHome);

    assert.equal(result.code, 1, 'unknown id should exit 1');
    assert.match(result.stderr, /no environment "ghost" found/);
    assert.match(result.stderr, /config[/\\]environments/);
    assert.match(result.stderr, /doctor/);
  } finally {
    await rm(gateHome, { recursive: true, force: true });
  }
});

test('an invalid id is rejected before anything is deleted', async () => {
  const gateHome = await makeGateHome();
  try {
    // A healthy record sits next to the target: validation must refuse the
    // traversal attempt without touching it.
    const safe = await writeRecord(gateHome, 'safe-env', '{}');

    const result = await runCli(['remove-environment', '../evil'], gateHome);

    assert.equal(result.code, 1, 'path traversal should exit 1');
    assert.match(result.stderr, /environment id must be lowercase alphanumeric with hyphens/);
    assert.equal(await exists(safe), true, 'the unrelated record must survive');
  } finally {
    await rm(gateHome, { recursive: true, force: true });
  }
});

test('a missing id prints usage', async () => {
  const gateHome = await makeGateHome();
  try {
    const result = await runCli(['remove-environment'], gateHome);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: node gate\/cli\.mjs remove-environment <id>/);
  } finally {
    await rm(gateHome, { recursive: true, force: true });
  }
});
