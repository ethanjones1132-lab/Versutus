export function extractMentions(text: string, rosterIds: string[]): string[] {
  const allowed = new Set(rosterIds.map((id) => id.toLowerCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /@([a-z0-9][a-z0-9_-]{0,62})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text ?? '')) !== null) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (text[end] === '@') continue;
    const id = match[1].toLowerCase();
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const canonical = rosterIds.find((entry) => entry.toLowerCase() === id) ?? id;
    found.push(canonical);
  }
  return found;
}

export function mentionPrefix(fromId: string, text: string): string {
  return `Message from 🤖 ${fromId} (@${fromId}):\n\n${text}`;
}
