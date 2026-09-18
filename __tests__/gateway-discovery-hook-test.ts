import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';

type ScannerMock = {
  subscribe: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
};

let scanner: ScannerMock;

jest.mock('@/lib/discovery/scanner', () => {
  const instance: ScannerMock = {
    subscribe: jest.fn(() => jest.fn()) as jest.Mock,
    start: jest.fn() as jest.Mock,
    stop: jest.fn() as jest.Mock,
  };
  scanner = instance;
  return {
    GatewayDiscoveryScanner: jest.fn(() => instance),
    isNativeDiscoveryAvailable: jest.fn(() => false),
  };
});

let hookResult: ReturnType<typeof useGatewayDiscovery>;

function DiscoveryHost({ enabled }: { enabled?: boolean }) {
  hookResult = useGatewayDiscovery(enabled);
  return null;
}

describe('useGatewayDiscovery owns the shared scanner lifecycle', () => {
  let renderers: ReactTestRenderer[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    for (const renderer of renderers) {
      await act(async () => {
        renderer.unmount();
      });
    }
    renderers = [];
  });

  async function mountHost(enabled = true): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(DiscoveryHost, { enabled }));
    });
    renderers.push(renderer);
    return renderer;
  }

  async function unmount(renderer: ReactTestRenderer) {
    renderers = renderers.filter((item) => item !== renderer);
    await act(async () => {
      renderer.unmount();
    });
  }

  test('an enabled hook subscribes and starts the shared scan', async () => {
    const renderer = await mountHost(true);
    expect(scanner.subscribe).toHaveBeenCalledTimes(1);
    expect(scanner.start).toHaveBeenCalledTimes(1);
    expect(scanner.stop).not.toHaveBeenCalled();
    await unmount(renderer);
    expect(scanner.subscribe).toHaveBeenCalledTimes(1);
  });

  test('the last subscriber leaving stops the shared scan', async () => {
    const renderer = await mountHost(true);
    await unmount(renderer);
    expect(scanner.start).toHaveBeenCalledTimes(1);
    expect(scanner.stop).toHaveBeenCalledTimes(1);
  });

  test('disabling the hook stops the shared scan on the way out', async () => {
    const renderer = await mountHost(true);
    await act(async () => {
      renderer.update(createElement(DiscoveryHost, { enabled: false }));
    });
    expect(scanner.start).toHaveBeenCalledTimes(1);
    expect(scanner.stop).toHaveBeenCalledTimes(1);
  });

  test('a second subscriber keeps the scan running when the first leaves', async () => {
    const first = await mountHost(true);
    const second = await mountHost(true);
    expect(scanner.subscribe).toHaveBeenCalledTimes(2);
    expect(scanner.start).toHaveBeenCalledTimes(2);
    await unmount(first);
    expect(scanner.stop).not.toHaveBeenCalled();
    await unmount(second);
    expect(scanner.stop).toHaveBeenCalledTimes(1);
  });

  test('disabled discovery performs no scan', async () => {
    const renderer = await mountHost(false);
    expect(scanner.subscribe).not.toHaveBeenCalled();
    expect(scanner.start).not.toHaveBeenCalled();
    expect(scanner.stop).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  test('re-enabling an unsubscribed hook starts a fresh scan', async () => {
    const renderer = await mountHost(true);
    await act(async () => {
      renderer.update(createElement(DiscoveryHost, { enabled: false }));
    });
    expect(scanner.stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(createElement(DiscoveryHost, { enabled: true }));
    });
    expect(scanner.subscribe).toHaveBeenCalledTimes(2);
    expect(scanner.start).toHaveBeenCalledTimes(2);
    expect(scanner.stop).toHaveBeenCalledTimes(1);
  });

  test('an explicit rescan still restarts the scan', async () => {
    const renderer = await mountHost(true);
    expect(scanner.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      hookResult.rescan();
    });
    expect(scanner.stop).toHaveBeenCalledTimes(1);
    expect(scanner.start).toHaveBeenCalledTimes(2);
    await unmount(renderer);
    expect(scanner.stop).toHaveBeenCalledTimes(2);
  });
});