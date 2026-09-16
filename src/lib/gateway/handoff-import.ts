// ─── The receiving host of a Bot handoff ──────────────────────────────────
// D6's other half: a packet built on one host is read on another. The trust
// line still holds — the packet has no memory and no credentials, so this
// module has none to import. What it decides is only whether the file is a
// packet at all and whether the receiving gateway can take a new Bot.
//
// It is pure: the screen reads the clipboard or a picked file, and the plan
// is testable without a device. `memory` and `credentials` are never on the
// plan, so no code path can carry them in.

import {
  BOT_HANDOFF_FORMAT,
  BOT_HANDOFF_VERSION,
  botHandoffFromUnknown,
  type BotHandoffBot,
  type BotHandoffPacket,
} from '@/lib/gateway/handoff';

export type BotHandoffReceivingHost = {
  /** Whether the connected gateway advertises Bot creation. */
  canCreateBots: boolean;
};

export type BotHandoffImportPlan =
  | { ok: true; bot: BotHandoffBot; excluded: string[]; note: string }
  | { ok: false; reason: string };

/**
 * Why a parse refused, each its own outcome rather than one null for every
 * bad shape: not JSON at all, JSON that parses but holds no packet, a packet
 * version this build predates, a payload of the wrong kind, or a packet with
 * no Bot record.
 */
export type BotHandoffParseOutcome =
  | { ok: true; packet: BotHandoffPacket }
  | { ok: false; reason: string };

/**
 * What create actually restores on this host, said plainly. A packet carries
 * routines, skills and chrome so a fuller host can use them; this gateway's
 * Bot creation takes the core only, and the line never implies otherwise.
 */
export const BOT_HANDOFF_IMPORT_NOTE =
  'Restores the Bot name, description, soul and model. Memory and credentials are never in a packet; routines, skills and chrome are not applied by this gateway.';

/** The refusal for text that is not JSON at all, said where it is thrown. */
const NOT_JSON_REASON = 'This text is not valid JSON.';
const WRONG_VERSION_REASON = `This packet is a handoff version this build does not read (it reads version ${BOT_HANDOFF_VERSION}).`;
const WRONG_KIND_REASON = `This JSON is not a Versutus Bot handoff packet (it must say format: "${BOT_HANDOFF_FORMAT}").`;
const NO_BOT_REASON = 'This packet carries no Bot record to import.';

/** The packet a pasted or picked text holds, or its own refusal. */
export function parseBotHandoffText(text: unknown): BotHandoffParseOutcome {
  if (typeof text !== 'string') {
    // An already-parsed object rides the same fold as the packed text.
    const packet = botHandoffFromUnknown(text);
    return classifyHandoff(packet, text);
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: NOT_JSON_REASON };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: NOT_JSON_REASON };
  }
  const packet = botHandoffFromUnknown(parsed);
  return classifyHandoff(packet, parsed);
}

/**
 * Sort the fold's single `null` into the true reason it failed. The parser
 * from `handoff.ts` refuses a wrong format and a missing id the same way, so
 * this re-checks the two fields it can distinguish — version and format —
 * and answers the honest line for each; anything else still shaped like an
 * object without a readable Bot id is a packet with no Bot record, and anything
 * not shaped at all is not a packet.
 */
function classifyHandoff(packet: BotHandoffPacket | null, parsed: unknown): BotHandoffParseOutcome {
  if (packet) return { ok: true, packet };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: WRONG_KIND_REASON };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.format !== BOT_HANDOFF_FORMAT && raw.format !== undefined) {
    return { ok: false, reason: WRONG_KIND_REASON };
  }
  if (raw.version !== BOT_HANDOFF_VERSION) {
    return { ok: false, reason: WRONG_VERSION_REASON };
  }
  return { ok: false, reason: NO_BOT_REASON };
}

/**
 * Fold a parse outcome and the receiving gateway's capability into what the
 * screen may do. Every refusal carries its own true reason — never a generic
 * "not a packet" —; only an allowed plan carries the Bot core to create.
 */
export function botHandoffImportPlan(
  outcome: BotHandoffParseOutcome,
  receiving: BotHandoffReceivingHost,
): BotHandoffImportPlan {
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  if (!receiving.canCreateBots) {
    return {
      ok: false,
      reason: 'This gateway cannot create Bots, so the handoff cannot be imported here.',
    };
  }
  return { ok: true, bot: outcome.packet.bot, excluded: [...outcome.packet.excluded], note: BOT_HANDOFF_IMPORT_NOTE };
}

/** One line for the import surface: what will happen, or why it will not. */
export function botHandoffImportCopy(plan: BotHandoffImportPlan): string {
  if (!plan.ok) return plan.reason;
  const name = plan.bot.name ?? plan.bot.id;
  return `Import ${name} as a new Bot on this gateway. ${plan.note}`;
}
