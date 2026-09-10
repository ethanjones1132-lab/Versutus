import {
  APPROVAL_APPROVE_ACTION_ID,
  APPROVAL_CATEGORY_ID,
  APPROVAL_DENY_ACTION_ID,
  BOT_MESSAGE_CATEGORY_ID,
  BOT_MESSAGE_REPLY_ACTION_ID,
  registerNotificationCategories,
} from '@/lib/notifications/categories';

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

const layout = () => readSource('src', 'app', '_layout.tsx');

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

const mockSetCategory = Notifications.setNotificationCategoryAsync as jest.Mock;

/**
 * The registration the module made for `identifier`, found by its identifier
 * rather than by call order: a later slice registers a further category from
 * the same entry point and must not have to re-time these assertions.
 */
function categoryRegistration(identifier: string): [string, Notifications.NotificationAction[]] {
  const call = mockSetCategory.mock.calls.find(
    ([registered]: [string]) => registered === identifier,
  );
  if (!call) throw new Error(`the ${identifier} category was not registered`);
  return call as [string, Notifications.NotificationAction[]];
}

function approvalRegistration(): [string, Notifications.NotificationAction[]] {
  return categoryRegistration(APPROVAL_CATEGORY_ID);
}

function botMessageRegistration(): [string, Notifications.NotificationAction[]] {
  return categoryRegistration(BOT_MESSAGE_CATEGORY_ID);
}

describe('registerNotificationCategories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetCategory.mockResolvedValue({ identifier: APPROVAL_CATEGORY_ID, actions: [] });
  });

  test('registers the approval category with its approve and deny actions', async () => {
    await registerNotificationCategories();

    const [identifier, actions] = approvalRegistration();
    expect(identifier).toBe('approval');
    expect(actions.map((action) => action.identifier)).toEqual([
      APPROVAL_APPROVE_ACTION_ID,
      APPROVAL_DENY_ACTION_ID,
    ]);
  });

  test('both approval actions decide without foregrounding the app', async () => {
    await registerNotificationCategories();

    // The point of the category is deciding from the banner; `true` here
    // would open the app on every button press and defeat it.
    const [, actions] = approvalRegistration();
    for (const action of actions) {
      expect(action.options?.opensAppToForeground).toBe(false);
    }
  });

  test('deny is destructive and approve is not', async () => {
    await registerNotificationCategories();

    const [, actions] = approvalRegistration();
    const approve = actions.find((action) => action.identifier === APPROVAL_APPROVE_ACTION_ID);
    const deny = actions.find((action) => action.identifier === APPROVAL_DENY_ACTION_ID);
    expect(deny?.options?.isDestructive).toBe(true);
    expect(approve?.options?.isDestructive).toBeUndefined();
  });

  test('every identifier avoids the characters expo says break category matching', async () => {
    await registerNotificationCategories();

    // Expo v57 docs, setNotificationCategoryAsync: "Don't use the characters
    // `:` or `-` in your category identifier. If you do, categories might not
    // work as expected." Action identifiers are kept to the same rule — and so
    // is the bot-message category, which is why its id is one bare word rather
    // than the dashed name the spec describes it by.
    const registrations = [
      categoryRegistration(APPROVAL_CATEGORY_ID),
      categoryRegistration(BOT_MESSAGE_CATEGORY_ID),
    ];
    for (const [identifier, actions] of registrations) {
      for (const id of [identifier, ...actions.map((action) => action.identifier)]) {
        expect(id.length).toBeGreaterThan(0);
        expect(id).not.toMatch(/[:-]/);
      }
    }
  });

  test('every action carries a button title an operator can act on', async () => {
    await registerNotificationCategories();

    const [, actions] = approvalRegistration();
    for (const action of actions) {
      expect(action.buttonTitle.trim().length).toBeGreaterThan(0);
    }
  });

  test('registers the bot-message category with one reply action', async () => {
    await registerNotificationCategories();

    const [identifier, actions] = botMessageRegistration();
    expect(identifier).toBe('botmessage');
    expect(actions.map((action) => action.identifier)).toEqual([BOT_MESSAGE_REPLY_ACTION_ID]);
    expect(actions[0].buttonTitle.trim().length).toBeGreaterThan(0);
  });

  test('the reply action asks for text with a placeholder and a submit title', async () => {
    await registerNotificationCategories();

    // Both fields are required by NotificationAction.textInput; on Android the
    // placeholder is the one the native record insists on, and iOS adds the
    // submit button title on top of it.
    const [, actions] = botMessageRegistration();
    const reply = actions[0];
    expect(reply.textInput?.placeholder.trim().length).toBeGreaterThan(0);
    expect(reply.textInput?.submitButtonTitle.trim().length).toBeGreaterThan(0);
  });

  test('a reply foregrounds the app, where the Bot Chat send path lives', async () => {
    await registerNotificationCategories();

    // The approval buttons deliberately decide without foregrounding; a reply
    // is the other way round. expo v57 NotificationAction.options: with `false`
    // and the app killed, "NotificationResponseReceived listeners will not be
    // triggered when a user selects this action" — so a non-foregrounding reply
    // would silently swallow the text the operator typed.
    const [, actions] = botMessageRegistration();
    expect(actions[0].options?.opensAppToForeground).toBe(true);
    expect(actions[0].options?.isDestructive).toBeUndefined();
  });

  test('the two categories keep their own actions', async () => {
    await registerNotificationCategories();

    // The approval category must not gain a text field, and the reply must not
    // wear the approval's identifiers: one category, one kind of answer.
    const [, approvalActions] = approvalRegistration();
    const [, botMessageActions] = botMessageRegistration();
    expect(APPROVAL_CATEGORY_ID).not.toBe(BOT_MESSAGE_CATEGORY_ID);
    expect(approvalActions.every((action) => action.textInput === undefined)).toBe(true);
    expect(botMessageActions.map((action) => action.identifier)).not.toContain(
      APPROVAL_APPROVE_ACTION_ID,
    );
  });

  test('a platform where categories are unavailable does not fail the boot', async () => {
    // setNotificationCategoryAsync is @platform android/ios in expo v57, and
    // the web stub throws UnavailabilityError — a boot must not crash over a
    // button that platform cannot show.
    mockSetCategory.mockRejectedValue(new Error('Notifications.setNotificationCategoryAsync is not available'));

    await expect(registerNotificationCategories()).resolves.toBeUndefined();
  });
});

describe('the startup registration', () => {
  test('the router registers the categories at startup, from the categories module', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('registerNotificationCategories()');
    expect(layout()).toContain('@/lib/notifications/categories');
  });
});
