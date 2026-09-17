import { beginFleetRoutineRead, fleetRoutineRead, type FleetRoutineRead } from '@/lib/fleet/routine-read';

const jobs = [{ id: 'morning', title: 'Morning', name: '[bot:scout] morning', botId: 'scout' }];
const ready: FleetRoutineRead = { gatewayId: 'home', jobs, status: 'ready' };

describe('the shared Routine read retains facts without claiming freshness', () => {
  test('a pending or failed refresh retains the last good list as stale', () => {
    const pending = beginFleetRoutineRead(ready);
    expect(pending.jobs).toBe(jobs);
    expect(pending.status).toBe('stale');
    expect(fleetRoutineRead(pending, 'home')).toBe(pending);
  });

  test('a read with no successful result stays unreported', () => {
    const empty: FleetRoutineRead = { jobs: [], status: 'unreported' };
    expect(beginFleetRoutineRead(empty)).toEqual(empty);
    expect(fleetRoutineRead(empty, 'home')).toEqual({ jobs: [], status: 'unreported' });
  });

  test('a successful empty list is ready and clears the old arcs', () => {
    expect(fleetRoutineRead({ gatewayId: 'home', jobs: [], status: 'ready' }, 'home'))
      .toEqual({ gatewayId: 'home', jobs: [], status: 'ready' });
  });

  test.each([undefined, 'travel'])('disconnect or another gateway (%s) masks retained facts', (gatewayId) => {
    expect(fleetRoutineRead(ready, gatewayId)).toEqual({ jobs: [], status: 'unreported' });
    expect(ready.jobs).toBe(jobs);
  });
});
