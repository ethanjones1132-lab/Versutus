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

function group(groupId: string, sessionId = 'ses_room'): ComposerDraftThread {
  const thread = composerDraftThread({
    gatewayId: GATE,
    surface: { kind: 'group', groupId },
    sessionId,
  });
  if (!thread) throw new Error('expected group thread');
  return thread;
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
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

  test('a group room is a composer thread of its own, keyed by the room', () => {
    // The room's composer is this screen's composer — holding the draft of its
    // own, not a useState the room loses the moment it unmounts — so a shared
    // text naming no Bot can be written into the room the operator sits in.
    const thread = composerDraftThread({
      gatewayId: GATE,
      surface: { kind: 'group', groupId: 'room-1' },
      sessionId: 'ses_x',
    });
    expect(thread?.surface).toEqual({ kind: 'group', groupId: 'room-1' });
    expect(thread ? composerDraftKey(thread) : undefined).toBe('gw-home:group:room-1');
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

  test('the shipped keys are unchanged — a Bot and a configurable surface key as they always did', () => {
    // The room joins the store BESIDE these two: every draft already on disk
    // has to keep being found under the key it was written with.
    expect(composerDraftKey(bot('researcher', 'ses_crew'))).toBe('gw-home:bot:researcher:ses_crew');
    expect(composerDraftKey(configurable('ses_crew'))).toBe('gw-home:configurable:ses_crew');
  });

  test('two rooms on one gateway do not share a key', () => {
    expect(composerDraftKey(group('room-1'))).not.toBe(composerDraftKey(group('room-2')));
  });

  test('the same room on two gateways does not share a key', () => {
    const other = composerDraftThread({
      gatewayId: OTHER_GATE,
      surface: { kind: 'group', groupId: 'room-1' },
      sessionId: group('room-1').sessionId,
    });
    if (!other) throw new Error('expected other gateway room');
    expect(composerDraftKey(other)).not.toBe(composerDraftKey(group('room-1')));
  });

  test('a room holds no session, so a session it was opened from cannot split its key', () => {
    // A room has no session of its own: whatever session id the screen was
    // holding when the operator walked into the room is not part of what the
    // room's draft belongs to, so the same room is one key.
    expect(composerDraftKey(group('room-1', 'ses_a'))).toBe(composerDraftKey(group('room-1', 'ses_b')));
  });

  test('a room and a thread of another kind never meet, even sharing an id', () => {
    expect(composerDraftKey(group('researcher'))).not.toBe(composerDraftKey(bot('researcher')));
    expect(composerDraftKey(group('researcher'))).not.toBe(composerDraftKey(configurable('researcher')));
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

  test('a draft typed in one room is still there after you type in another', () => {
    const first = group('room-1');
    const second = group('room-2');
    let drafts = applyComposerDraft({}, first, 'brief the room');
    drafts = applyComposerDraft(drafts, second, 'ask the other room');
    expect(readComposerDraft(drafts, first)).toBe('brief the room');
    expect(readComposerDraft(drafts, second)).toBe('ask the other room');
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

  test('a room draft is what you get back after leaving the room', async () => {
    const room = group('room-1');
    await saveComposerDraft(room, 'brief the room');
    expect(await loadComposerDraft(room)).toBe('brief the room');
  });

  test('a room draft and a Bot draft in one workspace never meet', async () => {
    const room = group('room-1');
    const researcher = bot('researcher');
    await saveComposerDraft(room, 'brief the room');
    await saveComposerDraft(researcher, 'look at the logs');
    expect(await loadComposerDraft(room)).toBe('brief the room');
    expect(await loadComposerDraft(researcher)).toBe('look at the logs');
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

describe('a shared text composed onto a thread that already holds a draft', () => {
  test('what was typed is kept and the shared text follows it', () => {
    const researcher = bot('researcher');
    let drafts = applyComposerDraft({}, researcher, 'check the logs');

    // Item 5's compose handoff writes through the composer's one writer and
    // composes with the rule the spoken draft states, so a thread the operator
    // was already typing in does not lose what they typed.
    drafts = applyComposerDraft(
      drafts,
      researcher,
      spokenDraftText(readComposerDraft(drafts, researcher), 'look at this\nand this'),
    );

    expect(readComposerDraft(drafts, researcher)).toBe('check the logs look at this\nand this');
  });

  test('a thread holding nothing takes the shared text as its own characters', () => {
    const researcher = bot('researcher');
    const shared = '  log the  disk,  twice';
    let drafts = applyComposerDraft({}, researcher, '');

    drafts = applyComposerDraft(drafts, researcher, spokenDraftText(readComposerDraft(drafts, researcher), shared));

    // Untrusted input is not re-worded and not trimmed: what lands is what was
    // shared, for the operator to review before anything leaves the phone.
    expect(readComposerDraft(drafts, researcher)).toBe(shared);
  });

  test('the shared text lands under the thread it names and leaves another one alone', () => {
    const researcher = bot('researcher');
    const coder = bot('coder');
    let drafts = applyComposerDraft({}, coder, 'ship it');

    drafts = applyComposerDraft(
      drafts,
      researcher,
      spokenDraftText(readComposerDraft(drafts, researcher), 'look at this'),
    );

    expect(readComposerDraft(drafts, researcher)).toBe('look at this');
    expect(readComposerDraft(drafts, coder)).toBe('ship it');
  });

  test('a thread that reads as empty still records a reading, which is how the screen knows a load settled', () => {
    const researcher = bot('researcher');
    const drafts = applyComposerDraft({}, researcher, '');

    // The screen holds a shared text until the thread's own stored draft has
    // been read, and this is what tells it so: the key is present whatever the
    // reading was, so an empty stored draft is a reading like any other.
    expect(composerDraftKey(researcher) in drafts).toBe(true);
    expect(readComposerDraft(drafts, researcher)).toBe('');
  });
});

describe('the room composer draws the store draft, not one of its own', () => {
  test('the room is handed its draft and writes through the one writer it is given', () => {
    const room = readSource('src', 'components', 'chat', 'group-room-view.tsx');

    // A room that keeps its text in a useState loses it when the surface
    // unmounts, and no shared text could ever be written into it: the store is
    // what makes the room a thread like a Bot Chat. The room authors no draft
    // state and no storage of its own — it draws what it is handed.
    expect(room).toContain('draft: string;');
    expect(room).toContain('onDraftChange: (text: string) => void;');
    expect(room).not.toMatch(/const \[draft, setDraft\] = useState/);
    expect(room).not.toMatch(/saveComposerDraft|loadComposerDraft|composer-draft/);
  });

  test('the screen hands the room the same draft its thread key holds', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const call = between(screen, '<GroupRoomView', '\n            />');

    // One draft map for the whole screen: the room takes the value the chat
    // screen read off its own draft thread and writes through the screen's own
    // writer, so the shared-text handoff writes into the room by construction.
    expect(call).toContain('draft={draft}');
    expect(call).toContain('onDraftChange={setDraft}');
  });

  test('nothing on the room draft path sends', () => {
    const room = readSource('src', 'components', 'chat', 'group-room-view.tsx');

    // The store holds a draft; the room's own Send control is the only thing
    // that leaves the phone, and it is the operator's tap.
    expect(room).not.toMatch(/saveComposerDraft/);
  });
});

describe('the shared-text handoff reaches a room the way it reaches a Bot Chat', () => {
  test('the room takes an input handle and hands it to its one composer field', () => {
    const room = readSource('src', 'components', 'chat', 'group-room-view.tsx');

    // Iter-108 made the room's dock a thread of the same draft store, so a
    // shared text lands there — and the handoff that writes the words also
    // opens the field. The room hands that field over, the way ChatComposer
    // does; it authors no focus of its own, because the screen decides whether
    // a request applies at all.
    expect(room).toContain('inputRef?: Ref<TextFieldHandle>;');
    expect(room).toContain('inputRef,');
    expect(room).toContain('inputRef={inputRef}');
    expect(room).not.toContain('.focus()');
  });

  test('the screen hands the room the same handle the thread composer takes', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const call = between(screen, '<GroupRoomView', '\n            />');

    // One handle for the whole screen. Only one of the two composer surfaces is
    // ever mounted, so `composerInputRef.current` is the field of the surface
    // that is up — and the handoff's `focus()` reaches the room's dock exactly
    // as it reaches a Bot Chat's composer.
    expect(call).toContain('inputRef={composerInputRef}');
    expect((screen.match(/inputRef=\{composerInputRef\}/g) ?? []).length).toBe(2);
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
