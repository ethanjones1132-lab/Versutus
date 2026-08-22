import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWindowsJob } from '../core/cli-environments/windows-job.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error('waitFor timed out');
}

test('on Windows terminate walks the process tree via taskkill and still kills the child', async () => {
  const treeKills = [];
  const directKills = [];
  const job = createWindowsJob({
    platform: 'win32',
    killTree: async (pid) => {
      treeKills.push(pid);
    },
  });
  job.add({ pid: 4242, kill: () => directKills.push(4242) });
  job.add({ pid: 5151, kill: () => directKills.push(5151) });

  await job.terminate();

  assert.equal(job.terminated, true);
  // /T is the whole point: launchers spawn the real CLI as their own child.
  assert.deepEqual(treeKills.sort(), [4242, 5151]);
  assert.deepEqual(directKills.sort(), [4242, 5151], 'the direct kill stays as fallback');
});

test('a failed tree kill still stops the direct child instead of leaking the run', async () => {
  const job = createWindowsJob({
    platform: 'win32',
    killTree: async () => {
      throw new Error('taskkill could not find the process');
    },
  });
  let killed = false;
  job.add({ pid: 99, kill: () => {
    killed = true;
  } });

  await job.terminate(); // must not reject

  assert.equal(killed, true);
});

test('off-Windows terminate kills the direct child without shelling out to taskkill', async () => {
  let treeKillCalls = 0;
  const job = createWindowsJob({
    platform: 'linux',
    killTree: async () => {
      treeKillCalls += 1;
    },
  });
  let killed = false;
  job.add({ pid: 7, kill: () => {
    killed = true;
  } });

  await job.terminate();

  assert.equal(treeKillCalls, 0);
  assert.equal(killed, true);
});

test('children that are already gone or not processes are skipped quietly', async () => {
  const job = createWindowsJob({ platform: 'win32', killTree: async () => {} });
  job.add(null);
  job.add({ pid: undefined, kill: () => {} }); // exited before terminate
  await job.terminate();
  assert.equal(job.terminated, true);
});

test('terminate stops grandchildren a launcher left behind — for real', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-tree-kill-'));
  const heartbeats = join(dir, 'heartbeats.log');
  const grandchild = join(dir, 'grandchild.mjs');
  await writeFile(
    grandchild,
    `import { appendFileSync } from 'node:fs';\nsetInterval(() => appendFileSync(${JSON.stringify(heartbeats)}, 'beat\\n'), 100);\n`,
    'utf8',
  );

  const job = createWindowsJob();
  // cmd.exe plays the pip/npm launcher role: killing it alone orphans node,
  // exactly how hermes.exe orphans python.exe.
  const launcher = spawn('cmd.exe', ['/d', '/c', 'node', grandchild], { windowsHide: true });
  job.add(launcher);

  try {
    const beats = async () =>
      (await readFile(heartbeats, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    await waitFor(async () => (await beats()) >= 3, { timeoutMs: 5000 });

    await job.terminate();
    await waitFor(() => launcher.exitCode !== null || launcher.signalCode !== null, { timeoutMs: 3000 });

    const stoppedAt = (await stat(heartbeats)).size;
    await sleep(700);
    assert.equal((await stat(heartbeats)).size, stoppedAt, 'grandchild kept writing after cancel');
  } finally {
    try {
      launcher.kill();
    } catch {
      /* already gone */
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
