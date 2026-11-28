// ─── ExternalLink must keep the caller's press handler ───────────────────────
// The component spread `rest` before its own onPress, so a caller's handler was
// replaced with no error. Its browser open also awaited with no catch, turning
// a refused browser into an unhandled rejection. Both are pinned here.

jest.mock('expo-router', () => ({ Link: 'Link' }));

const mockOpenBrowser = jest.fn();

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: (...args: unknown[]) => mockOpenBrowser(...args),
  WebBrowserPresentationStyle: { AUTOMATIC: 'automatic' },
}));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ExternalLink } from '@/components/external-link';

afterEach(() => {
  mockOpenBrowser.mockReset();
});

async function pressLink(onPress?: (event: unknown) => void) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ExternalLink, {
        href: 'https://example.com',
        onPress,
      } as never),
    );
  });
  const link = renderer.root.findAll((node) => String(node.type) === 'Link')[0];
  expect(link).toBeDefined();
  const event = { preventDefault: jest.fn() };
  let result: unknown = undefined;
  await act(async () => {
    result = await link.props.onPress(event);
  });
  renderer.unmount();
  return { event, result };
}

test("the caller's onPress runs and the native link still opens the browser", async () => {
  mockOpenBrowser.mockResolvedValue(undefined);
  const caller = jest.fn();

  const { event } = await pressLink(caller);

  expect(caller).toHaveBeenCalledTimes(1);
  expect(caller.mock.calls[0][0]).toBe(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(mockOpenBrowser).toHaveBeenCalledWith('https://example.com', {
    presentationStyle: 'automatic',
  });
});

test('a refused browser open is handled, not left as an unhandled rejection', async () => {
  mockOpenBrowser.mockRejectedValue(new Error('no browser'));

  await expect(pressLink(jest.fn())).resolves.toBeDefined();
});
