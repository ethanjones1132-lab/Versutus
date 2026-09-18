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

/** The live-call registry the media socket also reads. */
export class VoiceSessionRegistry {
  constructor() {
    this.sessions = new Map();
  }

  create(record) {
    const session = { ...record, ended: false };
    this.sessions.set(record.voiceSessionId, session);
    return session;
  }

  get(voiceSessionId) {
    return this.sessions.get(voiceSessionId) ?? null;
  }

  liveForDevice(deviceId) {
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && !session.ended) return session;
    }
    return null;
  }

  end(voiceSessionId) {
    const session = this.sessions.get(voiceSessionId);
    if (!session) return false;
    session.ended = true;
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
      // M1 S1: codex app-server realtime requires API-key auth; the ChatGPT
      // login cannot provide it, so this engine does not ship.
      codex: {
        state: 'disabled',
        reason: 'Codex realtime needs an API key; the ChatGPT login does not provide one.',
      },
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
      requireDevice(ctx, params);
      return decorate(capabilities());
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
      const deviceId = requireDevice(ctx, params);
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

      return {
        voiceSessionId,
        engine: choice.engine,
        ...(choice.fellBackFrom ? { fellBackFrom: choice.fellBackFrom, reason: choice.reason } : {}),
        streamPath: '/v1/voice/stream',
        input: { ...INPUT },
        output: { ...OUTPUT },
      };
    },

    'voice.session.stop': async (params = {}, ctx) => {
      const deviceId = requireDevice(ctx, params);
      const session = registry.get(params.voiceSessionId);
      if (!session) throw rpcError('Unknown voice session', 404, 'unknown_session');
      if (session.deviceId !== deviceId) {
        throw rpcError('That voice session belongs to another device', 403, 'not_your_session');
      }
      registry.end(params.voiceSessionId);
      return { stopped: true };
    },
  };

  return { methods, registry };
}
