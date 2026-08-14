import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function acquireInstanceLock(gateHome) {
  await mkdir(gateHome, { recursive: true });
  const lockPath = join(gateHome, 'gate.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('Gate instance lock is already held — another Gate is already running');
    }
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return {
    path: lockPath,
    async release() {
      await handle.close();
      await rm(lockPath, { force: true });
    },
  };
}
