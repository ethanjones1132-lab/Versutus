/**
 * The routine arc's words — one pure fold, one file.
 *
 * An arc drawn in the constellation's fixed-offset column had one line, the
 * health label, identical whether it hung beneath a Bot or the gateway: with
 * several Bots' routines in one column the map could not answer "which
 * routine is unhealthy". `routineArcLabel` joins the Bot's own name to the
 * health label for an attributed arc and answers the label alone otherwise;
 * `routineArcDetail` answers a warn/error verdict's own detail on a second
 * micro line — never invented, dropped when the verdict carries none.
 */

import type { CronHealth } from '@/lib/gateway/cron';

/**
 * The label the arc paints: `"<Bot> · <label>"` when the row's name
 * attributed a Bot AND the roster answered its display name, `"label"` when
 * either is absent — no name the roster did not hand over.
 */
export function routineArcLabel({
  botName,
  verdict,
}: {
  botName?: string;
  verdict: CronHealth;
}): string {
  if (botName && botName.length > 0) return `${botName} · ${verdict.label}`;
  return verdict.label;
}

/**
 * The second micro line: the verdict's own detail, shown for warn and error
 * only — an `ok`/`off`/`unknown` verdict's detail is not an alarm, and an
 * alarm without a detail says its label alone.
 */
export function routineArcDetail({
  verdict,
}: {
  verdict: CronHealth;
}): string | undefined {
  if (verdict.tone !== 'warn' && verdict.tone !== 'error') return undefined;
  return verdict.detail;
}
