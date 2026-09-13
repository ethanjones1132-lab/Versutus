// ─── The local voice engine: a supervised Python worker on this PC ────────
// Implements the §4.5 engine interface over newline-delimited JSON-RPC on the
// worker's stdio. The worker is spawned through `buildCliEnvironment` so it
// sees only the environment it is given, and restarted with backoff when it
// dies; only after the restart budget is spent does the call end. Nothing here
// imports a model — the worker owns every model call.

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

import { createStdioJsonRpc } from '../../cli-environments/jsonrpc-stdio.mjs';
import { buildCliEnvironment } from '../../cli-environments/process-environment.mjs';

const INPUT_SAMPLE_RATE = 16000;

/** Start the real worker: the Gate voice venv running `versutus_voice.server`. */
export function spawnVoiceWorker({ paths, env = process.env } = {}) {
  return nodeSpawn(
    paths.python,
    ['-m', 'versutus_voice.server', '--models-dir', paths.models],
    {
      cwd: paths.worker,
      env: buildCliEnvironment(env, {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

export class LocalEngine extends EventEmitter {
  constructor({
    paths,
    spawn = () => spawnVoiceWorker({ paths }),
    createRpc = createStdioJsonRpc,
    backoffMs = [250, 500, 1000, 2000],
    maxRestarts = 5,
    schedule = (fn, ms) => setTimeout(fn, ms),
    log = () => {},
  } = {}) {
    super();
    this.id = 'local';
    this._paths = paths;
    this._spawn = spawn;
    this._createRpc = createRpc;
    this._backoff = backoffMs;
    this._maxRestarts = maxRestarts;
    this._schedule = schedule;
    this._log = log;
    this._child = null;
    this._rpc = null;
    this._call = null;
    this._restarts = 0;
    this._closed = false;
    this._opened = false;
  }

  async open(call = {}) {
    this._call = call;
    this._closed = false;
    this._restarts = 0;
    this._ensureWorker();
    this._openSession();
    this._opened = true;
  }

  pushAudio(frame) {
    const pcm = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    this._send('voice.pushAudio', {
      chunk: { data: pcm.toString('base64'), sampleRate: INPUT_SAMPLE_RATE, numChannels: 1 },
    });
  }

  speak(text, { gen, final } = {}) {
    this._send('voice.speak', { gen, text, final: Boolean(final) });
  }

  cancelSpeech(gen) {
    this._send('voice.cancelSpeech', { gen });
  }

  setMuted(muted) {
    this._send('voice.setMuted', { muted: Boolean(muted) });
  }

  async close() {
    this._closed = true;
    this._send('voice.close', {});
    try {
      this._rpc?.close();
    } catch {
      // the worker is already gone
    }
    this._rpc = null;
    this._child?.kill?.();
    this._child = null;
  }

  _ensureWorker() {
    if (this._rpc || this._closed) return;
    const child = this._spawn();
    this._child = child;
    this._rpc = this._createRpc({
      child,
      onNotification: (message) => this._onNotification(message),
      onDiagnostic: (event) => this.emit('log', event?.message ?? String(event)),
    });
    child.on('exit', (code) => this._onExit(code));
  }

  _openSession() {
    if (!this._call) return;
    this._send('voice.open', {
      voiceSessionId: this._call.voiceSessionId,
      botName: this._call.botName,
    });
  }

  _send(method, params) {
    try {
      this._rpc?.notify(method, params);
    } catch (error) {
      this._log(error);
    }
  }

  _onNotification(message) {
    const method = message?.method;
    const params = message?.params ?? {};
    if (method === 'voice.partial') this.emit('partial', { text: params.text });
    else if (method === 'voice.final') this.emit('final', { text: params.text });
    else if (method === 'voice.speechAudio') {
      const chunk = params.chunk ?? {};
      this.emit('speechAudio', { gen: params.gen, pcm: Buffer.from(chunk.data ?? '', 'base64') });
    } else if (method === 'voice.speechDone') this.emit('speechDone', { gen: params.gen });
    else if (method === 'voice.userSpeechStart') this.emit('userSpeechStart', { gen: params.gen });
    else if (method === 'voice.error') {
      this.emit('error', {
        code: params.code,
        message: params.message,
        fatal: Boolean(params.fatal),
      });
    }
  }

  _onExit(code) {
    this._rpc = null;
    this._child = null;
    if (this._closed) return;
    if (this._restarts >= this._maxRestarts) {
      this.emit('error', {
        code: 'worker-exhausted',
        message: `The voice worker exited ${this._restarts + 1} times without staying up.`,
        fatal: true,
      });
      return;
    }
    const delay = this._backoff[Math.min(this._restarts, this._backoff.length - 1)];
    this._restarts += 1;
    this._schedule(() => {
      if (this._closed) return;
      this._ensureWorker();
      this._openSession();
    }, delay);
  }
}
