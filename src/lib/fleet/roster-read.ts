import type { PublicBot } from '@/lib/gateway/bots';

export type FleetRosterReadStatus = 'ready' | 'stale' | 'unreported' | 'unavailable';
export type FleetRosterRead = {
  gatewayId?: string;
  bots: PublicBot[];
  status: FleetRosterReadStatus;
  request?: object;
};

export const UNREPORTED_ROSTER: FleetRosterRead = { bots: [], status: 'unreported' };

/** Only the connected gateway owns these Bots; a new read cannot certify old facts. */
export function fleetRosterRead(
  read: FleetRosterRead,
  gatewayId: string | undefined,
  request: object,
): FleetRosterRead {
  if (!gatewayId || read.gatewayId !== gatewayId) return UNREPORTED_ROSTER;
  if (read.request === request) return read;
  return { ...read, status: read.status === 'ready' || read.status === 'stale' ? 'stale' : 'unreported' };
}

/** A refusal keeps last-good facts, including a successfully read empty Roster. */
export function failFleetRosterRead(
  read: FleetRosterRead,
  gatewayId: string,
  request: object,
): FleetRosterRead {
  const retained = fleetRosterRead(read, gatewayId, request);
  return {
    gatewayId,
    request,
    bots: retained.bots,
    status: retained.status === 'ready' || retained.status === 'stale' ? 'stale' : 'unavailable',
  };
}
