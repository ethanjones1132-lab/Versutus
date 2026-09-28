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
  // Jewel tones, spread across hue *and* value so two crests side by side
  // never read as the same person. Every stop stays out of the status bands
  // (mint, amber, red) — see __tests__/bot-avatar-test.ts.
  { from: '#A99DFF', to: '#5646D0' }, // violet — the brand's own
  { from: '#86A9FF', to: '#2446B8' }, // cobalt
  { from: '#6FD2D8', to: '#12646E' }, // lagoon
  { from: '#62B6F2', to: '#1B5A90' }, // ocean
  { from: '#F190C8', to: '#8C2766' }, // mulberry
  { from: '#D9A3F6', to: '#7636AC' }, // orchid
  { from: '#F59AB4', to: '#A3345C' }, // raspberry
  { from: '#E8E9EE', to: '#646878' }, // platinum
  // Two twilight crests turn between hues as they fall into shadow.
  { from: '#F3A6C8', to: '#5B3FC4' }, // dusk — rose into violet
  { from: '#7EDBD9', to: '#3140A6' }, // tide — lagoon into cobalt
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

/** The tone a Bot wears when nothing else is known: its id's own bucket. */
function naturalTone(botId: string): number {
  return fnv1a(botId) % BOT_CREST_TONES.length;
}

/**
 * Tones assigned across the operator's current fleet, so two Bots on the same
 * roster never wear the same crest while tones remain. A hash alone cannot
 * promise that — six Bots over ten tones collide more often than not.
 *
 * Deterministic and order-free: ids are walked sorted, each takes its natural
 * tone when free, and only the Bots that collide step forward to the next
 * free tone. A Bot that owns its natural tone never moves when the fleet
 * changes around it.
 */
let fleetTones = new Map<string, number>();

export function registerCrestFleet(botIds: readonly string[]): void {
  const ids = [...new Set(botIds)].sort();
  const next = new Map<string, number>();
  const taken = new Set<number>();
  const colliders: string[] = [];
  for (const id of ids) {
    const slot = naturalTone(id);
    if (taken.has(slot)) {
      colliders.push(id);
    } else {
      taken.add(slot);
      next.set(id, slot);
    }
  }
  const count = BOT_CREST_TONES.length;
  for (const id of colliders) {
    // A fleet larger than the tone set starts a second round of tones.
    if (taken.size >= count) taken.clear();
    const start = naturalTone(id);
    for (let step = 1; step <= count; step += 1) {
      const slot = (start + step) % count;
      if (!taken.has(slot)) {
        taken.add(slot);
        next.set(id, slot);
        break;
      }
    }
  }
  fleetTones = next;
}

export function botCrestFromId(botId: string, displayName?: string): BotCrest {
  const tone = BOT_CREST_TONES[fleetTones.get(botId) ?? naturalTone(botId)];
  return { tone, initial: botInitial(displayName?.trim() || botId) };
}
