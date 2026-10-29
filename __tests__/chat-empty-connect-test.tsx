// VS-030: the first-run "Connect to gateway" did nothing visible when no local
// gateway was running. The attempt was inferred from an observed `attempting`
// true -> false edge, but the screen's press threw the promise `retryAutoConnect`
// returned away behind a bare `void`: a quick cycle, a batched update, or a
// failure before the phase reached `searching` never produced an observed
// phase. The control then stayed pending with its lock held, and the failed
// state and setup route never appeared. These mount both platform empty states
// and pin the promise-owned contract: resolve or reject ends the attempt,
// `attempting` may only hold the control pending, and a finished attempt with
// no gateway leaves the idle screen and offers setup.

declare const __dirname: string;

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

jest.mock('@/components/brand/versutus-mark', () => ({ VersutusMark: 'VersutusMark' }));

// The shared primitives are leaves here: the test reads their labels and
// presses, never their pixels.
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Text: 'Text',
}));

// SwiftUI primitives are native; the iOS file only needs the description it
// hands ContentUnavailableView and the button labels it renders.
jest.mock('@expo/ui/swift-ui', () => ({
  Button: 'SwiftButton',
  ContentUnavailableView: 'ContentUnavailableView',
  Host: 'Host',
}));

import { createElement, type ComponentType, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  CHAT_EMPTY_FAILED_COPY,
  CHAT_EMPTY_PENDING_COPY,
} from '@/components/chat/chat-empty-connect';

type EmptyProps = {
  title: string;
  description: string;
  onConnect: () => void | Promise<unknown>;
  onGoHome: () => void;
  onSettings?: () => void;
  onSetup?: () => void;
  attempting?: boolean;
};

type EmptyComponent = ComponentType<EmptyProps>;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readChatScreen(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/**
 * The platform files are loaded by their exact filenames: this project runs the
 * platform-agnostic jest-expo preset, whose resolution a bare
 * `chat-empty-state` specifier would settle on the shared `.tsx` only, so the
 * iOS implementation has to be named exactly to be mounted at all.
 */
function loadEmpty(modulePath: string): EmptyComponent {
  return (jest.requireActual(modulePath) as { ChatEmptyState: EmptyComponent }).ChatEmptyState;
}

const PLATFORMS: { name: string; Component: EmptyComponent }[] = [
  { name: 'shared', Component: loadEmpty('@/components/chat/chat-empty-state.tsx') },
  { name: 'ios', Component: loadEmpty('@/components/chat/chat-empty-state.ios.tsx') },
];

const IDLE_COPY = 'Versutus will connect to your PC automatically. You can also tap below.';

const mockConnect = jest.fn();
const mockGoHome = jest.fn();
const mockSettings = jest.fn();
const mockSetup = jest.fn();

let renderer: ReactTestRenderer | null = null;

function emptyProps(overrides: Partial<EmptyProps> = {}): EmptyProps {
  return {
    title: 'Not connected yet',
    description: IDLE_COPY,
    onConnect: mockConnect,
    onGoHome: mockGoHome,
    onSettings: mockSettings,
    onSetup: mockSetup,
    ...overrides,
  };
}

/** A promise whose settle this test decides, to hold a press pending. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mount(Component: EmptyComponent, overrides: Partial<EmptyProps> = {}): Promise<ReactTestRenderer> {
  let created!: ReactTestRenderer;
  await act(async () => {
    created = create(createElement(Component, emptyProps(overrides)));
  });
  renderer = created;
  return created;
}

async function unmount(view: ReactTestRenderer): Promise<void> {
  if (renderer === view) renderer = null;
  await act(async () => {
    view.unmount();
  });
}

/** A pressable by its label, on either this empty state's shared or SwiftUI button. */
function control(view: ReactTestRenderer, label: string) {
  const types = ['Button' as ElementType, 'SwiftButton' as ElementType];
  for (const type of types) {
    const found = view.root.findAllByType(type).find((node) => node.props.label === label);
    if (found) return found;
  }
  return undefined;
}

async function press(view: ReactTestRenderer, label: string): Promise<void> {
  const target = control(view, label);
  expect(target).toBeDefined();
  await act(async () => {
    target?.props.onPress();
  });
}

/** Every sentence this empty state shows, shared Text or native description. */
function copy(view: ReactTestRenderer): string {
  const chunks: string[] = [];
  for (const node of view.root.findAllByType('Text' as ElementType)) {
    if (typeof node.props.children === 'string') chunks.push(node.props.children);
  }
  for (const node of view.root.findAllByType('ContentUnavailableView' as ElementType)) {
    if (typeof node.props.description === 'string') chunks.push(node.props.description);
  }
  return chunks.join(' ');
}

beforeEach(() => {
  jest.resetAllMocks();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.restoreAllMocks();
});

describe.each(PLATFORMS)('$name empty state', ({ Component }) => {
  test('a resolving press with no observed phase ends failed and offers setup', async () => {
    mockConnect.mockResolvedValue(undefined);
    const view = await mount(Component);

    await press(view, 'Connect to gateway');

    expect(mockConnect).toHaveBeenCalledTimes(1);
    // The attempt finished with no gateway: the idle sentence is gone, not
    // still sitting there while a pending lock spins forever.
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);
    expect(copy(view)).not.toContain(IDLE_COPY);
    expect(control(view, 'Connect to gateway')).toBeUndefined();
    expect(control(view, 'Try again')).toBeDefined();
    expect(control(view, 'Set up PC address')).toBeDefined();
    // The quiet doors survive the failure.
    expect(control(view, 'Go to Home')).toBeDefined();
    expect(control(view, 'Settings')).toBeDefined();

    await press(view, 'Set up PC address');
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockGoHome).not.toHaveBeenCalled();
    expect(mockSettings).not.toHaveBeenCalled();
  });

  test('a rejecting press ends failed as well', async () => {
    mockConnect.mockRejectedValue(new Error('no gateway on this network'));
    const view = await mount(Component);

    await press(view, 'Connect to gateway');

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);
    expect(copy(view)).not.toContain(IDLE_COPY);
    expect(control(view, 'Try again')).toBeDefined();

    await press(view, 'Set up PC address');
    expect(mockSetup).toHaveBeenCalledTimes(1);
  });

  test('a second press while the attempt is pending starts nothing', async () => {
    const attempt = deferred();
    mockConnect.mockReturnValue(attempt.promise);
    const view = await mount(Component);

    await press(view, 'Connect to gateway');
    expect(copy(view)).toContain(CHAT_EMPTY_PENDING_COPY);

    await press(view, 'Connect to gateway');
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      attempt.resolve();
    });
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);
  });

  test('Try again starts a fresh attempt from the failed state', async () => {
    mockConnect.mockResolvedValueOnce(undefined);
    const view = await mount(Component);
    await press(view, 'Connect to gateway');
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);

    const second = deferred();
    mockConnect.mockReturnValueOnce(second.promise);
    await press(view, 'Try again');

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(copy(view)).toContain(CHAT_EMPTY_PENDING_COPY);

    await act(async () => {
      second.resolve();
    });
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);
  });

  test('a caller that omits attempting still gets pending and failed from the promise', async () => {
    const attempt = deferred();
    mockConnect.mockReturnValue(attempt.promise);
    // No `attempting` at all: nothing but the press's own promise reports.
    const view = await mount(Component, { attempting: undefined });

    await press(view, 'Connect to gateway');
    expect(copy(view)).toContain(CHAT_EMPTY_PENDING_COPY);

    await act(async () => {
      attempt.resolve();
    });
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);
  });

  test('the automatic cycle holds the control pending but never invents a failure', async () => {
    const view = await mount(Component, { attempting: true });

    // A press during the screen's own searching cycle is not a second attempt.
    await press(view, 'Connect to gateway');
    expect(mockConnect).not.toHaveBeenCalled();

    // The cycle ending on its own is not a press ending: no failed state.
    await act(async () => {
      view.update(createElement(Component, emptyProps({ attempting: false })));
    });
    expect(copy(view)).not.toContain(CHAT_EMPTY_FAILED_COPY);
    expect(copy(view)).toContain(IDLE_COPY);
    expect(control(view, 'Connect to gateway')).toBeDefined();
  });

  test('a void callback keeps the legacy caller usable without inventing failure', async () => {
    // Terminal intentionally fires retryAutoConnect without returning its promise.
    // No completion signal means this shared control cannot infer a failure.
    mockConnect.mockReturnValue(undefined);
    const view = await mount(Component);
    await press(view, 'Connect to gateway');
    expect(copy(view)).toContain(IDLE_COPY);
    expect(copy(view)).not.toContain(CHAT_EMPTY_FAILED_COPY);
    expect(control(view, 'Try again')).toBeUndefined();
    await press(view, 'Connect to gateway');
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  test('a synchronous throw from the press ends the attempt instead of spinning', async () => {
    mockConnect.mockImplementation(() => {
      throw new Error('not even a promise');
    });
    const view = await mount(Component);

    await press(view, 'Connect to gateway');

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(copy(view)).toContain(CHAT_EMPTY_FAILED_COPY);
  });

  test('an attempt that settles after unmount neither warns nor writes state', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempt = deferred();
    mockConnect.mockReturnValue(attempt.promise);
    const view = await mount(Component);
    await press(view, 'Connect to gateway');

    await unmount(view);
    await act(async () => {
      attempt.resolve();
    });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

/**
 * The mounted control proves the press calls onSetup; the screen's wiring is
 * what makes that press land on the setup route, so the failed first attempt
 * leads somewhere instead of ending on the empty screen.
 */
test('the screen wires the failed attempt’s setup control to onboarding', () => {
  const empty = readChatScreen().match(/<ChatEmptyState[\s\S]*?\/>/)?.[0] ?? '';
  expect(empty).toContain("onSetup={() => router.push('/onboarding')}");
});

