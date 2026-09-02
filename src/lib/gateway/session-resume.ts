import { pickAppSession } from '@/lib/gateway/messages';
import { sameModelId } from '@/lib/gateway/model-selection';
import type { GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient } from '@/lib/portal/adapters';

export type ResumeSessionClient = Pick<PortalClient, 'getSessions' | 'createSession' | 'canManageSessions'>;

export type SessionResumeOutcome = {
  /** The session the thread resumes, or undefined for stateless chat. */
  sessionId: string | undefined;
  /** The sessions from a successful list, or [] when the list could not be read. */
  sessions: HermesSession[];
};

/** Page size the history reload asks for when listing sessions. */
export const RESUME_SESSION_PAGE = 20;

/**
 * Which session a history load should treat as current.
 *
 * Live wins. Stored (`gateway.sessionId`) is a reconnect pin written on
 * disconnect — it is not a live thread after a deliberate release. The
 * connect path copies stored onto the live slot before the first load, so a
 * reconnect still resumes. Using stored as a fallback here is what made a
 * CLI-environment switch reload and send against the previous session:
 * `selectBackend` cleared the live slot, then `reloadHistoryFor` restored it
 * from the profile. A 404 on the new environment looked like a fresh thread
 * while the next send still carried the old id.
 */
export function liveSessionId(input: {
  live?: string;
  stored?: string;
}): string | undefined {
  const live = input.live?.trim();
  if (live) return live;
  return undefined;
}

/**
 * Adopt a session as the live thread on the client, and write it as the
 * reconnect pin on the gateway profile.
 *
 * Connect copies stored (`gateway.sessionId`) onto the live slot before the
 * first history load. Disconnect copies the client's current session back
 * onto stored. Gate `createSession` does not assign `currentSessionId`
 * (Hermes native does), so a New session that only updated React state
 * would reconnect as the previous thread and leave the new one orphaned
 * in the list.
 *
 * Returns the same profile when the pin is already written, so the caller
 * can skip a persist. Pins the client even when there is no profile.
 */
export function pinLiveSession(input: {
  client: Pick<PortalClient, 'setSessionId'>;
  sessionId: string | undefined;
  profile?: GatewayProfile;
}): GatewayProfile | undefined {
  const sessionId = input.sessionId?.trim() || undefined;
  input.client.setSessionId(sessionId);
  if (!input.profile) return undefined;
  if (input.profile.sessionId === sessionId) return input.profile;
  return { ...input.profile, sessionId };
}

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
  // Compare on qualification-insensitive identity: the app carries
  // `providerId/modelId` (sometimes two prefixes, when the inner id is
  // already `vendor/name`) while a session records whichever form its
  // creator used. A raw string compare reports a mismatch between two
  // names for the same model.
  return sameModelId(pinned, wanted);
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
  if (client.canManageSessions === false) return { sessionId: undefined, sessions: [] };

  let sessions: HermesSession[];
  try {
    sessions = await client.getSessions(RESUME_SESSION_PAGE);
  } catch {
    // A failed list is not proof that the gateway has no app session. Do not
    // create a duplicate thread while the session catalogue is unavailable.
    return { sessionId: undefined, sessions: [] };
  }
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
