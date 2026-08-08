// ─── Recent slash-command history per gateway ─────────────────────
// Lightweight, best-effort persistence. Recents are keyed by gateway
// because command sets differ by gateway kind.

import { keyValueStorage } from '@/lib/storage/key-value';

const MAX_RECENTS = 8;

function storageKey(gatewayId: string): string {
  return `recent-commands:${gatewayId}`;
}

export async function loadRecentCommands(gatewayId: string): Promise<string[]> {
  try {
    const raw = await keyValueStorage.getItem(storageKey(gatewayId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function pushRecentCommand(gatewayId: string, input: string): Promise<string[]> {
  const current = await loadRecentCommands(gatewayId);
  const next = [input, ...current.filter((item) => item !== input)].slice(0, MAX_RECENTS);
  try {
    await keyValueStorage.setItem(storageKey(gatewayId), JSON.stringify(next));
  } catch {
    // best-effort: recents must never break command execution
  }
  return next;
}
