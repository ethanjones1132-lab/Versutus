import { describeHomeEmptyState } from '@/lib/home/home-empty-state';
import { homeHeroPrimaryActions } from '@/lib/home/home-hero-actions';

type DescribeInput = Parameters<typeof describeHomeEmptyState>[0];

const base: DescribeInput = {
  status: 'disconnected',
  connectionPhase: 'idle',
  lastError: null,
  deviceId: 'device-1',
  tailscaleHost: 'https://ethanspc.tail3a1a8a.ts.net',
  discoveredCount: 0,
};

describe('describeHomeEmptyState', () => {
  test('first run surfaces the address setup action', () => {
    const model = describeHomeEmptyState({ ...base, tailscaleHost: undefined });
    expect(model.showSetupAction).toBe(true);
    expect(model.setupLabel).toBe('Set up PC address');
  });

  test('a saved host retires the setup action until a token error brings it back', () => {
    expect(describeHomeEmptyState(base).showSetupAction).toBe(false);
    expect(describeHomeEmptyState(base).setupLabel).toBe('Update setup token');

    const model = describeHomeEmptyState({ ...base, lastError: 'Gateway refused: setup token required' });
    expect(model.showSetupAction).toBe(true);
    expect(model.setupLabel).toBe('Update setup token');
  });

  test('a failed connect attaches troubleshooting, pairing attaches the approve panel', () => {
    const failed = describeHomeEmptyState({
      ...base,
      connectionPhase: 'failed',
      lastError: 'Network request failed',
    });
    expect(failed.showTroubleshooting).toBe(true);
    expect(describeHomeEmptyState(base).showTroubleshooting).toBe(false);

    expect(describeHomeEmptyState({ ...base, status: 'pairing' }).showPairing).toBe(true);
    expect(describeHomeEmptyState({ ...base, status: 'pairing', deviceId: null }).showPairing).toBe(false);
  });

  test('discovery candidates drive the nearby note', () => {
    expect(describeHomeEmptyState({ ...base, discoveredCount: 2 }).showDiscovered).toBe(true);
    expect(describeHomeEmptyState(base).showDiscovered).toBe(false);
  });
});

describe('homeHeroPrimaryActions', () => {
  test('the saved-gateway hero keeps Setup; Chat, Activity, and Tools live on the tab bar', () => {
    const actions = homeHeroPrimaryActions();
    const ids = actions.map((action) => action.id);
    expect(ids).toEqual(['setup']);
    expect(actions[0]?.label).toBe('Setup');
    expect(actions[0]?.href).toBe('/gateway/setup');
    expect(ids).not.toContain('chat');
    expect(ids).not.toContain('activity');
    expect(ids).not.toContain('tools');
  });
});
