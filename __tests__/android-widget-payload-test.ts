import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

const base: GlanceableSnapshot = {
  status: 'connected',
  runsInFlight: 3,
  approvalsPending: 1,
  lastResult: 'Deployed the fix',
  writtenAt: 1_757_700_000_000,
};

describe('androidWidgetPayload', () => {
  test('carries the same words the iOS widget draws, plus what the native card needs', () => {
    expect(androidWidgetPayload(base)).toEqual({
      v: 1,
      status: 'Connected',
      connected: true,
      work: '1 run waiting on your approval · 2 runs in flight',
      result: 'Deployed the fix',
      approvalsPending: 1,
      writtenAt: 1_757_700_000_000,
    });
  });

  test('an absent result stays absent', () => {
    const { lastResult: _omit, ...rest } = base;
    expect(androidWidgetPayload(rest)).not.toHaveProperty('result');
  });

  test('a disconnected snapshot is not drawn as connected', () => {
    const payload = androidWidgetPayload({ ...base, status: 'reconnecting' });
    expect(payload.connected).toBe(false);
    expect(payload.status).toBe('Reconnecting');
  });

  test('survives the JSON round trip the native module parses', () => {
    expect(JSON.parse(JSON.stringify(androidWidgetPayload(base)))).toEqual(androidWidgetPayload(base));
  });
});
