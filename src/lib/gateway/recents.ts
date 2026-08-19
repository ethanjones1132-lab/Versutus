// ─── Recent slash-command history per gateway ─────────────────────
// Lightweight, best-effort persistence. Recents are keyed by gateway
// because command sets differ by gateway kind.
//
// Ranking is decayed frequency rather than pure recency (see command-frequency):
// a plain MRU forgets a daily-driver command the moment you run anything else.
// The stored shape changed with it, and `parseStoredUsage` migrates the old
// `string[]` MRU in place, so an upgrade keeps whatever the user had.

import {
  parseStoredUsage,
  rankCommands,
  recordUsage,
  type CommandUsage,
} from '@/lib/gateway/command-frequency';
import { keyValueStorage } from '@/lib/storage/key-value';

const MAX_RECENTS = 8;

function storageKey(gatewayId: string): string {
  return `recent-commands:${gatewayId}`;
}

async function readUsage(gatewayId: string, now: number): Promise<CommandUsage[]> {
  try {
    const raw = await keyValueStorage.getItem(storageKey(gatewayId));
    if (!raw) return [];
    return parseStoredUsage(JSON.parse(raw), now);
  } catch {
    return [];
  }
}

export async function loadRecentCommands(gatewayId: string): Promise<string[]> {
  const now = Date.now();
  return rankCommands(await readUsage(gatewayId, now), now, MAX_RECENTS);
}

export async function pushRecentCommand(gatewayId: string, input: string): Promise<string[]> {
  const now = Date.now();
  const next = recordUsage(await readUsage(gatewayId, now), input, now);
  try {
    await keyValueStorage.setItem(storageKey(gatewayId), JSON.stringify(next));
  } catch {
    // best-effort: recents must never break command execution
  }
  return rankCommands(next, now, MAX_RECENTS);
}
