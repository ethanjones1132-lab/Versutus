import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * Force-kill a Windows process tree by pid. `taskkill /T` walks every
 * descendant, which is what a bare ChildProcess.kill() cannot do.
 */
async function killProcessTree(pid) {
  await execFile('taskkill', ['/pid', String(pid), '/T', '/F']);
}

export function createWindowsJob({ killTree = killProcessTree, platform = process.platform } = {}) {
  const children = [];
  return {
    children,
    terminated: false,
    add(child) {
      children.push(child);
    },
    /**
     * Forget the current generation of children.
     *
     * A supervisor that stops and starts again keeps one job for its whole life,
     * and terminate() keeps every pid it was ever handed — so without this the
     * second stop taskkills the first generation's pids, which are dead and may
     * since have been handed to an unrelated process.
     */
    reset() {
      children.length = 0;
      this.terminated = false;
    },
    /**
     * Stop every child this job holds. On Windows the registered executable is
     * usually a launcher — pip console scripts (`hermes.exe`) spawn python.exe,
     * npm global bins spawn node — so killing the launcher alone orphans the
     * real CLI and it keeps working (and burning provider tokens) after the
     * operator was told the run was cancelled. taskkill /T takes the whole
     * tree; child.kill() stays as the fallback for an already-dead pid or a
     * failed taskkill, and as the whole story off-Windows.
     */
    async terminate() {
      this.terminated = true;
      await Promise.all(
        children.map(async (child) => {
          if (!child || typeof child.kill !== 'function') return;
          if (platform === 'win32') {
            try {
              if (child.pid) await killTree(child.pid);
            } catch {
              // Nonzero exit usually means the pid is already gone; the direct
              // kill below settles whatever remains.
            }
          }
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }),
      );
    },
  };
}
