export function routineName(botId: string, title: string): string {
  const trimmed = title.trim();
  return `[bot:${botId}] ${trimmed}`;
}

export function parseRoutineName(name: string): { botId?: string; title: string } {
  const match = /^\[bot:([^\]]+)\]\s*(.*)$/.exec(name ?? '');
  if (!match) return { title: name ?? '' };
  return { botId: match[1], title: match[2] };
}
