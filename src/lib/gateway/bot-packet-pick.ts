// ─── Picking a Bot handoff packet file off the device ──────────────────────
// The device side of the packet read-back, riding the same one-seam pattern
// as `bot-packet-share.ts`: this is the only file that touches
// `expo-document-picker` and `expo-file-system` for imports, so the pure
// parse/validate fold in `bot-packet-import.ts` stays testable without a
// device. The Bot detail sheet composes the seam: it asks here for the
// packet file's text, then folds it pure.
//
// Nothing here parses or validates — it only reads bytes and answers
// honest refusals. A cancelled sheet and an unreadable file are two
// different facts (the read-back copy says which) and never collapse into
// one lie.

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

/** Why no packet text came back — one code, one honest sentence. */
export type BotPacketPickReason =
  | 'no-picker'
  | 'cancelled'
  | 'not-readable';

/**
 * Operator words for each refusal. Shown next to the trust line, never
 * instead of it.
 */
export const BOT_PACKET_PICK_REFUSAL_COPY: Record<BotPacketPickReason, string> = {
  'no-picker': 'This device has no file picker, so a packet cannot be read.',
  cancelled: 'No file was picked.',
  'not-readable': 'The picked file could not be read.',
};

/** What `pickBotPacketFile` answered. */
export type BotPacketPick =
  | { ok: true; text: string }
  | { ok: false; reason: BotPacketPickReason };

/**
 * Open the platform document picker for one JSON file and read its text as
 * UTF-8 shape, matching the export share's `application/json` mime — the
 * packet travels and returns under the same kind.
 */
export async function pickBotPacketFile(): Promise<BotPacketPick> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/json',
      multiple: false,
    });
    if (result.canceled) return { ok: false, reason: 'cancelled' };
    const file = result.assets[0];
    if (!file?.uri) return { ok: false, reason: 'not-readable' };
    const text = await new File(file.uri).text();
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'not-readable' };
  }
}
