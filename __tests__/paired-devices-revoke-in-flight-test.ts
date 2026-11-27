import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));
jest.mock('@/constants/tokens', () => ({ Spacing: { one: 4, two: 8, three: 12 } }));
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  ConfirmSheet: 'ConfirmSheet',
  ErrorCard: 'ErrorCard',
  // ListRow paints its trailing node; the mock keeps the Revoke button in
  // the tree so the test can tap it.
  ListRow: (props: any) => props.trailing ?? null,
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

const mockGateway = {
  status: 'connected',
  activeGateway: { id: 'gw-1', kind: 'custom' },
  gatewayRequest: jest.fn(),
};

import { PairedDevicesPane } from '@/components/gateway/paired-devices-pane';

const BUTTON = 'Button' as ElementType;
const SHEET = 'ConfirmSheet' as ElementType;

// A second confirm while the first device.revoke is still in flight used to
// fire a second revoke: both taps came off the same rendered closure before
// `setRevokePending` re-rendered. The ref guard makes the second a no-op, and
// the ConfirmSheet's confirm button announces busy while the write runs.
describe('a second confirm cannot revoke twice', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    if (renderer) {
      const doomed = renderer;
      renderer = null;
      await act(async () => {
        doomed.unmount();
      });
    }
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('an in-flight revoke ignores a second confirm and reports busy', async () => {
    let resolveRevoke!: (value: unknown) => void;
    const revokeGate = new Promise<unknown>((resolve) => {
      resolveRevoke = resolve;
    });
    mockGateway.gatewayRequest.mockImplementation((method: string) => {
      if (method === 'device.list') {
        return Promise.resolve({
          devices: [
            {
              deviceId: 'abc123',
              role: 'operator',
              scopes: ['operator.read'],
              issuedAtMs: 1_700_000_000_000,
              revoked: false,
            },
          ],
        });
      }
      if (method === 'device.revoke') return revokeGate;
      return Promise.resolve(undefined);
    });

    await act(async () => {
      renderer = create(createElement(PairedDevicesPane));
    });
    // The pane defers its first device.list read one tick.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });

    const revokeButton = renderer!.root
      .findAllByType(BUTTON)
      .find((button) => button.props.label === 'Revoke');
    expect(revokeButton).toBeDefined();
    await act(async () => {
      revokeButton!.props.onPress();
    });

    const sheet = () => renderer!.root.findAllByType(SHEET)[0];
    expect(sheet().props.visible).toBe(true);
    expect(sheet().props.busy).toBe(false);

    await act(async () => {
      void sheet().props.onConfirm();
      void sheet().props.onConfirm();
    });

    const revokeCalls = mockGateway.gatewayRequest.mock.calls.filter(
      ([method]) => method === 'device.revoke',
    );
    // One confirm in flight, one revoke — the second tap is not a second write.
    expect(revokeCalls).toHaveLength(1);
    // The confirm button announces the in-flight state while the write runs.
    expect(sheet().props.busy).toBe(true);

    await act(async () => {
      resolveRevoke(undefined);
      await revokeGate;
    });
    expect(sheet().props.busy).toBe(false);
  });
});
