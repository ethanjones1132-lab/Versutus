import type { CronJob } from '@/lib/gateway/cron';

export type FleetRoutineReadStatus = 'ready' | 'stale' | 'unreported';
export type FleetRoutineRead = {
  gatewayId?: string;
  jobs: CronJob[];
  status: FleetRoutineReadStatus;
};

const UNREPORTED: FleetRoutineRead = { jobs: [], status: 'unreported' };

/** Disconnects and pending reads cannot certify the retained list as current. */
export function beginFleetRoutineRead(read: FleetRoutineRead): FleetRoutineRead {
  return read.status === 'ready' ? { ...read, status: 'stale' } : read;
}

/** The widget may retain old facts; the Fleet may only show its own gateway's. */
export function fleetRoutineRead(
  read: FleetRoutineRead,
  connectedGatewayId?: string,
): FleetRoutineRead {
  return connectedGatewayId && read.gatewayId === connectedGatewayId ? read : UNREPORTED;
}
