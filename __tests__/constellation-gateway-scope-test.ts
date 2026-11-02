import { constellationLayout, constellationModel } from '@/lib/fleet/constellation-model';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';

// D2: the map's Bots belong to one gateway, and a run carries the gateway it
// was started on. The same Bot id can exist on two gateways, so the Running
// and failed badges must be folded per gateway: another gateway's run is not
// this Bot's work. A run saved before `gatewayId` existed names none and stays
// under the live gateway — the legacy rule `runsForGateway` applies.

const HOME = { id: 'gw-home', name: 'Home' };
const TRAVEL = { id: 'gw-travel', name: 'Travel' };
const SCOUT = { id: 'scout', displayName: 'Scout' };

type Run = { id: string; botId?: string; status: string; prompt?: string; gatewayId?: string };

function modelWith(
  runs: Run[],
  gateways = [HOME, TRAVEL],
  connectedGatewayId = 'gw-home',
) {
  return constellationModel(
    fleetConstellationInput({
      gateways,
      connectedGatewayId,
      roster: [SCOUT],
      activityRuns: runs,
    }),
  );
}

function scoutNode(model: ReturnType<typeof modelWith>) {
  const node = model.nodes.find((candidate) => candidate.kind === 'bot' && candidate.botId === 'scout');
  if (!node) throw new Error('the roster Bot is missing from the map');
  return node;
}

describe('the projection keeps the gateway a run was started on', () => {
  test('a run gateway id survives, trimmed, and an empty one is no id', () => {
    const input = fleetConstellationInput({
      activityRuns: [
        { id: 'r1', botId: 'scout', status: 'running', gatewayId: '  gw-home  ' },
        { id: 'r2', botId: 'scout', status: 'running', gatewayId: '   ' },
        { id: 'r3', botId: 'scout', status: 'running' },
      ],
    });
    expect(input.activityRuns).toEqual([
      { id: 'r1', botId: 'scout', status: 'running', gatewayId: 'gw-home' },
      { id: 'r2', botId: 'scout', status: 'running' },
      { id: 'r3', botId: 'scout', status: 'running' },
    ]);
  });
});

describe('a run marks only the Bot on its own gateway', () => {
  test("another gateway's running run does not mark the live Bot", () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', gatewayId: 'gw-travel', prompt: 'someone else' },
    ]);
    const bot = scoutNode(model);
    expect(bot.badges).not.toContainEqual({ label: 'Running', tone: 'accent' });
    expect(bot.runningRunName).toBeUndefined();
    expect(model.summary.running).toBe(0);
  });

  test("another gateway's failures do not badge the live Bot", () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'failed', gatewayId: 'gw-travel' },
      { id: 'r2', botId: 'scout', status: 'failed', gatewayId: 'gw-travel' },
    ]);
    expect(scoutNode(model).badges.some((badge) => badge.label.includes('failed'))).toBe(false);
  });

  test("this gateway's own runs still badge it", () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', gatewayId: 'gw-home', prompt: 'Nightly sweep' },
      { id: 'r2', botId: 'scout', status: 'failed', gatewayId: 'gw-home' },
    ]);
    const bot = scoutNode(model);
    expect(bot.badges).toContainEqual({ label: 'Running', tone: 'accent' });
    expect(bot.badges).toContainEqual({ label: '1 failed', tone: 'danger' });
    expect(bot.runningRunName).toBe('Nightly sweep');
    expect(model.summary.running).toBe(1);
  });

  test("another gateway's run cannot be the first run named on this one", () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', gatewayId: 'gw-travel' },
      { id: 'r2', botId: 'scout', status: 'running', gatewayId: 'gw-home', prompt: 'mine' },
    ]);
    const bot = scoutNode(model);
    expect(bot.runningRunName).toBe('mine');
    expect(model.summary.running).toBe(1);
  });

  test('a run saved before gatewayId existed stays under the live gateway', () => {
    const model = modelWith([{ id: 'r1', botId: 'scout', status: 'running' }]);
    expect(scoutNode(model).badges).toContainEqual({ label: 'Running', tone: 'accent' });
    expect(model.summary.running).toBe(1);
  });

  test('one gateway with a matching id behaves exactly like an unscoped run', () => {
    const scoped = modelWith(
      [{ id: 'r1', botId: 'scout', status: 'failed', gatewayId: 'gw-home' }],
      [HOME],
    );
    const legacy = modelWith([{ id: 'r1', botId: 'scout', status: 'failed' }], [HOME]);
    expect(scoped).toEqual(legacy);
  });

  test('the scope changes no node id and no figure on the map', () => {
    const own = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', gatewayId: 'gw-home', prompt: 'Nightly sweep' },
    ]);
    const foreign = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', gatewayId: 'gw-travel', prompt: 'Nightly sweep' },
    ]);
    expect(foreign.nodes.map((node) => node.id)).toEqual(own.nodes.map((node) => node.id));
    const ownLayout = constellationLayout(own, 320, 320);
    const foreignLayout = constellationLayout(foreign, 320, 320);
    expect(foreignLayout.nodes.map((node) => [node.id, node.x, node.y]))
      .toEqual(ownLayout.nodes.map((node) => [node.id, node.x, node.y]));
  });
});
