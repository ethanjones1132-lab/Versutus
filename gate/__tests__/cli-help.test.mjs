import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateDir = join(__dirname, '..');
const cliPath = join(gateDir, 'cli.mjs');

/**
 * The CLI help is an operator-first artifact: it must name the variable that
 * makes a second Gate actually startable beside a production one. The instance
 * lock is taken per gate home, so `--port <n>` alone is NOT enough — a demo
 * Gate sharing the default home refuses to start ("Gate instance lock is
 * already held"). Regression pin for rook MEDIUM a837b0d (docs must name
 * VERSUTUS_GATE_HOME for the 2nd instance).
 */
async function runHelp() {
  return new Promise((resolve) => {
    const proc = spawn('node', [cliPath, '--help'], {
      cwd: gateDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI help names VERSUTUS_GATE_HOME for a second/demo Gate', async () => {
  const { code, stdout } = await runHelp();
  assert.equal(code, 0);
  assert.match(stdout, /VERSUTUS_GATE_HOME/);
  // The start section must say the second instance needs its own home, not
  // just another port — otherwise an operator follows the old promise and the
  // per-home instance lock refuses to start.
  assert.match(stdout, /second instance also needs its own[\s\S]*home/);
  assert.match(stdout, /instance lock is taken per home/);
});

test('CLI help keeps the demo-beside-production promise reachable', async () => {
  const { stdout } = await runHelp();
  assert.match(stdout, /demo Gate beside a/);
  assert.match(stdout, /running production one/);
});