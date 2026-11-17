// ─── Calling a chat that has nothing in it yet (VS-124) ─────────────────────
// Tapping Call in a brand-new chat — or in a Bot Chat opened for the first time
// — used to answer "send a message first, then start the call", and a chat whose
// session was still being read was refused the same way. The conversation is
// now resolved before the call starts (bounded), the Gate opens one when the
// phone has none, and the id it names is adopted so the call's transcript lands
// in that chat and the next typed message continues it.
//
// The pure decisions are pinned here; the wiring that uses them is pinned by
// the source checks at the end, because the call itself is the provider's.

import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import {
  HANDSFREE_CALL_PREPARING_COPY,
  handsfreeStartResultCopy,
} from '@/lib/voice/handsfree-call-copy';
import {
  adoptedCallSessionId,
  CALL_SESSION_READY_MS,
  resolveCallThreadSession,
} from '@/lib/voice/call-session';
import { evaluateHandsfreeStart } from '@/lib/voice/handsfree-start-reason';
import { composerDraftKey, composerDraftThread } from '@/lib/gateway/composer-draft';
import {
  adoptTurnSession,
  clearThreadSessionPin,
  readThreadSessionPin,
  sessionlessThreadKey,
  threadSessionPinsFromUnknown,
  writeThreadSessionPin,
} from '@/lib/gateway/thread-session-pins';

// The pins are storage-backed in the app; the decisions are what this file
// tests, so the store is a stub here.
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    // Both are CRLF on disk; the assertions below are about content, not line
    // endings.
    .replace(/\r\n/g, '\n');
}

const gateStart = {
  phase: 'idle',
  appState: 'active',
  status: 'connected',
  gatewayId: 'gw-home',
  targetGatewayId: 'gw-home',
  isSending: false,
  isCommandRunning: false,
  pendingRunApproval: false,
  moduleLoaded: true,
  availability: null,
  transport: 'gate' as const,
  gatewayUrl: 'http://127.0.0.1:8760',
  sessionId: 'ses-open',
};

describe('a chat with no session is prepared, never refused', () => {
  test('the Gate start decision does not stop on a missing session', () => {
    expect(evaluateHandsfreeStart({ ...gateStart, sessionId: '' })).toEqual({ kind: 'gate' });
    // And the copy that would carry the refusal can no longer tell anyone to
    // type first (VS-124 item 4).
    expect(handsfreeStartResultCopy('no-session')).not.toMatch(/send a message|message first/i);
  });

  test('the preparing line is the one the sheet shows while it works', () => {
    expect(HANDSFREE_CALL_PREPARING_COPY).toBe('Getting this chat ready…');
    expect(CALL_SESSION_READY_MS).toBeLessThanOrEqual(5_000);
  });

  test('an existing session is used at once and nothing is opened', async () => {
    const open = jest.fn(async () => 'ses-new');
    await expect(resolveCallThreadSession({
      current: () => 'ses-open',
      resolving: () => true,
      open,
    })).resolves.toBe('ses-open');
    expect(open).not.toHaveBeenCalled();
  });

  test('a session that is still resolving is waited on, then used', async () => {
    let clock = 0;
    const landedAt = 240;
    const started = resolveCallThreadSession(
      {
        current: () => (clock >= landedAt ? 'ses-landed' : undefined),
        resolving: () => true,
        open: async () => 'ses-opened',
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    await expect(started).resolves.toBe('ses-landed');
  });

  test('a read that never lands does not refuse the call: the Gate opens the chat', async () => {
    let clock = 0;
    const open = jest.fn(async () => undefined);
    const session = await resolveCallThreadSession(
      { current: () => undefined, resolving: () => true, open },
      {
        readyMs: 500,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    // The wait was bounded by the budget the sheet advertises, and the start
    // went ahead with no session rather than refusing.
    expect(session).toBeUndefined();
    expect(clock).toBeGreaterThanOrEqual(500);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test('a chat that is not being read is not waited on at all', async () => {
    const sleep = jest.fn(async () => undefined);
    await resolveCallThreadSession(
      { current: () => undefined, resolving: () => false, open: async () => 'ses-opened' },
      { sleep, now: () => 0 },
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  test('none of the ways the prepare can fail is a throw', async () => {
    await expect(resolveCallThreadSession({
      current: () => undefined,
      resolving: () => false,
      open: async () => {
        throw new Error('the PC is not answering');
      },
    })).resolves.toBeUndefined();
  });

  test('a conversation this chat opened while it was elsewhere is reused, not duplicated', async () => {
    const open = jest.fn(async () => 'ses-duplicate');
    await expect(resolveCallThreadSession({
      current: () => undefined,
      resolving: () => false,
      pinned: () => 'ses-earlier',
      open,
    })).resolves.toBe('ses-earlier');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('the call adopts the conversation the Gate opened for it', () => {
  const target = {
    label: 'Versutus chat',
    surfaceKind: 'configurable' as const,
    sessionId: '',
  };

  test('a call started in an empty chat adopts the id the Gate returns', async () => {
    let media: string | undefined;
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => ({
        voiceSessionId: 'vs-1',
        streamPath: '/v1/voice/stream',
        chatSessionId: 'ses-call',
      }),
      startGateMedia: async (options) => {
        media = options.voiceSessionId;
        return true;
      },
      log: () => undefined,
    });

    expect(attempt.result).toBe('started');
    expect(media).toBe('vs-1');
    const adopted = adoptedCallSessionId({ sent: target.sessionId, returned: attempt.grant?.chatSessionId });
    expect(adopted).toBe('ses-call');
    // A call that already spoke into a known chat adopts nothing new: the
    // thread it started on stays exactly that thread.
    expect(adoptedCallSessionId({ sent: 'ses-open', returned: attempt.grant?.chatSessionId })).toBeUndefined();
  });
});

describe('the chat a first reply was sent from keeps its session', () => {
  const chatA = { gatewayId: 'gw-home' };
  const chatB = { gatewayId: 'gw-home', botId: 'researcher' };

  test('a reply that arrives after the operator left is kept for the chat it came from', () => {
    expect(adoptTurnSession({ sent: chatA, open: chatB, sessionId: 'ses-a' })).toBe('pin');
    expect(adoptTurnSession({ sent: chatB, open: chatA, sessionId: 'ses-b' })).toBe('pin');
    // Still on the same chat: the id is adopted as the live session, as before.
    expect(adoptTurnSession({ sent: chatA, open: chatA, sessionId: 'ses-a' })).toBe('adopt');
    // A gateway switch is leaving the chat too.
    expect(adoptTurnSession({ sent: chatA, open: { gatewayId: 'gw-other' }, sessionId: 'ses-a' })).toBe('pin');
  });

  test('the pin is filed under the chat’s own thread key, so reopening it finds the session', () => {
    const pins = writeThreadSessionPin({}, chatA, 'ses-a');
    expect(readThreadSessionPin(pins, chatA)).toBe('ses-a');
    // The other chat is untouched: one conversation never answers for another.
    expect(readThreadSessionPin(pins, chatB)).toBeUndefined();
    expect(readThreadSessionPin(writeThreadSessionPin(pins, chatB, 'ses-b'), chatA)).toBe('ses-a');

    // The key is the composer's own key for that sessionless thread, so the
    // screen that reopens the chat asks the same question the send did.
    const draft = composerDraftThread({ gatewayId: chatA.gatewayId, surface: { kind: 'configurable' }, sessionId: undefined })!;
    expect(sessionlessThreadKey(chatA)).toBe(composerDraftKey(draft));
    const botDraft = composerDraftThread({ gatewayId: chatB.gatewayId, surface: { kind: 'bot', botId: 'researcher' }, sessionId: undefined })!;
    expect(sessionlessThreadKey(chatB)).toBe(composerDraftKey(botDraft));
  });

  test('the pin is spent once adopted, and a deliberate new thread clears it', () => {
    const pins = writeThreadSessionPin({}, chatA, 'ses-a');
    expect(clearThreadSessionPin(pins, chatA)).toEqual({});
    // Only a real session is a pin; anything else is an empty store, never a throw.
    expect(threadSessionPinsFromUnknown({ 'gw-home:configurable:': 'ses-a', other: 42, blank: '  ' }))
      .toEqual({ 'gw-home:configurable:': 'ses-a' });
    expect(threadSessionPinsFromUnknown('not an object')).toEqual({});
  });
});

describe('the wiring that uses those decisions', () => {
  const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
  const provider = readSource('src', 'context', 'gateway-provider.tsx');

  test('the screen prepares the chat before it starts, and adopts what the Gate opened', () => {
    expect(screen).toContain('await prepareCallSession?.()');
    expect(screen).toContain("gatewayRequest<{ sessionId?: string | null }>(\n        'voice.session.chat',");
    // The adopted id waits for the call to end, because the provider ends a
    // live call whose session changes under it.
    expect(screen).toContain('setPendingCallSession(adopt)');
    expect(screen).toContain('adoptThreadSession?.(pendingCallSession)');
    // No path in the sheet can show the "send a message first" dead end.
    expect(screen).not.toContain("handsfreeStartResultCopy('no-session')");
  });

  test('a reply’s session is adopted only while its own chat is open', () => {
    expect(provider).toContain("adoptTurnSession({ sent: sentThread, open: openThread, sessionId }) === 'pin'");
    expect(provider).toContain('rememberThreadSession(sentThread, sessionId)');
    // The chat that left adopts its kept session when it is opened again.
    expect(screen).toContain('resumeThreadSession()');
  });
});
