// ─── Crash-safe recovery for call speech ───────────────────────────────────
// A call never records audio, so the latest transcript the JS side received is
// the only thing that can survive a process death. This module is that one
// fact: it persists the newest partial/final under the thread it was spoken
// into, merges it back into the ordinary composer on any terminal path or the
// next launch, and clears the record only once the turn was actually accepted
// as sent.
//
// Recovery is deliberately NOT the B1 spoken-draft hold. A hold composes a live
// transcript onto what the operator typed and never sends; a call owns its own
// writer and its words leave as a message. What the two share is the join rule
// (`spokenDraftText`), so recovered speech lands on top of a typed draft the
// same way a hold's transcript does — and a typed draft with no recovery is
// left byte-for-byte alone.

import {
  loadComposerDraftStrict,
  recoveryStorageKey,
  saveComposerDraftStrict,
  spokenDraftText,
  type ComposerDraftThread,
} from '@/lib/gateway/composer-draft';
import { keyValueStorage } from '@/lib/storage/key-value';

/** Persist the newest transcript for a thread. Best-effort, like the draft. */
export async function saveHandsfreeRecovery(
  thread: ComposerDraftThread,
  text: string,
): Promise<void> {
  const key = recoveryStorageKey(thread);
  try {
    if (!text.trim()) {
      await keyValueStorage.removeItem(key);
      return;
    }
    await keyValueStorage.setItem(key, JSON.stringify(text));
  } catch {
    // best-effort: a storage failure must not break a live call
  }
}

/** The stored transcript for a thread, or undefined when none survived. */
export async function loadHandsfreeRecovery(
  thread: ComposerDraftThread,
): Promise<string | undefined> {
  try {
    const raw = await keyValueStorage.getItem(recoveryStorageKey(thread));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' && parsed.trim() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Drop the stored transcript. A thread with none is untouched. */
export async function clearHandsfreeRecovery(thread: ComposerDraftThread): Promise<void> {
  try {
    await keyValueStorage.removeItem(recoveryStorageKey(thread));
  } catch {
    // best-effort: a failed clear is retried on the next terminal path
  }
}

/** The one join rule, exposed so a caller can merge without touching storage. */
export function mergeHandsfreeRecovery(typed: string, recovery: string): string {
  return spokenDraftText(typed, recovery);
}

/**
 * Merge any surviving speech into the ordinary composer and remove the record.
 * This is the recovery path's only writer: it reads the current typed draft,
 * joins the recovered words onto it with the hold's own rule, saves the result
 * and clears the recovery. Nothing is written when there is no recovery, so an
 * untouched draft stays exactly as it was.
 *
 * The recovery is the only surviving copy of the spoken words, so every step
 * here is strict: an unreadable typed draft is not an empty one, and the
 * recovery is cleared only after the merged write was confirmed. On any
 * refusal the recovery and the stored draft are both left where they were, and
 * the caller gets `undefined` because no promotion happened.
 */
export async function promoteHandsfreeRecovery(
  thread: ComposerDraftThread,
): Promise<string | undefined> {
  const recovery = await loadHandsfreeRecovery(thread);
  if (!recovery) return undefined;
  const draft = await loadComposerDraftStrict(thread);
  // Refuse rather than merge onto a draft we could not read: the typed words
  // would be lost, and the recovered words would land as if the composer had
  // been empty.
  if (!draft.ok) return undefined;
  const merged = mergeHandsfreeRecovery(draft.text, recovery);
  const saved = await saveComposerDraftStrict(thread, merged);
  // The merged words are not durable, so the recovery is still the only copy
  // of the speech. Keep it, and let a later terminal path try again.
  if (!saved) return undefined;
  await clearHandsfreeRecovery(thread);
  return merged;
}
