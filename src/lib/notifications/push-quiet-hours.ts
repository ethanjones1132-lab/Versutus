/**
 * The quiet-hours pane's copy and clock fold, apart from the section that
 * draws it. The Gate's validator (`push-rpc.mjs`) takes integer
 * minutes-since-midnight between 0 and 1439; the app side parses a text field
 * the operator typed, so the fold here answers only what it can prove: a well
 * formed `H:MM` or `HH:MM` clock text both ways, anything else a refusal —
 * a half-parsed line is never a window.
 */

/** A parsed clock read: minutes since midnight, rounded to the minute. */
export type ClockMinutes = { startMinutes: number; endMinutes: number } | null;

/** The upper bound the Gate's validator enforces (`push-rpc.mjs` 1439). */
export const CLOCK_MINUTES_A_DAY = 24 * 60;

/**
 * Parse one `H:MM` / `HH:MM` clock text into minutes since midnight. Returns
 * null on anything unparsable or out of range — an empty field, a stray
 * colon, an hour past 23, minutes past 59 have no answer.
 */
export function clockTextToMinutes(text: string): number | null {
  const match = /^\s*([0-9]{1,2}):([0-9]{1,2})\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Validate the pair the two fields hold against the Gate's own rule. */
export function validQuietHoursPair(
  start: number | null,
  end: number | null,
): { startMinutes: number; endMinutes: number } | null {
  if (start === null || end === null) return null;
  if (start < 0 || start >= CLOCK_MINUTES_A_DAY || end < 0 || end >= CLOCK_MINUTES_A_DAY) {
    return null;
  }
  return { startMinutes: start, endMinutes: end };
}

/** The one sentence the pane states the exempt rule in. */
export const QUIET_HOURS_EXEMPT_COPY =
  "A quiet window can't excuse an approval push — those break through.";

/** The pane's quiet-hours copy, built once so the source pin has one seam. */
export function quietHoursLine(
  value: { startMinutes: number; endMinutes: number } | null,
): string {
  if (!value) return 'No quiet hours. Push arrives around the clock.';
  return `Quiet from ${minutesToClockText(value.startMinutes)} to ${minutesToClockText(value.endMinutes)}.`;
}

/** Minutes since midnight back to `H:MM`, minutes zero-padded, 24-hour. */
export function minutesToClockText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The pane's field labels, held here so copy moves in one place. */
export const QUIET_HOURS_START_LABEL = 'Quiet from (24h H:MM)';
export const QUIET_HOURS_END_LABEL = 'Quiet until (24h H:MM)';
