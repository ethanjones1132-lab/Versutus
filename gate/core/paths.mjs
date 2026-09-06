import { posix, win32 } from 'node:path';

export function resolveGateHome(env = process.env, platform = process.platform) {
  if (typeof env.VERSUTUS_GATE_HOME === 'string' && env.VERSUTUS_GATE_HOME.length > 0) {
    return env.VERSUTUS_GATE_HOME;
  }
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) {
      throw new Error('LOCALAPPDATA is required to resolve the Windows Gate home');
    }
    // win32.join, not join: this function is parameterised by PLATFORM, so the
    // separator has to follow that argument rather than whatever host is running.
    // Plain join() is the host's, so resolveGateHome(env, 'win32') off Windows
    // returned `C:\Users\Test\AppData\Local/Versutus/Gate` -- a path that is
    // right on neither platform.
    return win32.join(env.LOCALAPPDATA, 'Versutus', 'Gate');
  }
  const base = env.XDG_DATA_HOME || posix.join(env.HOME || '', '.local', 'share');
  return posix.join(base, 'Versutus', 'Gate');
}
