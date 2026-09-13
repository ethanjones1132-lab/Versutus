#!/usr/bin/env node
// Run the local voice worker's pytest suite with the venv the Gate installs,
// or with whatever Python the environment provides (CI installs pytest).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

function gateHome() {
  const env = process.env;
  if (env.VERSUTUS_GATE_HOME) return env.VERSUTUS_GATE_HOME;
  if (isWindows) {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required to resolve the Gate home');
    return path.win32.join(env.LOCALAPPDATA, 'Versutus', 'Gate');
  }
  const base = env.XDG_DATA_HOME || path.posix.join(env.HOME || '', '.local', 'share');
  return path.posix.join(base, 'Versutus', 'Gate');
}

function interpreterCandidates() {
  const candidates = [];
  if (process.env.VERSUTUS_VOICE_PYTHON) candidates.push(process.env.VERSUTUS_VOICE_PYTHON);
  const venv = path.join(gateHome(), 'voice', 'venv');
  candidates.push(isWindows ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'));
  candidates.push(isWindows ? 'python' : 'python3');
  return candidates;
}

let result;
for (const candidate of interpreterCandidates()) {
  if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
  result = spawnSync(candidate, ['-m', 'pytest', '-q', 'tests'], {
    cwd: workerDir,
    stdio: 'inherit',
  });
  if (result.error && result.error.code === 'ENOENT') continue;
  break;
}

if (!result || (result.error && result.error.code === 'ENOENT')) {
  console.error('No Python interpreter with pytest was found; set VERSUTUS_VOICE_PYTHON.');
  process.exit(1);
}
process.exit(result.status ?? 1);
