// ─── The local voice engine: a lease on the shared, warm Python worker ──────
// Implements the §4.5 engine interface over newline-delimited JSON-RPC on the
// stdio of the worker the pool owns. Nothing here spawns or kills a process:
// `open` takes a lease (warming the worker first if nobody has), waits for the
// worker's `voice.ready` and then for `voice.open` to be acknowledged, and
// `close` hands the lease back with the process still warm for the next call.
//
// A worker that dies mid-call is a 250-2000 ms gap, not the end of it: what
// the engine was asked to say in that gap is queued and replayed once the new
// `voice.open` is acknowledged, so a three-sentence reply comes out as three
// sentences instead of one. `speak` reports whether it could be honoured — it
// returns false while the worker is away rather than dropping the text.
// Audio is not queued: speech from two seconds ago is not what the person is
// saying now. Nothing here imports a model — the worker owns every model call.

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

import { createStdioJsonRpc } from '../../cli-environments/jsonrpc-stdio.mjs';
import { buildCliEnvironment } from '../../cli-environments/process-environment.mjs';
import { createVoiceWorkerPool } from './worker-pool.mjs';

const INPUT_SAMPLE_RATE = 16000;

/** How long one call may wait for a worker before the call is ended. */
export const ENGINE_OPEN_TIMEOUT_MS = 90_000;
/**
 * How many commands may wait out a worker restart. A restart is measured in
 * seconds and a reply in sentences, so this is only ever reached by a worker
 * that stays away: the bound is there so a wedged worker cannot grow the queue
 * for the rest of the call, not to shape ordinary work.
 */
export const ENGINE_COMMAND_QUEUE_LIMIT = 64;

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

function namedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class LocalEngine extends EventEmitter {
  constructor({
    paths,
    pool = null,
    spawn = null,
    createRpc = createStdioJsonRpc,
    backoffMs,
    maxRestarts,
    schedule,
    log = () => {},
    now = () => Date.now(),
    engineOpenTimeoutMs = ENGINE_OPEN_TIMEOUT_MS,
    commandQueueLimit = ENGINE_COMMAND_QUEUE_LIMIT,
  } = {}) {
    super();
    this.id = 'local';
    this._paths = paths;
    this._log = log;
    this._now = now;
    this._openTimeoutMs = engineOpenTimeoutMs;
    this._queueLimit = commandQueueLimit;
    this._call = null;
    this._lease = null;
    this._queue = [];
    // `voice.open` has been acknowledged: the worker can hear this call. Every
    // command checks it, so a restart costs a queue and not a dropped reply.
    this._open = false;
    this._closed = true;
    this._reopening = false;
    this._pool = pool ?? createVoiceWorkerPool({
      spawn: spawn ?? (() => spawnVoiceWorker({ paths })),
      createRpc,
      backoffMs,
      maxRestarts,
      schedule,
      log: (line) => this._log(line),
      // The worker's own words (its stderr, a python traceback) are the engine's
      // `log` event, exactly as they were when the engine spawned it.
      onDiagnostic: (line) => this.emit('log', line),
    });
  }

  async open(call = {}) {
    this._call = call;
    this._closed = false;
    this._open = false;
    const startedAt = this._now();
    const lease = await this._acquire();
    if (this._closed) {
      // The call hung up while the worker was loading: the lease goes straight
      // back rather than sitting on the one the Gate allows.
      lease.release();
      return;
    }
    this._lease = lease;
    lease.onNotification((message) => this._onNotification(message));
    await this._openSession();
    this._open = true;
    this._log(`voice.engine open afterMs=${this._now() - startedAt}`);
    this._flushQueue();
  }

  pushAudio(frame) {
    // Dropped, not queued: audio the worker missed is a gap in what the person
    // said, and replaying a second of stale microphone would be worse.
    if (!this._open || !this._lease) return;
    const pcm = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    this._send('voice.pushAudio', {
      chunk: { data: pcm.toString('base64'), sampleRate: INPUT_SAMPLE_RATE, numChannels: 1 },
    });
  }

  /** Speak `text` now if the worker can; otherwise queue it. Returns whether. */
  speak(text, { gen, final } = {}) {
    return this._command('speak', 'voice.speak', { gen, text, final: Boolean(final) });
  }

  cancelSpeech(gen) {
    this._command('cancelSpeech', 'voice.cancelSpeech', { gen });
  }

  setMuted(muted) {
    this._command('setMuted', 'voice.setMuted', { muted: Boolean(muted) });
  }

  async close() {
    this._closed = true;
    this._open = false;
    this._queue.length = 0;
    const lease = this._lease;
    this._lease = null;
    lease?.release();
  }

  /** A lease, or `engine_not_ready` once this call's own budget is spent. */
  async _acquire() {
    const pending = this._pool.lease();
    let timer = null;
    try {
      return await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(namedError('engine_not_ready', `The PC voice engine was not ready within ${this._openTimeoutMs}ms.`)),
            this._openTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      // A lease that arrives after this call gave up is handed straight back:
      // the pool allows one, and nobody is here to use it.
      pending.then((lease) => lease.release(), () => {});
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _openSession() {
    if (!this._lease || !this._call) return;
    const { voiceSessionId, botName } = this._call;
    await this._lease.request('voice.open', { voiceSessionId, botName }, { timeoutMs: this._openTimeoutMs });
  }

  _command(kind, method, params) {
    if (this._open && this._lease) {
      try {
        this._lease.send(method, params);
        return true;
      } catch (error) {
        // The worker left between frames. Everything from here waits for the
        // next `voice.open` instead of being swallowed.
        this._open = false;
        this._log(error);
      }
    }
    this._enqueue(kind, method, params);
    return false;
  }

  _send(method, params) {
    try {
      this._lease?.send(method, params);
    } catch (error) {
      this._open = false;
      this._log(error);
    }
  }

  _enqueue(kind, method, params) {
    if (this._queue.length >= this._queueLimit) {
      // Past the bound the queue is the problem, not the worker: the oldest
      // unsaid sentence is dropped, and only said so once it happens.
      const spoken = this._queue.findIndex((entry) => entry.kind === 'speak');
      const at = spoken >= 0 ? spoken : 0;
      const [dropped] = this._queue.splice(at, 1);
      this._log(`voice.engine queue dropped kind=${dropped.kind} chars=${String(dropped.params.text ?? '').length}`);
    }
    this._queue.push({ kind, method, params });
  }

  _flushQueue() {
    const queued = this._queue;
    this._queue = [];
    for (let index = 0; index < queued.length; index += 1) {
      const entry = queued[index];
      try {
        this._lease?.send(entry.method, entry.params);
      } catch (error) {
        // The worker went away mid-replay: the rest waits for the next open.
        this._open = false;
        this._log(error);
        this._queue.push(...queued.slice(index));
        return;
      }
    }
  }

  /** A second `voice.ready` means a new process took the old lease's place. */
  async _reopen() {
    if (this._closed || this._reopening || !this._lease || !this._call) return;
    this._reopening = true;
    const lease = this._lease;
    try {
      await this._openSession();
      if (this._closed || this._lease !== lease) return;
      this._open = true;
      this._log('voice.engine recovered');
      this._flushQueue();
    } catch (error) {
      // The replacement died too; the pool's restart budget decides what
      // happens next, and a fatal there ends this call.
      this._log(error);
    } finally {
      this._reopening = false;
    }
  }

  _onNotification(message) {
    const method = message?.method;
    const params = message?.params ?? {};
    if (method === 'voice.ready') {
      void this._reopen();
    } else if (method === 'voice.partial') this.emit('partial', { text: params.text });
    else if (method === 'voice.final') this.emit('final', { text: params.text });
    else if (method === 'voice.earlyEnd') this.emit('earlyEnd', { text: params.text });
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
}
