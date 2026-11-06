const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  loadOfflineQueue,
  removeOfflineQueueItemsForGateways,
  saveOfflineQueue,
  type OfflineQueueItem,
} from '@/lib/gateway/session-persistence';
import { gatewayIdsRemovedWith, gatewayRemovalMessage } from '@/hooks/use-gateway-settings-screen';

const KEY = 'versutus:offline-queue';

function queued(id: string, gatewayId: string): OfflineQueueItem {
  return { id, text: `message ${id}`, gatewayId, createdAt: 1 };
}

describe('deleting a gateway profile with queued messages', () => {
  beforeEach(() => mockStore.clear());

  test('confirmation count reflects that gateway only and deleting removes only its durable rows', async () => {
    await saveOfflineQueue([queued('a1', 'gateway-a'), queued('a2', 'gateway-a'), queued('b1', 'gateway-b')]);
    const loaded = await loadOfflineQueue();
    expect(loaded.filter((item) => item.gatewayId === 'gateway-a')).toHaveLength(2);

    await saveOfflineQueue(removeOfflineQueueItemsForGateways(loaded, new Set(['gateway-a'])));

    expect(await loadOfflineQueue()).toEqual([queued('b1', 'gateway-b')]);
    expect(mockStore.get(KEY)).toContain('gateway-b');
    expect(mockStore.get(KEY)).not.toContain('gateway-a');
  });

  test('counted and unreadable queue states are stated, while zero keeps the old copy', () => {
    expect(gatewayRemovalMessage('Gateway A', true, 2)).toBe(
      'Gateway A will stay available if discovered again. 2 unsent messages will be deleted with this gateway.',
    );
    expect(gatewayRemovalMessage('Gateway A', false, null)).toBe(
      'Gateway A will stay available if discovered again. The unsent message count could not be read.',
    );
    expect(gatewayRemovalMessage('Gateway A', true, 0)).toBe(
      'Gateway A will stay available if discovered again.',
    );
  });

  test('the count covers the provider child profiles the delete cascades to, and nothing else', () => {
    const gateways = [
      { id: 'gateway-a' },
      { id: 'gateway-a::openrouter', parentId: 'gateway-a' },
      { id: 'gateway-b' },
      { id: 'gateway-b::openrouter', parentId: 'gateway-b' },
    ];
    expect([...gatewayIdsRemovedWith('gateway-a', gateways)].sort()).toEqual(['gateway-a', 'gateway-a::openrouter']);
    expect([...gatewayIdsRemovedWith('gateway-a::openrouter', gateways)]).toEqual(['gateway-a::openrouter']);
  });
});
