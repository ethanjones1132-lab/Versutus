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
 * Whether resuming this session can still honour the operator's model.
 *
 * A Hermes session's model is fixed at creation, so resuming one pinned to a
 * different model silently answers every turn on that old model however the
 * picker looks. The app had exactly one long-lived session per gateway, so a
 * model chosen weeks after it opened could never take effect — the operator
 * had to notice, pick a model, watch the session be released, and send again.
 *
 * True when there is nothing to disagree with: no model wanted, or a session
 * with no model recorded (the backend will resolve one at send time). A
 * mismatch is the only case that gives up continuity, and it gives it up in
 * favour of answering as the operator actually asked.
 */
export function canServeModel(session: Pick<HermesSession, 'model'>, wanted?: string): boolean {
  if (!wanted) return true;
  const pinned = session.model?.trim();
  if (!pinned) return true;
  // Compare on the bare model id: the app carries `providerId/modelId` while a
  // session records whichever form its creator used, so a raw string compare
  // reports a mismatch between two names for the same model.
  return bareModelId(pinned) === bareModelId(wanted);
}

/** `provider/model` -> `model`; anything else unchanged. Lowercased to compare. */
function bareModelId(model: string): string {
  const separator = model.indexOf('/');
  return (separator === -1 ? model : model.slice(separator + 1)).trim().toLowerCase();
}

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
  /**
   * Model to pin onto a session this call has to create. A Hermes session's
   * model is immutable once opened, so a session created here without one
   * answers every later turn on the host default — which is exactly how a
   * thread ended up on an unrequested NVIDIA model before the operator had
   * chosen anything.
   */
  model?: string,
): Promise<SessionResumeOutcome> {
  const sessions = await client
    .getSessions(RESUME_SESSION_PAGE)
    .catch(() => [] as HermesSession[]);
  const own = pickAppSession(sessions);
  if (own && canServeModel(own, model)) return { sessionId: own.id, sessions };

  if (!client.createSession) return { sessionId: undefined, sessions };

  try {
    const created = await client.createSession(undefined, model);
    return { sessionId: created.id, sessions };
  } catch {
    // A gate that cannot create sessions still connects. Environment runs
    // never need a session, and chat proceeds without one.
    return { sessionId: undefined, sessions };
  }
}
