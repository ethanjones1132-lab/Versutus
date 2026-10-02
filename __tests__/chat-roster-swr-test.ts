import { readCached, writeCached } from '@/lib/cache/swr-store';
import {
  rosterRowsAfterRead,
  rosterRowsForGateway,
  rosterRowsFromCache,
} from '@/components/chat/chat-screen';
import { type PublicBot, type RosterRow } from '@/lib/gateway/bots';
import { applyRosterRead } from '@/lib/gateway/roster-read';

// chat-screen pulls in the whole visual tree (reanimated, skia, expo-router) and
// none of it is what these tests are about. The roster rules below are exported
// from the screen itself so they are tested where they run, not in a copy of
// them. Every stand-in is built INSIDE its factory: chat-screen is imported at
// the top of this file, so anything a factory closes over would not exist yet.
jest.mock('react-native-reanimated', () => {
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_target, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  const easing = new Proxy(
    { bezier: () => (value: number) => value, ease: () => (value: number) => value },
    {
      get: (target, key) =>
        key in target ? (target as unknown as Record<string | symbol, unknown>)[key] : () => (value: number) => value,
    },
  ) as Record<string, unknown>;
  return {
    Easing: easing,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    View: 'Animated.View',
    Text: 'Animated.Text',
    ScrollView: 'Animated.ScrollView',
    createAnimatedComponent: (component: unknown) => component,
    runOnJS: (fn: unknown) => fn,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain },
    Layout: { duration: chain, easing: chain },
    LinearTransition: { duration: chain, easing: chain },
    Keyframe: class {
      duration() {
        return this;
      }

      easing() {
        return this;
      }
    },
  };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ setOptions: jest.fn() }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/components/avatar/look-studio-sheet', () => ({ LookStudioSheet: 'LookStudioSheet' }));
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: 'Canvas',
  Fill: 'Fill',
  Shader: 'Shader',
  Skia: {},
  Group: 'Group',
  Circle: 'Circle',
  Path: 'Path',
  LinearGradient: 'LinearGradient',
  SweepGradient: 'SweepGradient',
  useClock: () => 0,
  usePathValue: () => ({ current: null }),
}));

const mockBacking = new Map<string, string>();

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: async (key: string) => mockBacking.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockBacking.set(key, value);
    },
    removeItem: async (key: string) => {
      mockBacking.delete(key);
    },
    getAllKeys: async () => [...mockBacking.keys()],
    multiRemove: async (keys: string[]) => {
      for (const key of keys) mockBacking.delete(key);
    },
  },
}));

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const chatScreen = nodeFs
  .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

const BOTS: PublicBot[] = [
  { id: 'researcher', displayName: 'Researcher', routable: true },
  { id: 'scout', displayName: 'Scout', routable: false, routingIssue: 'listen_key_missing' },
];

const OTHER_BOTS: PublicBot[] = [{ id: 'auditor', displayName: 'Auditor', routable: true }];

/** The rows a gateway really has, as the screen's own row builder makes them. */
function rowsFor(gatewayId: string | undefined, bots: PublicBot[]): RosterRow[] {
  return applyRosterRead(rosterRowsForGateway([{ kind: 'configurable' }], undefined, gatewayId), { ok: true, bots });
}

const ids = (rows: RosterRow[]): string[] =>
  rows.map((row) => (row.kind === 'bot' ? row.bot.id : row.kind));

beforeEach(() => {
  mockBacking.clear();
});

describe('a cached roster paints with no network at all', () => {
  test('the copy on disk becomes rows the moment the screen mounts', async () => {
    await writeCached('roster', 'gw-cache', 'bots', BOTS);

    const cached = await readCached<PublicBot[]>('roster', 'gw-cache', 'bots');

    // Exactly what the mount paint does: no live rows yet, so the remembered
    // inventory is what the operator sees.
    const rows = rosterRowsFromCache([{ kind: 'configurable' }], undefined, 'gw-cache', cached!.value);
    expect(ids(rows)).toEqual(['configurable', 'researcher', 'scout']);
  });

  test('a gateway with no copy paints nothing and keeps waiting', async () => {
    expect(await readCached<PublicBot[]>('roster', 'gw-never-read', 'bots')).toBeNull();
  });
});

describe('a failed re-read keeps the rows and only names itself', () => {
  test('the last good rows survive a refused read after a good one', () => {
    // SPD-6/UI-1: the mount path used to answer a blip with
    // `setRosterRows([{ kind: 'configurable' }])`, which threw away bots the
    // operator was looking at. `applyRosterRead` is the rule pull-to-refresh
    // already followed, and it is what the mount path now uses.
    const good = rowsFor('gw-a', BOTS);
    const afterBlip = applyRosterRead(good, { ok: false });
    expect(afterBlip).toEqual(good);
    expect(afterBlip.some((row) => row.kind === 'bot')).toBe(true);
  });

  test('a first read that produced no rows at all still falls back to the navigation row', () => {
    expect(applyRosterRead([{ kind: 'configurable' }], { ok: false })).toEqual([{ kind: 'configurable' }]);
  });

  test('an empty-but-ok read is believed — it is the host telling the truth', () => {
    expect(applyRosterRead(rowsFor('gw-a', BOTS), { ok: true, bots: [] })).toEqual([{ kind: 'configurable' }]);
  });
});

describe('rows belong to the gateway they came from', () => {
  test('a switch resets the rows before anything reads', () => {
    const fromA = rowsFor('gw-a', BOTS);
    expect(ids(rosterRowsForGateway(fromA, 'gw-a', 'gw-b'))).toEqual(['configurable']);
    // The same gateway keeps them, which is the whole point of "last good".
    expect(rosterRowsForGateway(fromA, 'gw-a', 'gw-a')).toBe(fromA);
  });

  test('a disconnect keeps them — the same gateway is coming back', () => {
    // `activeGateway` is nulled on disconnect and set to the same id on
    // reconnect. Resetting there threw the roster away twice, which is what left
    // a Bot Chat with no display name and no pinned model after a blip.
    const rows = rowsFor('gw-a', BOTS);
    expect(rosterRowsForGateway(rows, 'gw-a', undefined)).toBe(rows);
    expect(ids(rosterRowsForGateway(rows, 'gw-a', undefined))).toEqual(['configurable', 'researcher', 'scout']);
  });

  test('a refused read on the new gateway never shows the old one\'s Bots', () => {
    // The failure UI-1 introduced a rule for is also the one a switch makes
    // dangerous: B's read fails, and the rows A left behind are not B's. This is
    // the exact call the mount effect's `.catch` makes.
    const fromA = rowsFor('gw-a', BOTS);
    const onB = rosterRowsAfterRead(fromA, 'gw-a', 'gw-b', { ok: false });
    expect(ids(onB)).toEqual(['configurable']);
    expect(onB.some((row) => row.kind === 'bot')).toBe(false);
  });

  test('a refused read on the SAME gateway still keeps its rows', () => {
    const fromA = rowsFor('gw-a', BOTS);
    expect(rosterRowsAfterRead(fromA, 'gw-a', 'gw-a', { ok: false })).toBe(fromA);
  });

  test("the new gateway's remembered roster paints over the old gateway's rows", () => {
    const fromA = rowsFor('gw-a', BOTS);
    const painted = rosterRowsFromCache(fromA, 'gw-a', 'gw-b', OTHER_BOTS);
    expect(ids(painted)).toEqual(['configurable', 'auditor']);
    expect(ids(painted)).not.toContain('researcher');
  });

  test("a remembered copy still never trades away this gateway's live rows", () => {
    const live = rowsFor('gw-a', BOTS);
    const painted = rosterRowsFromCache(live, 'gw-a', 'gw-a', OTHER_BOTS);
    expect(painted).toBe(live);
    expect(ids(painted)).toEqual(['configurable', 'researcher', 'scout']);
  });

  test('a good read on the new gateway replaces the old one\'s rows', () => {
    const fromA = rowsFor('gw-a', BOTS);
    const read = rosterRowsAfterRead(fromA, 'gw-a', 'gw-b', { ok: true, bots: OTHER_BOTS });
    expect(ids(read)).toEqual(['configurable', 'auditor']);
  });

  test('a switch back to a gateway that still has a copy paints that copy', async () => {
    await writeCached('roster', 'gw-a', 'bots', BOTS);
    const cached = await readCached<PublicBot[]>('roster', 'gw-a', 'bots');
    const onB = rowsFor('gw-b', OTHER_BOTS);
    const backOnA = rosterRowsFromCache(onB, 'gw-b', 'gw-a', cached!.value);
    expect(ids(backOnA)).toEqual(['configurable', 'researcher', 'scout']);
  });
});

describe('chat-screen wires the roster that way', () => {
  test('the mount path paints the cached roster before it reads', () => {
    expect(chatScreen).toContain("import { readCached, writeCached } from '@/lib/cache/swr-store';");
    const paint = chatScreen.match(
      /void readCached<PublicBot\[\]>\('roster', gatewayId, 'bots'\)[\s\S]*?\n  \}, \[surface\.kind, activeGateway\?\.id\]\);/,
    )?.[0];
    expect(paint).toBeDefined();
    // The effect it lives in is gated on the roster surface and a gateway.
    const effect = chatScreen.match(
      /const gatewayId = activeGateway\?\.id;\s*\n    if \(surface\.kind !== 'roster' \|\| !gatewayId\) return;[\s\S]*?void readCached<PublicBot\[\]>\('roster', gatewayId, 'bots'\)[\s\S]*?\n  \}, \[surface\.kind, activeGateway\?\.id\]\);/,
    )?.[0];
    expect(effect).toBeDefined();
    expect(effect).toContain('if (surface.kind !== \'roster\' || !gatewayId) return;');
    // Cached rows clear the loading flag: the screen is showing, not waiting.
    expect(paint).toContain('setRosterLoading(false);');
    // Which gateway the rows came from is carried into the paint and the fold,
    // along with whether a live read has already answered for this gateway.
    expect(paint).toContain('const liveAnswered = rosterAnsweredRef.current === gatewayId;');
    expect(paint).toContain(
      'rosterRowsFromCache(previous, previousGatewayId, gatewayId, cached.value, liveAnswered)',
    );
  });

  test('a remembered roster never paints over an answer that already landed', () => {
    // The dangerous order: this device's storage read is slower than the Gate,
    // so the live roster arrives first and the remembered one lands last. An
    // empty-but-ok read leaves no Bot rows on screen, and a remembered copy
    // landing after it would put back Bots the host has deleted.
    const answered = rowsFor('gw-a', []);
    expect(answered).toEqual([{ kind: 'configurable' }]);
    expect(rosterRowsFromCache(answered, 'gw-a', 'gw-a', BOTS, true)).toBe(answered);
    expect(ids(rosterRowsFromCache(answered, 'gw-a', 'gw-a', BOTS, true))).not.toContain('researcher');

    // A REFUSED read is not an answer: the remembered roster is exactly what
    // SPD-5 wants beside the error, so it still paints.
    expect(ids(rosterRowsFromCache(answered, 'gw-a', 'gw-a', BOTS, false))).toEqual([
      'configurable',
      'researcher',
      'scout',
    ]);
  });

  test('every live roster read stamps the gateway it answered for', () => {
    // The cached paint and the read that can beat it live in different effects,
    // so the flag has to be a ref shared by both, set by every read that really
    // answers — not just the mount one.
    expect(chatScreen).toContain('const rosterAnsweredRef = useRef<string | undefined>(undefined);');
    const stamps = chatScreen.match(/rosterAnsweredRef\.current = (gatewayId|activeGateway\.id);/g) ?? [];
    expect(stamps).toHaveLength(3);
  });

  test('the rows are re-keyed when the active gateway changes', () => {
    const rekey = chatScreen.match(
      /const rosterRowsGatewayRef = useRef<string \| undefined>\(undefined\);[\s\S]*?\n  \}, \[activeGateway\?\.id\]\);/,
    )?.[0];
    expect(rekey).toBeDefined();
    // A disconnect is not a switch: `activeGateway` goes null and comes back
    // as the SAME profile, and re-keying on the way out wiped a good roster for
    // nothing.
    expect(rekey).toContain('if (!gatewayId) return;');
    expect(rekey).toContain('rosterRowsGatewayRef.current = gatewayId;');
    expect(rekey).toContain('setRosterRows((previous) => rosterRowsForGateway(previous, previousGatewayId, gatewayId))');
    // Neither the last gateway's error nor its "already read" state survives the
    // switch: the new gateway has not been read at all yet. The 20s throttle
    // absorbs a `status` flip, not a switch — this inventory is new information,
    // and nothing on screen answers for it yet.
    expect(rekey).toContain('setRosterError(undefined);');
    expect(rekey).toContain('setRosterLoading(true);');
    expect(rekey).toContain('rosterReadAtRef.current = null;');
    expect(rekey).toContain('rosterAnsweredRef.current = undefined;');
  });

  test('the mount read never collapses a good roster to the navigation row', () => {
    expect(chatScreen).not.toContain('setRosterRows([{ kind: \'configurable\' }])');
    const failure = chatScreen.match(/\.catch\(\(error: unknown\) => \{\s*if \(cancelled\) return;[\s\S]*?\}\);\s*\n    return \(\) => \{/)?.[0];
    expect(failure).toBeDefined();
    expect(failure).toContain('rosterRowsAfterRead(previous, previousGatewayId, gatewayId, { ok: false })');
    expect(failure).toContain('setRosterError(');
  });

  test('a good read becomes the copy whoever asked for it, create included', () => {
    const success = chatScreen.match(/\.then\(\(bots\) => \{[\s\S]*?\}\)\s*\n      \.catch\(/)?.[0];
    expect(success).toBeDefined();
    expect(success).toContain('setRosterRows(buildRoster(bots));');
    expect(success).toContain('setRosterError(undefined);');
    expect(success).toContain("writeCached('roster', gatewayId, 'bots', bots)");
    // The create/edit path reads the roster too; a cold start after a create
    // must not come back without the Bot that was just made. The read there is
    // guarded (a refused one names itself on the roster — BOT-3), so the shape
    // this pins is `listBots()` under a handler, not a bare await.
    const created = chatScreen.match(
      /const bots = await listBots\(\)[\s\S]*?if \(!target && bot\.routable\)/,
    )?.[0];
    expect(created).toBeDefined();
    expect(created).toContain("writeCached('roster', activeGateway.id, 'bots', bots)");
    // And it folds through the gateway key like every other roster read, so a
    // create's answer cannot paint under a gateway the operator has left (V-1).
    expect(created).toContain('rosterRowsAfterRead(previous, rosterRowsGatewayRef.current, activeGateway.id, {');
  });

  test('a status flip inside 20s does not re-read; an explicit refresh always does', () => {
    expect(chatScreen).toContain('const ROSTER_REVALIDATE_MS = 20_000;');
    expect(chatScreen).toContain('const rosterReadAtRef = useRef<{ gatewayId: string; at: number } | null>(null);');
    const revalidate = chatScreen.match(
      /const lastRead = rosterReadAtRef\.current;[\s\S]*?rosterReadAtRef\.current = \{ gatewayId, at: Date\.now\(\) \};/,
    )?.[0];
    expect(revalidate).toBeDefined();
    expect(revalidate).toContain(
      'lastRead.gatewayId === gatewayId && Date.now() - lastRead.at < ROSTER_REVALIDATE_MS',
    );
    // Pull-to-refresh is a deliberate read: it is not behind the throttle, and it
    // folds through the same gateway key.
    const refresh = chatScreen.match(/const refreshRoster = useCallback\([\s\S]*?\n  \}, \[listBots, refreshGroups, activeGateway\?\.id\]\);/)?.[0];
    expect(refresh).toBeDefined();
    expect(refresh).toContain('listBots()');
    expect(refresh).toContain('rosterReadAtRef.current = { gatewayId, at: Date.now() };');
    expect(refresh).toContain("writeCached('roster', gatewayId, 'bots', read.bots)");
    expect(refresh).toContain('rosterRowsAfterRead(previous, previousGatewayId, gatewayId, read)');
  });

  test('the roster still hands the empty-state verdict the same loading flag', () => {
    // The roster distinguishes "not read yet" from "read and empty"; the
    // cached paint must not make a connected gateway look unread forever.
    expect(chatScreen).toMatch(/loading=\{rosterLoading && status === 'connected'\}/);
    expect(chatScreen).toMatch(/error=\{rosterError\}/);
  });
});
