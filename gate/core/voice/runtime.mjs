// ─── Installing and inspecting the PC voice runtime ──────────────────────
// `voice install` creates the uv venv, installs `requirements.lock` and
// downloads the selected models in `models.lock.json`, checking their SHA-256 and
// resuming an interrupted download. `voice doctor` proves the venv, the GPU and
// the models load. The network and the process spawns are injected so tests
// exercise install and resume without touching either.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGateHome } from '../paths.mjs';
import { codexRealtimeStatus, readCodexAuthMode } from './codex-status.mjs';

const WORKER_DIR = fileURLToPath(new URL('../../../gate/voice-worker', import.meta.url));
const KOKORO_INT8 = 'kokoro-v1.0.int8.onnx';

/**
 * How long a model download may wait for the server to answer before the
 * attempt is refused. It bounds the wait, not the size of the file: a stalled
 * connection must not leave `voice install` hanging with no error and no exit.
 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

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
 * A server that stops answering throws `download_timeout` after `timeoutMs`.
 */
export async function fetchVerified({
  url,
  sha256,
  dest,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (existsSync(dest) && sha256 && (await sha256Of(dest)) === sha256) {
    return { path: dest, resumed: false, downloaded: false };
  }
  const partial = `${dest}.part`;
  // A model may live in a subdirectory (`whisper/model.bin`); the partial is
  // written before the final rename, so the directory must exist first.
  mkdirSync(dirname(dest), { recursive: true });
  const from = existsSync(partial) ? statSync(partial).size : 0;
  const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
  const controller = new AbortController();
  // The fake fetches in the tests, and any override, are raced against the
  // deadline too: a promise that never settles must still reject.
  let timer = null;
  const deadline = timeoutMs > 0
    ? new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error(`download timed out for ${url} after ${timeoutMs}ms`);
        error.code = 'download_timeout';
        error.url = url;
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    })
    : null;
  let response;
  try {
    response = await (deadline
      ? Promise.race([
        Promise.resolve(fetchImpl(url, { headers, signal: controller.signal })),
        deadline,
      ])
      : fetchImpl(url, { headers, signal: controller.signal }));
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/** Fetch only the opt-in TTS asset, without changing the venv or activating it. */
export async function fetchVoiceTtsInt8({ paths, fetch: fetchImpl, log } = {}) {
  const entry = readModelsLock(paths).models?.[KOKORO_INT8];
  if (!entry?.url || !entry.sha256) throw new Error(`models.lock.json does not pin ${KOKORO_INT8}`);
  return fetchVerified({
    url: entry.url, sha256: entry.sha256, dest: join(paths.models, KOKORO_INT8), fetchImpl, log,
  });
}

const ORT_PACKAGES = ['onnxruntime', 'onnxruntime-gpu'];
const ORT_DIST_PROBE = String.raw`
from importlib.metadata import PackageNotFoundError, version

def ort_packages():
    installed = {}
    for name in ${JSON.stringify(ORT_PACKAGES)}:
        try:
            installed[name] = version(name)
        except PackageNotFoundError:
            pass
    return installed
`;

function probeOrtPackages(python) {
  const result = nodeSpawnSync(python, ['-I', '-c', `import json\n${ORT_DIST_PROBE}\nprint(json.dumps(ort_packages()))`], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not check the voice venv's ONNX Runtime packages: ${result.error?.message || result.stderr?.trim() || 'probe failed'}`);
  }
  return JSON.parse(result.stdout);
}

/** Create the venv, install the lock and download the selected models. Idempotent. */
export async function installVoice({
  paths,
  cpu = false,
  ttsInt8 = false,
  runUv,
  fetch: fetchImpl = globalThis.fetch,
  log = console.log,
  lock,
  downloadTimeoutMs,
  probePackages = probeOrtPackages,
  platform = process.platform,
} = {}) {
  mkdirSync(paths.venv, { recursive: true });
  log(`creating the venv at ${paths.venv}`);
  // `--allow-existing` keeps a second install (only new models to fetch) from
  // failing on the venv the first one created.
  await runUv(['venv', '--python', '3.12', '--allow-existing', paths.venv]);
  const installed = probePackages(paths.python);
  const conflicting = platform === 'darwin' ? 'onnxruntime-gpu' : 'onnxruntime';
  if (Object.hasOwn(installed, conflicting)) {
    // Both wheels own onnxruntime/. Removing either can break the other even
    // when its metadata still claims it is installed. Clear both before repair.
    log('removing conflicting ONNX Runtime packages');
    await runUv(['pip', 'uninstall', '--python', paths.python, ...ORT_PACKAGES]);
  }
  log('installing requirements.lock');
  // The lock already resolves all dependencies with the ORT override.
  // Re-resolving would let kokoro-onnx and faster-whisper pull CPU ORT back in.
  await runUv(['pip', 'install', '--python', paths.python, '--no-deps', '-r', paths.lockFile]);

  mkdirSync(paths.models, { recursive: true });
  const modelsLock = lock ?? readModelsLock(paths);
  const downloaded = [];
  for (const [name, entry] of Object.entries(modelsLock.models ?? {})) {
    if (entry.optIn && !(name === KOKORO_INT8 && ttsInt8)) continue;
    if (!entry.url) throw new Error(`models.lock.json has no url for ${name}`);
    if (entry.optIn && !entry.sha256) throw new Error(`models.lock.json has no checksum for ${name}`);
    await fetchVerified({
      url: entry.url,
      sha256: entry.sha256,
      dest: join(paths.models, name),
      fetchImpl,
      log,
      timeoutMs: downloadTimeoutMs,
    });
    downloaded.push(name);
  }
  // The platform wheel still provides CPU execution. Persist the requested
  // runtime mode without overwriting the operator's voice.json settings.
  // A later install without --cpu returns the venv to automatic provider selection.
  const forceCpuMarker = join(paths.root, 'force-cpu');
  if (cpu) writeFileSync(forceCpuMarker, '', { flag: 'a' });
  else rmSync(forceCpuMarker, { force: true });
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
export function voiceStatus({
  paths, now, readAuthMode = readCodexAuthMode, includeRuntime = false, probePackages = probeOrtPackages,
} = {}) {
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
  // The CLI asks for diagnostics. Capabilities is on a hot path and should not
  // spawn Python just to decide whether to warm the worker or allow a call.
  if (includeRuntime && paths && existsSync(paths.python)) {
    try {
      const ortPackages = probePackages(paths.python);
      const check = ortPackageCheck(ortPackages);
      Object.assign(engines.local, {
        ortPackages,
        tts: check.ok ? liveTtsStatus(paths) : null,
        ...(!check.ok && { state: 'unavailable', reason: check.detail }),
      });
    } catch (error) {
      Object.assign(engines.local, { state: 'unavailable', reason: error.message });
    }
  }
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

function liveTtsStatus(paths) {
  try {
    const { pid, profile } = JSON.parse(readFileSync(join(paths.root, 'tts-profile.json'), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0 || !Array.isArray(profile?.providers) || !profile.providers.length) return null;
    process.kill(pid, 0); // only check liveness; never send a signal
    return { ...profile, activeProvider: profile.providers[0] };
  } catch {
    // An old snapshot is not an active provider. No test model is loaded here.
    return null;
  }
}

const DOCTOR_PROBE = String.raw`
import contextlib, json, os, subprocess, sys
from dataclasses import replace
${ORT_DIST_PROBE}
result = {"versions": {}, "vram": None, "whisper": None, "error": None, "ortPackages": ort_packages()}
if len(result["ortPackages"]) != 1:
    print(json.dumps(result))
    sys.exit(0)

models_dir = os.environ.get("VERSUTUS_VOICE_MODELS", "")
cpu = False
try:
    from versutus_voice.server import _register_cuda_dlls, force_cpu

    cpu = force_cpu(models_dir)
    _register_cuda_dlls()
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
device, compute_type = ("cpu", "int8") if cpu or sys.platform == "darwin" else ("cuda", "int8_float16")
result["whisper"] = {"device": device, "computeType": compute_type, "ok": False}
try:
    from faster_whisper import WhisperModel
    names = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json")
    whisper_dir = os.path.join(models_dir, "whisper")
    missing = [name for name in names if not os.path.exists(os.path.join(whisper_dir, name))]
    if missing:
        result["whisper"]["error"] = "missing: " + ", ".join(missing)
    else:
        model = WhisperModel(whisper_dir, device=device, compute_type=compute_type)
        del model
        result["whisper"]["ok"] = True
except Exception as error:
    result["whisper"]["error"] = str(error)[:300]

# Each model is probed through the worker's own loader, in its own guard: one
# broken model must name itself without hiding the state of the other two.
try:
    from versutus_voice.audio import VAD_WINDOW_SAMPLES
    from versutus_voice.server import SileroScorer

    # One 32 ms window of silence: a missing or incompatible graph fails here,
    # which is exactly the failure that would make every window read as silence.
    SileroScorer()(b"\x00\x00" * VAD_WINDOW_SAMPLES)
    result["silero"] = {"ok": True, "error": None}
except Exception as error:
    result["silero"] = {"ok": False, "error": str(error)[:300]}

try:
    from versutus_voice.server import load_smart_turn

    # The loader returns None when the model is absent or cannot run its first
    # inference; that is the degraded "pause is a turn" judge the doctor exists
    # to catch, so it is a failure rather than an unknown.
    if load_smart_turn(models_dir) is None:
        installed = []
        if os.path.isdir(models_dir):
            installed = sorted(name for name in os.listdir(models_dir) if name.startswith("smart-turn"))
        reason = "no smart-turn model under " + models_dir if not installed else "the smart-turn model did not run"
        result["smartTurn"] = {"ok": False, "error": reason}
    else:
        result["smartTurn"] = {"ok": True, "error": None}
except Exception as error:
    result["smartTurn"] = {"ok": False, "error": str(error)[:300]}

try:
    from versutus_voice.kokoro import last_tts_latency, load_kokoro_speech, read_tts_config
    from versutus_voice.tts import WARMUP_TEXT

    config = read_tts_config(models_dir)
    if cpu:
        config = replace(config, provider="cpu")
    # ORT can print during provider selection. Keep the probe stdout JSON-only.
    with contextlib.redirect_stdout(sys.stderr):
        speaker = load_kokoro_speech(models_dir, config)
        if config.warmup != "off" and speaker.startup_warmup_ms is None:
            speaker.prime()
        first_ms = None
        for _, _, elapsed in speaker.timed_audio(WARMUP_TEXT, None):
            if first_ms is None:
                first_ms = elapsed
    result["kokoro"] = {
        "ok": first_ms is not None, "error": None if first_ms is not None else "synthesised no audio",
        "profile": speaker.synthesize.profile(), "probeFirstPcmMs": first_ms,
        "lastLive": last_tts_latency(models_dir, config),
    }
except Exception as error:
    result["kokoro"] = {"ok": False, "error": str(error)[:300]}
print(json.dumps(result))
`;

function ortPackageCheck(packages) {
  const installed = Object.entries(packages ?? {});
  const detail = installed.map(([name, version]) => `${name}==${version}`).join(', ');
  if (installed.length > 1) {
    return { name: 'ort', ok: false, detail: `both ${detail} are installed and share files; run voice install to repair the venv` };
  }
  if (installed.length === 0) {
    return { name: 'ort', ok: false, detail: 'no ONNX Runtime distribution found; run voice install' };
  }
  return { name: 'ort', ok: true, detail };
}

/**
 * One named check for a model the worker loads. A probe that did not report the
 * model is a failure, not a pass: the doctor's whole job is to prove the model
 * loads, so "not measured" must never read as "ready".
 */
function modelLoadCheck(name, label, okDetail, probe) {
  if (probe == null) {
    return { name, ok: false, detail: `the ${label} load probe did not run` };
  }
  if (probe.ok) return { name, ok: true, detail: okDetail };
  // A Python exception can wrap; the CLI prints one line per check.
  const reason = String(probe.error ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return { name, ok: false, detail: `${label} failed to load: ${reason}; run voice install` };
}

function kokoroCheck(probe) {
  const check = modelLoadCheck('kokoro', 'Kokoro TTS', 'Kokoro speaks a test sentence to a buffer', probe);
  if (!check.ok || !probe.profile) return check;
  const { profile, probeFirstPcmMs, lastLive } = probe;
  const config = profile.requested;
  const actual = (value) => `${value.model} via ${value.providers[0]}`;
  const last = Number.isFinite(lastLive?.synthToFirstPcmMs)
    ? `${lastLive.synthToFirstPcmMs} ms via ${actual(lastLive.profile)} (${new Date(lastLive.measuredAtUnixMs).toISOString()})`
    : 'not measured for this profile';
  check.detail = `${actual(profile)} voice=${config.voice} chunkWords=${config.chunkWords} warmup=${config.warmup}`
    + ` intra=${config.intraThreads || 'auto'} inter=${config.interThreads} opt=${config.graphOptimization}`
    + ` arena=${config.cpuArena} memoryPattern=${config.memoryPattern} spinning=${config.spinning}`
    + ` execution=${config.interThreads > 1 ? 'parallel' : 'sequential'}`
    + ` chunking=${config.chunkWords > 0 ? 'first-phrase+clauses' : 'off'}`
    + (config.warmup === 'idle' && config.idleSeconds != null ? ` idleSeconds=${config.idleSeconds}` : '')
    + `; probe first PCM ${probeFirstPcmMs} ms; last live first PCM ${last}`
    + describeFallbacks(profile);
  return { ...check, activeProvider: profile.providers[0], profile, probeFirstPcmMs, lastLive };
}

function describeFallbacks(profile) {
  return profile.fallbacks?.length ? `; fallback: ${profile.fallbacks.join('; ')}` : '';
}

/**
 * Check the venv, the GPU, Whisper and the three models every call loads
 * (Silero VAD, Smart Turn, Kokoro). Returns a list of named checks; a failing
 * check names itself instead of throwing.
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
  let info;
  try {
    info = JSON.parse(probe.stdout);
  } catch {
    const firstLine = String(probe.stdout ?? '').split(/\r?\n/, 1)[0].trim();
    checks.push({ name: 'probe', ok: false, detail: firstLine || 'probe returned invalid JSON' });
    return { ok: false, checks };
  }
  const ortCheck = ortPackageCheck(info.ortPackages);
  checks.push(ortCheck);
  if (!ortCheck.ok) return { ok: false, checks };
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
  if (info.whisper == null) {
    checks.push({ name: 'whisper', ok: false, detail: 'the Whisper load probe did not run' });
  } else {
    const { device, computeType, ok, error } = info.whisper;
    const detail = ok
      ? `whisper loads on ${device.toUpperCase()} (${computeType})`
      : `${device.toUpperCase()} load failed: ${error ?? 'unknown error'}; run voice install`;
    checks.push({ name: 'whisper', ok, detail });
  }
  // The three models a call cannot do without are probed by name: a call with
  // no Silero, no Smart Turn (the degraded "pause is a turn" judge) or no
  // Kokoro must fail the doctor instead of passing it.
  checks.push(
    modelLoadCheck('silero', 'Silero VAD', 'silero VAD scores a 32 ms window', info.silero),
    modelLoadCheck('smartTurn', 'Smart Turn', 'smart turn loads (not the pause-is-a-turn fallback)', info.smartTurn),
    kokoroCheck(info.kokoro),
  );
  const live = liveTtsStatus(paths);
  if (live) {
    checks.push({ name: 'kokoroLive', ok: true, detail: `${live.activeProvider}${describeFallbacks(live)}` });
  }
  log(JSON.stringify(checks));

  const status = voiceStatus({ paths });
  const ok = checks.every((check) => check.ok || check.name === 'cuda') && status.engines.local.state === 'ready';
  return { ok, checks, engines: status.engines };
}
