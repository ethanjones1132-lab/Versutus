/**
 * Deterministic monogram crests for bots (Nocturne identity).
 *
 * A Bot is a member of the operator's team, so it reads as one: its initial
 * set in the display serif on a two-stop gradient disc. The tone is derived
 * from the bot id, so the same Bot looks the same across launches and
 * gateways without any image storage, upload path, or second identity store
 * (ADR 0004 untouched — this is purely presentational).
 *
 * The tone set deliberately holds **no status hue**: no mint (connected), no
 * amber (connecting/warning), no red (failed). The UI audit (2026-09-24,
 * item 11) caught the old accent list reusing the exact "connected" mint, so a
 * Bot with no listen key wore a green dot and read as online.
 *
 * Pure and engine-independent on purpose (see src/lib/encoding.ts for the
 * same lesson): the hash walks UTF-16 code units via charCodeAt instead of
 * reaching for TextEncoder, so it runs identically on Hermes native, web,
 * and under jest.
 */

export type BotCrestTone = {
  /** Lit edge of the disc (top-left). */
  from: string;
  /** Shadowed edge of the disc (bottom-right). */
  to: string;
};

/** Stage the tones were tuned against: the near-black #0A0A0B. */
export const BOT_CREST_TONES: readonly BotCrestTone[] = [
  { from: '#A99DFF', to: '#5646D0' }, // violet — the brand's own
  { from: '#8FA8FF', to: '#3B4FB8' }, // indigo
  { from: '#86BEEB', to: '#2F6597' }, // steel blue
  { from: '#D39BF0', to: '#7C3FA6' }, // orchid
  { from: '#EFA3D6', to: '#9A4383' }, // rose quartz
  { from: '#7FD3E3', to: '#23707F' }, // deep cyan
  { from: '#D4D6DE', to: '#5E6272' }, // platinum
  { from: '#6F8BD9', to: '#22306E' }, // midnight
  { from: '#B98AF5', to: '#5B2BA0' }, // amethyst
  { from: '#8FB8C4', to: '#3B5F6B' }, // slate
] as const;

export type BotCrest = {
  tone: BotCrestTone;
  /** One display character: the first letter or digit of the name, upper-cased. */
  initial: string;
};

/** FNV-1a, 32-bit, over UTF-16 code units. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The crest's one character. The first letter or digit of the display name
 * (falling back to the id), so "  forge-2" reads "F" and an emoji-only name
 * falls back to a neutral mark instead of half a surrogate pair.
 */
export function botInitial(name: string): string {
  // A letter is any character with distinct cases — no Unicode property
  // escapes, so the scan behaves the same on every JS engine the app runs on.
  for (const char of name) {
    if (/[0-9]/.test(char) || char.toLowerCase() !== char.toUpperCase()) {
      return char.toUpperCase();
    }
  }
  return '·';
}

export function botCrestFromId(botId: string, displayName?: string): BotCrest {
  const tone = BOT_CREST_TONES[fnv1a(botId) % BOT_CREST_TONES.length];
  return { tone, initial: botInitial(displayName?.trim() || botId) };
}
