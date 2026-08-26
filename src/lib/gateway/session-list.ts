/** One row the session selector can show. The fold only needs identity. */
export type SessionListEntry = {
  id: string;
  title?: string | null;
};

/** What one session-list read produced. */
export type SessionListRead<T extends SessionListEntry = SessionListEntry> =
  | { ok: true; sessions: T[] }
  | { ok: false };

/**
 * Visible session list after folding a read. Two failures are not the same
 * fact:
 *   - A failed FIRST read claims zero knowledge — not "No sessions yet".
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 *
 * Sessions this app already knows (a New session, a Bot Chat pin, a prior
 * resume) stay on a failed first read. Wiping them would make a selector
 * error look like the gateway had deleted the thread the operator is in.
 */
export type SessionListState<T extends SessionListEntry = SessionListEntry> = {
  sessions: T[];
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export function emptySessionList<T extends SessionListEntry>(): SessionListState<T> {
  return { sessions: [], loaded: false, failed: false };
}

export const EMPTY_SESSION_LIST: SessionListState = emptySessionList();

export function applySessionListRead<T extends SessionListEntry>(
  previous: SessionListState<T>,
  read: SessionListRead<T>,
): SessionListState<T> {
  if (read.ok) return { sessions: read.sessions, loaded: true, failed: false };
  if (previous.loaded) return { sessions: previous.sessions, loaded: true, failed: true };
  return { sessions: previous.sessions, loaded: false, failed: true };
}

export function sessionListCopy(state: SessionListState): string | undefined {
  if (!state.loaded && state.failed) return 'Sessions could not be read.';
  if (state.failed) return 'Could not re-read sessions — showing the last list.';
  return undefined;
}

/**
 * Title forwarded to createNewSession from the name the operator typed.
 * Empty or whitespace still creates untitled — today's behaviour. There is
 * no later rename route, so this is the only chance to name the thread.
 */
export function sessionCreateTitle(draft: string): string | undefined {
  const title = draft.trim();
  return title ? title : undefined;
}

/**
 * What the selector and header print for a session. Missing or blank title
 * is Untitled, never a truncated id. Preview is a snippet, not a title.
 */
export function sessionListTitle(title?: string | null): string {
  const named = title?.trim();
  return named ? named : 'Untitled';
}
