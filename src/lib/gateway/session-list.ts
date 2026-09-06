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

/**
 * The selector opens on the newest page only. The session endpoints take a
 * `limit` but no offset or cursor (`gate/core/server.mjs` answers
 * `GET /v1/sessions` with `limit` alone), so "show older" re-reads the same
 * window with a wider limit — the same pattern history uses for "load
 * earlier". The cap matches the wide catalogue read `session.usage` uses.
 */
export const SESSION_LIST_PAGE_SIZE = 20;
export const SESSION_LIST_MAX = 200;

/** Widen one session-list read by a page, never past the catalogue cap. */
export function nextSessionListLimit(current: number): number {
  if (!Number.isFinite(current) || current < SESSION_LIST_PAGE_SIZE) return SESSION_LIST_PAGE_SIZE;
  return Math.min(current + SESSION_LIST_PAGE_SIZE, SESSION_LIST_MAX);
}

/**
 * A full window may hide older threads behind the limit; a short one is the
 * whole catalogue. At the cap there is nothing older left to ask for.
 */
export function sessionListMayHaveOlder(loaded: number, requested: number): boolean {
  if (!Number.isFinite(loaded) || !Number.isFinite(requested)) return false;
  if (requested >= SESSION_LIST_MAX) return false;
  return loaded >= requested;
}

/**
 * Honest window line for the session selector. A filled window may be
 * truncated — the list endpoint takes `limit` but no cursor — so a full
 * read names its bound instead of reading as the whole catalogue. A
 * partial window is the whole catalogue and needs no note. Mirrors
 * `spendWindowCopy` for the spend glance.
 */
export function sessionListWindowCopy(sessionCount: number): string | undefined {
  if (Number.isFinite(sessionCount) && sessionCount >= SESSION_LIST_MAX) {
    return `Showing newest ${SESSION_LIST_MAX} sessions`;
  }
  return undefined;
}

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

/** The fields a session row can be searched by. */
export type SessionSearchable = {
  id: string;
  title?: string | null;
  preview?: string | null;
};

/**
 * Narrow the session selector by a free-text query over title, preview, and id.
 *
 * A blank query is "no filter", not "nothing matches". Untitled sessions
 * match the word Untitled — that is what the row prints.
 */
export function filterSessions<T extends SessionSearchable>(
  sessions: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) =>
    [sessionListTitle(session.title), session.preview, session.id].some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
    ),
  );
}
