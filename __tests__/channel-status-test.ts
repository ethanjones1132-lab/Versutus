import { describeChannelStatusRow } from '@/lib/gateway/channel-status';
import type { GatewayCapabilityGroup } from '@/lib/gateway/types';

function group(status: GatewayCapabilityGroup['status'], overrides: Partial<GatewayCapabilityGroup> = {}): GatewayCapabilityGroup {
  return { id: 'channels', label: 'Channels', status, ...overrides };
}

describe('describeChannelStatusRow', () => {
  test('no snapshot entry and undeclared both hide the row entirely', () => {
    expect(describeChannelStatusRow(undefined).visible).toBe(false);
    expect(describeChannelStatusRow(group('undeclared')).visible).toBe(false);
  });

  test('a healthy channel family stays visible — persistent means always, not only-when-degraded', () => {
    const model = describeChannelStatusRow(group('ready'));
    expect(model.visible).toBe(true);
    expect(model.tone).toBe('live');
    expect(model.detail).toBe('Ready - manage from chat');
    expect(describeChannelStatusRow(group('available')).tone).toBe('live');
  });

  test('degraded families demand attention and offer inspection, not a promised repair', () => {
    const partial = describeChannelStatusRow(group('partial'));
    expect(partial.tone).toBe('attention');
    expect(partial.detail).toBe('Some channels degraded - open chat to inspect');

    const unhealthy = describeChannelStatusRow(group('unhealthy'));
    expect(unhealthy.tone).toBe('attention');
    expect(unhealthy.detail).toBe('Channels degraded - open chat to inspect');
  });

  test('no channel status ever promises a repair action chat cannot perform', () => {
    // The retired Channel Repair card prescribed /channel start|stop|logout —
    // commands no shipped gateway dispatches. The row's copy must never
    // resurrect that promise in any tone or state.
    const statuses = [
      'ready',
      'available',
      'partial',
      'unhealthy',
      'missing-scope',
      'unsupported',
      'warming',
      'stale',
      'unavailable',
      'experimental',
      'unknown',
      'undeclared',
    ] as const;
    for (const status of statuses) {
      expect(JSON.stringify(describeChannelStatusRow(group(status)))).not.toMatch(/repair/i);
    }
  });

  test('a gateway that declares no channels says so instead of going quiet', () => {
    const model = describeChannelStatusRow(group('unsupported'));
    expect(model.visible).toBe(true);
    expect(model.tone).toBe('quiet');
    expect(model.detail).toBe('This gateway offers no channels');
  });

  test('unverified states stay honest about what the snapshot does not know', () => {
    expect(describeChannelStatusRow(group('unknown')).detail).toBe('Not confirmed yet');
    expect(describeChannelStatusRow(group('warming')).detail).toBe('Warming up - not confirmed yet');
    expect(describeChannelStatusRow(group('stale')).detail).toBe('Last check is stale');
    expect(describeChannelStatusRow(group('missing-scope')).detail).toBe(
      'No permission to check channels',
    );
    expect(describeChannelStatusRow(group('experimental')).detail).toBe('Experimental support');
    for (const model of [
      describeChannelStatusRow(group('unknown')),
      describeChannelStatusRow(group('warming')),
      describeChannelStatusRow(group('stale')),
      describeChannelStatusRow(group('missing-scope')),
      describeChannelStatusRow(group('experimental')),
    ]) {
      expect(model.tone).toBe('quiet');
    }
  });

  test('an offline gateway keeps the row with the offline verdict', () => {
    const model = describeChannelStatusRow(group('unavailable'));
    expect(model.visible).toBe(true);
    expect(model.detail).toBe('Gateway offline');
  });

  test('the row never quotes command counts as if they were channel counts', () => {
    const model = describeChannelStatusRow(group('ready', { availableCount: 2, totalCount: 5 }));
    expect(JSON.stringify(model)).not.toContain('2/5');
    expect(model.detail).not.toMatch(/\d+\/\d+/);
  });

  test('a drifted label falls back to Channels instead of rendering an empty string', () => {
    expect(describeChannelStatusRow(group('ready', { label: '' })).label).toBe('Channels');
    expect(describeChannelStatusRow({ id: 'channels', label: '', status: 'undeclared' }).label).toBe(
      'Channels',
    );
  });

  test('a bridge-level note is more specific truth than the static degraded copy', () => {
    const partial = describeChannelStatusRow(group('partial', { note: '1 of 3 channel bridges healthy' }));
    expect(partial.tone).toBe('attention');
    expect(partial.detail).toBe('1 of 3 channel bridges healthy');

    const unhealthy = describeChannelStatusRow(group('unhealthy', { note: '0 of 2 channel bridges healthy' }));
    expect(unhealthy.detail).toBe('0 of 2 channel bridges healthy');

    const unknown = describeChannelStatusRow(
      group('unknown', { note: '2 declared - bridge states not confirmed' }),
    );
    expect(unknown.tone).toBe('quiet');
    expect(unknown.detail).toBe('2 declared - bridge states not confirmed');
  });

  test('without a note the static copy stands, ready never repeats a tally', () => {
    expect(describeChannelStatusRow(group('partial')).detail).toBe(
      'Some channels degraded - open chat to inspect',
    );
    expect(describeChannelStatusRow(group('unhealthy')).detail).toBe(
      'Channels degraded - open chat to inspect',
    );
    expect(describeChannelStatusRow(group('unknown')).detail).toBe('Not confirmed yet');
    expect(describeChannelStatusRow(group('ready', { note: '4 of 4 channel bridges healthy' })).detail).toBe(
      'Ready - manage from chat',
    );
  });
});
