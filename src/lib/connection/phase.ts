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