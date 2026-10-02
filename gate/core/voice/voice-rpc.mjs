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

/**
 * How long an ended session's record stays answerable. It cannot go at once: a
 * phone whose media socket upgrade is still in flight has to be told the session
 * is over, not that it never existed, or a socket arriving after its grant was
 * released would find nothing to refuse and could open a call beside the
 * replacement (media-socket.mjs rejects on `session.ended`, which needs the
 * record). Ten minutes covers that upgrade; past it the record says nothing an
 * unknown id does not, and the media socket answers both with 404.
 */
export const ENDED_RETENTION_MS = 10 * 60_000;

/**
 * How many ended records are held at once, oldest ended first. Ended records
 * exist to refuse a late upgrade, not to be listed, so a day of calls must not
 * leave a day of records behind. Live records are never evicted: one of them
 * still holds its device.
 */
export const MAX_ENDED_SESSIONS = 200;

/** The live-call registry the media socket also reads. */
export class VoiceSessionRegistry {
  constructor({
    now = () => Date.now(),
    endedRetentionMs = ENDED_RETENTION_MS,
    maxEndedSessions = MAX_ENDED_SESSIONS,
  } = {}) {
    this.sessions = new Map();
    this._endListeners = new Set();
    this._now = now;
    this._endedRetentionMs = endedRetentionMs;
    this._maxEndedSessions = maxEndedSessions;
    // Live ids per device, in the order they were created. `voice.session.start`
    // asks for the device's live call on every attempt, so walking the whole
    // map — every ended record included — made the start path cost O(sessions
    // ever) instead of O(this device's calls). This index holds only not-ended
    // records, and only `create`/`end` write it.
    this._liveByDevice = new Map();
    // Ended ids in the order they ended, with the clock reading at the end.
    // This is what makes "oldest ended first" and "older than its retention
    // window" answerable without walking the map.
    this._ended = new Map();
  }

  create(record) {
    this._prune();
    const grantedAt = this._now();
    const session = {
      ...record,
      ended: false,
      attached: false,
      grantedAt,
      lastSeenAt: grantedAt,
    };
    this.sessions.set(record.voiceSessionId, session);
    this._addLive(session.deviceId, record.voiceSessionId);
    return session;
  }

  /** Index a live session against its device, first come first served. */
  _addLive(deviceId, voiceSessionId) {
    let ids = this._liveByDevice.get(deviceId);
    if (!ids) {
      ids = new Set();
      this._liveByDevice.set(deviceId, ids);
    }
    ids.add(voiceSessionId);
  }

  /** Take a session off its device's index; an emptied device is forgotten. */
  _removeLive(deviceId, voiceSessionId) {
    const ids = this._liveByDevice.get(deviceId);
    if (!ids) return;
    ids.delete(voiceSessionId);
    if (ids.size === 0) this._liveByDevice.delete(deviceId);
  }

  /**
   * Sweep ended records: past their retention window, then past the cap. Called
   * from `create`, `end` and `liveForDevice` — the only writers and the only
   * paths that touch the registry often enough to pay for it — so nothing here
   * needs a timer of its own and the map stays bounded whether or not calls are
   * still being made.
   */
  _prune() {
    const cutoff = this._now() - this._endedRetentionMs;
    // `_ended` is in end order, so the first record still inside its window
    // ends the sweep: everything after it ended later and is inside it too.
    for (const [voiceSessionId, endedAtMs] of this._ended) {
      if (endedAtMs > cutoff) break;
      this._ended.delete(voiceSessionId);
      this.sessions.delete(voiceSessionId);
    }
    for (const voiceSessionId of this._ended.keys()) {
      if (this._ended.size <= this._maxEndedSessions) break;
      this._ended.delete(voiceSessionId);
      this.sessions.delete(voiceSessionId);
    }
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
      this._prune();
      const ids = this._liveByDevice.get(deviceId);
      if (!ids) return null;
      const now = this._now();
      for (const voiceSessionId of ids) {
        const session = this.sessions.get(voiceSessionId);
        // The index holds only not-ended records; a miss means the record was
        // released from under it, so it cannot be this device's live call.
        if (!session || session.ended) continue;
        if (!session.attached && now - session.grantedAt > GRANT_ATTACH_GRACE_MS) {
          this.end(voiceSessionId, 'expired');
          continue;
        }
        if (session.attached && now - session.lastSeenAt > ATTACHED_LIVENESS_MS) {
          this.end(voiceSessionId, 'abandoned');
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
    session.endedAtMs = this._now();
    // The fan-out runs with `thread` still in place: the media socket writes its
    // audit line from the terminal event it dispatches inside its own `end()`,
    // and that line names the Bot.
    for (const listener of [...this._endListeners]) {
      try {
        listener(session, reason);
      } catch {
        // one bad listener must not keep a session from being released
      }
    }
    // The thread is the phone's own object, stored by reference and unbounded.
    // Nothing reads it once the call is over — the fan-out above is the last
    // reader — so the record stops holding every conversation's thread for the
    // life of the Gate.
    session.thread = undefined;
    this._removeLive(session.deviceId, voiceSessionId);
    this._ended.set(voiceSessionId, session.endedAtMs);
    // Swept here too, so the bound holds the moment a call ends and not only
    // after the next start: an idle Gate must not sit on a day's records.
    this._prune();
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
  prepareCallBackend = null,
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
        const started = registry.create({
          voiceSessionId,
          deviceId,
          engine: choice.engine,
          thread: params.thread,
          startedAt: now(),
        });
        // Which backend answers this call's turns is decided here, while the
        // phone is still dialling, instead of inside its first reply — and it
        // cannot change between two turns of one call. The resolve runs in the
        // background: the start reply never waits for it, a failure is not
        // remembered, and the first turn asks again if it has to.
        const lease = prepareCallBackend?.({ voiceSessionId, thread: params.thread });
        if (lease) {
          started.backendLease = lease;
          // Never awaited, never a failure of the start reply: a resolve that
          // cannot finish is one the call asks for again when it needs it.
          Promise.resolve(lease.backend?.()).catch(() => undefined);
        }

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
