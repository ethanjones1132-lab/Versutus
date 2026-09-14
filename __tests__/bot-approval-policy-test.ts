jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadBotApprovalPolicy, setBotApprovalPolicy } from '@/lib/settings/bot-approval-policy';

describe('setBotApprovalPolicy / loadBotApprovalPolicy', () => {
  const policy = { enabled: true, readOnlyCommands: ['list', 'read'] };

  test('writes the policy under the Bot-scoped key', async () => {
    await setBotApprovalPolicy('bot-1', policy);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'versutus:approval-policy:bot-1',
      JSON.stringify(policy),
    );
  });

  test('a blank command is dropped on the way in, not stored', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await setBotApprovalPolicy('bot-1', { enabled: true, readOnlyCommands: ['list', '  '] });
    const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string);
    expect(stored.readOnlyCommands).toEqual(['list']);
  });

  test('a null policy removes the key rather than storing a word', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockClear();
    await setBotApprovalPolicy('bot-1', null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('versutus:approval-policy:bot-1');
  });

  test('an empty Bot id writes nothing — there is no Bot the policy could govern', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await setBotApprovalPolicy('  ', policy);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('a corrupt row is never stored — garbage never becomes a policy', async () => {
    (AsyncStorage.setItem as jest.Mock).mockClear();
    await setBotApprovalPolicy('bot-1', { enabled: 'yes', readOnlyCommands: ['list'] } as never);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('loads the stored policy back', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify(policy));
    await expect(loadBotApprovalPolicy('bot-1')).resolves.toEqual(policy);
  });

  test('no stored policy, a corrupt one, or a blank id reads as null — defer direction', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await expect(loadBotApprovalPolicy('bot-1')).resolves.toBeNull();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('garbage');
    await expect(loadBotApprovalPolicy('bot-1')).resolves.toBeNull();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({ enabled: 'yes', readOnlyCommands: 3 }),
    );
    await expect(loadBotApprovalPolicy('bot-1')).resolves.toBeNull();
    await expect(loadBotApprovalPolicy('  ')).resolves.toBeNull();
  });
});
