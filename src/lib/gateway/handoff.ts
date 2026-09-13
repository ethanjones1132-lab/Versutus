// ─── Bot handoff packets ──────────────────────────────────────────────────
// D6 (`FUTURE-ITEMS.md`): export a Bot as a portable file — soul, routines,
// skills, chrome — importable on another host. The trust line is what is NOT
// in the file: memory and credentials are excluded by default, and the packet
// says so. The builder reads an explicit allow-list rather than spreading the
// source, so a smuggled `memory`/`credentials` field cannot ride along.
//
// The file write/share and the receiving gateway's capability check are the
// next slice; this module is the packet shape and its exclusion rule.

export const BOT_HANDOFF_FORMAT = 'versutus-bot-handoff';
export const BOT_HANDOFF_VERSION = 1;

/** What a packet never carries. Named in the packet so an import can say so. */
export const BOT_HANDOFF_EXCLUDED: readonly string[] = ['memory', 'credentials'];

/** The allow-listed Bot fields. Everything else on the source is dropped. */
export type BotHandoffBot = {
  id: string;
  name?: string;
  description?: string;
  soul?: string;
  modelId?: string | null;
  providerId?: string | null;
};

export type BotHandoffPacket = {
  format: string;
  version: number;
  createdAt: string;
  bot: BotHandoffBot;
  routines: unknown[];
  skills: unknown[];
  chrome: Record<string, unknown>;
  excluded: string[];
};

export type BotHandoffSource = {
  bot: { id: string; [key: string]: unknown };
  routines?: unknown;
  skills?: unknown;
  chrome?: unknown;
  now?: () => string;
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return text(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Build the portable packet from what this host can read about a Bot. */
export function buildBotHandoff({
  bot,
  routines,
  skills,
  chrome,
  now = () => new Date().toISOString(),
}: BotHandoffSource): BotHandoffPacket {
  const handoffBot: BotHandoffBot = { id: text(bot.id) ?? '' };
  const name = text(bot.name);
  if (name) handoffBot.name = name;
  const description = text(bot.description);
  if (description) handoffBot.description = description;
  const soul = text(bot.soul);
  if (soul) handoffBot.soul = soul;
  const modelId = nullableText(bot.modelId);
  if (modelId !== undefined) handoffBot.modelId = modelId;
  const providerId = nullableText(bot.providerId);
  if (providerId !== undefined) handoffBot.providerId = providerId;

  return {
    format: BOT_HANDOFF_FORMAT,
    version: BOT_HANDOFF_VERSION,
    createdAt: now(),
    bot: handoffBot,
    routines: list(routines),
    skills: list(skills),
    chrome: record(chrome),
    excluded: [...BOT_HANDOFF_EXCLUDED],
  };
}

/** The packet an import can use, or null when the value is not one. */
export function botHandoffFromUnknown(value: unknown): BotHandoffPacket | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== BOT_HANDOFF_FORMAT || raw.version !== BOT_HANDOFF_VERSION) return null;
  const bot = raw.bot;
  if (!bot || typeof bot !== 'object' || Array.isArray(bot)) return null;
  if (!text((bot as Record<string, unknown>).id)) return null;
  return raw as unknown as BotHandoffPacket;
}

/** One line for a share sheet or a preview: what the file holds, and what it does not. */
export function botHandoffSummaryCopy(packet: BotHandoffPacket): string {
  const name = packet.bot.name ?? packet.bot.id;
  const routines = packet.routines.length;
  const skills = packet.skills.length;
  const routineWord = routines === 1 ? 'routine' : 'routines';
  const skillWord = skills === 1 ? 'skill' : 'skills';
  return `${name}: ${routines} ${routineWord}, ${skills} ${skillWord}. Memory and credentials are not included.`;
}
