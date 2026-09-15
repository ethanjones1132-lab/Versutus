// ─── Reading a Bot handoff packet back ─────────────────────────────────────
// The import half of D6: what the receiving app does with a picked packet
// file. The spec's rule is validate-first (`FUTURE-ITEMS.md:309-313`) — the
// packet is checked against what the target gateway can actually serve, and
// what would / would not land is answered BEFORE anything applies. Nothing
// here applies anything: this slice's outcome is the honest read-back, not
// a write-back.
//
// Pure, like `bot-packet.ts`: no platform, no fetch. Parse rides the shape
// `buildBotPacket` emits; validation folds the model pin against the
// catalog the target gateway already holds. Unknown turns answer honestly —
// an unknown pin is noted, never fatal, because the packet was written
// against a different host's catalog.

import {
  BOT_PACKET_EXCLUDED_COPY,
  BOT_PACKET_KIND,
  BOT_PACKET_VERSION,
  type BotPacket,
} from '@/lib/gateway/bot-packet';
import { sameModelId } from '@/lib/gateway/model-selection';

/** Why `parseBotPacket` refused a file — one code, one honest sentence. */
export type BotPacketImportReason =
  | 'not-json'
  | 'wrong-shape'
  | 'wrong-version'
  | 'wrong-kind'
  | 'no-bot'
  | 'no-name';

/**
 * Operator words for each refusal. A packet that never parses says WHY it
 * did not, never a bare "invalid file".
 */
export const BOT_PACKET_IMPORT_REFUSAL_COPY: Record<BotPacketImportReason, string> = {
  'not-json': 'This file is not JSON, so it is not a handoff packet.',
  'wrong-shape': 'This JSON is not a handoff packet — the expected fields are missing.',
  'wrong-version':
    'This packet was written by a different packet version, and is not reinterpretable.',
  'wrong-kind': 'This file is JSON, but not a Versutus handoff packet.',
  'no-bot': 'This packet carries no Bot to import.',
  'no-name': "This packet's Bot has no name, so there is nothing to read back.",
};

/** What `parseBotPacket` answered. */
export type BotPacketParse =
  | { ok: true; packet: BotPacket }
  | { ok: false; reason: BotPacketImportReason };

/**
 * Parse one packet file's text. Strict on the versioned contract, gentle on
 * optional fields: soul, description, and model pin may be absent (the
 * export half omits them when empty). No field is coerced, defaulted, or
 * reinterpreted — a packet that does not match what the export half emits
 * is refused, not guessed.
 */
export function parseBotPacket(text: string): BotPacketParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'wrong-shape' };
  }
  const data = raw as Record<string, unknown>;
  if (data.version !== BOT_PACKET_VERSION) return { ok: false, reason: 'wrong-version' };
  if (data.kind !== BOT_PACKET_KIND) return { ok: false, reason: 'wrong-kind' };

  const trust = data.trust;
  const bot = data.bot;
  if (typeof trust !== 'object' || trust === null || Array.isArray(trust)) {
    return { ok: false, reason: 'wrong-shape' };
  }
  if (typeof bot !== 'object' || bot === null || Array.isArray(bot)) {
    return { ok: false, reason: 'no-bot' };
  }

  const trustData = trust as Record<string, unknown>;
  const botData = bot as Record<string, unknown>;
  if (
    !Array.isArray(trustData.fields) ||
    !trustData.fields.every((f) => typeof f === 'string') ||
    !Array.isArray(trustData.excluded) ||
    !trustData.excluded.every((f) => typeof f === 'string')
  ) {
    return { ok: false, reason: 'wrong-shape' };
  }
  if (typeof botData.name !== 'string' || !botData.name.trim()) {
    return { ok: false, reason: 'no-name' };
  }
  if (data.soul !== undefined && typeof data.soul !== 'string') {
    return { ok: false, reason: 'wrong-shape' };
  }
  if (data.modelPin !== undefined && typeof data.modelPin !== 'string') {
    return { ok: false, reason: 'wrong-shape' };
  }
  if (botData.description !== undefined && typeof botData.description !== 'string') {
    return { ok: false, reason: 'wrong-shape' };
  }

  return {
    ok: true,
    packet: {
      version: BOT_PACKET_VERSION,
      kind: BOT_PACKET_KIND,
      bot: {
        name: botData.name,
        ...(botData.description ? { description: botData.description } : {}),
      },
      ...(data.soul ? { soul: data.soul } : {}),
      ...(data.modelPin ? { modelPin: data.modelPin } : {}),
      trust: {
        fields: trustData.fields as readonly string[],
        excluded: trustData.excluded as readonly string[],
      },
    },
  };
}

/** How the packet's model pin fared against the target gateway's catalog. */
export type BotPacketModelVerdict = 'absent' | 'matched' | 'unknown';

/** What `validateBotPacketAgainstGateway` answered about one packet. */
export type BotPacketGatewayVerdict = {
  model: BotPacketModelVerdict;
};

/**
 * Fold one parsed packet against the target gateway's own model catalog
 * (the flattened `modelCatalog` list the app already holds — no fetch).
 * Unknown is a note, not a refusal: the packet names a model this host
 * does not advertise, and that is a fact to show, not a crash.
 */
export function validateBotPacketAgainstGateway(
  packet: BotPacket,
  catalog: readonly { id: string }[],
): BotPacketGatewayVerdict {
  const pin = packet.modelPin;
  if (!pin) return { model: 'absent' };
  for (const entry of catalog) {
    if (sameModelId(entry.id, pin)) return { model: 'matched' };
  }
  return { model: 'unknown' };
}

/**
 * Why `applyBotPacket` refused to write. One code, one honest sentence.
 */
export type BotPacketApplyReason = 'unknown-pin' | 'no-management';

/** Operator words for each apply refusal. */
export const BOT_PACKET_APPLY_REFUSAL_COPY: Record<BotPacketApplyReason, string> = {
  'unknown-pin':
    'This packet pins a model this gateway does not serve, so nothing was applied — remap the pin first.',
  'no-management':
    'This gateway does not create Bots, so nothing was applied.',
};

/** What `applyBotPacket` answered: an exact `createBot` input, or a refusal. */
export type BotPacketApplyDecision =
  | { ok: true; input: { name: string; soul?: string; description?: string; modelId?: string } }
  | { ok: false; reason: BotPacketApplyReason };

/**
 * Fold one parsed packet + its gateway verdict + whether the gateway
 * creates Bots at all into the exact `createBot` input the packet
 * promises, or a named refusal. Pure: no fetch, no platform — the caller
 * owns the write. The gates: Apply only when the gateway manages Bots
 * (`hasBotManagement`) AND the model pin is `matched` or `absent` — an
 * `unknown` pin stays a read-back note, never a write.
 */
export function applyBotPacket(
  packet: BotPacket,
  verdict: BotPacketGatewayVerdict,
  canManage: boolean,
): BotPacketApplyDecision {
  if (!canManage) return { ok: false, reason: 'no-management' };
  if (verdict.model === 'unknown') return { ok: false, reason: 'unknown-pin' };
  return {
    ok: true,
    input: {
      name: packet.bot.name,
      ...(packet.soul ? { soul: packet.soul } : {}),
      ...(packet.bot.description ? { description: packet.bot.description } : {}),
      ...(packet.modelPin && verdict.model === 'matched' ? { modelId: packet.modelPin } : {}),
    },
  };
}

// The verdict copy imports `sameModelId` exactly like the send path does, so
// a catalog id qualified with providers matches the packet's pin either way.

/**
 * The read-back note, in operator words. Names what would land, what would
 * not, and re-asserts the trust line in the import direction: a packet read
 * back here applies nothing in this slice, and the exclusion sentence is
 * the packet's promise in BOTH directions.
 */
export function botPacketVerdictCopy(
  packet: BotPacket,
  verdict: BotPacketGatewayVerdict,
): string {
  const parts = [`Read Bot "${packet.bot.name}".`];
  parts.push(packet.soul ? 'Standing instructions carried.' : 'No standing instructions carried.');
  parts.push(
    packet.bot.description
      ? 'Description carried.'
      : 'No description carried.',
  );
  if (verdict.model === 'matched') {
    parts.push(
      `Model pin "${packet.modelPin}" matches a model this gateway serves.`,
    );
  } else if (verdict.model === 'unknown') {
    parts.push(
      `Model pin "${packet.modelPin}" names a model this gateway does not serve, so it would need remapping.`,
    );
  } else {
    parts.push('No model pin — an import would use the gateway default.');
  }
  parts.push(
    `Nothing is applied by reading it back. ${BOT_PACKET_EXCLUDED_COPY}`,
  );
  return parts.join(' ');
}
