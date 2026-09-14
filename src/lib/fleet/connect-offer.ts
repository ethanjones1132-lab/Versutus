// ─── D2 fleet constellation: the connect offer fold ───────────────
// FUTURE-ITEMS.md §D2's two-truth design exists to drive one action: tapping
// a saved gateway offers "connect". This module is the pure decision fold the
// map's connect flow runs — which node gets an offer, when the tap is
// disabled, and what the honest labels say — so the sheet component draws
// only what this fold answers. Pure: no fetches, no navigation.
//
// The honesty rules, per the charter:
// - The live node is not a button to itself: a connected gateway offers
//   nothing.
// - A mid-handshake gateway is still a saved node per the fold's own
//   classification (`constellationNodeClass`) — it shows its HONEST label
//   (the ConnectionBadge vocabulary) and its tap is disabled while the
//   handshake is in flight, so a second tap cannot fork a second handshake.
// - A failed connectGateway surfaces `humanizeGatewayError`'s copy at the
//   sheet — the screen maps the error once and hands only the cause line
//   here; the raw exception never reaches the map.

import type { ConstellationTruth } from '@/lib/fleet/constellation-model';
import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * The connect affordance's labels for a mid-handshake rail — the same words
 * `ConnectionBadge` speaks (connection-badge.tsx STATUS_LABELS), so the map
 * never invents a second vocabulary for the same state.
 */
const HANDSHAKE_LABELS: Partial<Record<ConnectionStatus, string>> = {
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  pairing: 'Needs approval',
};

/**
 * The connect offer's decision, for one node on the ring. `offer` is the
 * affordance the two-truth map exists to drive; a live node answers offer:
 * false — the connected gateway gets no button pointing at itself.
 */
export type ConstellationConnectOffer = {
  /** Whether tapping this node opens the connect sheet at all. */
  offer: boolean;
  /** Whether the sheet's Connect control is enabled (an in-flight handshake is not re-tappable). */
  tappable: boolean;
  /** The Connect control's label — the honest mid-handshake word while connecting. */
  label: string;
  /**
   * The sheet's one detail line: the humanized failure cause from the last
   * failed attempt on this gateway, absent otherwise.
   */
  detail?: string;
};

export function constellationConnectOffer({
  truth,
  gatewayId,
  status,
  handshakeTargetId,
  failureCause,
}: {
  /** The node's class from the map's own fold — never re-derived here. */
  truth: ConstellationTruth;
  gatewayId: string;
  status: ConnectionStatus;
  /** Gateway id whose connect promise is currently in flight on this screen, if any. */
  handshakeTargetId?: string | null;
  /** The humanized cause line of the last failed connect on THIS gateway, if it failed. */
  failureCause?: string | null;
}): ConstellationConnectOffer {
  // The live node is the connection; it does not offer to connect to itself.
  if (truth === 'live') {
    return { offer: false, tappable: false, label: 'Connected' };
  }

  // This gateway's handshake is already running: show its honest state word
  // and refuse a re-tap — the provider holds one rail, forking a second
  // connect onto a running one would supersede it mid-flight.
  if (handshakeTargetId === gatewayId) {
    return {
      offer: true,
      tappable: false,
      label: HANDSHAKE_LABELS[status] ?? 'Connecting',
    };
  }

  return {
    offer: true,
    tappable: true,
    label: 'Connect',
    ...(failureCause ? { detail: failureCause } : {}),
  };
}
