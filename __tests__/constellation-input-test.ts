import { constellationModel } from '@/lib/fleet/constellation-model';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';
import type { CronJob } from '@/lib/gateway/cron';

function job(overrides: Partial<CronJob> & { id: string }): CronJob {
  return {
    title: overrides.title ?? overrides.id,
    name: overrides.name ?? null,
    botId: overrides.botId ?? null,
    ...overrides,
  };
}

describe('fleetConstellationInput projects provider state onto the model input', () => {
  test('profiles pass through with their probe verdict and finite stamp', () => {
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
    expect(input.reachability).toEqual({
      'gw-travel': { state: 'unreachable', lastProbeAt: 1_700_000_000_000 },
      'gw-home': { state: 'unknown' },
    });
  });

  test('a non-finite or absent stamp is not a date', () => {
    const input = fleetConstellationInput({
      gateways: [{ id: 'gw-a' }],
      reachability: {
        'gw-a': { state: 'unknown' },
        'gw-b': { state: 'checking', checkedAt: Number.NaN },
      },
    });
    expect(input.reachability).toEqual({
      'gw-a': { state: 'unknown' },
      'gw-b': { state: 'checking' },
    });
  });

  test('probe details survive projection without making a saved gateway live', () => {
    const samples = {
      reachable: { state: 'reachable', latencyMs: 23.6, checkedAt: 100 },
      unreachable: { state: 'unreachable', error: 'Timed out waiting for gateway', checkedAt: 100 },
      checking: { state: 'checking', latencyMs: 20, error: 'old failure', checkedAt: 100 },
      unknown: { state: 'unknown' },
      formerlyConnected: { state: 'connected', checkedAt: 100 },
    };
    const input = fleetConstellationInput({ reachability: samples });
    expect(input.reachability).toMatchObject({
      reachable: { state: 'reachable', latencyMs: 23.6, lastProbeAt: 100 },
      unreachable: { state: 'unreachable', error: 'Timed out waiting for gateway', lastProbeAt: 100 },
      checking: { state: 'checking', lastProbeAt: 100 },
      unknown: { state: 'unknown' },
      formerlyConnected: { state: 'unknown', lastProbeAt: 100 },
    });
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
    expect(bot?.badges).toContainEqual({ label: '1 approval', tone: 'danger', action: 'approval' });
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

describe('the projection folds routine jobs into arcs', () => {
  test('a connected mesh of jobs land on the model as routine arcs', () => {
    const model = constellationModel(
      fleetConstellationInput({
        gateways: [{ id: 'gw-home', name: 'Home' }],
        connectedGatewayId: 'gw-home',
        routineReadStatus: 'ready',
        roster: [{ id: 'scout', displayName: 'Scout' }],
        cronJobs: [
          job({ id: 'j1', name: '[bot:scout] every morning' }),
          job({ id: 'j2', name: 'gateway sweep', botId: 'gateway' }),
        ],
      }),
    );

    expect(model.edges).toContainEqual({ from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'routine' });
    const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
    expect(gateway.badges).toContainEqual({ label: 'routine unreported', tone: 'neutral' });
    const routineEdges = model.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([
      { from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'routine' },
    ]);
  });

  test('no jobs arriving is no arcs at all, not a guessed empty roster', () => {
    const input = fleetConstellationInput({
      gateways: [{ id: 'gw-home' }],
      connectedGatewayId: 'gw-home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
    });
    expect(input.cronJobs).toEqual([]);
    expect(constellationModel(input).edges.filter((edge) => edge.kind === 'routine')).toEqual([]);
  });
});


test.each(['ready', 'stale', 'unreported'] as const)('the Routine read status %s survives projection', (routineReadStatus) => {
  const input = fleetConstellationInput({
    gateways: [{ id: 'home' }], connectedGatewayId: 'home', routineReadStatus,
  });
  expect(input.routineReadStatus).toBe(routineReadStatus);
  expect(constellationModel(input).summary.routineReadStatus).toBe(routineReadStatus);
});
