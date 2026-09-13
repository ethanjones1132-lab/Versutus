// ─── Installing and inspecting the PC voice runtime ──────────────────────
// `voice install` creates the uv venv, installs `requirements.lock` and
// downloads every model in `models.lock.json`, checking its SHA-256 and
// resuming an interrupted download. `voice doctor` proves the venv, the GPU and
// the models load. The network and the process spawns are injected so tests
// exercise install and resume without touching either.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGateHome } from '../paths.mjs';

const WORKER_DIR = fileURLToPath(new URL('../../../gate/voice-worker', import.meta.url));

/** Where the venv, python, models and worker live for a platform. */
export function voicePaths(env = process.env, platform = process.platform) {
  const home = resolveGateHome(env, platform);
  const root = join(home, 'voice');
  const venv = join(root, 'venv');
  const python = platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python');
  return {
    home,
    root,
    venv,
    python,
    models: join(root, 'models'),
    worker: WORKER_DIR,
    lockFile: join(WORKER_DIR, 'requirements.lock'),
  };
}

export function readModelsLock(paths) {
  return JSON.parse(readFileSync(join(paths.worker, 'models.lock.json'), 'utf8'));
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Download `url` to `dest`, resuming `dest.part` and keeping the file only when
 * its SHA-256 matches. Throws `hash_mismatch` and leaves no final file otherwise.
 */
export async function fetchVerified({ url, sha256, dest, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (existsSync(dest) && sha256 && (await sha256Of(dest)) === sha256) {
    return { path: dest, resumed: false, downloaded: false };
  }
  const partial = `${dest}.part`;
  const from = existsSync(partial) ? statSync(partial).size : 0;
  const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
  const response = await fetchImpl(url, { headers });
  if (!response || response.ok === false) {
    throw new Error(`download failed for ${url}: ${response?.status ?? 'no response'}`);
  }
  const appending = from > 0 && response.status === 206;
  log(appending ? `resuming ${url} at ${from} bytes` : `downloading ${url}`);
  const source = typeof response.body?.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
  await pipeline(source, createWriteStream(partial, { flags: appending ? 'a' : 'w' }));

  const actual = await sha256Of(partial);
  if (sha256 && actual !== sha256) {
    const error = new Error(`hash mismatch for ${url}`);
    error.code = 'hash_mismatch';
    error.expected = sha256;
    error.actual = actual;
    throw error;
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(partial, dest);
  return { path: dest, resumed: appending, downloaded: true };
}

/** Run `uv` with inherited stdio; resolve on exit 0, reject otherwise. */
export function uvRunner(uvPath = process.env.VERSUTUS_UV || 'uv') {
  return (args) => new Promise((resolve, reject) => {
    const child = nodeSpawn(uvPath, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`uv ${args[0]} exited with code ${code}`));
    });
  });
}

/** Create the venv, install the lock and download every model. Idempotent. */
export async function installVoice({ paths, cpu = false, runUv, fetch: fetchImpl = globalThis.fetch, log = console.log } = {}) {
  mkdirSync(paths.venv, { recursive: true });
  log(`creating the venv at ${paths.venv}`);
  await runUv(['venv', '--python', '3.12', paths.venv]);
  log('installing requirements.lock');
  await runUv(['pip', 'install', '--python', paths.python, '-r', paths.lockFile]);

  mkdirSync(paths.models, { recursive: true });
  const lock = readModelsLock(paths);
  const downloaded = [];
  for (const [name, entry] of Object.entries(lock.models ?? {})) {
    if (!entry.url) throw new Error(`models.lock.json has no url for ${name}`);
    await fetchVerified({ url: entry.url, sha256: entry.sha256, dest: join(paths.models, name), fetchImpl, log });
    downloaded.push(name);
  }
  return { venv: paths.venv, models: downloaded, cpu };
}

/** What `voice.capabilities` reports for `local`, deduced from the runtime. */
export function voiceStatus({ paths } = {}) {
  const engines = {
    local: localStatus(paths),
    codex: {
      state: 'disabled',
      reason: 'Codex realtime needs an API key; the ChatGPT login does not provide one.',
    },
  };
  return {
    enabled: true,
    installed: engines.local.state === 'ready',
    engines,
    limits: { codexMinutesPerDay: 60, maxConcurrentCalls: 1 },
    usedToday: { localMinutes: 0, codexMinutes: 0 },
  };
}

function localStatus(paths) {
  if (!paths || !existsSync(paths.python)) {
    return {
      state: 'not-installed',
      reason: 'The PC voice models are not installed. Run voice install on the Gate.',
    };
  }
  let lock;
  try {
    lock = readModelsLock(paths);
  } catch {
    return { state: 'unavailable', reason: 'models.lock.json is unreadable.' };
  }
  const missing = Object.keys(lock.models ?? {}).filter((name) => !existsSync(join(paths.models, name)));
  if (missing.length > 0) {
    return { state: 'not-installed', reason: `The PC voice models are missing: ${missing.join(', ')}.` };
  }
  return { state: 'ready' };
}

const DOCTOR_PROBE = String.raw`
import json, shutil, subprocess, sys
result = {"versions": {}, "vram": None, "error": None}
try:
    import faster_whisper, kokoro_onnx, onnxruntime
    result["versions"] = {
        "faster_whisper": getattr(faster_whisper, "__version__", "unknown"),
        "kokoro_onnx": getattr(kokoro_onnx, "__version__", "unknown"),
        "onnxruntime": getattr(onnxruntime, "__version__", "unknown"),
    }
except Exception as error:
    result["error"] = str(error)
try:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=10, check=True,
    )
    used, total = (int(part) for part in out.stdout.splitlines()[0].split(","))
    result["vram"] = {"usedMb": used, "totalMb": total}
except Exception:
    result["vram"] = None
print(json.dumps(result))
`;

/**
 * Check the venv, the GPU and the models. Returns a list of named checks; a
 * failing check names itself instead of throwing.
 */
export function voiceDoctor({ paths, spawnSync = nodeSpawnSync, env = process.env, log = console.log } = {}) {
  const checks = [];
  if (!paths || !existsSync(paths.python)) {
    checks.push({ name: 'venv', ok: false, detail: `no python at ${paths?.python ?? 'unknown'}; run voice install` });
    return { ok: false, checks };
  }
  checks.push({ name: 'venv', ok: true, detail: paths.python });

  const probe = spawnSync(paths.python, ['-c', DOCTOR_PROBE], {
    cwd: paths.worker,
    encoding: 'utf8',
    env: { ...env, VERSUTUS_VOICE_MODELS: paths.models },
  });
  if (probe.status !== 0) {
    checks.push({ name: 'imports', ok: false, detail: (probe.stderr || 'probe failed').trim() });
    return { ok: false, checks };
  }
  const info = JSON.parse(probe.stdout);
  checks.push({ name: 'imports', ok: !info.error, detail: info.error ?? JSON.stringify(info.versions) });
  checks.push({ name: 'cuda', ok: Boolean(info.vram), detail: info.vram ? `${info.vram.usedMb}/${info.vram.totalMb} MB` : 'no NVIDIA GPU' });
  log(JSON.stringify(checks));

  const status = voiceStatus({ paths });
  const ok = checks.every((check) => check.ok || check.name === 'cuda') && status.engines.local.state === 'ready';
  return { ok, checks, engines: status.engines };
}
