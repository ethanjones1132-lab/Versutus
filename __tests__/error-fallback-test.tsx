// ─── The crash screen ───────────────────────────────────────────────────────
// Expo Router hands a thrown render error to the exported ErrorBoundary, and
// on a release build there is no redbox to read: without a plain screen of our
// own the app just sits on a blank stage. This is that screen — it names the
// failure, offers the one action that can help (retry), and lets the operator
// carry the message and stack out to a report by hand.

// The UI barrel is stood in as host components so the test does not drag
// skia, reanimated and the safe-area provider in behind `Screen`.
jest.mock('@/components/ui', () => ({
  Screen: 'Screen',
  Text: 'Text',
  Button: 'Button',
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import * as Clipboard from 'expo-clipboard';
import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ErrorFallback } from '@/components/error-fallback';

// Stand-in host name for the mocked Button; not a real JSX intrinsic, so it
// needs the same ElementType cast the glass-surface test uses.
const BUTTON = 'Button' as ElementType;

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

let renderer: ReactTestRenderer;

async function mount(retry: () => void, error: Error): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ErrorFallback, { error, retry }));
  });
}

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

test('the screen names the failure instead of showing a blank stage', async () => {
  await mount(jest.fn(), new Error('GatewayProvider read a null session'));

  const shown = stringsIn(renderer.toJSON());
  expect(shown).toContain('Something went wrong');
  expect(shown).toContain('GatewayProvider read a null session');
});

test('Try again calls the retry the boundary was given', async () => {
  const retry = jest.fn();
  await mount(retry, new Error('boom'));

  const again = renderer.root
    .findAllByType(BUTTON)
    .find((button) => button.props.label === 'Try again');
  expect(again).toBeDefined();

  await act(async () => {
    again?.props.onPress();
  });
  expect(retry).toHaveBeenCalledTimes(1);
});

test('Copy details carries the message and the stack to the clipboard', async () => {
  const error = new Error('teardown exploded');
  error.stack = 'Error: teardown exploded\n    at teardown (chat.tsx:12)';
  await mount(jest.fn(), error);

  const copy = renderer.root
    .findAllByType(BUTTON)
    .find((button) => button.props.label === 'Copy details');
  expect(copy).toBeDefined();

  await act(async () => {
    copy?.props.onPress();
  });

  expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
  const copied = (Clipboard.setStringAsync as jest.Mock).mock.calls[0][0] as string;
  expect(copied).toContain('teardown exploded');
  expect(copied).toContain('chat.tsx:12');
});

test('an error with no stack still copies its message rather than nothing', async () => {
  await mount(jest.fn(), new Error('bare failure'));

  const copy = renderer.root
    .findAllByType(BUTTON)
    .find((button) => button.props.label === 'Copy details');
  await act(async () => {
    copy?.props.onPress();
  });

  expect((Clipboard.setStringAsync as jest.Mock).mock.calls[0][0]).toContain('bare failure');
});
