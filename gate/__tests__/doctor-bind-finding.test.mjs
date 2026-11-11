import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'cli.mjs');

/** Run the real CLI with a substituted environment, as the driver's shell would. */
async function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cliPath, ...args], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('gate doctor reports a plaintext bind as a warning, and says when it was acknowledged', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-doctor-bind-'));
  try {
    const plain = await runCli(
      ['doctor', '--host', '0.0.0.0', '--port', '1'],
      { VERSUTUS_GATE_HOME: dir, VERSUTUS_GATE_ALLOW_PLAINTEXT: '' },
    );
    assert.match(plain.stdout, /WARN — bind 0\.0\.0\.0 exposes bearer tokens over plain HTTP/);
    assert.match(plain.stdout, /without --allow-plaintext/);
    assert.doesNotMatch(plain.stdout, /ERROR — bind 0\.0\.0\.0/);

    const acknowledged = await runCli(
      ['doctor', '--host', '0.0.0.0', '--port', '1', '--allow-plaintext'],
      { VERSUTUS_GATE_HOME: dir, VERSUTUS_GATE_ALLOW_PLAINTEXT: '' },
    );
    assert.match(acknowledged.stdout, /WARN — bind 0\.0\.0\.0 exposes bearer tokens over plain HTTP/);
    assert.match(acknowledged.stdout, /\(acknowledged with --allow-plaintext\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
