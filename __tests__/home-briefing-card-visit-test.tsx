// ─── Home digest: the visit's window, and an unreadable stamp ─────
// The digest's window used to be written only when the operator LEFT Home
// (app background, unmount), so while Home stayed focused the window was
// still the previous leave's: a run that finished in front of the operator
// printed under "While you were away", and the same lines re-printed on
// every return to Home. A refused stamp read had the opposite failure — it
// answered the same value as "never stamped", so the digest vanished with
// no error and no retry, which is indistinguishable from "nothing
// happened".
//
// Both are pinned here against the rendered card, with the storage seam
// real (`@/lib/home/last-seen` over a Map-backed AsyncStorage), so what is
// asserted is what the operator would see.

const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
  getAllKeys: jest.fn(async () => [...mockStore.keys()]),
  multiRemove: jest.fn(async () => undefined),
}));

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));

// tokens.ts reads Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

const mockGateway = {
  activeGateway: { id: 'gw-1' } as { id: string } | null,
  runs: [] as ActivityRun[],
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    activeGateway: mockGateway.activeGateway,
    activityRunsForActiveGateway: mockGateway.runs,
  }),
}));

// The focus edge, under the test's control: the effect runs on mount, again
// whenever the card hands over a new one (a retry), and whenever the test
// calls `refocus()` — which is what returning to Home does, since the drawer
// keeps the screen mounted and so the state survives while the effect re-runs.
const mockFocus = {
  latest: null as null | (() => void),
  cleanup: null as null | (() => void),
};

jest.mock('expo-router', () => {
  const react = jest.requireActual('react') as typeof import('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      react.useEffect(() => {
        const run = () => {
          mockFocus.cleanup?.();
          mockFocus.cleanup = null;
          const cleanup = effect();
          mockFocus.cleanup = typeof cleanup === 'function' ? cleanup : null;
        };
        mockFocus.latest = run;
        run();
        return () => {
          mockFocus.cleanup?.();
          mockFocus.cleanup = null;
        };
      }, [effect]);
    },
  };
});

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { HomeBriefingCard } from '@/components/home-briefing-card';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAST_SEEN_KEY_PREFIX } from '@/lib/home/last-seen';
import type { ActivityRun } from '@/lib/gateway/runs';

const PRESSABLE = 'PressableScale' as ElementType;
const STAMP_KEY = `${LAST_SEEN_KEY_PREFIX}gw-1`;

/** The operator left at LEFT and opened Home a minute later. */
const LEFT = 1_757_400_000_000;
const ARRIVED = LEFT + 60_000;
/** A run that finished while they were away. */
const AWAY_FINISH = LEFT + 30_000;

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do the thing',
    status: 'complete',
    startedAt: LEFT - 60_000,
    finishedAt: AWAY_FINISH,
    events: [],
    ...overrides,
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

let renderer: ReactTestRenderer | undefined;
let clock = 0;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(HomeBriefingCard));
  });
}

/** The focus edge firing again — a return to Home inside one session. */
async function refocus(): Promise<void> {
  await act(async () => {
    mockFocus.latest?.();
  });
}

/**
 * A paint with the runs as they stand now — what the provider's own state
 * change does to a mounted card.
 */
async function repaint(): Promise<void> {
  await act(async () => {
    renderer?.update(createElement(HomeBriefingCard));
  });
}

beforeEach(() => {
  mockStore.clear();
  mockGateway.activeGateway = { id: 'gw-1' };
  mockGateway.runs = [];
  clock = ARRIVED;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('arriving stamps the window, so the next absence starts here', async () => {
  mockStore.set(STAMP_KEY, String(LEFT));
  mockGateway.runs = [run({ id: 'away', finishedAt: AWAY_FINISH })];

  await mount();

  // The digest for this visit is the window as it was on arrival...
  expect(stringsIn(renderer?.toJSON())).toContain('1 run finished');
  // ...and the stamp moves to this arrival exactly once, so the same line is
  // not waiting to be printed again.
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(STAMP_KEY, String(ARRIVED));
  expect(mockStore.get(STAMP_KEY)).toBe(String(ARRIVED));
});

test('lines shown on the first visit are not shown again on the second', async () => {
  mockStore.set(STAMP_KEY, String(LEFT));
  mockGateway.runs = [run({ id: 'away', finishedAt: AWAY_FINISH })];

  await mount();
  expect(stringsIn(renderer?.toJSON())).toContain('1 run finished');

  await refocus();

  // Nothing new finished between the two visits, so the card says nothing at
  // all rather than re-printing what the operator has already read.
  expect(renderer?.toJSON()).toBeNull();
});

test('a run that finishes during the visit is not labelled While you were away', async () => {
  mockStore.set(STAMP_KEY, String(LEFT));
  mockGateway.runs = [run({ id: 'away', finishedAt: AWAY_FINISH })];

  await mount();

  // It finishes while the card is up, and time moves on past it: the window is
  // this visit's own start, so an in-visit finish is not absence news.
  clock = ARRIVED + 90_000;
  mockGateway.runs = [
    mockGateway.runs[0],
    run({ id: 'in-visit', finishedAt: ARRIVED + 60_000 }),
  ];
  await repaint();

  const shown = stringsIn(renderer?.toJSON());
  expect(shown).toContain('1 run finished');
  expect(shown).toContain('While you were away');
  expect(shown).not.toContain('2 runs finished');

  // The next visit does report it — it was news, just not news from the
  // absence this card is describing.
  clock = ARRIVED + 120_000;
  await refocus();
  expect(stringsIn(renderer?.toJSON())).toContain('1 run finished');
});

test('a stamp this device cannot read says so and retries on tap', async () => {
  jest.useFakeTimers();
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('sqlite fault'));
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('sqlite fault'));
  mockGateway.runs = [run({ id: 'away', finishedAt: AWAY_FINISH })];

  await mount();
  await act(async () => {
    jest.advanceTimersByTime(1_000);
  });

  // Not nothing: the digest's absence is named, and offered a retry.
  const shown = stringsIn(renderer?.toJSON());
  expect(shown.join(' ')).toContain("Couldn't check what changed while you were away");
  expect(shown.join(' ')).toContain('tap to retry');

  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(String(LEFT));
  const retry = renderer?.root.findAllByType(PRESSABLE)[0];
  expect(retry).toBeDefined();
  await act(async () => {
    retry?.props.onPress();
  });

  expect(stringsIn(renderer?.toJSON())).toContain('1 run finished');
  jest.useRealTimers();
});

test('a never-stamped gateway still renders nothing', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockGateway.runs = [run({ id: 'away', finishedAt: AWAY_FINISH })];

  await mount();

  expect(renderer?.toJSON()).toBeNull();
  expect(stringsIn(renderer?.toJSON()).join(' ')).not.toContain('retry');
  // Nothing was ever stamped, so nothing is stamped now either.
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});
