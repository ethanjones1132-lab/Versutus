const mockBacking = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => mockBacking.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => {
  mockBacking.set(key, value);
});
const mockRemove = jest.fn(async (key: string) => {
  mockBacking.delete(key);
});
const mockGetAllKeys = jest.fn(async () => [...mockBacking.keys()]);
const mockMultiRemove = jest.fn(async (keys: string[]) => {
  for (const key of keys) mockBacking.delete(key);
});

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: (key: string) => mockGet(key),
    setItem: (key: string, value: string) => mockSet(key, value),
    removeItem: (key: string) => mockRemove(key),
    getAllKeys: () => mockGetAllKeys(),
    multiRemove: (keys: string[]) => mockMultiRemove(keys),
  },
}));

import {
  appendTranscript,
  createTranscriptId,
  flushTranscripts,
  loadTranscripts,
  removeTranscript,
  removeTranscriptsForSession,
} from '@/lib/gateway/transcript';
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

const storageKey = (gatewayId: string, sessionKey: string) =>
  `versutus:transcript:${gatewayId}:${sessionKey.replace(/[:/\\]/g, '_')}`;

function entry(overrides: Partial<CommandTranscriptEntry> = {}): CommandTranscriptEntry {
  return {
    id: createTranscriptId(),
    gatewayId: 'gw',
    sessionKey: 'session',
    input: '/status',
    title: 'status',
    status: 'complete',
    summary: 'ok',
    createdAt: 1,
    ...overrides,
  };
}

const stored = (gatewayId: string, sessionKey: string): CommandTranscriptEntry[] => {
  const raw = mockBacking.get(storageKey(gatewayId, sessionKey));
  return raw ? (JSON.parse(raw) as CommandTranscriptEntry[]) : [];
};

beforeEach(() => {
  mockBacking.clear();
  mockSet.mockClear();
  mockRemove.mockClear();
});

describe('removeTranscript', () => {
  test('drops one durable entry and leaves its neighbours', async () => {
    const gatewayId = 'rm-entry';
    await appendTranscript(gatewayId, 'session', entry({ id: 'cmd-1', gatewayId }));
    await appendTranscript(gatewayId, 'session', entry({ id: 'cmd-2', gatewayId }));

    const remaining = await removeTranscript(gatewayId, 'session', 'cmd-1');
    await flushTranscripts();

    expect(remaining.map((item) => item.id)).toEqual(['cmd-2']);
    expect((await loadTranscripts(gatewayId, 'session')).map((item) => item.id)).toEqual(['cmd-2']);
    expect(stored(gatewayId, 'session').map((item) => item.id)).toEqual(['cmd-2']);
  });
});

describe('removeTranscriptsForSession', () => {
  test('removes the whole key when the transcript is keyed by the session', async () => {
    const gatewayId = 'rm-session-key';
    await appendTranscript(gatewayId, 'sess-1', entry({ id: 'cmd-1', gatewayId, sessionKey: 'sess-1', sessionId: 'sess-1' }));

    await removeTranscriptsForSession(gatewayId, 'sess-1', 'sess-1');
    await flushTranscripts();

    expect(await loadTranscripts(gatewayId, 'sess-1')).toEqual([]);
    expect(mockBacking.has(storageKey(gatewayId, 'sess-1'))).toBe(false);
  });

  test('on a shared key drops only the deleted session and keeps the others', async () => {
    const gatewayId = 'rm-shared-key';
    const key = 'agent:main:main';
    await appendTranscript(gatewayId, key, entry({ id: 'cmd-a', gatewayId, sessionKey: key, sessionId: 'sess-a' }));
    await appendTranscript(gatewayId, key, entry({ id: 'cmd-b', gatewayId, sessionKey: key, sessionId: 'sess-b' }));

    await removeTranscriptsForSession(gatewayId, key, 'sess-a');
    await flushTranscripts();

    expect((await loadTranscripts(gatewayId, key)).map((item) => item.id)).toEqual(['cmd-b']);
    expect(stored(gatewayId, key).map((item) => item.id)).toEqual(['cmd-b']);
  });
});
