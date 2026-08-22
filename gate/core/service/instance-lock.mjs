import { rmSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** True when a process with this pid exists and we may signal it. */
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return error.code === 'EPERM';
  }
}

/**
 * Decide whether an existing lock file is worth honouring. A hard kill never
 * runs the release handler, so a lock naming a dead process — or one whose
 * bytes never finished being written — is debris, not an owner.
 */
async function lockIsStale(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    // Vanished between the failed create and this read: nothing holds it.
    return true;
  }
  try {
    return !pidIsAlive(JSON.parse(raw).pid);
  } catch {
    return true;
  }
}

export async function acquireInstanceLock(gateHome) {
  await mkdir(gateHome, { recursive: true });
  const lockPath = join(gateHome, 'gate.lock');

  let handle = await tryCreate();
  if (!handle) {
    if (!(await lockIsStale(lockPath))) {
      throw new Error('Gate instance lock is already held — another Gate is already running');
    }
    await rm(lockPath, { force: true });
    // A second Gate may have reclaimed it in the same instant; losing that race
    // means someone live owns the lock now, so report it exactly as before.
    handle = await tryCreate();
    if (!handle) {
      throw new Error('Gate instance lock is already held — another Gate is already running');
    }
  }

  await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      // Never let a rejected close skip the unlink — a leaked gate.lock names
      // our dead pid and blocks the next start.
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    },
    /**
     * Synchronous release for 'exit' handlers, which cannot await: an async
     * release there dies with the process mid-unlink and leaks gate.lock
     * naming a dead pid.
     *
     * Only the UNLINK must be synchronous — the OS reclaims every descriptor
     * when the process dies. The descriptor itself is closed through the
     * FileHandle API (never raw closeSync(handle.fd)): bypassing the
     * bookkeeping leaves this handle believing it still owns the fd number,
     * and its later GC finalizer closes that number again — by then it may
     * belong to an unrelated open file, whose own close fails with EBADF
     * (reproduced 2026-08-22 as flaky failures across the instance-lock
     * suite; the DEP0137 "closing file descriptor 3" warning is the same
     * finalizer). On the 'exit' path this close request may never run, which
     * is fine for exactly that reason.
     */
    releaseSync() {
      if (released) return;
      released = true;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Nothing more an exiting process can do about a contested file.
      }
      try {
        void handle.close().catch(() => undefined);
      } catch {
        // Exiting anyway — the OS closes whatever remains.
      }
    },
  };

  async function tryCreate() {
    try {
      return await open(lockPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') return null;
      throw error;
    }
  }
}
