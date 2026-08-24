// ─── Pure decision helpers for the "gateway unreachable" notice ──────────
// Deliberately free of expo-notifications imports so every matching rule is
// jest-pinnable without mocks. The side-effecting module (local.ts) applies
// these to the real tray APIs.

export const GATEWAY_DOWN_TITLE = 'Gateway unreachable';

/** data.kind marker that scopes a posted notice to one gateway. */
export const GATEWAY_DOWN_NOTICE_KIND = 'gateway-down';

export type GatewayDownNoticeData = {
  kind: typeof GATEWAY_DOWN_NOTICE_KIND;
  gatewayKey: string;
};

/**
 * Payload carried by down notices posted from this build onward. The gateway
 * key (the profile id) makes retirement exact: a different gateway answering
 * must never retire this notice.
 */
export function gatewayDownNoticeData(gatewayKey: string): GatewayDownNoticeData {
  return { kind: GATEWAY_DOWN_NOTICE_KIND, gatewayKey };
}

export interface NoticeContentLike {
  title?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * The minimal shape the helper inspects: an expo notification REQUEST
 * (identifier + content). Callers unwrap `notification.request` before
 * matching — the full expo Notification wraps the request in a `request`
 * field.
 */
export interface PresentedNoticeLike {
  identifier: string;
  content: NoticeContentLike;
}

/**
 * The gateway key a notice's payload names, or null when the payload is
 * absent or names a different kind. A data payload is authoritative: a
 * notice that explicitly says it is NOT a gateway-down notice is never
 * treated as one, even if its title collides.
 */
export function downNoticeGatewayKey(content: NoticeContentLike): string | null {
  const data = content.data;
  if (data && typeof data === 'object' && data['kind'] === GATEWAY_DOWN_NOTICE_KIND) {
    return typeof data['gatewayKey'] === 'string' ? data['gatewayKey'] : null;
  }
  return null;
}

/**
 * Whether a presented notification is the down notice for exactly this
 * gateway.
 *
 * Notices posted by this build carry a data payload naming their gateway, so
 * the match is rigid: only the gateway that actually answered retires its own
 * notice. Notices posted before the payload existed carry only the title; they
 * cannot be attributed to any gateway, so they match every gateway — retiring
 * a stale legacy entry beats leaving it in the tray forever, and modern
 * notices are unaffected because their payload scopes them first.
 */
export function isDownNoticeFor(
  notification: PresentedNoticeLike,
  gatewayKey: string,
): boolean {
  const content = notification.content;
  const payloadKey = downNoticeGatewayKey(content);
  if (payloadKey !== null) return payloadKey === gatewayKey;
  if (content.data && typeof content.data === 'object') return false;
  return content.title === GATEWAY_DOWN_TITLE;
}