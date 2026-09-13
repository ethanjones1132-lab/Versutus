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

export const LOCAL_DISCLOSURE =
  'Your voice goes to Versutus on your PC and nowhere else. Nothing is recorded. What you say becomes chat messages.';

export const CODEX_DISCLOSURE =
  "Your voice goes through your PC to OpenAI and uses your ChatGPT plan's voice allowance. Versutus records nothing. What you say becomes chat messages.";

export const VOICE_ENGINE_ROWS: VoiceEngineRow[] = [
  {
    id: 'auto',
    label: 'Automatic',
    summary: 'This PC when its voice models are ready, otherwise this phone. Only the engine it picks receives audio.',
    disclosure: 'Versutus picks the best available engine for the call and shows which one it used.',
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
    summary: 'On-device recognition and speech. Audio never leaves the phone.',
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
): string {
  const local = Math.max(0, Math.round(usedToday?.localMinutes ?? 0));
  const codex = Math.max(0, Math.round(usedToday?.codexMinutes ?? 0));
  const base = local === 0 && codex === 0
    ? 'No voice calls today.'
    : `Today: ${local} min on this PC, ${codex} min on ChatGPT.`;
  return lastError ? `${base} Last error: ${lastError}.` : base;
}
