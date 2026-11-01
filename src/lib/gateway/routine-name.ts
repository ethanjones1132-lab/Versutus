/**
 * The `[bot:<name>]` naming convention, shared by the routine surfaces and the
 * cron fold. It lives in its own module so `cron.ts` and `routines.ts` do not
 * import each other: Metro warned about that cycle, and a cycle can hand one
 * side an uninitialised value during startup.
 */

export function routineName(botId: string, title: string): string {
  const trimmed = title.trim();
  return `[bot:${botId}] ${trimmed}`;
}

export function parseRoutineName(name: string): { botId?: string; title: string } {
  const match = /^\[bot:([^\]]+)\]\s*(.*)$/.exec(name ?? '');
  if (!match) return { title: name ?? '' };
  return { botId: match[1], title: match[2] };
}
