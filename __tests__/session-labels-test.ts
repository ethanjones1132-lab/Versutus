// P3's pin/rename half (`FUTURE-ITEMS.md:523-531`): session pins and names
// are this DEVICE's, held in key-value storage keyed by gateway + session
// the way the command transcript is, because no gateway route can carry a
// rename. This suite pins both halves — the pure folds in
// `session-labels.ts` and the one blob they are persisted in.
//
// The honesty rules the copy has to keep: a blank rename clears the label
// rather than printing an empty row, and a stored blob that is not what it
// claims to be reads as no label at all, never a guess.

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  applySessionLabel,
  clearSessionLabel,
  clearSessionLabelsForGateway,
  dropSessionLabelsForGateway,
  loadSessionLabels,
  orderSessionsByLabel,
  saveSessionLabels,
  sessionLabelKey,
  sessionLabelsFromUnknown,
  sessionLabelTitle,
  type SessionLabel,
} from '@/lib/gateway/session-labels';
import { sessionListTitle } from '@/lib/gateway/session-list';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;

const GATE = 'gw-home';
const OTHER_GATE = 'gw-other';

const CREW = sessionLabelKey(GATE, 'ses_crew');
const LAB = sessionLabelKey(GATE, 'ses_lab');

describe('sessionLabelKey', () => {
  test('two sessions on one gateway do not share a key', () => {
    expect(sessionLabelKey(GATE, 'ses_a')).not.toBe(sessionLabelKey(GATE, 'ses_b'));
  });

  test('the same session id on two gateways does not share a key', () => {
    expect(sessionLabelKey(GATE, 'ses_a')).not.toBe(sessionLabelKey(OTHER_GATE, 'ses_a'));
  });

  test('a path-shaped session id is normalized into one flat key', () => {
    // A Hermes session key can be shaped like a path. The command transcript
    // normalizes the same separators; a key that kept them would read as a
    // nested location rather than one session's identity.
    const key = sessionLabelKey(GATE, 'agent/ses:1\\x');
    expect(key).not.toContain('/');
    expect(key).not.toContain('\\');
    expect(key.split(':')).toHaveLength(2);
  });
});

describe('applySessionLabel', () => {
  test('a pin on one session leaves another session alone', () => {
    const labels = applySessionLabel({}, CREW, { pinned: true });
    expect(labels).toEqual({ [CREW]: { pinned: true } });
    expect(labels[LAB]).toBeUndefined();
  });

  test('a rename lands under the session it was typed on', () => {
    const labels = applySessionLabel({}, CREW, { label: 'Crew chat' });
    expect(labels[CREW]).toEqual({ label: 'Crew chat' });
  });

  test('a patch merges — pinning a renamed session keeps the name', () => {
    let labels = applySessionLabel({}, CREW, { label: 'Crew chat' });
    labels = applySessionLabel(labels, CREW, { pinned: true });
    expect(labels[CREW]).toEqual({ pinned: true, label: 'Crew chat' });
  });

  test('a rename is trimmed before it is stored', () => {
    const labels = applySessionLabel({}, CREW, { label: '  Crew chat  ' });
    expect(labels[CREW]).toEqual({ label: 'Crew chat' });
  });

  test('a blank rename clears the name and keeps the pin', () => {
    let labels = applySessionLabel({}, CREW, { pinned: true, label: 'Crew chat' });
    labels = applySessionLabel(labels, CREW, { label: '   ' });
    expect(labels[CREW]).toEqual({ pinned: true });
  });

  test('a blank rename on a session with nothing else stored drops the key', () => {
    let labels = applySessionLabel({}, CREW, { label: 'Crew chat' });
    labels = applySessionLabel(labels, CREW, { label: '' });
    expect(labels[CREW]).toBeUndefined();
    expect(labels).toEqual({});
  });

  test('unpinning a renamed session keeps the name', () => {
    let labels = applySessionLabel({}, CREW, { pinned: true, label: 'Crew chat' });
    labels = applySessionLabel(labels, CREW, { pinned: false });
    expect(labels[CREW]).toEqual({ label: 'Crew chat' });
  });

  test('an unpin on a session with no label stores nothing at all', () => {
    // An entry holding only `pinned: false` is not a label; keeping it would
    // make an unlabelled session look labelled to every later read.
    const labels = applySessionLabel({}, CREW, { pinned: false });
    expect(labels[CREW]).toBeUndefined();
    expect(labels).toEqual({});
  });

  test('does not mutate the map it was given', () => {
    const before: Record<string, SessionLabel> = {};
    applySessionLabel(before, CREW, { pinned: true });
    expect(before).toEqual({});
  });
});

describe('clearSessionLabel', () => {
  test('clears a pin and a rename together', () => {
    const labels = clearSessionLabel({ [CREW]: { pinned: true, label: 'Crew chat' } }, CREW);
    expect(labels[CREW]).toBeUndefined();
    expect(labels).toEqual({});
  });

  test('clearing a session that carries no label returns the same map', () => {
    const labels: Record<string, SessionLabel> = { [CREW]: { pinned: true } };
    expect(clearSessionLabel(labels, LAB)).toBe(labels);
  });

  test('does not mutate the map it was given', () => {
    const before: Record<string, SessionLabel> = { [CREW]: { pinned: true } };
    clearSessionLabel(before, CREW);
    expect(before).toEqual({ [CREW]: { pinned: true } });
  });
});

describe('sessionLabelsFromUnknown', () => {
  test('a well-formed blob is read back field by field', () => {
    expect(sessionLabelsFromUnknown({ [CREW]: { pinned: true, label: 'Crew chat' } })).toEqual({
      [CREW]: { pinned: true, label: 'Crew chat' },
    });
  });

  test('a non-record reads as no labels at all', () => {
    expect(sessionLabelsFromUnknown(undefined)).toEqual({});
    expect(sessionLabelsFromUnknown(null)).toEqual({});
    expect(sessionLabelsFromUnknown('{"a":1}')).toEqual({});
    expect(sessionLabelsFromUnknown(7)).toEqual({});
    expect(sessionLabelsFromUnknown(true)).toEqual({});
    expect(sessionLabelsFromUnknown([{ pinned: true }])).toEqual({});
  });

  test('a non-boolean pin is not a pin', () => {
    expect(sessionLabelsFromUnknown({ [CREW]: { pinned: 'yes' } })).toEqual({});
    expect(sessionLabelsFromUnknown({ [CREW]: { pinned: 1 } })).toEqual({});
  });

  test('a non-string label is not a label', () => {
    expect(sessionLabelsFromUnknown({ [CREW]: { label: 7 } })).toEqual({});
    expect(sessionLabelsFromUnknown({ [CREW]: { label: null } })).toEqual({});
    expect(sessionLabelsFromUnknown({ [CREW]: { label: { text: 'Crew chat' } } })).toEqual({});
  });

  test('a blank label is not a label', () => {
    expect(sessionLabelsFromUnknown({ [CREW]: { label: '   ' } })).toEqual({});
  });

  test('an entry carrying neither is dropped, never an empty row', () => {
    expect(sessionLabelsFromUnknown({ [CREW]: {} })).toEqual({});
    expect(sessionLabelsFromUnknown({ [CREW]: 'Crew chat' })).toEqual({});
    expect(sessionLabelsFromUnknown({ [CREW]: null })).toEqual({});
  });

  test('a good entry beside a junk one keeps only the good one', () => {
    const parsed = sessionLabelsFromUnknown({
      [CREW]: { pinned: true, label: 'Crew chat' },
      [LAB]: { label: 42 },
    });
    expect(parsed).toEqual({ [CREW]: { pinned: true, label: 'Crew chat' } });
  });
});

describe('sessionLabelTitle', () => {
  test("the operator's rename wins over the gateway's own title", () => {
    expect(sessionLabelTitle('Session 4', { label: 'Crew chat' })).toBe('Crew chat');
  });

  test('a session with no label keeps the gateway title it always had', () => {
    expect(sessionLabelTitle('Crew chat', undefined)).toBe('Crew chat');
  });

  test('a pin with no rename keeps the gateway title', () => {
    expect(sessionLabelTitle('Crew chat', { pinned: true })).toBe('Crew chat');
  });

  test('a rename can name a session the gateway left untitled', () => {
    expect(sessionLabelTitle(undefined, { label: 'Night shift' })).toBe('Night shift');
    expect(sessionLabelTitle(null, { label: 'Night shift' })).toBe('Night shift');
  });

  test('a blank stored label cannot print an empty row', () => {
    expect(sessionLabelTitle('Crew chat', { label: '   ' })).toBe('Crew chat');
    expect(sessionLabelTitle(undefined, { label: '   ' })).toBe('Untitled');
  });

  test('a stored rename is printed trimmed', () => {
    expect(sessionLabelTitle('Session 4', { label: '  Crew chat  ' })).toBe('Crew chat');
  });

  test('with no label the fold is exactly the shipped gateway-title rule', () => {
    // What the chat header falls back to when the store holds nothing for the
    // thread — the shipped rule, not a second wording of it.
    expect(sessionLabelTitle('Session 4', undefined)).toBe(sessionListTitle('Session 4'));
    expect(sessionLabelTitle(undefined, undefined)).toBe(sessionListTitle(undefined));
    expect(sessionLabelTitle('   ', undefined)).toBe(sessionListTitle('   '));
  });
});

describe('orderSessionsByLabel', () => {
  const CREW_ROW = { id: 'ses_crew', title: 'Crew chat' };
  const LAB_ROW = { id: 'ses_lab', title: 'Lab notes' };
  const NIGHT_ROW = { id: 'ses_night', title: 'Night shift' };
  const READ_ORDER = [CREW_ROW, LAB_ROW, NIGHT_ROW];

  test('a pinned session leads the list', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_lab'), { pinned: true });
    expect(orderSessionsByLabel(READ_ORDER, labels, GATE).map((s) => s.id)).toEqual([
      'ses_lab',
      'ses_crew',
      'ses_night',
    ]);
  });

  test('pinned rows keep the read order among themselves', () => {
    let labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_night'), { pinned: true });
    labels = applySessionLabel(labels, sessionLabelKey(GATE, 'ses_crew'), { pinned: true });
    // The read listed crew before night, so crew still leads the pinned group.
    expect(orderSessionsByLabel(READ_ORDER, labels, GATE).map((s) => s.id)).toEqual([
      'ses_crew',
      'ses_night',
      'ses_lab',
    ]);
  });

  test('a list with nothing pinned comes back exactly as the read gave it', () => {
    expect(orderSessionsByLabel(READ_ORDER, {}, GATE)).toBe(READ_ORDER);
    const renamed = applySessionLabel({}, sessionLabelKey(GATE, 'ses_night'), {
      label: 'Night shift',
    });
    expect(orderSessionsByLabel(READ_ORDER, renamed, GATE)).toBe(READ_ORDER);
  });

  test('a rename alone never moves a row', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_night'), { label: 'Later' });
    expect(orderSessionsByLabel(READ_ORDER, labels, GATE).map((s) => s.id)).toEqual(
      READ_ORDER.map((s) => s.id),
    );
  });

  test("another gateway's pin does not move this gateway's rows", () => {
    // `sessionLabelKey` folds the gateway id in, so one gateway's pin is not
    // another's. The separator is what keeps `gw-1` from also matching `gw-10`.
    const other = applySessionLabel({}, sessionLabelKey('gw-10', 'ses_lab'), { pinned: true });
    expect(orderSessionsByLabel(READ_ORDER, other, 'gw-1')).toBe(READ_ORDER);
    const prefixed = applySessionLabel({}, sessionLabelKey(GATE, 'ses_lab'), { pinned: true });
    expect(orderSessionsByLabel(READ_ORDER, prefixed, GATE).map((s) => s.id)[0]).toBe('ses_lab');
  });

  test('a cleared pin is no pin, so the row goes back where the read had it', () => {
    let labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_lab'), { pinned: true });
    labels = applySessionLabel(labels, sessionLabelKey(GATE, 'ses_lab'), { pinned: false });
    expect(orderSessionsByLabel(READ_ORDER, labels, GATE)).toBe(READ_ORDER);
  });

  test('an unknown session id in the store moves nothing', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_gone'), { pinned: true });
    expect(orderSessionsByLabel(READ_ORDER, labels, GATE)).toBe(READ_ORDER);
  });

  test('without a gateway there is no key — the list is left alone', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_lab'), { pinned: true });
    expect(orderSessionsByLabel(READ_ORDER, labels, undefined)).toBe(READ_ORDER);
    expect(orderSessionsByLabel(READ_ORDER, labels, '')).toBe(READ_ORDER);
  });

  test('it does not rearrange the array it was given', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_lab'), { pinned: true });
    orderSessionsByLabel(READ_ORDER, labels, GATE);
    expect(READ_ORDER.map((s) => s.id)).toEqual(['ses_crew', 'ses_lab', 'ses_night']);
  });
});

describe('loadSessionLabels / saveSessionLabels', () => {
  const backing = new Map<string, string>();

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
  });

  test('a saved label set is what you get back after leaving the selector', async () => {
    await saveSessionLabels({ [CREW]: { pinned: true, label: 'Crew chat' } });
    await expect(loadSessionLabels()).resolves.toEqual({
      [CREW]: { pinned: true, label: 'Crew chat' },
    });
  });

  test('a missing blob loads as empty, not as a failure', async () => {
    await expect(loadSessionLabels()).resolves.toEqual({});
  });

  test('malformed storage loads as empty, not a throw', async () => {
    await saveSessionLabels({ [CREW]: { pinned: true } });
    const storedKey = mockSet.mock.calls[0]?.[0] as string;
    backing.set(storedKey, '{not-json');
    await expect(loadSessionLabels()).resolves.toEqual({});
  });

  test('a blob holding junk entries keeps only the honest ones', async () => {
    await saveSessionLabels({ [CREW]: { pinned: true } });
    const storedKey = mockSet.mock.calls[0]?.[0] as string;
    backing.set(
      storedKey,
      JSON.stringify({ [CREW]: { pinned: true }, [LAB]: { pinned: 'yes', label: 3 } }),
    );
    await expect(loadSessionLabels()).resolves.toEqual({ [CREW]: { pinned: true } });
  });

  test('a refused write does not throw — labelling must keep working', async () => {
    mockSet.mockRejectedValue(new Error('disk full'));
    await expect(saveSessionLabels({ [CREW]: { pinned: true } })).resolves.toBeUndefined();
  });

  test('a refused read does not throw — an unread label set is empty', async () => {
    mockGet.mockRejectedValue(new Error('disk full'));
    await expect(loadSessionLabels()).resolves.toEqual({});
  });
});

describe('dropSessionLabelsForGateway', () => {
  const GW_ONE = 'gw-1';
  const GW_TEN = 'gw-10';

  test("only the removed gateway's entries drop", () => {
    const labels: Record<string, SessionLabel> = {
      [sessionLabelKey(GATE, 'ses_crew')]: { pinned: true },
      [sessionLabelKey(OTHER_GATE, 'ses_crew')]: { label: 'Crew chat' },
    };
    expect(dropSessionLabelsForGateway(labels, GATE)).toEqual({
      [sessionLabelKey(OTHER_GATE, 'ses_crew')]: { label: 'Crew chat' },
    });
  });

  test('a pin and a rename on the removed gateway both go', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_crew'), {
      pinned: true,
      label: 'Crew chat',
    });
    expect(dropSessionLabelsForGateway(labels, GATE)).toEqual({});
  });

  test('a gateway whose id only shares a prefix survives', () => {
    // The trailing separator is what keeps `gw-1` from also clearing `gw-10`
    // — the transcript's own rule (`transcript.ts:59-61`).
    const labels: Record<string, SessionLabel> = {
      [sessionLabelKey(GW_ONE, 'ses_crew')]: { pinned: true },
      [sessionLabelKey(GW_TEN, 'ses_crew')]: { pinned: true },
    };
    expect(dropSessionLabelsForGateway(labels, GW_ONE)).toEqual({
      [sessionLabelKey(GW_TEN, 'ses_crew')]: { pinned: true },
    });
  });

  test('an id with nothing stored returns the same map', () => {
    const labels = applySessionLabel({}, sessionLabelKey(GATE, 'ses_crew'), { pinned: true });
    expect(dropSessionLabelsForGateway(labels, 'gw-absent')).toBe(labels);
  });

  test('does not mutate the map it was given', () => {
    const before = applySessionLabel({}, sessionLabelKey(GATE, 'ses_crew'), { pinned: true });
    dropSessionLabelsForGateway(before, GATE);
    expect(before).toEqual({ [sessionLabelKey(GATE, 'ses_crew')]: { pinned: true } });
  });
});

describe('clearSessionLabelsForGateway', () => {
  const backing = new Map<string, string>();

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
  });

  test("a deleted gateway's labels leave the blob and another gateway keeps its own", async () => {
    await saveSessionLabels({
      [sessionLabelKey(GATE, 'ses_crew')]: { pinned: true },
      [sessionLabelKey(OTHER_GATE, 'ses_lab')]: { label: 'Lab notes' },
    });
    await clearSessionLabelsForGateway(GATE);
    await expect(loadSessionLabels()).resolves.toEqual({
      [sessionLabelKey(OTHER_GATE, 'ses_lab')]: { label: 'Lab notes' },
    });
  });

  test('a gateway with nothing stored writes nothing back', async () => {
    await clearSessionLabelsForGateway('gw-absent');
    expect(mockSet).not.toHaveBeenCalled();
  });

  test('a refused write does not throw — deleting a gateway must keep working', async () => {
    mockSet.mockRejectedValue(new Error('disk full'));
    await expect(clearSessionLabelsForGateway(GATE)).resolves.toBeUndefined();
  });

  test('a refused read does not throw', async () => {
    mockGet.mockRejectedValue(new Error('disk full'));
    await expect(clearSessionLabelsForGateway(GATE)).resolves.toBeUndefined();
  });
});

describe('the profile-delete path', () => {
  test('a deleted gateway drops its labels where it drops its transcript', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    expect(src).toContain('clearTranscriptsForGateway(removedId)');
    expect(src).toContain('clearSessionLabelsForGateway(removedId)');
  });
});

describe('the child-profile sync path', () => {
  // A child profile retired by a manifest sync is a real, connectable gateway,
  // so its labels outlive it the same way a deleted profile's would. Both sync
  // call sites hand what they retired to the one helper, which clears the same
  // two stores the delete path clears.
  test('a retired child profile drops its labels where it drops its transcript', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    expect(src.match(/clearRetiredGatewayStores\(retirement\.removedIds\)/g)).toHaveLength(2);
    expect(src).toContain('clearTranscriptsForGateway(id)');
    expect(src).toContain('clearSessionLabelsForGateway(id)');
    // A sync that retired nothing is not a store call at all.
    expect(src).toContain('if (ids.length === 0) return;');
  });

  test('the retired profile leaves the app looking for another gateway', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const start = src.indexOf('const teardownRetiredActiveGateway = useCallback(');
    const end = src.indexOf('const attachClient = useCallback(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const teardown = src.slice(start, end);

    // The teardown ends in the delete path's own choice about the roster it
    // is left with, instead of settling on idle and leaving the operator to
    // reconnect by hand. A delete's teardown makes that choice; a retire is
    // the same teardown, so it makes it too.
    const handOff = teardown.indexOf('resumeAfterRetiredTeardownRef.current(remaining);');
    expect(handOff).toBeGreaterThan(-1);

    // A retire that took nothing the app is connected to hands nothing over:
    // the rule's early return stands above the hand-off.
    const rule = teardown.indexOf(
      'if (!retirementTookActiveGateway(removedIds, activeGatewayRef.current)) return;',
    );
    expect(rule).toBeGreaterThan(-1);
    expect(handOff).toBeGreaterThan(rule);

    // The choice is not spelled here: `runAutoConnect` is declared below this
    // callback, so it arrives through the ref.
    expect(teardown).not.toContain('runAutoConnect(');
    expect(teardown).not.toContain("applyConnectionPhase('searching')");
  });

  test('the choice is handed over by a ref, because runAutoConnect is declared below the teardown', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const declared = src.indexOf('const resumeAfterRetiredTeardownRef = useRef<');
    const teardown = src.indexOf('const teardownRetiredActiveGateway = useCallback(');
    const runAutoConnect = src.indexOf('const runAutoConnect = useCallback(');
    const assigned = src.indexOf('resumeAfterRetiredTeardownRef.current = resumeAfterRetiredTeardown;');

    expect(declared).toBeGreaterThan(-1);
    expect(assigned).toBeGreaterThan(-1);
    // Declared above the callback that reads it, so the ref is bound the first
    // time a retire can run...
    expect(declared).toBeLessThan(teardown);
    // ...and assigned once the callback it needs is in scope — the same
    // hand-off `scheduleAutoRetryRef` uses, and exactly one writer.
    expect(runAutoConnect).toBeGreaterThan(-1);
    expect(assigned).toBeGreaterThan(runAutoConnect);
    expect(src.match(/resumeAfterRetiredTeardownRef\.current = /g)).toHaveLength(1);
  });

  test('the ref is handed the delete path’s rule, and the delete path keeps its own', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    // The rule the retire asks: auto-connect on, and a profile left to search
    // for. `settingsRef` is what the file's other auto-connect choices read
    // (`scheduleAutoRetry`), so a stale render value cannot gate this.
    expect(src).toContain('const appSettings = settingsRef.current;');
    expect(src).toContain('if (appSettings.autoConnect && remaining.length > 0) {');
    expect(src).toContain('void runAutoConnect(appSettings, [...remaining], null);');
    // The delete path's own branch — the reference implementation this
    // mirrors, pinned beside it so the two cannot drift apart in silence.
    expect(src).toContain('if (settings.autoConnect && next.length > 0) {');
    expect(src).toContain('void runAutoConnect(settings, next, null);');
    // The promise the operator reads is the same one at both doors, pinned by
    // count so an edit to one path cannot leave the other saying something
    // else — a search the app is not running, or one it is.
    expect(src.match(/setProbeMessage\('Searching for another gateway…'\)/g)).toHaveLength(2);
    // Neither path promises a search the operator will not get: a delete with
    // auto-connect off still lands on idle, and a connect already in flight is
    // still never doubled up.
    expect(src).toContain("applyConnectionPhase('idle');");
    expect(src).toContain('if (autoConnectInFlightRef.current) return;');
  });

  test('both call sites clear before the roster drops the profile', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    const firstClear = src.indexOf('await clearRetiredGatewayStores(retirement.removedIds);');
    const firstSet = src.indexOf('setGateways(retirement.gateways);');
    const secondClear = src.indexOf(
      'await clearRetiredGatewayStores(retirement.removedIds);',
      firstClear + 1,
    );
    const secondSet = src.indexOf('setGateways(retirement.gateways);', firstSet + 1);
    expect(firstClear).toBeGreaterThan(-1);
    expect(firstSet).toBeGreaterThan(firstClear);
    expect(secondClear).toBeGreaterThan(-1);
    expect(secondSet).toBeGreaterThan(secondClear);
  });

  test('both call sites take the session down with the profile it is running on', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    // The retire runs on every manifest read, so it can take the profile the
    // app is connected to: the delete path reconciles the active connection
    // against what it dropped, and both sync call sites now apply that same
    // rule, through one shared teardown rather than two copies.
    expect(src.match(/const teardownRetiredActiveGateway = useCallback\(/g)).toHaveLength(1);
    // Both call sites hand over the roster the retire leaves behind as well as
    // the ids it took: the choice the teardown makes needs both.
    expect(src.match(/teardownRetiredActiveGateway\(retirement\.removedIds, retirement\.gateways\)/g)).toHaveLength(2);
    // The rule is asked about the LIVE active gateway, not a captured render
    // value — the same ref the provider's other request helpers read.
    expect(src).toContain('retirementTookActiveGateway(removedIds, activeGatewayRef.current)');

    // Stores away, then the session, then the roster — the delete path's own
    // order, at both call sites.
    const firstClear = src.indexOf('await clearRetiredGatewayStores(retirement.removedIds);');
    const firstTeardown = src.indexOf(
      'teardownRetiredActiveGateway(retirement.removedIds, retirement.gateways);',
    );
    const firstSet = src.indexOf('setGateways(retirement.gateways);');
    const secondClear = src.indexOf(
      'await clearRetiredGatewayStores(retirement.removedIds);',
      firstClear + 1,
    );
    const secondTeardown = src.indexOf(
      'teardownRetiredActiveGateway(retirement.removedIds, retirement.gateways);',
      firstTeardown + 1,
    );
    const secondSet = src.indexOf('setGateways(retirement.gateways);', firstSet + 1);
    expect(firstTeardown).toBeGreaterThan(firstClear);
    expect(firstSet).toBeGreaterThan(firstTeardown);
    expect(secondTeardown).toBeGreaterThan(secondClear);
    expect(secondSet).toBeGreaterThan(secondTeardown);
  });
});

describe('a label never leaves the device', () => {
  const source = () => readSource('src', 'lib', 'gateway', 'session-labels.ts');

  test('the module can reach no gateway transport and makes no request', () => {
    const src = source();
    expect(src).not.toContain('fetch(');
    // The strongest statement the file allows: nothing that talks to a
    // gateway is imported, so no pin or rename can be sent anywhere.
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(2);
    expect(imports.join('\n')).toContain("from '@/lib/storage/key-value'");
    expect(imports.join('\n')).toContain("from '@/lib/gateway/session-list'");
  });

  test("the Untitled fallback stays sessionListTitle's own, not a second rule", () => {
    const src = source();
    expect(src).toContain("from '@/lib/gateway/session-list'");
    expect(src).toContain('sessionListTitle(');
    expect(src).not.toContain("'Untitled'");
  });
});
