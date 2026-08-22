/**
 * Deterministic geometric avatar derivation for bots.
 *
 * Every bot row in the roster used to render the identical generic person
 * glyph, which read as a prototype rather than a set of distinct agents. Each
 * bot id hashes to one of a fixed set of shape/accent combinations, so the
 * same bot always looks the same across launches and gateways without any
 * image storage, upload path, or second identity store (ADR 0004 untouched —
 * this is purely presentational).
 *
 * Pure and engine-independent on purpose (see src/lib/encoding.ts for the
 * same lesson): the hash walks UTF-16 code units via charCodeAt instead of
 * reaching for TextEncoder, so it runs identically on Hermes native, web,
 * and under jest.
 */

/** Accent set for generated avatars — multi-accent against the dark gold
 * palette, tuned for contrast on #030304. These are per-entity identity
 * colors, not semantic state colors, so they live with the derivation logic
 * rather than in Palette (which stays the source of truth for UI semantics). */
export const BOT_AVATAR_ACCENTS = [
  '#D6B76A', // gold — palette accent
  '#5BC8D5', // cyan
  '#D96BB0', // magenta
  '#E08A4C', // orange
  '#63D7A6', // mint — matches statusConnected
] as const;

export const BOT_AVATAR_SHAPES = ['circle', 'diamond', 'square'] as const;

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

export type BotAvatar = {
  shape: BotAvatarShape;
  accent: string;
};

const COMBOS = BOT_AVATAR_SHAPES.length * BOT_AVATAR_ACCENTS.length; // 15

/** FNV-1a, 32-bit, over UTF-16 code units. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function botAvatarFromId(botId: string): BotAvatar {
  const bucket = fnv1a(botId) % COMBOS;
  return {
    shape: BOT_AVATAR_SHAPES[bucket % BOT_AVATAR_SHAPES.length],
    accent: BOT_AVATAR_ACCENTS[Math.floor(bucket / BOT_AVATAR_SHAPES.length)],
  };
}
