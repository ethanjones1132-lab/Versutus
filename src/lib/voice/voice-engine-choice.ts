// ─── Which engine a call should use, and why ──────────────────────────────
// The operator's preference is one input; the Gate's live readiness is the
// other. This is the whole decision, kept pure so every combination is a unit
// test rather than a device session: it names the engine actually chosen, and
// whenever that differs from the request it names the fallback and the reason
// the requested engine gave. `auto` is the Gate's own order, `local` first.
// A Gate whose voice switch is off chooses no engine at all: calls are off on
// every engine, and the phone is never the answer to that (S7/D7).
//
// M1 removed `codex` from shipping (it cannot run on the ChatGPT login), but it
// stays a real state here so a future CLI that accepts the login is a data
// change, not a rewrite.

export type VoiceEnginePreference = 'auto' | 'local' | 'codex' | 'phone';

/** The engines that can actually run, as opposed to the preference. */
export type RunningVoiceEngine = 'local' | 'codex' | 'phone';

/**
 * What a call will run on. `none` is the Gate's voice switch being off: calls
 * are off on every engine, so there is no engine to name. It exists so a
 * disabled Gate can never be read as "use the phone instead" (S7/D7).
 */
export type ResolvedVoiceEngine = RunningVoiceEngine | 'none';

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
  enabled?: boolean;
  engines: {
    local: VoiceEngineStatus;
    codex: VoiceEngineStatus;
  };
  /** Today's minutes per Gate engine (§4.9). */
  usedToday?: { localMinutes?: number; codexMinutes?: number };
  /** The most recent call error the Gate recorded, or null. */
  lastError?: string | null;
};

/** The off switch is authoritative even when no engine status came back. */
export type VoiceCapabilitiesSnapshot = VoiceEngineCapabilities | { enabled: false };

export type VoiceEngineChoice = {
  engine: ResolvedVoiceEngine;
  /** Set when the chosen engine is not the one requested. */
  fellBackFrom?: 'local' | 'codex';
  /** Why the requested engine could not be used. */
  reason?: string;
};

const FALLBACK_ORDER: RunningVoiceEngine[] = ['local', 'codex', 'phone'];
/** The one sentence for a switched-off Gate; Settings shows the same words. */
export const VOICE_CALLS_OFF_REASON = 'Gate voice is turned off on this PC.';
export const CALL_PLATFORM_REASON = 'Hands-free calls are available on Android.';

/** D1: applies even to links and to the explicit phone engine. */
export function supportsHandsfreeCalls(platform: string): boolean {
  return platform === 'android';
}

function statusOf(capabilities: VoiceCapabilitiesSnapshot, engine: 'local' | 'codex'): VoiceEngineStatus {
  const status = 'engines' in capabilities ? capabilities.engines?.[engine] : undefined;
  if (!status || typeof status.state !== 'string') return { state: 'not-installed' };
  return status;
}

function isReady(capabilities: VoiceCapabilitiesSnapshot, engine: RunningVoiceEngine): boolean {
  if (engine === 'phone') return true;
  return statusOf(capabilities, engine).state === 'ready';
}

export function chooseVoiceEngine(
  preference: VoiceEnginePreference,
  capabilities: VoiceCapabilitiesSnapshot,
  platform?: string,
): VoiceEngineChoice {
  if (platform !== undefined && !supportsHandsfreeCalls(platform)) {
    return { engine: 'none', reason: CALL_PLATFORM_REASON };
  }
  // S7/D7: the Gate's one switch turns calls off for every engine, and it is
  // checked before the preference and before any fallback. A phone call in its
  // place is exactly the silent fallback the switch exists to stop — even when
  // the operator's stored preference names the phone.
  if (capabilities.enabled === false) {
    const asked = preference === 'local' || preference === 'codex' ? preference : undefined;
    return {
      engine: 'none',
      ...(asked ? { fellBackFrom: asked } : {}),
      reason: VOICE_CALLS_OFF_REASON,
    };
  }

  if (preference === 'phone') return { engine: 'phone' };

  const requested = preference === 'auto' ? undefined : preference;
  const requestedStatus = requested ? statusOf(capabilities, requested) : undefined;

  if (requested && isReady(capabilities, requested)) {
    return { engine: requested };
  }

  const next = FALLBACK_ORDER.find((engine) => engine !== requested && isReady(capabilities, engine));
  // `phone` is always in the order, so `next` is never undefined.
  const engine = next ?? 'phone';

  if (!requested) {
    // `auto` that landed on a ready PC engine has nothing to warn about: the
    // unready engine it skipped (Codex, usually) is not the one being used.
    if (engine !== 'phone') return { engine };
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
