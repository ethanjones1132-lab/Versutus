import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { runCli, probeVersion, spawnCommand } from '../core/cli-environments/adapters/shared.mjs';

// QUALITY-SCAN-2026-10-11 [MED] gate/core/cli-environments/adapters/shared.mjs:
// runCli used to check access(executablePath.split(' ')[0]) while spawning the
// full, unsplit path -- so a real `C:\Program Files\...\cli.exe` was probed as
// `not_installed: executable not runnable`. executablePath is a single literal
// filesystem path; these tests pin down that it is probed and spawned whole,
// with the same command vector, stdio, windowsHide, timeout and exit handling.

// Each test builds a temporary directory tree containing space-separated
// segments, so checking or spawning anything but the whole path fails. Nothing
// here runs a live CLI: the child process is a fake EventEmitter whose streams
// are PassThrough buffers, handed to runCli through its spawnImpl seam.
const EXEC_OPTIONS = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

async function inSpacedTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-spaces-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A stand-in child: streams already hold their output, `close` fires once its
// consumers are attached. autoClose: false leaves the child hung for tests that
// exercise runCli's timeout.
function fakeChild({ stdout = '', stderr = '', code = 0, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  if (stdout) child.stdout.push(Buffer.from(stdout));
  if (stderr) child.stderr.push(Buffer.from(stderr));
  child.stdout.end();
  child.stderr.end();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
  };
  if (autoClose) setImmediate(() => child.emit('close', code));
  return child;
}

function spawnRecorder(respond) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, spawnImpl };
}

test('runCli checks and spawns a spaced conventional executable as one whole path', async () => {
  await inSpacedTempDir(async (dir) => {
    // Old code checked access on `...\Program`, which never exists; even a
    // decoy file holding exactly that name must not satisfy the new check.
    const programFiles = join(dir, 'Program Files', 'Trusted Tool Company');
    await mkdir(programFiles, { recursive: true });
    await writeFile(join(dir, 'Program'), 'decoy: split-first-token must not match\n');
    const executable = join(programFiles, 'tool.exe');
    await writeFile(executable, 'ordinary executable-shaped file; nothing here executes it\n');

    const { calls, spawnImpl } = spawnRecorder(() => fakeChild({ stdout: 'tool 1.4.0\n' }));
    const result = await runCli(executable, ['--version'], { spawnImpl });

    assert.deepEqual(calls, [{
      command: executable,
      args: ['--version'],
      options: EXEC_OPTIONS,
    }]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'tool 1.4.0');
    assert.equal(result.stderr, '');
  });
});

test('runCli keeps the node prefix for an .mjs fixture inside a spaced directory', async () => {
  await inSpacedTempDir(async (dir) => {
    const executable = join(dir, 'Vendor CLI', 'scripts', 'her.mjs');
    await mkdir(join(dir, 'Vendor CLI', 'scripts'), { recursive: true });
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("her 0.19.0\\n");\n');
    await chmod(executable, 0o755);

    const { calls, spawnImpl } = spawnRecorder(() => fakeChild({ stdout: 'her 0.19.0\n' }));
    const result = await runCli(executable, ['--acp', '--probe'], { spawnImpl });

    assert.deepEqual(calls, [{
      command: process.execPath,
      args: [executable, '--acp', '--probe'],
      options: EXEC_OPTIONS,
    }]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'her 0.19.0');
  });
});

test('probeVersion reports a spaced CLI ready through the runCli seam', async () => {
  await inSpacedTempDir(async (dir) => {
    const executable = join(dir, 'Program Files', 'Hermes Toolkit', 'hermes.exe');
    await mkdir(join(dir, 'Program Files', 'Hermes Toolkit'), { recursive: true });
    await writeFile(executable, 'never actually executed\n');

    const { calls, spawnImpl } = spawnRecorder((call) => (
      call.args[0] === '--version'
        ? fakeChild({ stdout: 'Hermes Agent v0.19.0\n' })
        : fakeChild({ stdout: 'acp offered\n' })
    ));
    const probe = await probeVersion(executable, {
      min: '0.18.0',
      maxExclusiveMajor: 1,
      protocol: 'acp',
      handshakeArgs: ['--acp', '--probe'],
      runCliImpl: (path, args) => runCli(path, args, { spawnImpl }),
    });

    assert.equal(probe.state, 'ready', probe.message);
    assert.equal(probe.executablePath, executable);
    assert.equal(probe.cliVersion, '0.19.0');
    assert.equal(probe.protocol, 'acp');
    assert.equal(probe.protocolVersion, '1');
    assert.deepEqual(calls.map((call) => call.command), [executable, executable]);
    assert.deepEqual(calls.map((call) => call.args), [
      ['--version'],
      ['--acp', '--probe'],
    ]);
  });
});

test('a missing spaced full path fails without reaching the spawn, even when the split prefix exists', async () => {
  await inSpacedTempDir(async (dir) => {
    // `...\Program` (the old check's first token) is made to exist, so any
    // residual splitting would sail past the existence check and spawn.
    const executable = join(dir, 'Program Files', 'Missing Tool', 'tool.exe');
    await writeFile(join(dir, 'Program'), 'decoy: split-first-token must not match\n');

    const { calls, spawnImpl } = spawnRecorder(() => fakeChild({ stdout: 'should never run\n' }));
    await assert.rejects(
      runCli(executable, ['--version'], { spawnImpl }),
      /ENOENT/,
    );
    assert.equal(calls.length, 0, 'no child may be spawned for a missing executable');
  });
});

test('a spaced CLI that exits nonzero still hands the caller the code and stderr', async () => {
  await inSpacedTempDir(async (dir) => {
    const executable = join(dir, 'With Spaces', 'sour.exe');
    await mkdir(join(dir, 'With Spaces'), { recursive: true });
    await writeFile(executable, 'never actually executed\n');

    const { spawnImpl } = spawnRecorder(() => fakeChild({
      stdout: 'partial line\n',
      stderr: 'fatal: config unreadable\n',
      code: 2,
    }));
    const result = await runCli(executable, ['--version'], { spawnImpl });

    assert.equal(result.code, 2);
    assert.equal(result.stdout, 'partial line');
    assert.equal(result.stderr, 'fatal: config unreadable');
  });
});

test('a hung spaced CLI still trips the timeout and is killed', async () => {
  await inSpacedTempDir(async (dir) => {
    const executable = join(dir, 'Long Haul Tool', 'hang.exe');
    await mkdir(join(dir, 'Long Haul Tool'), { recursive: true });
    await writeFile(executable, 'never actually executed\n');

    const child = fakeChild({ autoClose: false });
    const { spawnImpl } = spawnRecorder(() => child);
    await assert.rejects(
      runCli(executable, ['--version'], { spawnImpl, timeoutMs: 25 }),
      /cli probe timed out/,
    );
    assert.equal(child.killCalls, 1, 'the hung child must be killed');
  });
});

test('spawnCommand treats a spaced path as command, never as a command string', () => {
  const spaced = 'C:\\Program Files\\Trusted Tool\\tool.exe';
  assert.deepEqual(spawnCommand(spaced), { command: spaced, prefix: [] });
  const spacedScript = 'C:\\Program Files\\Trusted Tool\\tool.mjs';
  assert.deepEqual(spawnCommand(spacedScript), { command: process.execPath, prefix: [spacedScript] });
});
