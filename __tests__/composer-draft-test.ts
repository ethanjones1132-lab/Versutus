import { keyValueStorage } from '@/lib/storage/key-value';
import {
  applyComposerDraft,
  composerDraftKey,
  composerDraftThread,
  loadComposerDraft,
  readComposerDraft,
  saveComposerDraft,
  spokenDraftHold,
  spokenDraftText,
  type ComposerDraftThread,
} from '@/lib/gateway/composer-draft';

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

const GATE = 'gw-home';
const OTHER_GATE = 'gw-other';

function configurable(sessionId = 'ses_cfg'): ComposerDraftThread {
  const thread = composerDraftThread({
    gatewayId: GATE,
    surface: { kind: 'configurable' },
    sessionId,
  });
  if (!thread) throw new Error('expected configurable thread');
  return thread;
}

function bot(botId: string, sessionId = 'ses_bot'): ComposerDraftThread {
  const thread = composerDraftThread({
    gatewayId: GATE,
    surface: { kind: 'bot', botId },
    sessionId,
  });
  if (!thread) throw new Error('expected bot thread');
  return thread;
}

describe('composerDraftThread', () => {
  test('roster is not a composer thread', () => {
    expect(
      composerDraftThread({
        gatewayId: GATE,
        surface: { kind: 'roster' },
        sessionId: 'ses_x',
      }),
    ).toBeUndefined();
  });

  test('a group room is not this composer — it owns its own draft', () => {
    expect(
      composerDraftThread({
        gatewayId: GATE,
        surface: { kind: 'group', groupId: 'room-1' },
        sessionId: 'ses_x',
      }),
    ).toBeUndefined();
  });

  test('no gateway means no thread to key a draft on', () => {
    expect(
      composerDraftThread({
        gatewayId: undefined,
        surface: { kind: 'configurable' },
        sessionId: 'ses_x',
      }),
    ).toBeUndefined();
  });

  test('configurable chat with no session yet is still a thread', () => {
    const thread = composerDraftThread({
      gatewayId: GATE,
      surface: { kind: 'configurable' },
      sessionId: undefined,
    });
    expect(thread).toEqual({
      gatewayId: GATE,
      surface: { kind: 'configurable' },
      sessionId: '',
    });
  });
});

describe('composerDraftKey', () => {
  test('two Bots with the same session id do not share a key', () => {
    expect(composerDraftKey(bot('researcher'))).not.toBe(composerDraftKey(bot('coder')));
  });

  test('two sessions on one Bot do not share a key', () => {
    expect(composerDraftKey(bot('researcher', 'ses_a'))).not.toBe(
      composerDraftKey(bot('researcher', 'ses_b')),
    );
  });

  test('the same surface on two gateways do not share a key', () => {
    const home = configurable();
    const other = composerDraftThread({
      gatewayId: OTHER_GATE,
      surface: { kind: 'configurable' },
      sessionId: home.sessionId,
    });
    if (!other) throw new Error('expected other gateway thread');
    expect(composerDraftKey(home)).not.toBe(composerDraftKey(other));
  });

  test('configurable chat and a Bot do not share a key even with the same session id', () => {
    expect(composerDraftKey(configurable('ses_shared'))).not.toBe(
      composerDraftKey(bot('researcher', 'ses_shared')),
    );
  });
});

describe('applyComposerDraft / readComposerDraft', () => {
  test('a draft typed on one Bot is still there after you type on another', () => {
    const researcher = bot('researcher');
    const coder = bot('coder');
    let drafts = applyComposerDraft({}, researcher, 'look at the logs');
    drafts = applyComposerDraft(drafts, coder, 'ship the patch');
    expect(readComposerDraft(drafts, researcher)).toBe('look at the logs');
    expect(readComposerDraft(drafts, coder)).toBe('ship the patch');
  });

  test('a draft typed in one session is still there after you open another on the same Bot', () => {
    const standing = bot('researcher', 'ses_botchat');
    const extra = bot('researcher', 'ses_scratch');
    let drafts = applyComposerDraft({}, standing, 'continue the review');
    drafts = applyComposerDraft(drafts, extra, 'scratch idea');
    expect(readComposerDraft(drafts, standing)).toBe('continue the review');
    expect(readComposerDraft(drafts, extra)).toBe('scratch idea');
  });

  test('an unknown thread reads as empty, not someone else\'s draft', () => {
    const drafts = applyComposerDraft({}, bot('researcher'), 'look at the logs');
    expect(readComposerDraft(drafts, bot('coder'))).toBe('');
    expect(readComposerDraft(drafts, configurable())).toBe('');
  });

  test('clearing a draft keeps the key so a later load cannot resurrect it', () => {
    const thread = bot('researcher');
    let drafts = applyComposerDraft({}, thread, 'look at the logs');
    drafts = applyComposerDraft(drafts, thread, '');
    expect(readComposerDraft(drafts, thread)).toBe('');
    expect(drafts[composerDraftKey(thread)]).toBe('');
  });

  test('does not mutate the map it was given', () => {
    const thread = bot('researcher');
    const before: Record<string, string> = {};
    applyComposerDraft(before, thread, 'look at the logs');
    expect(before).toEqual({});
  });
});

describe('loadComposerDraft / saveComposerDraft', () => {
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

  test('a saved draft is what you get back after leaving the thread', async () => {
    const thread = bot('researcher');
    await saveComposerDraft(thread, 'look at the logs');
    expect(await loadComposerDraft(thread)).toBe('look at the logs');
  });

  test('a researcher draft is still there after you save a coder draft', async () => {
    const researcher = bot('researcher');
    const coder = bot('coder');
    await saveComposerDraft(researcher, 'look at the logs');
    await saveComposerDraft(coder, 'ship the patch');
    expect(await loadComposerDraft(researcher)).toBe('look at the logs');
    expect(await loadComposerDraft(coder)).toBe('ship the patch');
  });

  test('a missing draft loads as empty', async () => {
    expect(await loadComposerDraft(bot('researcher'))).toBe('');
  });

  test('malformed storage loads as empty, not a throw', async () => {
    const thread = bot('researcher');
    await saveComposerDraft(thread, 'look at the logs');
    const storedKey = mockSet.mock.calls[0]?.[0] as string;
    backing.set(storedKey, '{not-json');
    expect(await loadComposerDraft(thread)).toBe('');
  });

  test('a non-string payload loads as empty', async () => {
    const thread = bot('researcher');
    await saveComposerDraft(thread, 'look at the logs');
    const storedKey = mockSet.mock.calls[0]?.[0] as string;
    backing.set(storedKey, JSON.stringify({ text: 'look at the logs' }));
    expect(await loadComposerDraft(thread)).toBe('');
  });

  test('clearing the draft removes it from storage', async () => {
    const thread = bot('researcher');
    await saveComposerDraft(thread, 'look at the logs');
    await saveComposerDraft(thread, '');
    expect(await loadComposerDraft(thread)).toBe('');
    expect(mockRemove).toHaveBeenCalled();
  });

  test('a refused write does not throw — typing must keep working', async () => {
    mockSet.mockRejectedValue(new Error('disk full'));
    await expect(saveComposerDraft(bot('researcher'), 'look at the logs')).resolves.toBeUndefined();
  });

  test('a refused read does not throw — a missing draft is empty', async () => {
    mockGet.mockRejectedValue(new Error('disk full'));
    await expect(loadComposerDraft(bot('researcher'))).resolves.toBe('');
  });
});

describe('spokenDraftText', () => {
  test('a transcript lands on top of what the operator already typed', () => {
    expect(spokenDraftText('check the logs', 'and the disk')).toBe('check the logs and the disk');
  });

  test('an empty draft becomes the transcript, with no room left in front of it', () => {
    expect(spokenDraftText('', 'check the logs')).toBe('check the logs');
  });

  test('an empty transcript leaves the draft byte-identical', () => {
    expect(spokenDraftText('check the logs', '')).toBe('check the logs');
    expect(spokenDraftText('', '')).toBe('');
  });

  test('a transcript carrying no words leaves the draft byte-identical', () => {
    expect(spokenDraftText('check the logs', '   ')).toBe('check the logs');
  });

  test('typed text that already ends in whitespace does not gain a second one', () => {
    expect(spokenDraftText('check the logs ', 'and the disk')).toBe('check the logs and the disk');
    expect(spokenDraftText('check the logs\n', 'and the disk')).toBe('check the logs\nand the disk');
  });

  test("the transcript's own characters are what lands — nothing is re-worded", () => {
    expect(spokenDraftText('', 'log the  disk,  twice')).toBe('log the  disk,  twice');
    expect(spokenDraftText('  ', 'log the  disk')).toBe('  log the  disk');
  });

  test('the same transcript composes the same draft however often it is reported', () => {
    // The transcript is cumulative: each report carries the words so far, not
    // the words since the last one, so the fold is asked about the same base
    // every time and cannot double what was already heard.
    const heard = 'hello world';
    expect(spokenDraftText('note: ', heard)).toBe(spokenDraftText('note: ', heard));
  });
});

describe('spokenDraftHold', () => {
  test('each transcript is written through the one writer it was handed', () => {
    const write = jest.fn();
    const hold = spokenDraftHold('note: ', write);

    hold.onTranscript('hel');
    hold.onTranscript('hello');

    expect(write.mock.calls).toEqual([['note: hel'], ['note: hello']]);
  });

  test('a later report replaces the earlier one rather than doubling it', () => {
    const write = jest.fn();
    const hold = spokenDraftHold('note: ', write);

    hold.onTranscript('hello');
    hold.onTranscript('hello world');

    expect(write).toHaveBeenLastCalledWith('note: hello world');
    expect(write).not.toHaveBeenCalledWith('note: hello hello world');
  });

  test('a transcript carrying no words writes the typed text back unchanged', () => {
    const write = jest.fn();
    const hold = spokenDraftHold('check the logs', write);

    hold.onTranscript('');

    expect(write).toHaveBeenCalledWith('check the logs');
  });

  test('a cancelled hold puts the typed text back and drops what was heard', () => {
    const write = jest.fn();
    const hold = spokenDraftHold('check the logs', write);

    hold.onTranscript('and the disk');
    hold.onCancelled();

    expect(write).toHaveBeenLastCalledWith('check the logs');
  });

  test('a cancelled hold on an empty composer writes nothing to keep', () => {
    const write = jest.fn();
    const hold = spokenDraftHold('', write);

    hold.onCancelled();

    expect(write).toHaveBeenCalledWith('');
  });

  test('a hold has two edges and neither of them sends', () => {
    expect(Object.keys(spokenDraftHold('', jest.fn())).sort()).toEqual([
      'onCancelled',
      'onTranscript',
    ]);
  });
});

describe('a spoken draft and the draft map', () => {
  test('a spoken draft lands under the held thread and leaves another one alone', () => {
    const researcher = bot('researcher');
    const coder = bot('coder');
    let drafts = applyComposerDraft({}, researcher, 'check the logs');
    const hold = spokenDraftHold(readComposerDraft(drafts, researcher), (text) => {
      drafts = applyComposerDraft(drafts, researcher, text);
    });

    hold.onTranscript('and the disk');

    expect(readComposerDraft(drafts, researcher)).toBe('check the logs and the disk');
    expect(readComposerDraft(drafts, coder)).toBe('');
  });

  test('a transcript carrying no words leaves the map the very one it was', () => {
    const thread = bot('researcher');
    let drafts = applyComposerDraft({}, thread, 'check the logs');
    const before = drafts;
    const hold = spokenDraftHold(readComposerDraft(drafts, thread), (text) => {
      drafts = applyComposerDraft(drafts, thread, text);
    });

    hold.onTranscript('');

    // Byte-identical, so the merge rule short-circuits: no new map means no
    // re-render and no write for a hold the recognizer had nothing to say to.
    expect(drafts).toBe(before);
  });

  test('a cancelled hold leaves the typed text in the thread it was held in', () => {
    const researcher = bot('researcher');
    let drafts = applyComposerDraft({}, researcher, 'check the logs');
    const hold = spokenDraftHold(readComposerDraft(drafts, researcher), (text) => {
      drafts = applyComposerDraft(drafts, researcher, text);
    });

    hold.onTranscript('and the disk');
    expect(readComposerDraft(drafts, researcher)).toBe('check the logs and the disk');
    hold.onCancelled();

    expect(readComposerDraft(drafts, researcher)).toBe('check the logs');
  });
});

describe('the speech path and the send path', () => {
  test('the module that composes a spoken draft reaches no send', () => {
    const source = readSource('src', 'lib', 'gateway', 'composer-draft.ts');
    expect(source).not.toMatch(/onSend/);
  });

  test('the shipped fold and the shipped map rules are still what the module holds', () => {
    const source = readSource('src', 'lib', 'gateway', 'composer-draft.ts');
    expect(source).toMatch(/export function applyComposerDraft/);
    expect(source).toMatch(/export function composerDraftKey/);
    expect(source).toMatch(/export async function saveComposerDraft/);
  });
});
