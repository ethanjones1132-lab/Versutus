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

// Partials arrive several times a second, and only the newest transcript is
// recovery-relevant. Writes are coalesced per thread: a burst costs one write
// of the last transcript instead of one per partial, writes for a thread never
// overlap (so their completion order cannot reverse), and a transcript that
// arrives while a write is in flight is still persisted next. A caller's
// promise resolves after its text — or a newer transcript that supersedes it —
// has been written, so a final result and the send path still flush.
type RecoveryWriteQueue = {
  /** Newest transcript a caller has asked to persist. */
  latest: string;
  /** Callers waiting for their transcript (or a newer one) to be written. */
  waiters: Array<() => void>;
  scheduled: boolean;
  running: boolean;
};

const recoveryWrites = new Map<string, RecoveryWriteQueue>();

async function runRecoveryWrite(key: string, queue: RecoveryWriteQueue): Promise<void> {
  if (queue.running) return;
  queue.running = true;
  // Capture the newest text and this pass's waiters. A partial that arrives
  // during the await replaces `latest` and joins the next pass.
  const text = queue.latest;
  const waiters = queue.waiters;
  queue.waiters = [];
  try {
    if (!text.trim()) {
      await keyValueStorage.removeItem(key);
    } else {
      await keyValueStorage.setItem(key, JSON.stringify(text));
    }
  } catch {
    // best-effort: a storage failure must not break a live call
  } finally {
    queue.running = false;
  }
  for (const waiter of waiters) waiter();
  if (queue.waiters.length > 0) {
    // A newer transcript arrived while this write ran: persist it next rather
    // than dropping it.
    if (recoveryWrites.get(key) === queue) scheduleRecoveryWrite(key, queue);
  } else if (recoveryWrites.get(key) === queue) {
    recoveryWrites.delete(key);
  }
}

function scheduleRecoveryWrite(key: string, queue: RecoveryWriteQueue): void {
  if (queue.scheduled || queue.running) return;
  queue.scheduled = true;
  // One microtask lets a burst of synchronous partials collapse before the
  // first write starts.
  void Promise.resolve().then(() => {
    queue.scheduled = false;
    if (recoveryWrites.get(key) === queue) void runRecoveryWrite(key, queue);
  });
}

/** Resolves once no write is queued or running for the thread. */
function whenRecoveryWritesIdle(key: string): Promise<void> {
  const queue = recoveryWrites.get(key);
  if (!queue) return Promise.resolve();
  return new Promise<void>((resolve) => {
    queue.waiters.push(resolve);
    if (queue.scheduled || queue.running) return;
    if (recoveryWrites.get(key) === queue) recoveryWrites.delete(key);
    resolve();
  });
}

/** Persist the newest transcript for a thread. Best-effort, like the draft. */
export function saveHandsfreeRecovery(
  thread: ComposerDraftThread,
  text: string,
): Promise<void> {
  const key = recoveryStorageKey(thread);
  return new Promise<void>((resolve) => {
    const existing = recoveryWrites.get(key);
    const queue: RecoveryWriteQueue =
      existing ?? { latest: text, waiters: [], scheduled: false, running: false };
    queue.latest = text;
    queue.waiters.push(resolve);
    if (!existing) recoveryWrites.set(key, queue);
    scheduleRecoveryWrite(key, queue);
  });
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
  const key = recoveryStorageKey(thread);
  // A queued transcript is dropped rather than written; a write already in
  // flight is allowed to finish first, so the clear cannot be overtaken by it.
  const queued = recoveryWrites.get(key);
  if (queued) queued.latest = '';
  try {
    if (queued) await whenRecoveryWritesIdle(key);
    await keyValueStorage.removeItem(key);
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
