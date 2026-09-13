// ─── Which engine a call should use, and why ──────────────────────────────
// The operator's preference is one input; the Gate's live readiness is the
// other. This is the whole decision, kept pure so every combination is a unit
// test rather than a device session: it names the engine actually chosen, and
// whenever that differs from the request it names the fallback and the reason
// the requested engine gave. `auto` is the Gate's own order, `local` first.
//
// M1 removed `codex` from shipping (it cannot run on the ChatGPT login), but it
// stays a real state here so a future CLI that accepts the login is a data
// change, not a rewrite.

export type VoiceEnginePreference = 'auto' | 'local' | 'codex' | 'phone';

/** The engines that can actually run, as opposed to the preference. */
export type RunningVoiceEngine = 'local' | 'codex' | 'phone';

/** What the Gate says about one engine right now. */
export type VoiceEngineRuntimeState =
  | 'ready'
  | 'not-installed'
  | 'installing'
  | 'starting'
  | 'unavailable'
  | 'over-allowance'
  | 'disabled';

export type VoiceEngineStatus = {
  state: VoiceEngineRuntimeState;
  /** One sentence the Settings row and the banner show when the engine is not ready. */
  reason?: string;
};

export type VoiceEngineCapabilities = {
  enabled: boolean;
  engines: {
    local: VoiceEngineStatus;
    codex: VoiceEngineStatus;
  };
};

export type VoiceEngineChoice = {
  engine: RunningVoiceEngine;
  /** Set when the chosen engine is not the one requested. */
  fellBackFrom?: 'local' | 'codex';
  /** Why the requested engine could not be used. */
  reason?: string;
};

const FALLBACK_ORDER: RunningVoiceEngine[] = ['local', 'codex', 'phone'];
const KILL_SWITCH_REASON = 'Gate voice is turned off.';

function statusOf(capabilities: VoiceEngineCapabilities, engine: 'local' | 'codex'): VoiceEngineStatus {
  const status = capabilities.engines?.[engine];
  if (!status || typeof status.state !== 'string') return { state: 'not-installed' };
  return status;
}

function isReady(capabilities: VoiceEngineCapabilities, engine: RunningVoiceEngine): boolean {
  if (engine === 'phone') return true;
  return statusOf(capabilities, engine).state === 'ready';
}

export function chooseVoiceEngine(
  preference: VoiceEnginePreference,
  capabilities: VoiceEngineCapabilities,
): VoiceEngineChoice {
  if (preference === 'phone') return { engine: 'phone' };

  const requested = preference === 'auto' ? undefined : preference;
  const requestedStatus = requested ? statusOf(capabilities, requested) : undefined;

  if (!capabilities.enabled) {
    return {
      engine: 'phone',
      ...(requested ? { fellBackFrom: requested } : {}),
      reason: KILL_SWITCH_REASON,
    };
  }

  if (requested && isReady(capabilities, requested)) {
    return { engine: requested };
  }

  const next = FALLBACK_ORDER.find((engine) => engine !== requested && isReady(capabilities, engine));
  // `phone` is always in the order, so `next` is never undefined.
  const engine = next ?? 'phone';

  if (!requested) {
    // `auto` has no request to fall back from; the reason is the first gate
    // engine's, so a phone call on a PC-less Gate still says why.
    const reason = statusOf(capabilities, 'local').reason
      ?? statusOf(capabilities, 'codex').reason
      ?? 'PC voice is not ready.';
    return { engine, reason };
  }

  return {
    engine,
    fellBackFrom: requested,
    reason: requestedStatus?.reason ?? 'PC voice is not ready.',
  };
}
