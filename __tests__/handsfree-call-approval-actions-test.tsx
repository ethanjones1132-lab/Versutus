import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import { HandsfreeCallBanner } from '@/components/voice/handsfree-call-banner';
import { useHandsfreeVoice } from '@/context/handsfree-voice-provider';

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));
jest.mock('@/context/handsfree-voice-provider', () => ({ useHandsfreeVoice: jest.fn() }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({ accentWarmMuted: '#fff', accent: '#fff', border: '#fff', statusDisconnected: '#fff' }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@/components/ui', () => ({
  GlassSurface: 'GlassSurface',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));
jest.mock('@/components/voice/handsfree-call-indicator', () => ({
  HandsfreeCallIndicator: 'HandsfreeCallIndicator',
}));

test('the mounted call banner offers one-time approve and deny actions for a pending approval', async () => {
  const decideApproval = jest.fn(async () => undefined);
  jest.mocked(useHandsfreeVoice).mockReturnValue({
    active: true,
    phase: 'sending',
    partial: '',
    label: 'Test Bot',
    level: { value: 0 } as never,
    engine: 'local',
    engineReason: undefined,
    muted: false,
    turnError: null,
    turnState: null,
    approval: { turnId: 't1', approvalId: 'a1', summary: 'Run ls?', state: 'pending' },
    approvalBusy: false,
    decideApproval,
    mute: jest.fn(),
    unmute: jest.fn(),
    skipReply: jest.fn(),
    end: jest.fn(),
    startedAtMs: undefined,
    sendingSinceMs: null,
  } as never);
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(HandsfreeCallBanner)); });

  const buttons = renderer.root.findAllByType('PressableScale' as never);
  const approve = buttons.find((button) => button.props.accessibilityLabel === 'Approve tool once');
  const deny = buttons.find((button) => button.props.accessibilityLabel === 'Deny tool approval');
  expect(approve).toBeDefined();
  expect(deny).toBeDefined();
  expect(JSON.stringify(renderer.toJSON())).toContain('Run ls?');
  await act(async () => { approve?.props.onPress(); });
  expect(decideApproval).toHaveBeenCalledWith('approve');
  await act(async () => { deny?.props.onPress(); });
  expect(decideApproval).toHaveBeenCalledWith('deny');
  await act(async () => { renderer.unmount(); });
});
