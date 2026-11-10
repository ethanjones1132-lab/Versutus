import { botRuntimeFamily, botRuntimeLabel, type PublicBot, type RosterRow } from '@/lib/gateway/bots';

/** Filter-chip labels. botRuntimeLabel hides Hermes (it is the roster's unmarked default), so it cannot name a chip. */
const runtimeChipLabels: Record<string, string> = {
  hermes: 'Hermes',
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export type RosterBackendFilter = { id: string; label: string };

/** The picker order the Bots themselves are listed in, by family (see botRuntimeFamily). */
const knownRuntimeOrder = ['hermes', 'opencode', 'claude-code', 'codex'];

/** Where a runtime id sits in the picker order; -1 for a family the app does not know. */
function runtimeOrder(id: string): number {
  return knownRuntimeOrder.indexOf(botRuntimeFamily(id));
}

/** Backends represented by tagged Bots, in the Bot runtime picker order. */
export function rosterBackendFilters(bots: PublicBot[]): RosterBackendFilter[] {
  const byRuntime = new Map<string, RosterBackendFilter>();
  for (const bot of bots) {
    const runtime = bot.runtime?.trim();
    if (!runtime) continue;
    const id = runtime.toLowerCase();
    const label = runtimeChipLabels[id] ?? (botRuntimeLabel(runtime) || runtime);
    if (!byRuntime.has(id)) byRuntime.set(id, { id, label });
  }
  return [...byRuntime.values()].sort((left, right) => {
    const leftOrder = runtimeOrder(left.id);
    const rightOrder = runtimeOrder(right.id);
    if (leftOrder >= 0 || rightOrder >= 0) {
      if (leftOrder < 0) return 1;
      if (rightOrder < 0) return -1;
      return leftOrder - rightOrder;
    }
    return left.label.localeCompare(right.label);
  });
}

/** Filter only Bot rows; navigation rows always survive. */
export function filterRosterBots(rows: RosterRow[], runtimeId: string | null): RosterRow[] {
  if (!runtimeId) return rows;
  return rows.filter((row) =>
    row.kind !== 'bot' || row.bot.runtime?.trim().toLowerCase() === runtimeId,
  );
}
