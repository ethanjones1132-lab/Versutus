import { readSessionList } from '@/lib/gateway/session-list-read';
import {
  applySessionListRead,
  emptySessionList,
  nextSessionListLimit,
  sessionListMayHaveOlder,
  type SessionListState,
} from '@/lib/gateway/session-list';

const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
declare const __dirname: string;
const source = nodeFs.readFileSync(`${__dirname}/../src/context/gateway-provider.tsx`, 'utf8').replace(/\r\n/g, '\n');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let generation = 0;
  let state: SessionListState = emptySessionList();
  let limit = 20;
  let hasOlder = false;
  const read = (pending: Promise<{ id: string }[]>, requested: number) => {
    const captured = ++generation;
    return readSessionList(() => pending, () => captured === generation, (result) => {
      state = applySessionListRead(state, result);
      if (result.ok) {
        limit = requested;
        hasOlder = sessionListMayHaveOlder(result.sessions.length, requested);
      }
    });
  };
  return {
    read,
    switchScope: () => { ++generation; state = emptySessionList(); limit = 20; hasOlder = false; },
    snapshot: () => ({ state, limit, hasOlder }),
  };
}

test.each(['Bot', 'Gateway', 'CLI environment'])('an old %s session read cannot repopulate the selector', async () => {
  const h = harness();
  const old = deferred<{ id: string }[]>();
  const reading = h.read(old.promise, 20);
  h.switchScope();
  old.resolve([{ id: 'old-thread' }]);
  await reading;
  expect(h.snapshot()).toEqual({ state: emptySessionList(), limit: 20, hasOlder: false });
});

test('a slow open cannot overwrite a newer open', async () => {
  const h = harness();
  const old = deferred<{ id: string }[]>();
  const reading = h.read(old.promise, 20);
  await h.read(Promise.resolve([{ id: 'new-thread' }]), 20);
  old.resolve([{ id: 'old-thread' }]);
  await reading;
  expect(h.snapshot().state.sessions).toEqual([{ id: 'new-thread' }]);
});

test.each(['resolve', 'reject'] as const)('an old page that later %ss cannot change a new scope or its window', async (settle) => {
  const h = harness();
  const old = deferred<{ id: string }[]>();
  const reading = h.read(old.promise, 40);
  h.switchScope();
  await h.read(Promise.resolve([{ id: 'current-thread' }]), 20);
  if (settle === 'resolve') old.resolve(Array.from({ length: 40 }, (_, i) => ({ id: `old-${i}` })));
  else old.reject(new Error('old Gateway refused'));
  await reading;
  expect(h.snapshot()).toEqual({ state: { sessions: [{ id: 'current-thread' }], loaded: true, failed: false }, limit: 20, hasOlder: false });
});

test('reopening supersedes an in-flight wider page even in the same scope', async () => {
  const h = harness();
  const old = deferred<{ id: string }[]>();
  const reading = h.read(old.promise, 40);
  await h.read(Promise.resolve([{ id: 'fresh' }]), 20);
  old.resolve([{ id: 'old' }]);
  await reading;
  expect(h.snapshot().limit).toBe(20);
  expect(h.snapshot().state.sessions).toEqual([{ id: 'fresh' }]);
});

test('a current refusal preserves the last good list and marks it stale', async () => {
  const h = harness();
  await h.read(Promise.resolve([{ id: 'pinned-thread' }]), 20);
  await h.read(Promise.reject(new Error('Gateway refused')), 40);
  expect(h.snapshot().state).toEqual({ sessions: [{ id: 'pinned-thread' }], loaded: true, failed: true });
  expect(h.snapshot().limit).toBe(20);
});

test('a current first refusal is not presented as a successfully empty list', async () => {
  const h = harness();
  await h.read(Promise.reject(new Error('Gateway refused')), 20);
  expect(h.snapshot().state).toEqual({ sessions: [], loaded: false, failed: true });
});

test('current paging stays bounded and stops offering older sessions at the cap', async () => {
  const h = harness();
  await h.read(Promise.resolve(Array.from({ length: 200 }, (_, i) => ({ id: `thread-${i}` }))), nextSessionListLimit(180));
  expect(h.snapshot().limit).toBe(200);
  expect(h.snapshot().hasOlder).toBe(false);
});

test('both provider reads guard the client and scope generation and queued list writes', () => {
  const reads = source.slice(source.indexOf('const openSessionSelector = useCallback'), source.indexOf('const closeSessionSelector = useCallback'));
  expect(reads.match(/readSessionList\(/g)).toHaveLength(2);
  expect(reads.match(/clientRef\.current === client/g)).toHaveLength(2);
  expect(reads.match(/seq === sessionReadSeqRef\.current/g)).toHaveLength(2);
  expect(reads.match(/isCurrent\(\) \? applySessionListRead/g)).toHaveLength(2);
  expect(reads).toContain('if (!client || loadingOlderSessionsRef.current) return;');
  expect(reads).toMatch(/finally \{\s*if \(isCurrent\(\)\) \{/);
  expect(reads).not.toContain('setCurrentSessionId');
  expect(reads).not.toContain('setSessionId(');
});

test('every Gateway teardown and Bot or CLI environment scope change retires selector reads', () => {
  expect(source.match(/clientGenerationRef\.current \+= 1;\s*resetSessionSelector\(\);/g)).toHaveLength(4);
  for (const marker of ['const selectBackend = useCallback', 'const clearBot = useCallback', 'const openBot = useCallback']) {
    const action = source.slice(source.indexOf(marker));
    const reset = action.indexOf('resetSessionSelector();');
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(action.indexOf(marker.includes('openBot') ? 'client.setBotId(botId)' : 'setBotId?.'));
  }
  expect(source).toMatch(/resetSessionSelector\(\);\s*client\?\.setBackendId\?\.\(resolved\)/);
  expect(source).toMatch(/if \(!botOpenFailureKeepsScope\(error\)\) \{\s*resetSessionSelector\(\);/);
  const reset = source.slice(source.indexOf('const resetSessionSelector = useCallback'), source.indexOf('const resetSessionSelector = useCallback') + 600);
  expect(reset).toContain('++sessionReadSeqRef.current;');
  expect(reset).toContain('setSessionListState(emptySessionList<HermesSession>());');
  expect(reset).toContain('loadingOlderSessionsRef.current = false;');
});
