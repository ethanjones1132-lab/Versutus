// ─── Notification preference form helpers (Solution A5/A6) ─────────────────
// Pure parsing between the Settings inputs and the Gate's
// `notifications.preferences.set` shape. Quiet hours ride as minutes since
// midnight (0–1439); the Bot filter is a comma-separated allowlist where an
// empty list means every Bot may notify.

/** `HH:MM` (24 h) → minutes since midnight, or null when not a time. */
export function parseTimeToMinutes(text: string): number | null {
  const match = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Minutes since midnight → `HH:MM`. */
export function formatMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(minutes)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export type QuietHours = { startMinutes: number; endMinutes: number };

/**
 * Two `HH:MM` fields → quiet-hours patch, or an error naming the bad field.
 * Both empty clears the window (null); half a window is an error, never a
 * guess.
 */
export function parseQuietHoursInput(
  startText: string,
  endText: string,
): { quietHours: QuietHours | null } | { error: string } {
  const startEmpty = startText.trim().length === 0;
  const endEmpty = endText.trim().length === 0;
  if (startEmpty && endEmpty) return { quietHours: null };
  const start = parseTimeToMinutes(startText);
  const end = parseTimeToMinutes(endText);
  if (start === null && end === null) return { error: 'Quiet hours need HH:MM times, like 22:00–07:00.' };
  if (start === null) return { error: `“${startText.trim()}” is not a time — use HH:MM, like 22:00.` };
  if (end === null) return { error: `“${endText.trim()}” is not a time — use HH:MM, like 07:00.` };
  return { quietHours: { startMinutes: start, endMinutes: end } };
}

/** Comma-separated Bot ids → de-duplicated allowlist (empty = every Bot). */
export function parseBotIdsInput(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const id = part.trim();
    if (id.length > 0) seen.add(id);
  }
  return [...seen];
}

/** Allowlist → the text field's contents. */
export function formatBotIds(ids: readonly string[]): string {
  return ids.join(', ');
}
