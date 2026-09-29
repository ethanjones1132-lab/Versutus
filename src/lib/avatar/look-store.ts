/**
 * The looks an operator has chosen for their Bots, kept on this device.
 *
 * A look is presentation, not identity: it never goes to the Gate and never
 * touches the Hermes profile (ADR 0004), so it lives beside the app's other
 * device settings. Everything a look can hold is validated on the way in —
 * a value this build does not know is dropped, and the Bot falls back to its
 * natural form, face or colour for that part.
 */

import {
  crestLooksSnapshot,
  registerCrestLooks,
  type BotCrestTone,
  type BotLookChoice,
} from '@/lib/bot-avatar';
import { keyValueStorage } from '@/lib/storage/key-value';

import { isAvatarForm } from './forms';
import { isAvatarFace } from './look';

export const BOT_LOOKS_KEY = 'versutus:bot-looks';

const HEX = /^#[0-9a-f]{6}$/i;

function readTone(value: unknown): BotCrestTone | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { from, to } = value as { from?: unknown; to?: unknown };
  if (typeof from !== 'string' || typeof to !== 'string' || !HEX.test(from) || !HEX.test(to)) return undefined;
  return { from: from.toUpperCase(), to: to.toUpperCase() };
}

/** One stored choice, keeping only the parts this build can draw. */
export function readLookChoice(value: unknown): BotLookChoice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { form?: unknown; face?: unknown; tone?: unknown };
  const choice: BotLookChoice = {};
  if (isAvatarForm(raw.form)) choice.form = raw.form;
  if (isAvatarFace(raw.face)) choice.face = raw.face;
  const tone = readTone(raw.tone);
  if (tone) choice.tone = tone;
  return Object.keys(choice).length > 0 ? choice : undefined;
}

/** The stored map, as written; anything unreadable is an empty map, never a throw. */
export function parseBotLooks(raw: string | null): Map<string, BotLookChoice> {
  const looks = new Map<string, BotLookChoice>();
  if (!raw) return looks;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return looks;
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const choice = readLookChoice(value);
      if (botId && choice) looks.set(botId, choice);
    }
  } catch {
    // A corrupt entry costs the choices, not the app.
  }
  return looks;
}

let loading: Promise<void> | null = null;

/** Read the stored looks once; every later call shares the first read. */
export function ensureBotLooksLoaded(): Promise<void> {
  loading ??= keyValueStorage
    .getItem(BOT_LOOKS_KEY)
    .then((raw) => {
      const stored = parseBotLooks(raw);
      // A choice made before the read landed is newer than what was stored.
      const merged = new Map(stored);
      for (const [botId, choice] of crestLooksSnapshot()) merged.set(botId, choice);
      if (merged.size > 0) registerCrestLooks(merged);
    })
    .catch(() => undefined);
  return loading;
}

/**
 * Keep a Bot's look, or forget it (null) so the Bot wears its natural look
 * again. The change is drawn at once and written behind.
 */
export async function saveBotLook(botId: string, choice: BotLookChoice | null): Promise<void> {
  await ensureBotLooksLoaded();
  const next = new Map(crestLooksSnapshot());
  const clean = choice ? readLookChoice(choice) : undefined;
  if (clean) next.set(botId, clean);
  else next.delete(botId);
  registerCrestLooks(next);
  await keyValueStorage.setItem(BOT_LOOKS_KEY, JSON.stringify(Object.fromEntries(next))).catch(() => undefined);
}

/** Tests only: forget the shared first read. */
export function resetBotLooksForTests(): void {
  loading = null;
  registerCrestLooks(new Map());
}
