export const MAX_GROUP_MEMBERS = 6;
export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_ROUNDS = 3;
export const MAX_GROUP_MESSAGES = 10;

export function GROUP_SESSION_TITLE(name: string): string {
  return `Group: ${name}`;
}

export function validateGroup({ name, memberIds }: { name: string; memberIds: string[] }): { ok: boolean; error?: string } {
  if (!name.trim()) return { ok: false, error: 'name required' };
  const unique = [...new Set(memberIds)];
  if (unique.length < MIN_GROUP_MEMBERS) return { ok: false, error: 'need at least 2 bots' };
  if (unique.length > MAX_GROUP_MEMBERS) return { ok: false, error: 'at most 6 bots' };
  return { ok: true };
}

export function planGroupRounds({
  memberIds,
  mentionedIds = [],
  maxRounds = MAX_GROUP_ROUNDS,
  maxMessages = MAX_GROUP_MESSAGES,
}: {
  memberIds: string[];
  mentionedIds?: string[];
  maxRounds?: number;
  maxMessages?: number;
}): { botId: string }[] {
  const mentioned = mentionedIds.filter((id) => memberIds.includes(id));
  const active = mentioned.length > 0 ? mentioned : memberIds;
  const steps: { botId: string }[] = [];
  for (let round = 0; round < maxRounds && steps.length < maxMessages; round += 1) {
    for (const botId of active) {
      if (steps.length >= maxMessages) break;
      steps.push({ botId });
    }
  }
  return steps;
}
