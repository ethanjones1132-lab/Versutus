jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { keyValueStorage } from '@/lib/storage/key-value';
import {
  loadBotSpendCap,
  setBotSpendCap,
  spendCapNoticeCopy,
  spendCapVerdict,
  SPEND_CAP_LIMIT_COPY,
} from '@/lib/settings/bot-spend-cap';

import {
  executeGatewaySlashCommand,
} from '@/lib/gateway/slash-commands';
import type { SpendCapVerdict } from '@/lib/settings/bot-spend-cap';

describe('setBotSpendCap / loadBotSpendCap', () => {
  test('writes the cap under the Bot-scoped key', async () => {
    await setBotSpendCap('bot-1', 5);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('versutus:spend-cap:bot-1', '5');
  });

  test('a null cap removes the key rather than storing a word', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockClear();
    await setBotSpendCap('bot-1', null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('versutus:spend-cap:bot-1');
  });

  test('an empty Bot id writes nothing — there is no Bot the cap could govern', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await setBotSpendCap('  ', 5);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('a negative or non-finite cap stores nothing, so garbage never becomes a policy', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await setBotSpendCap('bot-1', -1);
    await setBotSpendCap('bot-1', Number.NaN);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('loads the stored cap back', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('2.5');
    await expect(loadBotSpendCap('bot-1')).resolves.toBe(2.5);
  });

  test('no stored cap reads as null, and a corrupt value is unknown rather than zero', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await expect(loadBotSpendCap('bot-1')).resolves.toBeNull();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('garbage');
    await expect(loadBotSpendCap('bot-1')).resolves.toBeNull();
  });
});

describe('spendCapVerdict', () => {
  test('no cap set simply allows — the existing uncapped path is untouched', () => {
    expect(spendCapVerdict(null, 100)).toEqual({ decision: 'allow' });
    expect(spendCapVerdict(null, null)).toEqual({ decision: 'allow' });
  });

  test('spend under the cap allows', () => {
    expect(spendCapVerdict(5, 4.99)).toEqual({ decision: 'allow' });
  });

  test('spend at the cap pauses — a run started past the cap is what a hard stop stops', () => {
    const verdict = spendCapVerdict(5, 5);
    expect(verdict).toEqual({ decision: 'pause-and-escalate', reason: 'cap-met', spendUsd: 5, capUsd: 5 });
  });

  test('spend past the cap pauses with both numbers for the notice', () => {
    const verdict = spendCapVerdict(5, 7.25);
    expect(verdict).toEqual({
      decision: 'pause-and-escalate',
      reason: 'cap-met',
      spendUsd: 7.25,
      capUsd: 5,
    });
  });

  test('an unreadable spend escalates rather than silently allowing more spend', () => {
    const verdict = spendCapVerdict(5, null);
    expect(verdict).toEqual({
      decision: 'pause-and-escalate',
      reason: 'unreadable-spend',
      capUsd: 5,
    });
  });
});

describe('spendCapNoticeCopy', () => {
  test('the cap-met notice names what was paused, in due vocabulary, never a fake result', () => {
    const copy = spendCapNoticeCopy({ decision: 'pause-and-escalate', reason: 'cap-met', spendUsd: 7.26, capUsd: 5 });
    expect(copy).toContain('$7.26');
    expect(copy).toContain('$5.00');
    expect(copy).toContain('paused for your decision');
  });

  test('the unreadable-spend notice says what it could not read', () => {
    const copy = spendCapNoticeCopy({ decision: 'pause-and-escalate', reason: 'unreadable-spend', capUsd: 5 });
    expect(copy).toContain('could not read');
  });

  test('the honest-limit copy states client-side enforcement', () => {
    expect(SPEND_CAP_LIMIT_COPY).toContain('this app');
  });
});

describe('the pre-run gate on the /run path', () => {
  const runTask = jest.fn().mockResolvedValue({ runId: 'run-9', status: 'complete', approved: true, result: 'done' });
  const baseContext = {
    hello: null,
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
    runTask,
  };
  beforeEach(() => {
    runTask.mockClear();
  });

  test('a pause-and-escalate verdict refuses before runTask is called', async () => {
    const spendCapCheck = jest.fn().mockResolvedValue({
      decision: 'pause-and-escalate',
      reason: 'cap-met',
      spendUsd: 5,
      capUsd: 5,
    } as SpendCapVerdict);
    const result = await executeGatewaySlashCommand('/run rebuild', { ...baseContext, spendCapCheck });
    expect(spendCapCheck).toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
    expect(result.text).toContain('Run not started');
    expect(result.text).toContain('paused for your decision');
    expect(result.title).toBe('/run');
  });

  test('an allow verdict runs exactly as before', async () => {
    const spendCapCheck = jest.fn().mockResolvedValue({ decision: 'allow' } as SpendCapVerdict);
    const result = await executeGatewaySlashCommand('/run rebuild', { ...baseContext, spendCapCheck });
    expect(runTask).toHaveBeenCalledWith('rebuild', expect.anything());
    expect(result.text).toContain('Run complete');
  });

  test('a gate that throws never blocks the run on a device that set no cap', async () => {
    const spendCapCheck = jest.fn().mockRejectedValue(new Error('storage locked'));
    const result = await executeGatewaySlashCommand('/run rebuild', { ...baseContext, spendCapCheck });
    expect(runTask).toHaveBeenCalled();
    expect(result.text).toContain('Run complete');
  });

  test('no spendCapCheck wired is the old uncapped path, byte-identical', async () => {
    const result = await executeGatewaySlashCommand('/run rebuild', { ...baseContext });
    expect(runTask).toHaveBeenCalledWith('rebuild', expect.anything());
    expect(result.text).toContain('Run complete');
  });
});
