// ─── One Bot's memory, read from the Gate host ────────────────────────────
// P2: the Gate reads a Hermes profile's `memories/` files on demand
// (`memories/MEMORY.md`, `memories/USER.md`) and answers `bots.memory`. This
// parses that answer and searches it. The whitelist is enforced on both
// sides: a file the Gate did not send is never rendered, and the pane is
// read-first — nothing here writes.

export type BotMemoryFile = { name: string; text: string };
export type BotMemory = { id?: string; files: BotMemoryFile[] };

/** The only memory file names the Gate is expected to send. */
export const BOT_MEMORY_FILES = ['MEMORY.md', 'USER.md'] as const;

function isAllowedName(name: string): boolean {
  return (BOT_MEMORY_FILES as readonly string[]).includes(name);
}

export function botMemoryFromUnknown(payload: unknown): BotMemory {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { files: [] };
  const record = payload as Record<string, unknown>;
  const raw = Array.isArray(record.files) ? record.files : [];
  const files: BotMemoryFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const file = entry as Record<string, unknown>;
    const name = typeof file.name === 'string' ? file.name : '';
    const text = typeof file.text === 'string' ? file.text : '';
    if (!isAllowedName(name) || !text.trim()) continue;
    files.push({ name, text });
  }
  return { id: typeof record.id === 'string' ? record.id : undefined, files };
}

export type MemoryMatch = { name: string; line: number; text: string };

/** Line matches for a query; an empty query returns every non-empty line. */
export function memoryFileSearch(files: BotMemoryFile[], query: string): MemoryMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: MemoryMatch[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      if (needle && !line.toLowerCase().includes(needle)) return;
      matches.push({ name: file.name, line: index + 1, text: line });
    });
  }
  return matches;
}

/** The pane's status line: what was read, or an honest empty. */
export function botMemoryCopy(memory: BotMemory): string {
  if (memory.files.length === 0) return 'No memory stored on this Bot yet.';
  const parts = memory.files.map((file) => {
    const lines = file.text.split(/\r?\n/).filter((line) => line.trim()).length;
    return `${file.name} · ${lines} line${lines === 1 ? '' : 's'}`;
  });
  return `Memory on the Gate host — ${parts.join(', ')}`;
}

/** Whether a name is one of the memory files an edit may target. */
export function isBotMemoryFile(name: string): boolean {
  return isAllowedName(name);
}

/** The confirmation the pane shows before it writes anything. */
export function memorySaveConfirmationCopy(name: string): string {
  return `Save changes to ${name}? The Bot reads this on its next turn.`;
}
