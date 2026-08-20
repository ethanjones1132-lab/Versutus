import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Shell sessions for the app's Shell tab.
 *
 * Deliberately not a PTY. `gate/package.json` has no dependencies and node-pty
 * is a native module needing a C++ toolchain, but the stronger reason is that
 * the client does not want one: the app renders output as a list of lines
 * (`TerminalOutput lines={…}`), sends one newline-terminated command per
 * submit, and never calls resize. A PTY would emit cursor-addressing escapes
 * that a line list cannot render, making the feature worse, not better.
 *
 * What this is: a real shell process with piped stdio, streamed live. What it
 * is not: a terminal. Full-screen programs (vim, htop, anything checking
 * isatty) will misbehave, and that is a property of the client's design rather
 * than a gap to close later.
 *
 * The old `conpty.mjs` claimed this territory while spawning nothing at all.
 */

/**
 * Frame size bound, not a data cap.
 *
 * This was applied with `subarray(0, MAX)`, which truncated: everything past
 * the limit in one burst was dropped, silently. Output is now split across
 * frames instead, so a large burst arrives whole.
 */
const MAX_CHUNK_CHARS = 16 * 1024;

function defaultShell() {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  // No `-i`: an interactive shell without a tty warns on every prompt. Reading
  // piped lines is exactly the mode this client drives.
  return { command: process.env.SHELL || '/bin/sh', args: [] };
}

/**
 * Kill the whole tree. A shell's children outlive `child.kill()` on Windows,
 * which would leave orphaned processes behind every closed tab.
 */
function killTree(child, spawnImpl) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to the plain kill below
    }
  }
  try { child.kill(); } catch { /* already gone */ }
}

export function createTerminalSessions({
  spawnImpl = spawn,
  shell = defaultShell,
  cwd = process.cwd(),
  maxSessions = 8,
} = {}) {
  const sessions = new Map();

  return {
    get size() { return sessions.size; },

    /**
     * Open a session. Its lifetime is the caller's stream: when the consumer
     * detaches, the process tree dies with it. One consumer per session is
     * what the client does, and tying them together is what stops a dropped
     * phone connection leaving a shell running on the host.
     */
    open({ onChunk, onExit, onError, owner = null }) {
      if (sessions.size >= maxSessions) {
        throw new Error(`too many terminal sessions open (limit ${maxSessions})`);
      }

      const { command, args } = shell();
      const child = spawnImpl(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const sid = randomUUID();

      // One decoder per stream. A multi-byte character can straddle two 'data'
      // events, and decoding each buffer independently turns the split point
      // into U+FFFD; a streaming decoder carries the partial sequence over.
      // stdout and stderr get their own because they interleave independently.
      const makeEmitter = () => {
        const decoder = new TextDecoder('utf-8');
        return (buffer) => {
          const text = decoder.decode(buffer, { stream: true });
          for (let i = 0; i < text.length; ) {
            let end = Math.min(i + MAX_CHUNK_CHARS, text.length);
            // Never cut between the halves of a surrogate pair.
            if (end < text.length) {
              const code = text.charCodeAt(end - 1);
              if (code >= 0xd800 && code <= 0xdbff) end -= 1;
            }
            onChunk(text.slice(i, end));
            i = end;
          }
        };
      };
      child.stdout?.on('data', makeEmitter());
      child.stderr?.on('data', makeEmitter());

      child.on('error', (error) => {
        sessions.delete(sid);
        onError?.(error.message);
      });
      child.on('exit', (code) => {
        sessions.delete(sid);
        onExit?.(code ?? 0);
      });

      const session = {
        sid,
        // Who may write to this shell. A session is a live process on the
        // host; another credential holding a valid token has no business
        // typing into one it did not open.
        owner,
        write(data) {
          if (child.exitCode !== null) throw new Error('terminal session has exited');
          child.stdin?.write(String(data));
        },
        close() {
          sessions.delete(sid);
          killTree(child, spawnImpl);
        },
      };
      sessions.set(sid, session);
      return session;
    },

    get(sid) {
      return sessions.get(sid) ?? null;
    },

    /** Tear every session down — used when the Gate itself shuts down. */
    closeAll() {
      for (const session of [...sessions.values()]) session.close();
    },
  };
}
