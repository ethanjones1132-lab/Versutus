import type { ConnectionPhase } from '@/context/gateway-provider';
import type { ConnectionStatus } from '@/lib/gateway/types';

export function phaseToStepIndex(
  phase: ConnectionPhase,
  status: ConnectionStatus,
): number {
  if (status === 'connected' || phase === 'connected') return 3;
  if (status === 'pairing' || phase === 'pairing') return 2;
  if (phase === 'connecting' || status === 'connecting' || status === 'reconnecting') return 1;
  if (phase === 'searching') return 0;
  return -1;
}

export function phaseToTimelineStep(phase: ConnectionPhase): number {
  return phaseToStepIndex(phase, 'disconnected');
}

/** Side effects the caller must apply alongside the phase transition. */
export type ConnectionPhaseDecision = {
  phase: ConnectionPhase;
  clearAutoRetryTimer: boolean;
  clearGatewayDownNotified: boolean;
  clearProbeMessage: boolean;
  clearLastError: boolean;
  notifyGatewayDown: boolean;
  scheduleAutoRetry: boolean;
};

const NO_OP: Omit<ConnectionPhaseDecision, 'phase'> = {
  clearAutoRetryTimer: false,
  clearGatewayDownNotified: false,
  clearProbeMessage: false,
  clearLastError: false,
  notifyGatewayDown: false,
  scheduleAutoRetry: false,
};

/**
 * Given the phase before a client status event and the status it just
 * reported, decide the next phase and which side effects the caller owns
 * (timers, notifications, refs) — kept out of this function so it stays a
 * pure decision table, testable without mocking timers or the client.
 */
export function decideConnectionPhase(
  currentPhase: ConnectionPhase,
  nextStatus: ConnectionStatus,
): ConnectionPhaseDecision {
  if (nextStatus === 'connected') {
    return {
      phase: 'connected',
      ...NO_OP,
      clearAutoRetryTimer: true,
      clearGatewayDownNotified: true,
      clearProbeMessage: true,
      clearLastError: true,
    };
  }

  if (nextStatus === 'connecting' || nextStatus === 'reconnecting') {
    return {
      phase: 'connecting',
      ...NO_OP,
      // Only a fresh attempt clears the last failure. 'reconnecting' is
      // reported immediately after onError, so clearing here would wipe the
      // reason before it could ever be shown.
      clearLastError: nextStatus === 'connecting',
      notifyGatewayDown: nextStatus === 'reconnecting',
    };
  }

  if (nextStatus === 'disconnected') {
    return {
      phase: currentPhase === 'connecting' || currentPhase === 'connected' ? 'failed' : currentPhase,
      ...NO_OP,
      scheduleAutoRetry: true,
    };
  }

  // 'pairing' and any other status reported on this channel do not drive a
  // phase transition here — pairing has its own onPairingRequired callback.
  return { phase: currentPhase, ...NO_OP };
}

/**
 * Fold one status event's gateway-down request into the set of gateways that
 * already owe a notice, keyed by gateway id.
 *
 * A single process-wide flag could not tell one gateway from another: a
 * `connected` on gateway B cleared it for gateway A too, so every later outage
 * of A posted a second notice while A's first still sat in the tray. Keyed by
 * id, only the gateway that answered has its notice state cleared, and a
 * gateway still down never posts twice for one outage.
 *
 * Pure, so the state machine is testable without rendering the provider.
 */
export function applyGatewayDownDecision(
  notifiedGatewayIds: ReadonlySet<string>,
  decision: ConnectionPhaseDecision,
  gatewayId: string,
): { notifiedGatewayIds: Set<string>; notify: boolean } {
  const next = new Set(notifiedGatewayIds);
  if (decision.clearGatewayDownNotified) next.delete(gatewayId);
  const notify = decision.notifyGatewayDown && !next.has(gatewayId);
  if (notify) next.add(gatewayId);
  return { notifiedGatewayIds: next, notify };
}