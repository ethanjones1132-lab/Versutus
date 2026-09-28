// ─── Voice RPC: capability, session start/stop ───────────────────────────
// Registered beside the push RPC. Every method resolves its caller exactly as
// `notification.*` does (push-rpc.mjs requireDevice): a paired-device grant, or
// a bootstrap-token phone that names its own device id and is filed as
// `bootstrap:<id>`. Without the second, a phone connected with the Gate's own
// token could never start a call (2026-09-17). One live call per
// device; a start that cannot use the requested engine names why and what it
// used instead (§4.2), so a fallback is never silent.

import { requireDevice } from '../push-rpc.mjs';
import { randomUUID } from 'node:crypto';
import { codexRealtimeStatus } from './codex-status.mjs';

/**
 * How long a granted-but-never-attached session blocks new starts. Longer
 * than the phone's whole start path (grant → session → media socket) needs;
 * far shorter than "until the Gate restarts".
 */
export const GRANT_ATTACH_GRACE_MS = 60_000;

/**
 * How long an attached session may go with no traffic in either direction
 * before the Gate treats the phone as gone and releases the device.
 *
 * This is a backstop, not the primary release path: the media socket already
 * ends a call whose audio stops (`NO_AUDIO_TIMEOUT_MS`), one that no socket
 * rejoins (`RESUME_TIMEOUT_MS`), and every call on a Gate restart (`endAll`).
 * Those are all driven from the call's own timers, so a call whose timers never
 * run — a wedged event loop, a half-open socket that never emits `close` — kept
 * its device reservation forever, and `markAttached` being a one-way latch meant
 * nothing could take it back. A phone streams microphone audio continuously, so
 * a healthy call refreshes its lease many times a second and never approaches
 * this bound; only a call nobody is on the other end of goes quiet.
 */
export const ATTACHED_LIVENESS_MS = 90_000;

/** The live-call registry the media socket also reads. */
export class VoiceSessionRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.sessions = new Map();
    this._endListeners = new Set();
    this._now = now;
  }

  create(record) {
    const grantedAt = this._now();
    const session = {
      ...record,
      ended: false,
      attached: false,
      grantedAt,
      lastSeenAt: grantedAt,
    };
    this.sessions.set(record.voiceSessionId, session);
    return session;
  }

  get(voiceSessionId) {
    return this.sessions.get(voiceSessionId) ?? null;
  }

  /** The media socket calls this when a call's first socket actually attaches. */
  markAttached(voiceSessionId) {
    const session = this.sessions.get(voiceSessionId);
    if (!session) return;
    session.attached = true;
    session.lastSeenAt = this._now();
  }

  /**
   * The media socket calls this for every frame that crosses it — inbound audio,
   * an inbound control frame, outbound speech. It is what keeps a live call's
   * lease from expiring underneath it.
   */
  markActivity(voiceSessionId) {
    const session = this.sessions.get(voiceSessionId);
    if (session) session.lastSeenAt = this._now();
  }

  /**
     * The one live call a device may have. A grant that never attached a socket
     * (the phone died between `voice.session.start` and the media link) stops
     * counting as live once its grace period passes, so a retry after a failed
     * start is not `call_in_progress` forever when the compensating
     * `voice.session.stop` never landed either.
     *
     * An attached call holds the device for as long as it is alive. Once it goes
     * completely silent past its liveness lease the phone is not there, so the
     * call is ended with reason `abandoned` and the device is released. Ending it
     * (rather than merely skipping it) is what makes the release stick, and the
     * end fans out through `onEnd`: the media socket tears its call down in the
     * same turn, before `voice.session.start` can hand the device to a new
     * session. A released reservation with a call still running beside the new
     * one would be two media calls for one device.
     *
     * A lapsed grant is ended for the same reason, not merely skipped. Skipping
     * freed the device for a retry but left the old record open, so the phone's
     * socket could still arrive after the grace — the wedged start that finally
     * dials — claim that released session, and run beside the replacement: two
     * media calls for one device. Ending it makes the late upgrade a 409.
     */
    liveForDevice(deviceId) {
      const now = this._now();
      for (const session of this.sessions.values()) {
        if (session.deviceId !== deviceId || session.ended) continue;
        if (!session.attached && now - session.grantedAt > GRANT_ATTACH_GRACE_MS) {
          this.end(session.voiceSessionId, 'expired');
          continue;
        }
        if (session.attached && now - session.lastSeenAt > ATTACHED_LIVENESS_MS) {
          this.end(session.voiceSessionId, 'abandoned');
          continue;
        }
        return session;
      }
      return null;
    }

  /**
   * Who hears about a session the registry ends — the media socket, so a call
   * whose reservation was released (as abandoned, or by a `voice.session.stop`
   * that landed after the phone's own teardown) ends with it instead of
   * outliving the device it was holding. Returns the listener's own unsubscribe.
   */
  onEnd(listener) {
    this._endListeners.add(listener);
    return () => this._endListeners.delete(listener);
  }

  end(voiceSessionId, reason = 'unspecified') {
    const session = this.sessions.get(voiceSessionId);
    // The first end wins: the reason a release named is the reason the call,
    // its phone frame and its audit line keep.
    if (!session || session.ended) return false;
    session.ended = true;
    session.endedReason = reason;
    for (const listener of [...this._endListeners]) {
      try {
        listener(session, reason);
      } catch {
        // one bad listener must not keep a session from being released
      }
    }
    return true;
  }
}

const INPUT = Object.freeze({ encoding: 'pcm16le', sampleRate: 16000, channels: 1, frameMs: 20 });
const OUTPUT = Object.freeze({ encoding: 'pcm16le', sampleRate: 24000, channels: 1 });

/** The engines that can run on the Gate right now, and why not when they cannot. */
export function defaultCapabilities() {
  return {
    enabled: true,
    engines: {
      local: {
        state: 'not-installed',
        reason: 'The PC voice models are not installed. Run voice install on the Gate.',
      },
      // M1 S1: ChatGPT login cannot start thread/realtime; the engine is
      // unavailable, not operator-disabled.
      codex: codexRealtimeStatus(null),
    },
    limits: { codexMinutesPerDay: 60, maxConcurrentCalls: 1 },
    usedToday: { localMinutes: 0, codexMinutes: 0 },
  };
}


function rpcError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** `auto` prefers `local`, then `codex`; `phone` never runs on the Gate. */
function readyEngines(engines) {
  return ['local', 'codex'].filter((id) => engines[id]?.state === 'ready');
}

function chooseEngine(requested, engines) {
  const ready = readyEngines(engines);
  if (ready.length === 0) return null;
  if (requested === 'auto') return { engine: ready[0] };
  if (engines[requested]?.state === 'ready') return { engine: requested };
  return {
    engine: ready[0],
    fellBackFrom: requested,
    reason: engines[requested]?.reason ?? `${requested} is not ready.`,
  };
}

function validThread(thread) {
  return thread !== null && typeof thread === 'object'
    && (thread.kind === 'bot' || thread.kind === 'configurable')
    && typeof thread.sessionId === 'string'
    && thread.sessionId.length > 0;
}

export function createVoiceRpc({
  registry = new VoiceSessionRegistry(),
  capabilities = defaultCapabilities,
  now = () => new Date().toISOString(),
  makeId = randomUUID,
  install = null,
  log = () => {},
} = {}) {
  // The install the operator started from the phone, if any. It outlives the
  // request that began it, so `voice.capabilities` and `voice.install.status`
  // both report it while `install` is running.
  let installState = { running: false, error: null };

  const decorate = (state) => {
    if (installState.running) {
      return {
        ...state,
        engines: {
          ...state.engines,
          local: { state: 'installing', reason: 'Installing the PC voice models…' },
        },
      };
    }
    if (installState.error) {
      return {
        ...state,
        engines: {
          ...state.engines,
          local: { state: 'unavailable', reason: installState.error },
        },
      };
    }
    return state;
  };

  const methods = {
    'voice.capabilities': async (params = {}, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const state = decorate(capabilities());
      log(`voice.capabilities device=${deviceId} enabled=${state.enabled} local=${state.engines?.local?.state} codex=${state.engines?.codex?.state}`);
      return state;
    },

    'voice.install.start': async (params = {}, ctx) => {
      requireDevice(ctx, params);
      if (!install) throw rpcError('This Gate cannot install the voice models.', 501, 'install_unavailable');
      if (installState.running) throw rpcError('A voice install is already running.', 409, 'install_in_progress');
      installState = { running: true, error: null };
      Promise.resolve()
        .then(() => install.start())
        .then(() => {
          installState = { running: false, error: null };
        })
        .catch((error) => {
          installState = { running: false, error: error?.message ?? 'The voice install failed.' };
        });
      return { state: 'installing' };
    },

    'voice.install.status': async (params = {}, ctx) => {
      requireDevice(ctx, params);
      if (installState.running) return { state: 'installing', reason: 'Installing the PC voice models…' };
      if (installState.error) return { state: 'unavailable', reason: installState.error };
      return install?.status?.() ?? { state: 'unavailable', reason: 'The voice models are not installed.' };
    },

    'voice.session.start': async (params = {}, ctx) => {
      let deviceId = 'unknown';
      try {
        deviceId = requireDevice(ctx, params);
        if (!validThread(params.thread)) {
          throw rpcError('thread must name a session', 400, 'invalid_request');
        }
        const existing = registry.liveForDevice(deviceId);
        if (existing) {
          throw rpcError('This device already has a live voice call', 409, 'call_in_progress');
        }
        const state = decorate(capabilities());
        // `auto` means the Bot's own preference when it carries one (§4.9); an
        // explicit request from the phone still wins.
        const requested = params.engine ?? params.thread?.voiceEngine ?? 'auto';
        const choice = chooseEngine(requested, state.engines);
        if (!choice) {
          const reason = params.engine && params.engine !== 'auto'
            ? state.engines[params.engine]?.reason ?? `${params.engine} is not installed.`
            : state.engines.local?.reason ?? 'No PC voice engine is installed.';
          throw rpcError(reason, 409, 'no_engine');
        }

        const voiceSessionId = makeId();
        registry.create({
          voiceSessionId,
          deviceId,
          engine: choice.engine,
          thread: params.thread,
          startedAt: now(),
        });

        log(`voice.session.start ok device=${deviceId} engine=${choice.engine} session=${voiceSessionId}`);
        return {
          voiceSessionId,
          engine: choice.engine,
          ...(choice.fellBackFrom ? { fellBackFrom: choice.fellBackFrom, reason: choice.reason } : {}),
          streamPath: '/v1/voice/stream',
          input: { ...INPUT },
          output: { ...OUTPUT },
        };
      } catch (error) {
        log(`voice.session.start fail device=${deviceId} code=${error.code ?? 'rpc_error'} ${error.message}`);
        throw error;
      }
    },

    'voice.session.stop': async (params = {}, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const session = registry.get(params.voiceSessionId);
      if (!session) throw rpcError('Unknown voice session', 404, 'unknown_session');
      if (session.deviceId !== deviceId) {
        throw rpcError('That voice session belongs to another device', 403, 'not_your_session');
      }
      registry.end(params.voiceSessionId);
      log(`voice.session.stop ok device=${deviceId} session=${params.voiceSessionId} reason=${params.reason ?? 'unspecified'}`);
      return { stopped: true };
    },
  };

  return { methods, registry };
}
