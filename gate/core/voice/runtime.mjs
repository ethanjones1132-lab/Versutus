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
import { codexRealtimeStatus, readCodexAuthMode } from './codex-status.mjs';

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
  // A model may live in a subdirectory (`whisper/model.bin`); the partial is
  // written before the final rename, so the directory must exist first.
  mkdirSync(dirname(dest), { recursive: true });
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
export async function installVoice({ paths, cpu = false, runUv, fetch: fetchImpl = globalThis.fetch, log = console.log, lock } = {}) {
  mkdirSync(paths.venv, { recursive: true });
  log(`creating the venv at ${paths.venv}`);
  // `--allow-existing` keeps a second install (only new models to fetch) from
  // failing on the venv the first one created.
  await runUv(['venv', '--python', '3.12', '--allow-existing', paths.venv]);
  log('installing requirements.lock');
  await runUv(['pip', 'install', '--python', paths.python, '-r', paths.lockFile]);

  mkdirSync(paths.models, { recursive: true });
  const modelsLock = lock ?? readModelsLock(paths);
  const downloaded = [];
  for (const [name, entry] of Object.entries(modelsLock.models ?? {})) {
    if (!entry.url) throw new Error(`models.lock.json has no url for ${name}`);
    await fetchVerified({ url: entry.url, sha256: entry.sha256, dest: join(paths.models, name), fetchImpl, log });
    downloaded.push(name);
  }
  return { venv: paths.venv, models: downloaded, cpu };
}

/**
 * The Gate's `voice` config block (§4.9), from `<gateHome>/voice/voice.json`.
 * A missing or malformed file means everything is enabled; a `false` switch
 * is the only thing that turns an engine off.
 */
export function readVoiceConfig({ paths } = {}) {
  const config = {
    enabled: true,
    engines: { local: { enabled: true }, codex: { enabled: true } },
  };
  if (!paths?.root) return config;
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(paths.root, 'voice.json'), 'utf8'));
  } catch {
    return config;
  }
  if (!raw || typeof raw !== 'object') return config;
  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
  for (const engine of ['local', 'codex']) {
    const value = raw.engines?.[engine]?.enabled;
    if (typeof value === 'boolean') config.engines[engine].enabled = value;
  }
  return config;
}

/**
 * Today's voice use, from the audit log: minutes per engine and the most
 * recent error. It never invents minutes — a missing or unreadable log is zero.
 */
export function readVoiceUsage({ paths, now = () => new Date() } = {}) {
  const empty = { localMinutes: 0, codexMinutes: 0, lastError: null };
  if (!paths?.root) return empty;
  let text;
  try {
    text = readFileSync(join(paths.root, 'audit.jsonl'), 'utf8');
  } catch {
    return empty;
  }
  const today = now().toISOString().slice(0, 10);
  let localSeconds = 0;
  let codexSeconds = 0;
  let lastError = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.error === 'string' && entry.error && entry.error !== 'user') {
      // The audit's error field carries the end reason; a hang-up the
      // operator asked for is not an error and must not read as one.
      lastError = entry.error;
    }
    if (typeof entry.ts !== 'string' || !entry.ts.startsWith(today)) continue;
    const seconds = (Number(entry.secondsListening) || 0) + (Number(entry.secondsSpeaking) || 0);
    if (entry.engine === 'local') localSeconds += seconds;
    else if (entry.engine === 'codex') codexSeconds += seconds;
  }
  return {
    localMinutes: Math.round(localSeconds / 60),
    codexMinutes: Math.round(codexSeconds / 60),
    lastError,
  };
}

/** What `voice.capabilities` reports for each engine, from the runtime and config. */
export function voiceStatus({ paths, now, readAuthMode = readCodexAuthMode } = {}) {
  const config = readVoiceConfig({ paths });
  const usage = readVoiceUsage({ paths, now });
  const off = config.enabled === false;
  const disabledReason = (engine) =>
    off
      ? 'Voice is turned off on this Gate.'
      : `The ${engine} voice engine is turned off on this Gate.`;
  const engines = {
    local:
      off || config.engines.local.enabled === false
        ? { state: 'disabled', reason: disabledReason('local') }
        : localStatus(paths),
    codex:
      off || config.engines.codex.enabled === false
        ? { state: 'disabled', reason: disabledReason('codex') }
        : codexRealtimeStatus(readAuthMode()),
  };
  return {
    enabled: !off,
    installed: engines.local.state === 'ready',
    engines,
    limits: { codexMinutesPerDay: 60, maxConcurrentCalls: 1 },
    usedToday: { localMinutes: usage.localMinutes, codexMinutes: usage.codexMinutes },
    lastError: usage.lastError,
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
  const missing = Object.entries(lock.models ?? {})
    .filter(([, entry]) => !entry?.optional)
    .map(([name]) => name)
    .filter((name) => !existsSync(join(paths.models, name)));
  if (missing.length > 0) {
    return { state: 'not-installed', reason: `The PC voice models are missing: ${missing.join(', ')}.` };
  }
  return { state: 'ready' };
}

const DOCTOR_PROBE = String.raw`
import json, os, shutil, subprocess, sys
result = {"versions": {}, "vram": None, "whisperCuda": None, "error": None}
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
try:
    from faster_whisper import WhisperModel
    names = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json")
    whisper_dir = os.path.join(os.environ.get("VERSUTUS_VOICE_MODELS", ""), "whisper")
    missing = [name for name in names if not os.path.exists(os.path.join(whisper_dir, name))]
    if missing:
        result["whisperCuda"] = {"ok": False, "error": "missing: " + ", ".join(missing)}
    else:
        model = WhisperModel(whisper_dir, device="cuda", compute_type="int8_float16")
        del model
        result["whisperCuda"] = {"ok": True}
except Exception as error:
    result["whisperCuda"] = {"ok": False, "error": str(error)[:300]}
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
    timeout: 180000,
  });
  if (probe.error) {
    checks.push({ name: 'imports', ok: false, detail: `probe failed: ${probe.error.message}` });
    return { ok: false, checks };
  }
  if (probe.status !== 0) {
    checks.push({ name: 'imports', ok: false, detail: (probe.stderr || 'probe failed').trim() });
    return { ok: false, checks };
  }
  const info = JSON.parse(probe.stdout);
  checks.push({ name: 'imports', ok: !info.error, detail: info.error ?? JSON.stringify(info.versions) });
  try {
    const lock = readModelsLock(paths);
    const entries = Object.entries(lock.models ?? {});
    const present = entries.map(([name]) => name).filter((name) => existsSync(join(paths.models, name)));
    // An optional model (the pre-built STT weights) does not hold the runtime
    // unready when absent: the worker falls back to faster-whisper's own first
    // load, and a 1.6 GB download must not read as a broken install.
    const missingRequired = entries
      .filter(([name, entry]) => !entry?.optional && !present.includes(name))
      .map(([name]) => name);
    checks.push({
      name: 'models',
      ok: missingRequired.length === 0,
      detail: present.length ? present.sort().join(', ') : 'none installed',
    });
  } catch (error) {
    checks.push({ name: 'models', ok: false, detail: error.message });
  }
  checks.push({ name: 'cuda', ok: Boolean(info.vram), detail: info.vram ? `${info.vram.usedMb}/${info.vram.totalMb} MB` : 'no NVIDIA GPU' });
  if (info.whisperCuda == null) {
    checks.push({ name: 'whisper', ok: false, detail: 'the CUDA load probe did not run' });
  } else if (info.whisperCuda.ok) {
    checks.push({ name: 'whisper', ok: true, detail: 'whisper loads on CUDA (int8_float16)' });
  } else {
    checks.push({ name: 'whisper', ok: false, detail: `CUDA load failed: ${info.whisperCuda.error ?? 'unknown error'}; run voice install` });
  }
  log(JSON.stringify(checks));

  const status = voiceStatus({ paths });
  const ok = checks.every((check) => check.ok || check.name === 'cuda') && status.engines.local.state === 'ready';
  return { ok, checks, engines: status.engines };
}
