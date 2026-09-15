// ─── Fleet constellation: the saved-gateway handshake ─────────────────────
// Tapping a saved-but-not-connected gateway starts the app's one real
// connection attempt, and while that attempt runs the map must say what is
// happening — Connecting / Reconnecting / Needs approval — and refuse a
// second handshake until the first one settles. This is the pure decision
// the route applies; the provider owns the attempt itself.
//
// One gateway tries at a time because the app holds one live connection:
// while an attempt is in flight, no other saved gateway may start one. The
// line names the gateway the attempt belongs to, so a frozen tap always has
// a visible reason. A settled failure names its reason so the next tap
// answers "why did it not work", and stays retriable.

import type { ConnectionStatus } from '@/lib/gateway/types';

export type GatewayHandshakeInput = {
  gatewayName: string;
  /** The gateway this decision is about. */
  gatewayId: string;
  /** The gateway, if any, that is currently live. */
  connectedGatewayId?: string | null;
  /** The gateway, if any, the provider is currently trying. */
  activeGatewayId?: string | null;
  /** The name of that gateway, for a line about a rival attempt. */
  activeGatewayName?: string;
  status: ConnectionStatus;
  /** The provider's last words about the attempt, when it failed. */
  failureReason?: string | null;
};

export type GatewayHandshakeState = {
  /** False when starting another handshake would lie about the world. */
  canConnect: boolean;
  /** One honest line for the status, or none when nothing is in flight. */
  statusLine: string | null;
};

const needsApprovalCopy = (name: string) => `Needs approval — approve the pairing request on ${name}`;

function attemptCopy(status: ConnectionStatus, name: string): string {
  switch (status) {
    case 'reconnecting':
      return `Reconnecting to ${name}…`;
    case 'pairing':
      return needsApprovalCopy(name);
    default:
      return `Connecting to ${name}…`;
  }
}

export function gatewayHandshake(input: GatewayHandshakeInput): GatewayHandshakeState {
  const { gatewayName, gatewayId, connectedGatewayId, activeGatewayId, activeGatewayName, status } =
    input;

  // Already live: the tap means nothing, and the map's own badge says Live.
  if (connectedGatewayId === gatewayId && status === 'connected') {
    return { canConnect: false, statusLine: null };
  }

  // An attempt in flight anywhere: one handshake at a time. The line names
  // the gateway the attempt belongs to — its own name for this gateway's
  // attempt, the rival's name otherwise.
  if (activeGatewayId && (status === 'connecting' || status === 'reconnecting' || status === 'pairing')) {
    const name = activeGatewayId === gatewayId ? gatewayName : (activeGatewayName ?? gatewayName);
    return { canConnect: false, statusLine: attemptCopy(status, name) };
  }

  // Settled and not live: failed, or simply idle. A named reason travels;
  // an idle gateway stays silent.
  const reason = input.failureReason?.trim();
  return { canConnect: true, statusLine: reason ? reason : null };
}
