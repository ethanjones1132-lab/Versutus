// ─── What a routine's last run says, in readable words ─────────────────────
//
// The list used to print the host's own status word: `ok`, or worse the raw
// `blocked_config`. Both are wire vocabulary, not something an operator should
// have to decode. Known verdicts get a sentence; anything this build has never
// seen is still repeated honestly, just made readable — never snake_case.

/** A status value that means the last run finished cleanly. */
const OK = /^(?:ok|okay)$/i;
/** A status value that means the last run failed. */
const FAILED = /^(?:error|errored|fail|failed|failure)$/i;
/** The host's word for a routine whose configuration is not complete yet. */
const NEEDS_SETUP = /^blocked[_-]?config$/i;

/** The raw value in sentence case, with any snake or camel joins opened up. */
function readableWord(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The words a routine row prints for its last run.
 *
 * Paused outranks the last run: off on purpose is not the same fact as what
 * happened the last time it ran, and the row keeps the existing "Paused".
 */
export function routineStatusWord(lastStatus: string | undefined, paused = false): string {
  if (paused) return 'Paused';
  const raw = (lastStatus ?? '').trim();
  if (!raw) return 'Not run yet';
  if (OK.test(raw)) return 'Last run OK';
  if (FAILED.test(raw)) return 'Last run failed';
  if (NEEDS_SETUP.test(raw)) return 'Needs setup';
  return readableWord(raw);
}
