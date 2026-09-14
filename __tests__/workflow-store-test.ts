// The store's own Jest cases, written first. Storage is mocked at AsyncStorage
// with a real in-memory map, so every case reads and writes through the real
// keyValueStorage wrapper — read-backs are real, not mocked echoes.
jest.mock('@react-native-async-storage/async-storage', () => {
  const map = new Map<string, string>();
  return {
    __MEM: map,
    getItem: jest.fn(async (key: string) => map.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      map.delete(key);
    }),
    getAllKeys: jest.fn(async () => [...map.keys()]),
    multiRemove: jest.fn(async (keys: string[]) => {
      for (const key of keys) map.delete(key);
    }),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ActivityRun } from '@/lib/gateway/runs';
import {
  SavedWorkflowNotSavableError,
  SavedWorkflowNameTakenError,
  SAVED_WORKFLOWS_STORAGE_KEY,
  WORKFLOW_STORE_CAP,
  deleteWorkflow,
  loadWorkflows,
  saveWorkflowFromRun,
} from '@/lib/workflow/workflow-store';
import { keyValueStorage } from '@/lib/storage/key-value';

const getItem = AsyncStorage.getItem as unknown as jest.Mock;
const setItem = AsyncStorage.setItem as unknown as jest.Mock;
const removeItem = AsyncStorage.removeItem as unknown as jest.Mock;
const mem = (AsyncStorage as unknown as { __MEM: Map<string, string> }).__MEM;

function finishedRun(overrides: Partial<ActivityRun> = {}): ActivityRun {
  const base: ActivityRun = {
    id: 'run-1',
    prompt: 'fix the failing widget test',
    status: 'complete',
    startedAt: 1700000000000,
    finishedAt: 1700000006000,
    summary: 'Green',
    events: [],
    approved: true,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  mem.clear();
  getItem.mockClear();
  setItem.mockClear();
});

describe('saveWorkflowFromRun', () => {
  test('saves a finished run under the gateway+name identity', async () => {
    const saved = await saveWorkflowFromRun({
      run: finishedRun({ botId: 'bot-7' }),
      name: '  Widget fix  ',
      gatewayId: 'gw-1',
      now: 1710000000000,
    });
    const workflows = await loadWorkflows('gw-1');
    expect(saved).toEqual(workflows[0]);
    expect(workflows[0]).toEqual({
      id: expect.any(String),
      name: 'Widget fix',
      prompt: 'fix the failing widget test',
      botId: 'bot-7',
      createdAt: 1710000000000,
      runCount: 0,
    });
  });

  test('persists through keyValueStorage under the one blob key', async () => {
    await saveWorkflowFromRun({
      run: finishedRun(),
      name: 'Widget fix',
      gatewayId: 'gw-1',
      now: 1710000000000,
    });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      SAVED_WORKFLOWS_STORAGE_KEY,
      expect.any(String),
    );
    const blob = JSON.parse(
      (await keyValueStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY)) ?? '{}',
    ) as Record<string, unknown>;
    expect(Object.keys(blob)).toEqual(['gw-1']);
  });

  test('rejects an existing name rather than overwriting it', async () => {
    await saveWorkflowFromRun({ run: finishedRun(), name: 'Widget fix', gatewayId: 'gw-1' });
    const written = (await keyValueStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY)) ?? '';
    await expect(
      saveWorkflowFromRun({
        run: finishedRun({ prompt: 'second' }),
        name: 'widget fix',
        gatewayId: 'gw-1',
      }),
    ).rejects.toBeInstanceOf(SavedWorkflowNameTakenError);
    expect(await keyValueStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY)).toBe(written);
  });

  test('the same name folds two gateways as two workflows', async () => {
    await saveWorkflowFromRun({ run: finishedRun(), name: 'Widget fix', gatewayId: 'gw-1' });
    await saveWorkflowFromRun({ run: finishedRun(), name: 'Widget fix', gatewayId: 'gw-2' });
    expect((await loadWorkflows('gw-1')).length).toBe(1);
    expect((await loadWorkflows('gw-2')).length).toBe(1);
  });

  test('a blank or whitespace name is refused, not stored', async () => {
    await expect(
      saveWorkflowFromRun({ run: finishedRun(), name: '   ', gatewayId: 'gw-1' }),
    ).rejects.toBeInstanceOf(SavedWorkflowNotSavableError);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('a run not settled is refused — there is nothing trustworthy to fold', async () => {
    for (const status of ['running', 'waiting-approval', 'unresolved'] as const) {
      await expect(
        saveWorkflowFromRun({ run: finishedRun({ status }), name: 'w', gatewayId: 'gw-1' }),
      ).rejects.toBeInstanceOf(SavedWorkflowNotSavableError);
    }
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('a run with no finishedAt is refused — rows and status disagree', async () => {
    await expect(
      saveWorkflowFromRun({
        run: finishedRun({ finishedAt: undefined }),
        name: 'w',
        gatewayId: 'gw-1',
      }),
    ).rejects.toBeInstanceOf(SavedWorkflowNotSavableError);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('caps the store at WORKFLOW_STORE_CAP entries, oldest evicted first', async () => {
    for (let index = 0; index < WORKFLOW_STORE_CAP + 2; index += 1) {
      await saveWorkflowFromRun({
        run: finishedRun({ prompt: `run ${index}` }),
        name: `wl-${index}`,
        gatewayId: 'gw-1',
      });
    }
    const workflows = await loadWorkflows('gw-1');
    expect(workflows.length).toBe(WORKFLOW_STORE_CAP);
    // the two oldest names were evicted to make room
    expect(workflows.some((w) => w.name === 'wl-0')).toBe(false);
    expect(workflows.some((w) => w.name === 'wl-1')).toBe(false);
    expect(workflows.some((w) => w.name === `wl-${WORKFLOW_STORE_CAP + 1}`)).toBe(true);
  });

  test('a storage refusal answers null, never a phantom save', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('locked'));
    const result = await saveWorkflowFromRun({
      run: finishedRun(),
      name: 'Widget fix',
      gatewayId: 'gw-1',
    });
    expect(result).toBeNull();
  });
});

describe('loadWorkflows', () => {
  test('answers [] with nothing stored', async () => {
    expect(await loadWorkflows('gw-1')).toEqual([]);
  });

  test('answers [] when nothing belongs to this gateway', async () => {
    await keyValueStorage.setItem(SAVED_WORKFLOWS_STORAGE_KEY, JSON.stringify({ 'gw-9': [] }));
    expect(await loadWorkflows('gw-1')).toEqual([]);
  });

  test('normalizes the stored blob rather than trusting it', async () => {
    const now = 1710000050000;
    await saveWorkflowFromRun({ run: finishedRun(), name: 'good', gatewayId: 'gw-1', now });
    const good = await keyValueStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY);
    const junk = { 'gw-1': [null, 'string', { name: 'only-name' }, 42] };
    await keyValueStorage.setItem(SAVED_WORKFLOWS_STORAGE_KEY, JSON.stringify(junk));
    expect(await loadWorkflows('gw-1')).toEqual([]);
    expect(good).toBeTruthy();
  });

  test('a refused or corrupt blob answers [] rather than throwing', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('locked'));
    expect(await loadWorkflows('gw-1')).toEqual([]);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not json');
    expect(await loadWorkflows('gw-1')).toEqual([]);
  });
});

describe('deleteWorkflow', () => {
  test('removes the workflow and leaves the other gateways alone', async () => {
    await saveWorkflowFromRun({ run: finishedRun(), name: 'keep me', gatewayId: 'gw-2' });
    await saveWorkflowFromRun({ run: finishedRun(), name: 'drop me', gatewayId: 'gw-1' });
    expect(await deleteWorkflow('gw-1', 'Drop me')).toBe(true);
    expect(await loadWorkflows('gw-1')).toEqual([]);
    expect((await loadWorkflows('gw-2')).length).toBe(1);
  });

  test('a name the store does not hold reports false and writes nothing', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    expect(await deleteWorkflow('gw-1', 'missing')).toBe(false);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
