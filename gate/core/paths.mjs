import { join } from 'node:path';

export function resolveGateHome(env = process.env, platform = process.platform) {
  if (typeof env.VERSUTUS_GATE_HOME === 'string' && env.VERSUTUS_GATE_HOME.length > 0) {
    return env.VERSUTUS_GATE_HOME;
  }
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) {
      throw new Error('LOCALAPPDATA is required to resolve the Windows Gate home');
    }
    return join(env.LOCALAPPDATA, 'Versutus', 'Gate');
  }
  const base = env.XDG_DATA_HOME || join(env.HOME || '', '.local', 'share');
  return join(base, 'Versutus', 'Gate');
}
