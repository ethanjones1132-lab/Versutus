// ─── Diagnostics: Recent failures ──────────────────────────────────────────
// The Runtime environment card says what the engine can do; this section says
// what actually went wrong on this phone. A log nobody can read is the same as
// no log, so the section has to load on arrival, admit an empty state honestly
// rather than rendering a blank card, and let the operator clear what they have
// already read. The runtime environment card above it must keep working.

jest.mock('@/components/ui', () => ({
  Screen: 'Screen',
  Card: 'Card',
  Badge: 'Badge',
  Button: 'Button',
  Text: 'Text',
}));

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ activeGateway: { kind: 'custom', url: 'http://gate.test' } }),
}));

jest.mock('@/lib/diagnostics/failure-log', () => ({
  loadFailures: jest.fn(async () => []),
  clearFailures: jest.fn(async () => undefined),
}));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewayDiagnosticsScreen from '@/app/gateway/diagnostics';
import { clearFailures, loadFailures, type FailureEntry } from '@/lib/diagnostics/failure-log';

// Stand-in host name for the mocked Button; not a real JSX intrinsic, so it
// needs an ElementType cast the way the glass-surface test does.
const BUTTON = 'Button' as ElementType;
const BADGE = 'Badge' as ElementType;

function entry(patch: Partial<FailureEntry> = {}): FailureEntry {
  return {
    at: Date.now(),
    kind: 'js-error',
    message: 'gateway socket closed',
    count: 1,
    ...patch,
  };
}

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

/** Every control label on the screen — the mock keeps them in props. */
function labels(): string[] {
  return renderer.root
    .findAll((node) => node.type === BUTTON || node.type === BADGE)
    .map((node) => String(node.props.label));
}

let renderer: ReactTestRenderer;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(GatewayDiagnosticsScreen));
  });
}

function press(label: string): Promise<void> {
  const button = renderer.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === label);
  expect(button).toBeDefined();
  return act(async () => {
    button?.props.onPress();
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

test('an empty log says so rather than rendering a card with nothing in it', async () => {
  await mount();

  const shown = stringsIn(renderer.toJSON());
  expect(shown).toContain('Recent failures');
  expect(shown).toContain('No failures recorded');
  expect(loadFailures).toHaveBeenCalledTimes(1);
  expect(shown).not.toContain('gateway socket closed');
});

test('a recorded failure is listed with its time, kind and repeat count', async () => {
  (loadFailures as jest.Mock).mockResolvedValue([
    entry({ kind: 'unhandled-rejection', message: 'ECONNREFUSED', count: 12 }),
    entry({ kind: 'render', message: 'GatewayProvider read a null session' }),
  ]);

  await mount();

  const shown = stringsIn(renderer.toJSON());
  expect(shown).toContain('Recent failures');
  expect(shown).toContain('just now · unhandled-rejection');
  expect(shown).toContain('ECONNREFUSED');
  expect(labels()).toContain('×12');
  expect(shown).toContain('GatewayProvider read a null session');
  expect(shown).not.toContain('No failures recorded');
  // A single occurrence carries no count badge — one is not a repeat.
  expect(labels()).not.toContain('×1');
});

test('Clear empties the log and the list', async () => {
  (loadFailures as jest.Mock).mockResolvedValue([entry()]);
  await mount();
  expect(stringsIn(renderer.toJSON())).toContain('gateway socket closed');

  await press('Clear');

  expect(clearFailures).toHaveBeenCalledTimes(1);
  const shown = stringsIn(renderer.toJSON());
  expect(shown).not.toContain('gateway socket closed');
  expect(shown).toContain('No failures recorded');
});

test('the Runtime environment card and the live check above it are untouched', async () => {
  await mount();

  const shown = stringsIn(renderer.toJSON());
  expect(shown).toContain('Runtime environment');
  expect(labels()).toContain('Run live check');
  expect(labels()).toContain('No known breakage');
});
