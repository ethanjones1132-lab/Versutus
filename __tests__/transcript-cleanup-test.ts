jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
    getAllKeys: async () => [...store.keys()],
    multiRemove: async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    },
  };
});

import {
  appendTranscript,
  clearTranscriptsForGateway,
  createTranscriptId,
  loadTranscripts,
} from '@/lib/gateway/transcript';
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

function entry(gatewayId: string, sessionKey: string): CommandTranscriptEntry {
  return {
    id: createTranscriptId(),
    gatewayId,
    sessionKey,
    input: '/status',
    title: 'status',
    status: 'complete',
    summary: 'ok',
    createdAt: Date.now(),
  } as CommandTranscriptEntry;
}

describe('clearTranscriptsForGateway', () => {
  it('removes every session transcript belonging to the gateway', async () => {
    await appendTranscript('gw-1', 'session-a', entry('gw-1', 'session-a'));
    await appendTranscript('gw-1', 'session-b', entry('gw-1', 'session-b'));

    await clearTranscriptsForGateway('gw-1');

    expect(await loadTranscripts('gw-1', 'session-a')).toEqual([]);
    expect(await loadTranscripts('gw-1', 'session-b')).toEqual([]);
  });

  it('leaves other gateways untouched', async () => {
    await appendTranscript('gw-keep', 'session-a', entry('gw-keep', 'session-a'));
    await appendTranscript('gw-drop', 'session-a', entry('gw-drop', 'session-a'));

    await clearTranscriptsForGateway('gw-drop');

    expect(await loadTranscripts('gw-drop', 'session-a')).toEqual([]);
    expect(await loadTranscripts('gw-keep', 'session-a')).toHaveLength(1);
  });

  it('does not clear a gateway whose id merely shares a prefix', async () => {
    await appendTranscript('gw-1', 'session-a', entry('gw-1', 'session-a'));
    await appendTranscript('gw-10', 'session-a', entry('gw-10', 'session-a'));

    await clearTranscriptsForGateway('gw-1');

    expect(await loadTranscripts('gw-1', 'session-a')).toEqual([]);
    expect(await loadTranscripts('gw-10', 'session-a')).toHaveLength(1);
  });
});
