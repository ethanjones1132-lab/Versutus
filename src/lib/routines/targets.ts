import type { ActivityCoverage, RoutineEntry } from '@/lib/gateway/activity-feed';
import type { PublicBot } from '@/lib/gateway/bots';

// Who can run a new Routine: every backend the Gate reports routines for, and
// every Bot on one of those backends. Pure, so it is testable without the UI.
export type RoutineTarget = {
  key: string;
  label: string;
  kind: 'Bot' | 'Backend';
  scope: RoutineCreateScope;
};

/** Creation alone distinguishes an explicit backend-root target from inherited Bot scope. */
export type RoutineCreateScope = { backendId?: string; botId?: string | null };

export function routineTargets(
  backends: readonly ActivityCoverage[],
  routines: readonly RoutineEntry[],
  bots: readonly PublicBot[],
): RoutineTarget[] {
  const supported = new Set(
    backends.filter((backend) => backend.status === 'complete' || backend.status === 'partial').map((backend) => backend.id),
  );
  for (const routine of routines) supported.add(routine.backendId);
  const targets: RoutineTarget[] = [];
  for (const backend of backends) {
    if (!supported.has(backend.id)) continue;
    targets.push({
      key: `backend:${backend.id}`,
      label: backend.label,
      kind: 'Backend',
      scope: { backendId: backend.id, botId: null },
    });
  }
  const knownBots = new Map<string, PublicBot>(bots.map((bot) => [bot.id, bot] as const));
  const botTargets = new Map<string, RoutineTarget>();
  for (const botId of new Set([
    ...bots.map((bot) => bot.id),
    ...routines.flatMap((routine) => routine.botId ? [routine.botId] : []),
  ])) {
    const bot = knownBots.get(botId);
    const backendId = bot?.backendId?.trim() ||
      routines.find((routine) => routine.botId === botId)?.backendId;
    if (!backendId || !supported.has(backendId)) continue;
    const target = {
      key: `bot:${backendId}:${botId}`,
      label: bot?.displayName || botId,
      kind: 'Bot',
      scope: { backendId, botId },
    } satisfies RoutineTarget;
    botTargets.set(target.key, target);
  }
  targets.push(...botTargets.values());
  return targets;
}

