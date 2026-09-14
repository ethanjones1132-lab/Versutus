// ─── A Bot handoff packet: what a Bot is, and what deliberately is not ─────
// The export half of D6: a portable, versioned JSON a sighted operator can
// offer a receiving Hermes host. Only what the app can already read travels —
// the soul the detail sheet loads on demand, the roster's description and
// model pin. Memory and credentials are EXCLUDED — the packet is required to
// say so out loud (`trust.excluded` + `BOT_PACKET_EXCLUDED_COPY`), which is
// the honesty line the spec calls the trust line. Importing this packet is
// the receiving side's job and is not this slice.
//
// The companion `bot-packet-share.ts` owns the platform seam (file + share
// sheet); this file stays pure and fetches nothing.

import type { BotSoulState, PublicBot } from '@/lib/gateway/bots';

/** Versioned packet kind — the import half (not this slice) validates on it. */
export const BOT_PACKET_KIND = 'versutus-bot-packet';

/** Version of this packet's shape. Bump with a change, never reinterpret. */
export const BOT_PACKET_VERSION = 1;

/**
 * The trust line, in operator words. Rendered wherever the packet is named —
 * a packet handed over without this sentence next to it is a file, not a
 * disclosure.
 */
export const BOT_PACKET_EXCLUDED_COPY = 'Memory and credentials are excluded by default.';

/** One Bot's portable packet, exactly what `buildBotPacket` emits. */
export type BotPacket = {
  version: typeof BOT_PACKET_VERSION;
  kind: typeof BOT_PACKET_KIND;
  bot: {
    /** The Gate-reported name — identity, not the raw profile id. */
    name: string;
    /** Absent when the roster reports no description, never invented. */
    description?: string;
  };
  /** The standing instructions — absent when the read failed or the Bot has none. */
  soul?: string;
  /** The pinned default model, absent when unpinned or the Gate reports none. */
  modelPin?: string;
  /** The trust line, carried IN the file and not only beside it. */
  trust: {
    /** What travels, in the sheet's own field words. */
    fields: readonly string[];
    /** What never travels, named rather than implied. */
    excluded: readonly string[];
  };
};

/**
 * Build one packet from what the detail surface already holds. Nothing is
 * fetched and nothing is guessed:
 * - a soul whose read FAILED is not folded in as `soul: null`-silence — the
 *   packet omits it, because "no standing instructions" is a fact about the
 *   Bot, and a failed read is not one;
 * - a soul the read says is genuinely EMPTY (loaded, null) is also omitted —
 *   an empty soul adds nothing to port;
 * - the trust block is always present: the exclusions are the packet's
 *   promise, independent of what this particular Bot carries.
 */
export function buildBotPacket(
  bot: Pick<PublicBot, 'displayName' | 'description' | 'model'>,
  soul: BotSoulState | undefined,
): BotPacket {
  return {
    version: BOT_PACKET_VERSION,
    kind: BOT_PACKET_KIND,
    bot: {
      name: bot.displayName,
      ...(bot.description ? { description: bot.description } : {}),
    },
    ...(soul?.loaded && soul.soul ? { soul: soul.soul } : {}),
    ...(bot.model?.default ? { modelPin: bot.model.default } : {}),
    trust: {
      fields: ['soul', 'description', 'model pin'],
      excluded: ['memory', 'credentials'],
    },
  };
}

/** The stable file name for one share, with the Bot made filesystem-safe. */
export function botPacketFileName(bot: Pick<PublicBot, 'displayName'>): string {
  const safe = bot.displayName
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${safe || 'bot'}-packet-v${BOT_PACKET_VERSION}.json`;
}

/**
 * The manifest copy that SAYS what the packet carries and deliberately does
 * not — the trust line. Shown wherever the export row asks to be understood,
 * and pinned so it cannot silently drop the exclusion sentence.
 */
export function botPacketManifest(packet: BotPacket): string {
  return [
    `Carries: ${packet.trust.fields.join(', ')}.`,
    `Excluded by default: ${packet.trust.excluded.join(', ')}.`,
    BOT_PACKET_EXCLUDED_COPY,
  ].join(' ');
}
