import { botSheetView } from '@/lib/fleet/bot-sheet';
import { constellationLayout, constellationModel } from '@/lib/fleet/constellation-model';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';

// D2: a Bot wearing the Running badge should say WHAT is running. The run row
// already holds the operator's prompt; the map names the run with its first
// line, from the projection through the model to the long-press sheet. A run
// with no readable prompt is still Running, with no invented title.

const HOME = { id: 'gw-home', name: 'Home' };
const SCOUT = { id: 'scout', displayName: 'Scout' };

type Run = { id: string; botId?: string; status: string; prompt?: string };

function modelWith(runs: Run[]) {
  return constellationModel(
    fleetConstellationInput({
      gateways: [HOME],
      connectedGatewayId: 'gw-home',
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

describe('the running run keeps its own name on the map', () => {
  test('the projection carries the prompt\'s first line as the run label', () => {
    const input = fleetConstellationInput({
      gateways: [HOME],
      activityRuns: [{ id: 'r1', botId: 'scout', status: 'running', prompt: '  Nightly sweep  \nsecond line' }],
    });
    expect(input.activityRuns).toEqual([
      { id: 'r1', botId: 'scout', status: 'running', label: 'Nightly sweep' },
    ]);
  });

  test('a running run names its Bot with that label', () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', prompt: 'Nightly sweep\nsecond line' },
    ]);
    const bot = scoutNode(model);
    expect(bot.badges).toContainEqual({ label: 'Running', tone: 'accent' });
    expect(bot.runningRunName).toBe('Nightly sweep');
  });

  test('the Bot sheet shows the run the map carries', () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', prompt: 'Nightly sweep' },
    ]);
    const view = botSheetView({ node: scoutNode(model), bot: SCOUT });
    expect(view.running).toBe('Nightly sweep');
  });

  test('a run with no readable prompt is Running with no invented name', () => {
    for (const prompt of [undefined, '', '   ', '\n\nsecond line only']) {
      const model = modelWith([{ id: 'r1', botId: 'scout', status: 'running', prompt }]);
      const bot = scoutNode(model);
      expect(bot.badges).toContainEqual({ label: 'Running', tone: 'accent' });
      expect(bot.runningRunName).toBeUndefined();
      expect(botSheetView({ node: bot, bot: SCOUT }).running).toBeNull();
    }
  });

  test('only a running run names a Bot', () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'complete', prompt: 'finished work' },
      { id: 'r2', botId: 'scout', status: 'failed', prompt: 'broken work' },
      { id: 'r3', botId: 'scout', status: 'waiting-approval', prompt: 'waiting work' },
    ]);
    expect(scoutNode(model).runningRunName).toBeUndefined();
  });

  test('the first running run in input order is the one the map names', () => {
    const model = modelWith([
      { id: 'r1', botId: 'scout', status: 'running', prompt: 'newest' },
      { id: 'r2', botId: 'scout', status: 'running', prompt: 'older' },
    ]);
    expect(scoutNode(model).runningRunName).toBe('newest');
  });

  test('a run off the roster names nobody', () => {
    const model = modelWith([
      { id: 'r1', botId: 'ghost', status: 'running', prompt: 'a house call from another roster' },
    ]);
    expect(scoutNode(model).runningRunName).toBeUndefined();
    expect(model.summary.running).toBe(0);
  });

  test('a label changes no node id and no figure on the map', () => {
    const withLabel = modelWith([{ id: 'r1', botId: 'scout', status: 'running', prompt: 'Nightly sweep' }]);
    const withoutLabel = modelWith([{ id: 'r1', botId: 'scout', status: 'running' }]);
    expect(withLabel.nodes.map((node) => node.id)).toEqual(withoutLabel.nodes.map((node) => node.id));
    const laidOut = constellationLayout(withLabel, 320, 320);
    const bare = constellationLayout(withoutLabel, 320, 320);
    expect(laidOut.nodes.map((node) => [node.id, node.x, node.y]))
      .toEqual(bare.nodes.map((node) => [node.id, node.x, node.y]));
  });
});
