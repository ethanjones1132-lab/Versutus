// ─── D2 fleet constellation: the pure model ───────────────────────
// The Skia map needs a positioned node/edge graph before any renderer runs
// (FUTURE-ITEMS.md §D2 Build 2). This module is that fold: it takes what the
// surfaces already hold — the saved gateway roster, the probe wave's own
// reachability records, and the provider's connection facts — and answers
// where every gateway node sits and which of the map's TWO truth classes it
// belongs to. Pure: it fetches nothing, stores nothing, and draws nothing.
// The renderer draws only what this fold emits.
//
// The honesty rules this fold enforces, quoted from the spec's own shaping:
// - `live` is ONE thing: the connected gateway. Id must match AND the
//   provider's status must be `connected` — a probe that answered
//   `reachable` is a health sample, never a connection, and a mid-handshake
//   name (`connecting`, `pairing`, `reconnecting`) is not a live gateway yet.
// - Everything else is `saved`. A saved node carries the reachability record
//   it was handed — the wave's own state and `checkedAt` stamp — so the
//   surface can dim it and date it "last seen …" without the model ever
//   dating it from a clock of its own.
// - A saved gateway with no record yet is not labeled at all rather than
//   guessed "unreachable": answering nothing is the honest unknown.

import type { GatewayReachability } from '@/lib/gateway/dashboard';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

/**
 * How far the outer ring sits from the canvas centre, as a share of the
 * smaller side. A number, not a rule: the renderer's only geometry it must
 * not re-derive, because the ring is what makes N gateways readable as one
 * fleet.
 */
export const CONSTELLATION_RING_RADIUS = 0.72;

/** The two truth classes the constellation renders, visually distinct. */
export type ConstellationTruth = 'live' | 'saved';

/**
 * Which class one gateway node belongs to. The spec's own constraint
 * (FUTURE-ITEMS.md §D2): the connected gateway is live; saved-but-not-
 * connected gateways are dimmed and dated, never green.
 */
export function constellationNodeClass({
  gatewayId,
  activeGatewayId,
  status,
}: {
  gatewayId: string;
  activeGatewayId: string | null;
  status: ConnectionStatus;
}): ConstellationTruth {
  return status === 'connected' && activeGatewayId === gatewayId ? 'live' : 'saved';
}

/** One positioned gateway node on the ring. */
export type ConstellationGatewayNode = {
  gatewayId: string;
  gatewayName: string;
  truth: ConstellationTruth;
  /** Position, in shares of the canvas (multiply by width/height to draw). */
  x: number;
  y: number;
  /**
   * The probe wave's own record for this gateway, handed through un-reworded —
   * absent when no wave has reached it, so the surface says nothing rather
   * than inventing a "last seen" it cannot back.
   */
  reachability?: GatewayReachability;
};

/** The ring the gateway nodes sit on, in the same shares the nodes use. */
export type ConstellationRing = { cx: number; cy: number; radius: number };

/** The whole model one fold emits; the Skia layer draws only this. */
export type ConstellationModel = {
  gateways: ConstellationGatewayNode[];
  ring: ConstellationRing;
};

/**
 * Fold the fleet onto the ring. Positioning is deterministic per input:
 * roster order fixes the angles (the roster's own order, the one Home and
 * settings already show), so N gateways fold to N distinct ring seats and
 * the same roster always folds to the same map.
 */
export function foldConstellation({
  profiles,
  reachability,
  activeGatewayId,
  status,
  width,
  height,
}: {
  profiles: GatewayProfile[];
  reachability: Record<string, GatewayReachability>;
  activeGatewayId: string | null;
  status: ConnectionStatus;
  width: number;
  height: number;
  now: number;
}): ConstellationModel {
  const cx = width / 2;
  const cy = height / 2;
  // A canvas that cannot be drawn (zero, negative, not finite) answers a
  // zero-radius ring and no nodes rather than a scatter off-canvas.
  const drawable =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0;
  const radius = drawable ? (CONSTELLATION_RING_RADIUS * Math.min(width, height)) / 2 : 0;
  const ring: ConstellationRing = { cx, cy, radius };

  if (!drawable || profiles.length === 0) {
    return { gateways: [], ring };
  }

  const gateways = profiles.map((profile, index) => ({
    gatewayId: profile.id,
    gatewayName: profile.name,
    truth: constellationNodeClass({ gatewayId: profile.id, activeGatewayId, status }),
    // Start from the ring's 12 o'clock and walk clockwise; the seat count is
    // the roster's own count, so no seat is ever shared.
    x: (cx + radius * Math.sin((2 * Math.PI * index) / profiles.length)) / width,
    y: (cy - radius * Math.cos((2 * Math.PI * index) / profiles.length)) / height,
    reachability: reachability[profile.id],
  }));

  return { gateways, ring };
}
