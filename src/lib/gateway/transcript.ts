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

export async function clearTranscriptsForGateway(gatewayId: string): Promise<void> {
  // Best-effort: we don't have a full index, so we clear by known patterns isn't possible easily.
  // For now callers should clear specific session keys when gateway is removed.
  // A future improvement could keep a manifest.
}

export function createTranscriptId(prefix = 'cmd'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
