import { pickAppSession } from '@/lib/gateway/messages';
import type { HermesSession } from '@/lib/gateway/types';
import type { PortalClient } from '@/lib/portal/adapters';

export type ResumeSessionClient = Pick<PortalClient, 'getSessions' | 'createSession'>;

export type SessionResumeOutcome = {
  /** The session the thread resumes, or undefined for stateless chat. */
  sessionId: string | undefined;
  /**
   * Whatever the gateway could list. The session selector shows even a
   * failed/sessionless read as an empty list — never a stale one.
   */
  sessions: HermesSession[];
};

/** Page size the history reload asks for when listing sessions. */
export const RESUME_SESSION_PAGE = 20;

/**
 * Decide which session a thread resumes, degrading to stateless when the
 * gateway cannot manage sessions at all.
 *
 * A custom Gate can legitimately offer chat, terminal and CLI-environment
 * runs without a `/v1/sessions` endpoint — sessions are a backend-owned
 * extra, not a prerequisite. The connect path used to call
 * `client.createSession()` the moment the client exposed it:
 * `ManifestClient` refuses to invent an endpoint the manifest never
 * advertised, so the throw aborted the whole history reload and left the
 * Home dashboard dark with "does not advertise a sessions endpoint" — even
 * though every env-card run needs no session at all. This helper never
 * throws: a gateway that cannot list or create sessions simply yields
 * stateless chat, and the rest of the dashboard (environments, providers,
 * runs) loads normally.
 */
export async function resolveResumeSession(
  client: ResumeSessionClient,
): Promise<SessionResumeOutcome> {
  const sessions = await client
    .getSessions(RESUME_SESSION_PAGE)
    .catch(() => [] as HermesSession[]);
  const own = pickAppSession(sessions);
  if (own) return { sessionId: own.id, sessions };

  if (!client.createSession) return { sessionId: undefined, sessions };

  try {
    const created = await client.createSession();
    return { sessionId: created.id, sessions };
  } catch {
    // A gate that cannot create sessions still connects. Environment runs
    // never need a session, and chat proceeds without one.
    return { sessionId: undefined, sessions };
  }
}
