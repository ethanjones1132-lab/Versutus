import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateDir = join(__dirname, '..');

/**
 * A copy of the Gate that cannot resolve `ws`.
 *
 * gate/package.json declares no dependencies of its own — `ws` is the repo
 * root's — so a Gate started before `npm install` used to die with a raw
 * ERR_MODULE_NOT_FOUND stack from inside the import graph. node_modules is
 * never touched to reproduce that: the copy gets its own `node_modules/ws`
 * whose entry point is missing, which is the failure the preflight has to
 * survive.
 */
async function gateWithoutDependencies() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-no-deps-'));
  for (const entry of ['cli.mjs', 'core', 'flavors', 'registry']) {
    await cp(join(gateDir, entry), join(dir, entry), { recursive: true });
  }
  const ws = join(dir, 'node_modules', 'ws');
  await mkdir(ws, { recursive: true });
  await writeFile(
    join(ws, 'package.json'),
    JSON.stringify({ name: 'ws', version: '0.0.0', main: 'index.js' }),
    'utf-8',
  );
  return dir;
}

function runCli(cwd, args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [join(cwd, 'cli.mjs'), ...args], {
      cwd,
      env: { ...process.env, VERSUTUS_GATE_HOME: join(cwd, 'home') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a Gate with no dependencies installed says what to run instead of printing a stack', async () => {
  const dir = await gateWithoutDependencies();
  try {
    const result = await runCli(dir, ['start']);

    assert.equal(result.code, 78, 'EX_CONFIG: a setup problem, not a Gate fault');
    assert.match(result.stderr, /needs the repo's dependencies/);
    assert.match(result.stderr, /npm install/, 'the operator needs the command, not the diagnosis');
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|at async|node:internal/);
    assert.doesNotMatch(result.stdout, /Starting/, 'it must refuse before taking the port or the lock');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
