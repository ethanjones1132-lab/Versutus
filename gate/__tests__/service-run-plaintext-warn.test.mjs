import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

test('service run warns about a plaintext bind but still starts the child with the acknowledgement', { skip: process.platform !== 'win32' }, async () => {
  // The Scheduled Task revives this supervisor every five minutes, so a refusal
  // here is a silent outage. It must warn loudly, then hand its child
  // --allow-plaintext or the child's own refusal would undo that decision.
  const dir = await mkdtemp(join(tmpdir(), 'gate-service-run-plaintext-'));
  const shim = join(dir, 'capture-spawn.cjs');
  const spawnLog = join(dir, 'spawn.log');
  await writeFile(
    shim,
    [
      "const childProcess = require('node:child_process');",
      "const fs = require('node:fs');",
      "const { EventEmitter } = require('node:events');",
      'childProcess.spawn = function (file, args, options) {',
      "  fs.appendFileSync(process.env.GATE_TEST_SPAWN_LOG, JSON.stringify({ file, args, options: { windowsHide: options?.windowsHide } }) + '\\n');",
      '  setTimeout(() => process.exit(0), 250);',
      '  const child = new EventEmitter();',
      '  child.pid = 4242;',
      '  child.stdout = new EventEmitter();',
      '  child.stderr = new EventEmitter();',
      '  child.send = () => true;',
      '  child.kill = () => true;',
      '  return child;',
      '};',
    ].join('\n'),
  );
  try {
    const { code, stdout, stderr } = await runCli(
      ['service', 'run', '--host', '0.0.0.0', '--port', '9500'],
      {
        VERSUTUS_GATE_HOME: dir,
        VERSUTUS_GATE_ALLOW_PLAINTEXT: '',
        GATE_TEST_SPAWN_LOG: spawnLog,
        NODE_OPTIONS: `--require "${shim.split('\\').join('/')}"`,
      },
    );

    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stderr, /WARNING: refusing to bind 0\.0\.0\.0/);
    assert.match(stderr, /Continuing anyway because this supervisor must not refuse/);
    assert.doesNotMatch(stderr, /Error: refusing to bind/);

    assert.ok(existsSync(spawnLog), 'the supervisor never spawned its Gate child');
    const spawned = JSON.parse(readFileSync(spawnLog, 'utf8').trim());
    assert.equal(spawned.args[1], 'start');
    assert.ok(spawned.args.includes('--host') && spawned.args.includes('0.0.0.0'));
    assert.ok(spawned.args.includes('--port') && spawned.args.includes('9500'));
    assert.ok(spawned.args.includes('--allow-plaintext'), `child args were ${JSON.stringify(spawned.args)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
