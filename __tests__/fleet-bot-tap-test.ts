/**
 * The Bot cluster's tap contract, beside the fold it routes through.
 *
 * The tap rides the provider's own `openBot` promise (the seam
 * `GatewayDeepLinkRouter`'s landed-open path uses — _layout.tsx:510-522):
 * a land opens Bot Chat and the route follows, a refusal surfaces the roster
 * rather than a dead navigation, and a `routable: false` Bot is drawn with
 * its detail words, never silently dead.
 */

import {
  fleetBotTapAction,
  type FleetBotTapAction,
} from '@/lib/fleet/bot-tap';

describe('fleetBotTapAction', () => {
  const routable = { botId: 'bot-1', routable: true };
  const unroutable = { botId: 'bot-2', routable: false };
  const diagnosed = { botId: 'bot-3', routable: false, issue: 'Multiplex is off' };

  it('a routable Bot on the connected gateway opens Bot Chat', () => {
    const action = fleetBotTapAction({ bot: routable, connected: true });
    expect(action).toEqual({ kind: 'open', botId: 'bot-1' });
  });

  it('a routable Bot on a saved cluster opens nothing — no live session to scope', () => {
    const action = fleetBotTapAction({ bot: routable, connected: false });
    expect(action.kind).toBe('detail');
  });

  it('a drawn but unroutable Bot is detail, never silently dead', () => {
    const action: FleetBotTapAction = fleetBotTapAction({ bot: unroutable, connected: true });
    expect(action).toEqual({ kind: 'detail', botId: 'bot-2', issue: 'No listen key' });
  });

  it('the routing verdict the Gate reported is handed through un-reworded', () => {
    const action = fleetBotTapAction({ bot: diagnosed, connected: true });
    expect(action).toEqual({ kind: 'detail', botId: 'bot-3', issue: 'Multiplex is off' });
  });

  it('a stale seat the roster dropped answers nothing', () => {
    expect(fleetBotTapAction({ bot: undefined, connected: true })).toEqual({ kind: 'none' });
  });
});
