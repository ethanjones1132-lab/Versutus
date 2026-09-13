// ─── The receiving host of a Bot handoff ──────────────────────────────────
// D6's other half: a packet built on one host is read on another. The trust
// line still holds — the packet has no memory and no credentials, so this
// module has none to import. What it decides is only whether the file is a
// packet at all and whether the receiving gateway can take a new Bot.
//
// It is pure: the screen reads the clipboard, and the plan is testable without
// a device. `memory` and `credentials` are never on the plan, so no code path
// can carry them in.

import {
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
 * What create actually restores on this host, said plainly. A packet carries
 * routines, skills and chrome so a fuller host can use them; this gateway's
 * Bot creation takes the core only, and the line never implies otherwise.
 */
export const BOT_HANDOFF_IMPORT_NOTE =
  'Restores the Bot name, description, soul and model. Memory and credentials are never in a packet; routines, skills and chrome are not applied by this gateway.';

/** The packet a pasted or clipboard text holds, or null when it is not one. */
export function parseBotHandoffText(text: unknown): BotHandoffPacket | null {
  if (typeof text === 'string') {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return botHandoffFromUnknown(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return botHandoffFromUnknown(text);
}

/**
 * Fold a packet and the receiving gateway's capability into what the screen
 * may do. A non-packet and a host that cannot create Bots are each refused with
 * their own true reason; only an allowed plan carries the Bot core to create.
 */
export function botHandoffImportPlan(
  packet: BotHandoffPacket | null,
  receiving: BotHandoffReceivingHost,
): BotHandoffImportPlan {
  if (!packet) {
    return { ok: false, reason: 'This text is not a Versutus Bot handoff packet.' };
  }
  if (!receiving.canCreateBots) {
    return {
      ok: false,
      reason: 'This gateway cannot create Bots, so the handoff cannot be imported here.',
    };
  }
  return { ok: true, bot: packet.bot, excluded: [...packet.excluded], note: BOT_HANDOFF_IMPORT_NOTE };
}

/** One line for the import surface: what will happen, or why it will not. */
export function botHandoffImportCopy(plan: BotHandoffImportPlan): string {
  if (!plan.ok) return plan.reason;
  const name = plan.bot.name ?? plan.bot.id;
  return `Import ${name} as a new Bot on this gateway. ${plan.note}`;
}
