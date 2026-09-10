import { AppState } from 'react-native';

import {
  botReplyFromResponse,
  botReplyNoticeCopy,
} from '@/lib/notifications/bot-reply';
import {
  BOT_MESSAGE_CATEGORY_ID,
  BOT_MESSAGE_REPLY_ACTION_ID,
} from '@/lib/notifications/categories';
import { notifyBotReplyNotSent } from '@/lib/notifications/local';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;

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

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

const layout = () => readSource('src', 'app', '_layout.tsx');

/** The response listener body — where a reply action is read. */
const listener = () =>
  between(
    between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter'),
    'addNotificationResponseReceivedListener',
    'return () => subscription.remove()',
  );

/** The module-level send helper the listener hands a reply to. */
const delivery = () => between(layout(), 'async function deliverBotReply', 'function NotificationRouter');

/** The payload the notice producer will write: the Bot and the session it was about. */
const payload = (botId: unknown, sessionId: unknown) => ({ botId, sessionId });

describe('botReplyFromResponse (the payload contract and the typed text)', () => {
  test('a well-shaped payload and typed text make a reply for that Bot Chat', () => {
    expect(botReplyFromResponse(payload('scout', 'sess-1'), 'on my way')).toEqual({
      botId: 'scout',
      sessionId: 'sess-1',
      text: 'on my way',
    });
  });

  test('the text is the response text, trimmed — never anything in the payload', () => {
    // The typed text arrives beside the action identifier (expo v57
    // NotificationResponse.userText), so a payload carrying a `text` field of
    // its own must not become the reply.
    const withPayloadText = { ...payload('scout', 'sess-1'), text: 'not the operator' };

    expect(botReplyFromResponse(withPayloadText, '  the operator  ')).toEqual({
      botId: 'scout',
      sessionId: 'sess-1',
      text: 'the operator',
    });
  });

  test('nothing typed is not a reply', () => {
    // A reply is never fabricated: whitespace-only text is no message at all.
    expect(botReplyFromResponse(payload('scout', 'sess-1'), '')).toBeNull();
    expect(botReplyFromResponse(payload('scout', 'sess-1'), '   ')).toBeNull();
    expect(botReplyFromResponse(payload('scout', 'sess-1'), '\n\t ')).toBeNull();
  });

  test('text that is not text is not a reply', () => {
    expect(botReplyFromResponse(payload('scout', 'sess-1'), undefined)).toBeNull();
    expect(botReplyFromResponse(payload('scout', 'sess-1'), null)).toBeNull();
    expect(botReplyFromResponse(payload('scout', 'sess-1'), 7)).toBeNull();
  });

  test('a half-shaped payload names no destination, so nothing is sent', () => {
    // The same rule routeForTap applies to a half-shaped route: an id this app
    // cannot read is not an id, and guessing one would post the operator's text
    // to another conversation.
    expect(botReplyFromResponse(payload('scout', undefined), 'hi')).toBeNull();
    expect(botReplyFromResponse(payload(undefined, 'sess-1'), 'hi')).toBeNull();
    expect(botReplyFromResponse(payload('', 'sess-1'), 'hi')).toBeNull();
    expect(botReplyFromResponse(payload('scout', ''), 'hi')).toBeNull();
    expect(botReplyFromResponse(payload(7, 'sess-1'), 'hi')).toBeNull();
    expect(botReplyFromResponse(payload('scout', null), 'hi')).toBeNull();
  });

  test('a payload that is not an object is not a destination', () => {
    expect(botReplyFromResponse(undefined, 'hi')).toBeNull();
    expect(botReplyFromResponse(null, 'hi')).toBeNull();
    expect(botReplyFromResponse('scout', 'hi')).toBeNull();
    expect(botReplyFromResponse(42, 'hi')).toBeNull();
    expect(botReplyFromResponse({}, 'hi')).toBeNull();
  });

  test('another notice payload is not a bot-message payload', () => {
    // A routine notice names a Bot but no session; an approval names a run.
    expect(botReplyFromResponse({ kind: 'routine', jobId: 'job-1', botId: 'scout' }, 'hi')).toBeNull();
    expect(botReplyFromResponse({ kind: 'approval', runId: 'run-7', gatewayKey: 'gw-a' }, 'hi')).toBeNull();
  });
});

describe('botReplyNoticeCopy (one table, two honest notices)', () => {
  test('a queued reply says it is saved, not that it was delivered', () => {
    const copy = botReplyNoticeCopy('queued');

    expect(copy.title).toBe('Reply queued');
    expect(copy.body).toContain('saved');
    // No delivery claim and no count.
    expect(copy.body).not.toMatch(/\d/);
    expect(copy.body).not.toContain('delivered');
  });

  test('a reply whose Bot Chat could not be opened claims nothing about the Bot', () => {
    const copy = botReplyNoticeCopy('bot-chat-unavailable');

    expect(copy.title).toBe('Reply not sent');
    expect(copy.body).toContain("couldn't open this Bot's chat");
    // It is the app that could not open the chat, and the copy says only that.
    expect(copy.body).not.toMatch(/\d/);
    expect(copy.body).not.toContain('delivered');
  });
});

// present() refuses to post while the app is foregrounded, so the notice tests
// below pin AppState away from 'active'.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

const grantedPermissions = { granted: true, status: 'granted' };

describe('notifyBotReplyNotSent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue(grantedPermissions);
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('a queued reply is an immediate notice carrying the table copy', async () => {
    await notifyBotReplyNotSent('queued');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe(botReplyNoticeCopy('queued').title);
    expect(request.content.body).toBe(botReplyNoticeCopy('queued').body);
    expect(request.trigger).toBeNull();
  });

  test('a reply that was not sent says so, with no buttons and no payload', async () => {
    await notifyBotReplyNotSent('bot-chat-unavailable');

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.title).toBe('Reply not sent');
    // No category: the follow-up offers no second text input. No data: a tap
    // on it can never be read back as a notice of its own (routeForTap).
    expect(request.content.categoryIdentifier).toBeUndefined();
    expect(request.content.data).toBeUndefined();
    expect(request.trigger).toBeNull();
  });

  test('a follow-up posted while the app is foregrounded is suppressed, like every local notice', async () => {
    setAppState('active');

    await notifyBotReplyNotSent('queued');
    await notifyBotReplyNotSent('bot-chat-unavailable');

    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('NotificationRouter quick-reply wiring', () => {
  test('the reply action, the payload and the typed text are read in the listener', () => {
    const src = listener();

    expect(src).toContain('BOT_MESSAGE_REPLY_ACTION_ID');
    expect(src).toContain('botReplyFromResponse(');
    expect(src).toContain('response.userText');
  });

  test('the reply is handed to the provider send path, not a parallel one', () => {
    const src = delivery();

    // Open the Bot's canonical Bot Chat first, then send through the same call
    // the chat composer uses.
    const open = src.indexOf('sender.openBot(reply.botId)');
    const send = src.indexOf('sender.sendChatInput(reply.text)');
    expect(open).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(open);
    // No second pipeline: no client, no HTTP, no notice-as-a-send, and no
    // touching the outbox directly — the queued fallback is the send call's own.
    expect(src).not.toContain('clientRef');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('gatewayRequest');
    expect(src).not.toContain('queueOfflineInput');
    expect(src).not.toContain('saveOfflineQueue');
  });

  test('a Bot Chat that cannot be opened sends nothing and says so', () => {
    const src = delivery();

    const catchAt = src.indexOf('} catch {');
    const refusal = src.indexOf("notifyBotReplyNotSent('bot-chat-unavailable')");
    const send = src.indexOf('sender.sendChatInput(reply.text)');
    expect(catchAt).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(catchAt);
    // The refusal returns before the send: an unopened Bot Chat means the send
    // would land in whichever session the client still held.
    expect(src.indexOf('return;', catchAt)).toBeLessThan(send);
  });

  test('only the send path decides that a reply had to be queued', () => {
    const src = delivery();

    expect(src).toContain("if (outcome === 'queued') void notifyBotReplyNotSent('queued');");
  });

  test('the connection rule is the approval path rule, applied before the open', () => {
    const src = delivery();

    const gate = src.indexOf('decisionCanReachGateway(status)');
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf('sender.openBot(reply.botId)')).toBeGreaterThan(gate);
    // The live status is read from the same ref the decision path reads.
    expect(listener()).toContain('deliverBotReply(reply, sender, statusRef.current)');
  });

  test('a reply is taken ahead of the tap destination, after the approval decision', () => {
    const src = listener();

    const decision = src.indexOf('const decision = approvalDecisionFor(');
    const reply = src.indexOf('BOT_MESSAGE_REPLY_ACTION_ID');
    const destination = src.indexOf('const destination = destinationFor(');
    expect(decision).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(decision);
    expect(reply).toBeLessThan(destination);
  });

  test('an unusable reply falls through to the tap destination rather than vanishing', () => {
    const src = listener();

    // The guard is `if (reply && sender) { ...; return; }`, so a reply action
    // with nothing to send keeps the ordinary Activity fallback.
    expect(src).toContain('if (reply && sender) {');
    expect(src).toContain('return;');
  });

  test('the send path is mirrored into a ref, so the listener is still registered once', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');

    expect(src).toContain('replySenderRef.current = { openBot, sendChatInput, requestSurface }');
    const listenerEnd = src.slice(src.indexOf('addNotificationResponseReceivedListener'));
    expect(listenerEnd).toContain('}, [router, isBootstrapped]);');
  });

  test('the reply action belongs to the bot-message category, not the approval one', () => {
    // The approval decision table must never read 'reply' as a decision.
    expect(BOT_MESSAGE_CATEGORY_ID).not.toBe('approval');
    expect(BOT_MESSAGE_REPLY_ACTION_ID).toBe('reply');
  });
});
