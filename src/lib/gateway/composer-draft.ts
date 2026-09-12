// ─── Unsent composer drafts, keyed by thread ──────────────────────
// One useState leaked a half-typed prompt from researcher onto coder.
// Drafts are keyed by gateway + surface + session so leaving a thread
// and coming back restores that thread's text, never someone else's.
// A group room is a thread of this store too — it has no session, so
// its key names the room and the workspace alone. Persistence is
// best-effort, same as recents: a storage failure must not break typing.

import type { ChatSurface } from '@/lib/gateway/bots';
import { keyValueStorage } from '@/lib/storage/key-value';

/**
 * The surfaces whose composer is this screen's composer. The roster keeps none
 * of these — a row there decides which thread the operator opens, it is not a
 * thread itself.
 */
export type ComposerDraftSurface = Extract<
  ChatSurface,
  { kind: 'configurable' } | { kind: 'bot' } | { kind: 'group' }
>;

export type ComposerDraftThread = {
  gatewayId: string;
  surface: ComposerDraftSurface;
  sessionId: string;
};

export function composerDraftThread(input: {
  gatewayId: string | undefined;
  surface: ChatSurface;
  sessionId: string | undefined;
}): ComposerDraftThread | undefined {
  if (!input.gatewayId) return undefined;
  const kind = input.surface.kind;
  if (kind !== 'configurable' && kind !== 'bot' && kind !== 'group') {
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
  if (thread.surface.kind === 'group') {
    // A room holds no session: the draft belongs to the room, so a session id
    // carried in from the thread the operator came from cannot split it.
    return `${thread.gatewayId}:group:${thread.surface.groupId}`;
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

// ─── The spoken draft ─────────────────────────────────────────────
// A hold-to-talk transcript is cumulative: every result the recognizer
// reports carries the words so far, not the words since the last one. So a
// hold does not append to the draft as it goes — it composes what the
// operator had already typed with the transcript it is handed, which is what
// makes the answer for a given transcript the same however many times that
// transcript is reported. The composer's own change handler is the only
// writer on this path: a hold reports words, it never sends, so the operator
// always reviews what was said before anything leaves the phone.

/**
 * The operator's typed text with a live transcript composed onto it. A
 * transcript that carries no words — an empty result, or one that is only
 * whitespace — leaves the typed text byte-identical, so a hold the recognizer
 * had nothing to say to never touches the draft. The transcript's own
 * characters are what lands: this fold adds the words, it does not re-word
 * them.
 */
export function spokenDraftText(typed: string, transcript: string): string {
  if (!transcript.trim()) return typed;
  if (!typed) return transcript;
  return /\s$/.test(typed) ? `${typed}${transcript}` : `${typed} ${transcript}`;
}

/**
 * A hold's two edges over the one writer the composer already has. The
 * transcript edge composes what was heard onto the typed text; the cancelled
 * edge puts the typed text back and drops the words, because a cancel is the
 * operator saying it did not happen. Neither edge sends.
 */
export type SpokenDraftHold = {
  onTranscript: (transcript: string) => void;
  onCancelled: () => void;
};

export function spokenDraftHold(
  typedBeforeHold: string,
  write: (text: string) => void,
): SpokenDraftHold {
  return {
    onTranscript: (transcript) => write(spokenDraftText(typedBeforeHold, transcript)),
    onCancelled: () => write(typedBeforeHold),
  };
}

function storageKey(thread: ComposerDraftThread): string {
  return `composer-draft:${composerDraftKey(thread)}`;
}

/**
 * The key a call's unsent speech is recovered under. It is the same key-space
 * as the composer draft — the thread the call was started in — under a prefix
 * of its own, so `handsfree-recovery.ts` and the typed draft can never be
 * confused for one another while both stay keyed by the shipped thread rule.
 */
export function recoveryStorageKey(thread: ComposerDraftThread): string {
  return `handsfree-recovery:${composerDraftKey(thread)}`;
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
