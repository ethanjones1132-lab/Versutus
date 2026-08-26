// ─── Unsent composer drafts, keyed by thread ──────────────────────
// One useState leaked a half-typed prompt from researcher onto coder.
// Drafts are keyed by gateway + surface + session so leaving a thread
// and coming back restores that thread's text, never someone else's.
// Persistence is best-effort, same as recents: a storage failure must
// not break typing.

import type { ChatSurface } from '@/lib/gateway/bots';
import { keyValueStorage } from '@/lib/storage/key-value';

export type ComposerDraftThread = {
  gatewayId: string;
  surface: Extract<ChatSurface, { kind: 'configurable' } | { kind: 'bot' }>;
  sessionId: string;
};

export function composerDraftThread(input: {
  gatewayId: string | undefined;
  surface: ChatSurface;
  sessionId: string | undefined;
}): ComposerDraftThread | undefined {
  if (!input.gatewayId) return undefined;
  if (input.surface.kind !== 'configurable' && input.surface.kind !== 'bot') {
    return undefined;
  }
  return {
    gatewayId: input.gatewayId,
    surface: input.surface,
    sessionId: input.sessionId ?? '',
  };
}

export function composerDraftKey(thread: ComposerDraftThread): string {
  if (thread.surface.kind === 'configurable') {
    return `${thread.gatewayId}:configurable:${thread.sessionId}`;
  }
  return `${thread.gatewayId}:bot:${thread.surface.botId}:${thread.sessionId}`;
}

export function readComposerDraft(
  drafts: Record<string, string>,
  thread: ComposerDraftThread,
): string {
  return drafts[composerDraftKey(thread)] ?? '';
}

export function applyComposerDraft(
  drafts: Record<string, string>,
  thread: ComposerDraftThread,
  text: string,
): Record<string, string> {
  const key = composerDraftKey(thread);
  if (drafts[key] === text) return drafts;
  return { ...drafts, [key]: text };
}

function storageKey(thread: ComposerDraftThread): string {
  return `composer-draft:${composerDraftKey(thread)}`;
}

export async function loadComposerDraft(thread: ComposerDraftThread): Promise<string> {
  try {
    const raw = await keyValueStorage.getItem(storageKey(thread));
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

export async function saveComposerDraft(thread: ComposerDraftThread, text: string): Promise<void> {
  try {
    const key = storageKey(thread);
    if (!text) {
      await keyValueStorage.removeItem(key);
      return;
    }
    await keyValueStorage.setItem(key, JSON.stringify(text));
  } catch {
    // best-effort: drafts must never break typing
  }
}
