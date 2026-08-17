import { keyValueStorage } from '@/lib/storage/key-value';
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

const TRANSCRIPT_PREFIX = 'versutus:transcript';

function transcriptKey(gatewayId: string, sessionKey: string): string {
  // Normalize sessionKey for storage key safety
  const safeSession = sessionKey.replace(/[:/\\]/g, '_');
  return `${TRANSCRIPT_PREFIX}:${gatewayId}:${safeSession}`;
}

export async function loadTranscripts(gatewayId: string, sessionKey: string): Promise<CommandTranscriptEntry[]> {
  const key = transcriptKey(gatewayId, sessionKey);
  const raw = await keyValueStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CommandTranscriptEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveTranscripts(gatewayId: string, sessionKey: string, entries: CommandTranscriptEntry[]): Promise<void> {
  const key = transcriptKey(gatewayId, sessionKey);
  // Keep only the last N to avoid unbounded growth (plan implies bounded history)
  const limited = entries.slice(-200);
  await keyValueStorage.setItem(key, JSON.stringify(limited));
}

export async function appendTranscript(
  gatewayId: string,
  sessionKey: string,
  entry: CommandTranscriptEntry,
): Promise<CommandTranscriptEntry[]> {
  const existing = await loadTranscripts(gatewayId, sessionKey);
  const next = [...existing, entry];
  await saveTranscripts(gatewayId, sessionKey, next);
  return next;
}

export async function updateTranscript(
  gatewayId: string,
  sessionKey: string,
  id: string,
  patch: Partial<CommandTranscriptEntry>,
): Promise<CommandTranscriptEntry[]> {
  const existing = await loadTranscripts(gatewayId, sessionKey);
  const next = existing.map((e) => (e.id === id ? { ...e, ...patch } : e));
  await saveTranscripts(gatewayId, sessionKey, next);
  return next;
}

/**
 * Drop every stored transcript belonging to a gateway. Called when its profile
 * is deleted — without this the keys outlive the gateway forever.
 */
export async function clearTranscriptsForGateway(gatewayId: string): Promise<void> {
  // Keys are `versutus:transcript:{gatewayId}:{sessionKey}`. Matching includes
  // the trailing separator so `gw-1` does not also clear `gw-10`.
  const prefix = `${TRANSCRIPT_PREFIX}:${gatewayId}:`;
  const keys = await keyValueStorage.getAllKeys();
  const owned = keys.filter((key) => key.startsWith(prefix));
  await keyValueStorage.multiRemove(owned);
}

export function createTranscriptId(prefix = 'cmd'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
