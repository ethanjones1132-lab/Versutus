// ─── A requested composer text ────────────────────────────────────
// Item 5's share half: a `versutus://compose?text=&bot=` link (and, later, an
// Android SEND intent) carries text that belongs in a thread's composer — never
// in the send path (FUTURE-ITEMS.md:193-194, "it goes into the composer as a
// draft, never auto-sent"). The link is answered in the router, where the
// composer's draft does not exist, and that draft belongs to the Chat screen:
// the request is folded here and held on the provider until the screen is
// showing the thread it names — the same shape as a requested composer focus
// (`@/lib/gateway/composer-focus`), except that this one carries words. The
// workspace it arrived in is held with it (`composeRequestArrival`): the draft
// it becomes belongs to that workspace's gateway and is saved under that
// gateway's key, so a request is only a thread's to write where it arrived.
//
// Pure, so both rules are jest-pinnable and need no renderer.

import type { ChatSurface } from '@/lib/gateway/bots';

/**
 * Text a shared link wants put in a thread's composer, the thread when the
 * link names one, and the workspace it arrived in. A request carries a text, a
 * Bot id and a workspace and nothing else — there is no field here a send
 * could ride in on.
 */
export type ComposeRequest = { text: string; botId?: string; gatewayId?: string };

/**
 * The workspace a request arrived in, stamped onto it as the provider holds
 * it. A request is the workspace's it arrived in: the Chat screen writes a
 * text into the draft of the gateway in front of the operator, and that draft
 * is SAVED under that gateway's key, so words shared into one workspace must
 * never be written into another's thread.
 *
 * A request that arrived with no workspace in front of the operator carries
 * none — a share that launched an app with nothing connected has no workspace
 * to name — and waits for whichever workspace comes up, the behaviour the
 * share path already documents.
 */
export function composeRequestArrival(
  request: ComposeRequest,
  gatewayId: string | undefined,
): ComposeRequest {
  if (gatewayId === undefined) return request;
  return { ...request, gatewayId };
}

/**
 * Fold a request into the pending slot. The same text for the same thread in
 * the same workspace is the same request and returns the pending value
 * unchanged — the screen's effect keys on it, and a fresh object would re-write
 * a draft that is already there. Anything else replaces what was pending: the
 * request that arrived last is the text the operator last shared. The workspace
 * is part of that identity, so the same words shared again into another
 * workspace are a request of that workspace's rather than the one already held.
 */
export function pendingComposeRequest(
  pending: ComposeRequest | null,
  requested: ComposeRequest,
): ComposeRequest | null {
  if (
    pending &&
    pending.text === requested.text &&
    pending.botId === requested.botId &&
    pending.gatewayId === requested.gatewayId
  ) {
    return pending;
  }
  return requested;
}

/**
 * Whether a pending request is for the surface in front of the operator, in
 * the workspace in front of them. A request that names a workspace is that
 * workspace's and no other thread's; a request that names none arrived with no
 * workspace up, so it belongs to whichever one the operator is now on.
 *
 * A request that names a Bot is for that Bot's own Bot Chat and no other
 * thread; a request naming no Bot is for whichever thread the operator already
 * has up — a shared text arrives with no opinion about where it goes, so it
 * lands where the operator is looking rather than pulling them somewhere else.
 *
 * The roster is not that thread: it has no composer of this screen's, so a
 * shared text handed to it could not be written. The screen holds the request
 * instead (the rule `composerFocusApplies` already follows for another thread).
 * A group room IS that thread — its composer is a draft of the same store a
 * Bot Chat's is (`composerDraftThread` keys it by the room), so the words the
 * operator shared land in the room they are sitting in.
 */
export function composeRequestApplies(
  request: ComposeRequest | null,
  surface: ChatSurface,
  gatewayId?: string,
): boolean {
  if (!request) return false;
  if (request.gatewayId !== undefined && request.gatewayId !== gatewayId) return false;
  if (request.botId !== undefined) {
    return surface.kind === 'bot' && surface.botId === request.botId;
  }
  return surface.kind === 'bot' || surface.kind === 'configurable' || surface.kind === 'group';
}

// ─── What the roster says it is holding ──────────────────────────
// The roster is the surface a share lands on most often: the Chat tab opens
// there, and a fresh app has no thread up. That is exactly the surface that
// cannot write the request (`composeRequestApplies`), so the screen holds the
// words — and until this line existed it held them in silence, leaving the
// operator with a tab that looks untouched and no reason to open a thread.

/** The roster's one line, in the module's own words. */
export const COMPOSE_REQUEST_HOLD_COPY =
  'A shared text is waiting — open a chat and it lands in the composer as a draft.';

/**
 * What the roster states while it holds a shared text, or nothing at all.
 *
 * The line promises exactly what the operator's next tap will do — open a chat
 * row and find the words in that composer as a draft — so it names no thread
 * and no result. Three requests are not the roster's to state:
 *
 * - nothing pending: there is nothing to say;
 * - one that names a Bot: its link already opened that Bot's Bot Chat, so the
 *   roster is never the surface that decides those words, and a line here
 *   would sit between the open and the draft it belongs to;
 * - one that arrived in another workspace: a tap on THIS roster writes into
 *   this workspace's draft, and the screen refuses a request from elsewhere —
 *   a line here would promise a drop that never comes.
 *
 * A request that arrived with no workspace belongs to whichever one comes up,
 * so it is stated wherever the operator is looking — the same rule the writer
 * follows.
 */
export function composeRequestHoldCopy(
  request: ComposeRequest | null,
  gatewayId?: string,
): string | undefined {
  if (!request) return undefined;
  if (request.gatewayId !== undefined && request.gatewayId !== gatewayId) return undefined;
  if (request.botId !== undefined) return undefined;
  return COMPOSE_REQUEST_HOLD_COPY;
}
