// ─── When a routine next runs, said one way ────────────────────────────────
//
// The list mixed "next in 8h" with a bare "12:15": one was relative, one had no
// day. Near runs get a countdown because that is what the operator decides
// against; anything a day or more away gets the weekday and a clock time, in
// the device's own locale and time zone.

/** How the far-away form is rendered; overridable so tests are deterministic. */
export type RoutineNextRunFormat = {
  /** Defaults to the device's locale, the same one every other row uses. */
  locale?: string;
  /** Defaults to the device's zone; only tests need to pin it. */
  timeZone?: string;
};

const DAY_HOURS = 24;

/**
 * "due", "in 25 min", "in 3 h", or "Tue 9:00 AM".
 *
 * A timestamp the host wrote badly answers null rather than a confident wrong
 * promise. The countdown covers the next 24 hours; at exactly 24 h the line
 * switches to the weekday form so it never claims "in 24 h" is an hour away.
 */
export function routineNextRunLabel(
  nextRunAt: string,
  now = Date.now(),
  format: RoutineNextRunFormat = {},
): string | null {
  const at = Date.parse(nextRunAt);
  if (!Number.isFinite(at)) return null;
  const deltaMs = at - now;
  if (deltaMs <= 0) return 'due';
  const minutes = Math.round(deltaMs / 60_000);
  // Below the half-minute mark the minute read rounds to 0 — a routine the
  // gateway is about to fire cannot print the contradictory "in 0 min".
  if (minutes < 1) return 'due';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < DAY_HOURS) return `in ${hours} h`;

  const date = new Date(at);
  const weekday = date.toLocaleDateString(format.locale, {
    weekday: 'short',
    timeZone: format.timeZone,
  });
  // ICU 72+ separates AM/PM with a narrow no-break space; one plain space
  // keeps the line identical across runtimes (and matches the row's copy).
  const time = date
    .toLocaleTimeString(format.locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: format.timeZone,
    })
    .replace(/[\u00a0\u202f]/g, ' ');
  return `${weekday} ${time}`;
}
