jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-router', () => ({
  Link: 'Link',
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => undefined), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock('@/components/device-id-row', () => ({ DeviceIdRow: 'DeviceIdRow' }));
jest.mock('@/components/gateway/notifications-section', () => ({ NotificationsSection: 'NotificationsSection' }));
jest.mock('@/components/gateway/spend-entry-row', () => ({ SpendEntryRow: 'SpendEntryRow' }));
jest.mock('@/components/gateway/transport-security-card', () => ({ TransportSecurityCard: 'TransportSecurityCard' }));
jest.mock('@/components/brand/versutus-mark', () => ({ VersutusMark: 'VersutusMark' }));
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  RowGroup: 'RowGroup',
  RowGroupRow: 'RowGroupRow',
  Screen: 'Screen',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

const mockAuditReader = jest.fn<Promise<unknown[]>, []>();
jest.mock('@/lib/gateway/approval-policy', () => ({
  approvalAuditCopy: (record: { approvalId: string }) => `Decision ${record.approvalId}`,
  approvalAuditSummaryCopy: (count: number) => count === 0 ? 'No approval decisions recorded yet.' : `${count} decisions`,
  loadApprovalAuditStrict: () => mockAuditReader(),
}));

const mockGateway = {
  activeGateway: null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto', pcName: 'Home PC', tailscaleHost: '' },
  status: 'disconnected',
  deviceId: 'device-1',
  deviceIdState: 'ready',
  deviceIdError: null,
  reloadDeviceId: jest.fn(),
  gatewayRequest: jest.fn(async () => ({ enabled: false, engines: {} })),
};
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#7353ba',
    accentDeep: '#483179',
    accentMuted: '#7353ba22',
    backgroundRaised: '#fff',
    controlTrackOff: '#888',
    statusConnected: '#39855f',
    textPrimary: '#222',
    textTertiary: '#777',
  }),
}));
jest.mock('@/lib/haptics', () => ({ haptics: { success: jest.fn(async () => undefined) } }));
jest.mock('@/lib/notifications/push-registration', () => ({ pushDeviceParams: jest.fn(async () => ({ deviceId: 'device-1' })) }));
jest.mock('@/lib/settings/app-lock', () => ({
  APP_LOCK_LABEL: 'App lock',
  APP_LOCK_SUMMARY: 'Require authentication to open the app.',
  appLockUnavailableCopy: () => 'App lock is unavailable.',
  saveAppLock: jest.fn(async () => undefined),
}));
jest.mock('@/lib/settings/app-lock-device', () => ({ deviceAppLockState: jest.fn(async () => ({ enabled: false, reason: null })) }));
jest.mock('@/lib/settings/widget-privacy', () => ({
  WIDGET_PRIVACY_LABEL: 'Hide widget results',
  WIDGET_PRIVACY_SUMMARY: 'Keep private details off widgets.',
  loadWidgetResultHidden: jest.fn(async () => false),
  saveWidgetResultHidden: jest.fn(async () => undefined),
}));
jest.mock('@/lib/settings/app-settings', () => ({
  loadAppSettings: jest.fn(async () => ({ autoConnect: true, onboardingComplete: true, voiceEngine: 'auto', pcName: 'Home PC', tailscaleHost: '' })),
  saveAppSettings: jest.fn(async () => ({ autoConnect: true, onboardingComplete: true, voiceEngine: 'auto', pcName: 'Home PC', tailscaleHost: '' })),
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewaySettingsScreen from '@/app/gateway/settings';

let renderer: ReactTestRenderer | null = null;

function texts(): string[] {
  return renderer?.root.findAllByType('Text' as ElementType).flatMap((node) => {
    const child = (node.props as { children?: unknown }).children;
    return typeof child === 'string' ? [child] : [];
  }) ?? [];
}

function auditErrorCard() {
  return renderer?.root.findAllByType('ErrorCard' as ElementType).find(
    (node) => (node.props as { affected?: string }).affected === 'approval decisions saved on this device',
  );
}

beforeEach(() => {
  mockAuditReader.mockReset();
  mockGateway.gatewayRequest.mockClear();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => doomed.unmount());
  }
});

test('a storage failure stays visible until retry confirms an empty history', async () => {
  let rejectInitial!: (error: Error) => void;
  const initialRead = new Promise<unknown[]>((_resolve, reject) => { rejectInitial = reject; });
  mockAuditReader.mockReturnValueOnce(initialRead).mockResolvedValueOnce([]);

  await act(async () => {
    renderer = create(createElement(GatewaySettingsScreen));
  });
  expect(renderer?.root.findAllByType('Skeleton' as ElementType).length).toBeGreaterThan(0);
  expect(texts()).not.toContain('No approval decisions recorded yet.');

  await act(async () => {
    rejectInitial(new Error('Secure storage is unavailable'));
    await initialRead.catch(() => undefined);
  });
  expect(
    renderer?.root.findAllByType('Badge' as ElementType).find(
      (node) => (node.props as { label?: string }).label === '0',
    ),
  ).toBeUndefined();
  expect(auditErrorCard()?.props).toMatchObject({
    cause: 'Secure storage is unavailable',
    affected: 'approval decisions saved on this device',
    next: 'Retry the read.',
  });
  expect(texts()).not.toContain('No approval decisions recorded yet.');

  await act(async () => {
    (auditErrorCard()?.props as { onRetry: () => void }).onRetry();
    await Promise.resolve();
  });
  expect(mockAuditReader).toHaveBeenCalledTimes(2);
  expect(auditErrorCard()).toBeUndefined();
  expect(texts()).toContain('No approval decisions recorded yet.');
});
