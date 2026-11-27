// ─── The hook behind the per-turn change row ───────────────────────
// VS-094, slice 3: one bubble asks the store (finished) or the journal
// (still streaming), and nothing else.
//
// The resolution itself is pure-ish and lives in
// `@/lib/chat/turn-change-row-state`, so tests can pin it without a renderer.
// This file only owns the async lifecycle: a different turn resets the row, a
// late answer never lands on a newer turn, and no storage read ever throws
// into the transcript.
//
// Persistence is the app's existing adapter (`keyValueStorage`), wrapped in the
// landed store. There is no second storage path here.

import { useEffect, useState } from 'react';

import type { TurnDiffRow } from '@/lib/chat/turn-changes';
import type {
  TurnChangeFrame,
  TurnJournalMetaFetcher,
} from '@/lib/chat/turn-change-collector';
import type {
  TurnChangeRecordStore,
  TurnChangeRowState,
} from '@/lib/chat/turn-change-row-state';
import { resolveTurnChangeRowState } from '@/lib/chat/turn-change-row-state';
import { createTurnChangeStore, type TurnChangeStore } from '@/lib/chat/turn-change-store';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { ChatMessage } from '@/lib/gateway/types';

let sharedStore: TurnChangeStore | undefined;

/**
 * The app's one store over the existing key-value adapter.
 *
 * Lazily built so importing this hook costs nothing until a row actually asks
 * for a turn, and shared so the LRU index is not re-read per bubble.
 */
export function getSharedTurnChangeStore(): TurnChangeStore {
  sharedStore ??= createTurnChangeStore({ storage: keyValueStorage });
  return sharedStore;
}

/**
 * The store touches its LRU index on every `load` (read-modify-write), so a
 * thread mounting many finished bubbles at once would race those writes and
 * drop index rows. Resolutions are serialised here; the cost is one small read
 * after another, and the index stays whole.
 */
let readChain: Promise<void> = Promise.resolve();

function enqueueTurnChangeRead<T>(read: () => Promise<T>): Promise<T> {
  const result = readChain.then(read, read);
  readChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export type UseTurnChangeRowInput = {
  turnId?: string;
  streaming?: boolean;
  sessionId?: string;
  backendId?: string;
  messages?: readonly ChatMessage[];
  frames?: readonly TurnChangeFrame[];
  diffBefore?: readonly TurnDiffRow[] | null;
  diffAfter?: readonly TurnDiffRow[] | null;
  /** Injected for tests; production uses the shared store below. */
  store?: TurnChangeRecordStore;
  /** The journal seam, when the caller has one. */
  readJournalMeta?: TurnJournalMetaFetcher;
};

/**
 * The row state for one turn, or `undefined` while the answer is in flight.
 *
 * `undefined` renders nothing, which keeps a bubble from flashing an empty row
 * before its record is read. Collector payloads are dependencies too: a live
 * turn can acquire new frames/messages while it streams.
 */
export function useTurnChangeRow(input: UseTurnChangeRowInput): TurnChangeRowState | undefined {
  const { turnId, streaming, sessionId, backendId, store, readJournalMeta } = input;
  const [answer, setAnswer] = useState<{ turnId: string; state: TurnChangeRowState } | undefined>(undefined);

  useEffect(() => {
    let live = true;
    if (!turnId) {
      return () => {
        live = false;
      };
    }

    const target = store ?? getSharedTurnChangeStore();
    void enqueueTurnChangeRead(() =>
      resolveTurnChangeRowState({
        turnId,
        streaming,
        sessionId,
        backendId,
        messages: input.messages,
        frames: input.frames,
        diffBefore: input.diffBefore,
        diffAfter: input.diffAfter,
        store: target,
        readJournalMeta,
      }),
    )
      .then((next) => {
        if (live) setAnswer({ turnId, state: next });
      })
      .catch(() => {
        // A rejected read is an answer we do not have. A finished turn says so;
        // a live turn simply keeps its row closed.
        if (live) setAnswer({ turnId, state: streaming ? { status: 'none' } : { status: 'unavailable' } });
      });

    return () => {
      live = false;
    };
  }, [
    backendId,
    input.diffAfter,
    input.diffBefore,
    input.frames,
    input.messages,
    readJournalMeta,
    sessionId,
    store,
    streaming,
    turnId,
  ]);

  if (!turnId) return { status: 'none' };
  return answer?.turnId === turnId ? answer.state : undefined;
}
