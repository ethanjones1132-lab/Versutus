import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { HandsfreeCallBanner } from '@/components/voice/handsfree-call-banner';
import { useHandsfreeVoice } from '@/context/handsfree-voice-provider';

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));
jest.mock('@/context/handsfree-voice-provider', () => ({ useHandsfreeVoice: jest.fn() }));
jest.mock('@/hooks/use-tokens', () => ({ useTokens: () => ({ accentWarmMuted: '#fff', accent: '#fff', border: '#fff', statusDisconnected: '#fff' }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@/components/ui', () => ({
  GlassSurface: 'GlassSurface',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));
jest.mock('@/components/voice/handsfree-call-indicator', () => ({ HandsfreeCallIndicator: 'HandsfreeCallIndicator' }));

function mockVoice(active: boolean, startedAtMs?: number) {
  jest.mocked(useHandsfreeVoice).mockReturnValue({
    active,
    phase: 'listening',
    partial: '',
    label: 'Test Bot',
    level: { value: 0 } as never,
    engine: undefined,
    engineReason: undefined,
    mute: jest.fn(),
    unmute: jest.fn(),
    skipReply: jest.fn(),
    end: jest.fn(),
    startedAtMs,
    sendingSinceMs: null,
  } as never);
}

function Nothing() {
  return null;
}

/**
 * The banner's per-second clock is a `setInterval`, so that is what an idle
 * app must not have. React parks a timer of its own in this environment even
 * for a component that renders nothing, so the count is compared against that
 * baseline rather than against zero.
 */
async function schedulerBaseline(): Promise<number> {
  let control!: ReactTestRenderer;
  await act(async () => { control = create(createElement(Nothing)); });
  const count = jest.getTimerCount();
  await act(async () => { control.unmount(); });
  jest.clearAllTimers();
  return count;
}

describe('HandsfreeCallBanner timer', () => {
  let renderer: ReactTestRenderer | null = null;
  let intervals: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    intervals = jest.spyOn(global, 'setInterval');
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount(); });
    renderer = null;
    intervals.mockRestore();
    jest.useRealTimers();
  });

  test('with active: false the banner schedules no clock', async () => {
    const baseline = await schedulerBaseline();
    mockVoice(false);
    await act(async () => { renderer = create(createElement(HandsfreeCallBanner)); });
    expect(intervals).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(baseline);
  });

  test('with active: true the elapsed copy ticks', async () => {
    mockVoice(true, Date.now() - 120_000);
    await act(async () => { renderer = create(createElement(HandsfreeCallBanner)); });
    expect(intervals).toHaveBeenCalledWith(expect.any(Function), 1000);
    const before = JSON.stringify(renderer!.toJSON());
    await act(async () => { jest.advanceTimersByTime(2000); });
    const after = JSON.stringify(renderer!.toJSON());
    expect(after).not.toBe(before);
  });
});
