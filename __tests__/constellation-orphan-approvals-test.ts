import {
  constellationLayout,
  constellationModel,
  constellationSummaryCopy,
} from '@/lib/fleet/constellation-model';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';

// D2: a pending approval is a thing waiting on the operator, even when its Bot
// is not on the roster this device can read. Such an orphan has no star to
// badge, but the HUD total must still count it — otherwise the map silently
// drops part of the approval queue. Per-node badges and the layout stay the
// rostered truth: no Bot is invented for an unknown id.

const HOME = { id: 'gw-home', name: 'Home' };
const SCOUT = { id: 'scout', displayName: 'Scout' };

function modelWith(
  pendingApprovals: { botId?: string }[],
  roster = [SCOUT],
) {
  return constellationModel({
    profiles: [HOME],
    connectedGatewayId: 'gw-home',
    roster,
    pendingApprovals,
  });
}

describe('an approval whose Bot is missing from the roster still counts in the HUD', () => {
  test('the HUD total is every pending approval; the star badges only rostered ones', () => {
    const model = modelWith([{ botId: 'scout' }, { botId: 'ghost' }]);
    expect(model.summary.approvals).toBe(2);
    const scout = model.nodes.find((node) => node.kind === 'bot' && node.botId === 'scout');
    expect(scout?.badges).toContainEqual({
      label: '1 approval',
      tone: 'danger',
      action: 'approval',
    });
    // No star is invented for the Bot the roster does not name.
    expect(model.nodes.some((node) => node.botId === 'ghost')).toBe(false);
    expect(model.nodes.filter((node) => node.kind === 'bot')).toHaveLength(1);
  });

  test('the HUD line reads the orphan in its approvals figure', () => {
    const model = modelWith([{ botId: 'scout' }, { botId: 'ghost' }]);
    expect(constellationSummaryCopy(model.summary)).toContain('2 approvals waiting');
  });

  test('a row naming no Bot at all is counted, not dropped', () => {
    const model = modelWith([{}]);
    expect(model.summary.approvals).toBe(1);
    expect(model.nodes.every((node) => !node.badges.some((badge) => badge.action === 'approval'))).toBe(true);
  });

  test('an approval the projection cannot attribute to a run is still a waiting approval', () => {
    const input = fleetConstellationInput({
      gateways: [HOME],
      connectedGatewayId: 'gw-home',
      roster: [SCOUT],
      // The run the approval names is gone from this device's history, so the
      // projection carries an unattributed row: `{}`.
      activityRuns: [],
      pendingRunApproval: { runId: 'gone' },
    });
    expect(input.pendingApprovals).toEqual([{}]);
    const model = constellationModel(input);
    expect(model.summary.approvals).toBe(1);
    expect(
      model.nodes.every((node) => !node.badges.some((badge) => badge.action === 'approval')),
    ).toBe(true);
  });

  test('a run attributed to a Bot that already left the roster still reaches the HUD', () => {
    const input = fleetConstellationInput({
      gateways: [HOME],
      connectedGatewayId: 'gw-home',
      roster: [SCOUT],
      activityRuns: [{ id: 'r1', botId: 'ghost', status: 'waiting-approval' }],
      pendingRunApproval: { runId: 'r1' },
    });
    expect(input.pendingApprovals).toEqual([{ botId: 'ghost' }]);
    const model = constellationModel(input);
    expect(model.summary.approvals).toBe(1);
    expect(model.nodes.some((node) => node.botId === 'ghost')).toBe(false);
  });

  test('an empty roster does not swallow the approvals it cannot place', () => {
    const model = modelWith([{ botId: 'ghost' }], []);
    expect(model.summary.approvals).toBe(1);
    expect(model.nodes.filter((node) => node.kind === 'bot')).toHaveLength(0);
  });

  test('counting an orphan changes no node, no badge and no figure besides the total', () => {
    const rostered = modelWith([{ botId: 'scout' }, { botId: 'scout' }]);
    const withOrphans = modelWith([
      { botId: 'scout' },
      { botId: 'scout' },
      { botId: 'ghost' },
      {},
    ]);
    expect(withOrphans.summary.approvals).toBe(4);
    expect(rostered.summary.approvals).toBe(2);
    // The per-node truth and the picture are identical; only the HUD adds the
    // approvals it cannot place.
    expect(withOrphans.nodes).toEqual(rostered.nodes);
    expect(constellationLayout(withOrphans, 320, 320).nodes.map((node) => [node.id, node.x, node.y]))
      .toEqual(constellationLayout(rostered, 320, 320).nodes.map((node) => [node.id, node.x, node.y]));
    expect(constellationSummaryCopy(rostered.summary)).toContain('2 approvals waiting');
    expect(constellationSummaryCopy(withOrphans.summary)).toContain('4 approvals waiting');
  });
});
