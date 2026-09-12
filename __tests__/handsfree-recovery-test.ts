import { keyValueStorage } from '@/lib/storage/key-value';
import {
  composerDraftKey,
  composerDraftThread,
  loadComposerDraft,
  recoveryStorageKey,
  saveComposerDraft,
  type ComposerDraftThread,
} from '@/lib/gateway/composer-draft';
import {
  clearHandsfreeRecovery,
  loadHandsfreeRecovery,
  mergeHandsfreeRecovery,
  promoteHandsfreeRecovery,
  saveHandsfreeRecovery,
} from '@/lib/voice/handsfree-recovery';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;
const mockRemove = keyValueStorage.removeItem as jest.Mock;

const GATE = 'gw-home';

function bot(botId = 'researcher', sessionId = 'ses_bot'): ComposerDraftThread {
  const thread = composerDraftThread({
    gatewayId: GATE,
    surface: { kind: 'bot', botId },
    sessionId,
  });
  if (!thread) throw new Error('expected bot thread');
  return thread;
}

const backing = new Map<string, string>();

beforeEach(() => {
  backing.clear();
  mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
  mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
    backing.set(key, value);
  });
  mockRemove.mockReset().mockImplementation(async (key: string) => {
    backing.delete(key);
  });
});

describe('the recovery key', () => {
  test('is the draft thread key under its own prefix', () => {
    const thread = bot();
    expect(recoveryStorageKey(thread)).toBe(`handsfree-recovery:${composerDraftKey(thread)}`);
  });

  test('two threads never share a recovery record', () => {
    expect(recoveryStorageKey(bot('researcher'))).not.toBe(recoveryStorageKey(bot('coder')));
  });
});

describe('saveHandsfreeRecovery / loadHandsfreeRecovery', () => {
  test('the latest transcript is what a later launch reads back', async () => {
    await saveHandsfreeRecovery(bot(), 'book a table');
    expect(await loadHandsfreeRecovery(bot())).toBe('book a table');
  });

  test('a newer transcript replaces the older one', async () => {
    await saveHandsfreeRecovery(bot(), 'book a');
    await saveHandsfreeRecovery(bot(), 'book a table for two');
    expect(await loadHandsfreeRecovery(bot())).toBe('book a table for two');
  });

  test('one thread recovery never appears in another', async () => {
    await saveHandsfreeRecovery(bot('researcher'), 'look at the logs');
    expect(await loadHandsfreeRecovery(bot('coder'))).toBeUndefined();
  });

  test('a missing record reads as none', async () => {
    expect(await loadHandsfreeRecovery(bot())).toBeUndefined();
  });

  test('an empty transcript clears rather than storing noise', async () => {
    await saveHandsfreeRecovery(bot(), 'book a table');
    await saveHandsfreeRecovery(bot(), '   ');
    expect(mockRemove).toHaveBeenCalled();
    expect(await loadHandsfreeRecovery(bot())).toBeUndefined();
  });

  test('malformed storage reads as none, not a throw', async () => {
    await saveHandsfreeRecovery(bot(), 'book a table');
    backing.set(recoveryStorageKey(bot()), '{not-json');
    expect(await loadHandsfreeRecovery(bot())).toBeUndefined();
  });

  test('a refused read is none and a refused write does not throw', async () => {
    mockGet.mockRejectedValue(new Error('disk full'));
    mockSet.mockRejectedValue(new Error('disk full'));
    await expect(loadHandsfreeRecovery(bot())).resolves.toBeUndefined();
    await expect(saveHandsfreeRecovery(bot(), 'book a table')).resolves.toBeUndefined();
  });
});

describe('clearHandsfreeRecovery', () => {
  test('removes the record', async () => {
    await saveHandsfreeRecovery(bot(), 'book a table');
    await clearHandsfreeRecovery(bot());
    expect(await loadHandsfreeRecovery(bot())).toBeUndefined();
  });
});

describe('mergeHandsfreeRecovery', () => {
  test('joins recovered speech onto the typed draft with the hold rule', () => {
    expect(mergeHandsfreeRecovery('check the logs', 'and the disk')).toBe(
      'check the logs and the disk',
    );
  });

  test('an empty typed draft becomes the recovered speech', () => {
    expect(mergeHandsfreeRecovery('', 'book a table')).toBe('book a table');
  });

  test('the recovered words are never re-worded', () => {
    expect(mergeHandsfreeRecovery('', 'log the  disk,  twice')).toBe('log the  disk,  twice');
  });
});

describe('promoteHandsfreeRecovery', () => {
  test('a typed draft with no recovery is left byte-for-byte alone', async () => {
    const thread = bot();
    await saveComposerDraft(thread, 'check the logs');
    mockSet.mockClear();
    expect(await promoteHandsfreeRecovery(thread)).toBeUndefined();
    expect(mockSet).not.toHaveBeenCalled();
    expect(await loadComposerDraft(thread)).toBe('check the logs');
  });

  test('recovery is merged onto the existing typed draft and then cleared', async () => {
    const thread = bot();
    await saveComposerDraft(thread, 'check the logs');
    await saveHandsfreeRecovery(thread, 'and the disk');

    expect(await promoteHandsfreeRecovery(thread)).toBe('check the logs and the disk');
    expect(await loadComposerDraft(thread)).toBe('check the logs and the disk');
    expect(await loadHandsfreeRecovery(thread)).toBeUndefined();
  });

  test('recovery with no typed draft lands as its own characters', async () => {
    const thread = bot();
    await saveHandsfreeRecovery(thread, 'book a table');
    expect(await promoteHandsfreeRecovery(thread)).toBe('book a table');
    expect(await loadComposerDraft(thread)).toBe('book a table');
  });

  test('a workspace shared by two threads recovers only the one that spoke', async () => {
    const researcher = bot('researcher');
    const coder = bot('coder');
    await saveComposerDraft(coder, 'ship the patch');
    await saveHandsfreeRecovery(researcher, 'look at the logs');

    await promoteHandsfreeRecovery(researcher);

    expect(await loadComposerDraft(researcher)).toBe('look at the logs');
    expect(await loadComposerDraft(coder)).toBe('ship the patch');
  });
});
