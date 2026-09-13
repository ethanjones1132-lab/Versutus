import { constellationModel } from '@/lib/fleet/constellation-model';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';

describe('fleetConstellationInput projects provider state onto the model input', () => {
  test('profiles pass through and a finite probe stamp becomes last seen', () => {
    const input = fleetConstellationInput({
      gateways: [
        { id: 'gw-home', name: 'Home' },
        { id: 'gw-travel', name: 'Travel' },
      ],
      connectedGatewayId: 'gw-home',
      reachability: {
        'gw-travel': { state: 'unreachable', checkedAt: 1_700_000_000_000 },
        'gw-home': { state: 'connected' },
      },
    });

    expect(input.profiles).toEqual([
      { id: 'gw-home', name: 'Home' },
      { id: 'gw-travel', name: 'Travel' },
    ]);
    expect(input.connectedGatewayId).toBe('gw-home');
    expect(input.reachability).toEqual({ 'gw-travel': { lastProbeAt: 1_700_000_000_000 } });
  });

  test('a non-finite or absent stamp is not a date', () => {
    const input = fleetConstellationInput({
      gateways: [{ id: 'gw-a' }],
      reachability: {
        'gw-a': { state: 'unknown' },
        'gw-b': { state: 'checking', checkedAt: Number.NaN },
      },
    });
    expect(input.reachability).toEqual({});
  });

  test('a pending run approval is attributed to the Bot its run names', () => {
    const attributed = fleetConstellationInput({
      gateways: [{ id: 'gw-home' }],
      connectedGatewayId: 'gw-home',
      activityRuns: [{ id: 'r1', botId: 'scout', status: 'waiting-approval' }],
      pendingRunApproval: { runId: 'r1' },
    });
    expect(attributed.pendingApprovals).toEqual([{ botId: 'scout' }]);

    const orphan = fleetConstellationInput({
      gateways: [{ id: 'gw-home' }],
      activityRuns: [],
      pendingRunApproval: { runId: 'gone' },
    });
    expect(orphan.pendingApprovals).toEqual([{}]);
  });

  test('no pending approval is no approval row', () => {
    expect(fleetConstellationInput({ gateways: [{ id: 'gw-home' }] }).pendingApprovals).toEqual([]);
  });

  test('the projection feeds a model that is live only where it is connected', () => {
    const model = constellationModel(
      fleetConstellationInput({
        gateways: [
          { id: 'gw-home', name: 'Home' },
          { id: 'gw-travel', name: 'Travel' },
        ],
        connectedGatewayId: 'gw-home',
        reachability: { 'gw-travel': { state: 'unreachable', checkedAt: 1_700_000_000_000 } },
        roster: [{ id: 'scout', displayName: 'Scout' }],
        activityRuns: [{ id: 'r1', botId: 'scout', status: 'running' }],
        pendingRunApproval: { runId: 'r1' },
      }),
    );

    const home = model.nodes.find((node) => node.id === 'gateway:gw-home');
    const travel = model.nodes.find((node) => node.id === 'gateway:gw-travel');
    const bot = model.nodes.find((node) => node.kind === 'bot');
    expect(home?.live).toBe(true);
    expect(travel?.live).toBe(false);
    expect(travel?.lastSeenAt).toBe(1_700_000_000_000);
    expect(travel?.badges).not.toContainEqual({ label: 'Live', tone: 'success' });
    expect(bot?.badges).toContainEqual({ label: 'Running', tone: 'accent' });
    expect(bot?.badges).toContainEqual({ label: '1 approval', tone: 'danger' });
  });

  test('an absent fleet is an empty input, not a crash', () => {
    const input = fleetConstellationInput({});
    expect(input.profiles).toEqual([]);
    expect(input.roster).toEqual([]);
    expect(input.activityRuns).toEqual([]);
    expect(input.pendingApprovals).toEqual([]);
    expect(constellationModel(input).empty).toBe(true);
  });
});
