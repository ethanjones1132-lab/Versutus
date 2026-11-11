// ─── The words Settings and the start sheet use for each engine ────────────
// Copy is contract, not decoration: the disclosure a call shows is what the
// operator consents to, and the cost/privacy line is how they choose. Keeping
// it in one module lets a test pin it without mounting a screen, and stops the
// Settings row and the start sheet from drifting apart.

import { HANDSFREE_DISCLOSURE } from '@/lib/voice/handsfree-call-copy';
import type { VoiceEnginePreference, VoiceEngineRuntimeState } from '@/lib/voice/voice-engine-choice';

export type VoiceEngineRow = {
  id: VoiceEnginePreference;
  label: string;
  /** One line of cost and where audio goes. */
  summary: string;
  /** What the start sheet shows before the call begins. */
  disclosure: string;
};

// The local engine's audio still crosses the network from the phone to the PC,
// and a plaintext link would let the network read it. S1 refuses that link
// rather than warn, so the one truthful sentence names the encrypted transport
// the call can actually use instead of claiming the audio goes "nowhere else".
export const LOCAL_DISCLOSURE =
  'Your voice streams continuously from this phone to Versutus on your PC while the call is unmuted, over an encrypted link (Tailscale or HTTPS). Nothing is recorded. Speech is sent automatically as a chat message when you pause. End it here or from Android’s notification.';

export const CODEX_DISCLOSURE =
  "Your voice streams continuously from this phone through your PC to OpenAI while the call is unmuted, over an encrypted link (Tailscale or HTTPS). It uses your ChatGPT plan's voice allowance. Versutus records nothing. Speech is sent automatically as a chat message when you pause. End it here or from Android’s notification.";

export const VOICE_ENGINE_ROWS: VoiceEngineRow[] = [
  {
    id: 'auto',
    label: 'Automatic',
    summary: 'This PC when its voice models are ready, otherwise this phone. Only the engine it picks receives audio.',
    disclosure: 'Versutus picks the best available engine for the call and shows which one it used. Whichever engine it picks, your voice streams continuously to it while the call is unmuted. Speech is sent automatically when you pause. End it here or from Android’s notification.',
  },
  {
    id: 'local',
    label: 'This PC — local voice',
    summary: 'Free. Audio stays on your PC and is never recorded.',
    disclosure: LOCAL_DISCLOSURE,
  },
  {
    id: 'codex',
    label: 'ChatGPT subscription (via Codex on this PC)',
    summary: "Spends your ChatGPT plan's voice allowance. Audio goes through your PC to OpenAI.",
    disclosure: CODEX_DISCLOSURE,
  },
  {
    id: 'phone',
    label: 'This phone only',
    summary: 'On-device recognition and speech. Recognition can use the platform speech service, so audio is not guaranteed to stay on the phone.',
    disclosure: HANDSFREE_DISCLOSURE,
  },
];

/** The Grok row is shown disabled, with this reason (§4.8). */
export const GROK_ROW_LABEL = 'Grok subscription';
export const GROK_DISABLED_REASON =
  'Grok’s voice mode is dictation only and has no headless interface, so Versutus will not bridge it. Grok models remain available as a Bot’s text brain.';

/** The readiness sentence Settings shows for one engine. */
export function voiceEngineReadinessCopy(state: VoiceEngineRuntimeState, reason?: string): string {
  switch (state) {
    case 'ready':
      return 'Ready.';
    case 'not-installed':
      return reason ?? 'The PC voice models are not installed yet.';
    case 'installing':
      return reason ?? 'Installing on the PC…';
    case 'starting':
      return reason ?? 'Starting on the PC…';
    case 'over-allowance':
      return reason ?? 'Out of voice allowance for today.';
    case 'disabled':
      return reason ?? 'Unavailable on this PC.';
    default:
      return reason ?? 'Unavailable right now.';
  }
}

/** The disclosure the start sheet shows for the engine a call will use. */
export function voiceEngineDisclosure(preference: VoiceEnginePreference): string {
  return VOICE_ENGINE_ROWS.find((row) => row.id === preference)?.disclosure ?? HANDSFREE_DISCLOSURE;
}

/** The Settings → Voice → Today line: minutes per engine and the last error (§4.9). */
export function voiceUsageCopy(
  usedToday: { localMinutes?: number; codexMinutes?: number } | undefined,
  lastError?: string | null,
  readState?: 'loading' | 'ready' | 'error',
): string {
  // A read that has not answered yet has measured nothing, so it may not
  // report a zero. The refused read names itself the same way.
  if (readState === 'loading') return 'Checking usage on this PC…';
  if (readState === 'error') return 'Usage unknown.';
  const local = Math.max(0, Math.round(usedToday?.localMinutes ?? 0));
  const codex = Math.max(0, Math.round(usedToday?.codexMinutes ?? 0));
  const base = local === 0 && codex === 0
    ? 'No voice calls today.'
    : `Today: ${local} min on this PC, ${codex} min on ChatGPT.`;
  return lastError ? `${base} Last error: ${lastError}.` : base;
}
