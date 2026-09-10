import {
  APPROVAL_APPROVE_ACTION_ID,
  APPROVAL_CATEGORY_ID,
  APPROVAL_DENY_ACTION_ID,
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
 * The approval registration the module made, found by its identifier rather
 * than by call order: a later slice registers a second category from the same
 * entry point and must not have to re-time these assertions.
 */
function approvalRegistration(): [string, Notifications.NotificationAction[]] {
  const call = mockSetCategory.mock.calls.find(
    ([identifier]: [string]) => identifier === APPROVAL_CATEGORY_ID,
  );
  if (!call) throw new Error('the approval category was not registered');
  return call as [string, Notifications.NotificationAction[]];
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
    // work as expected." Action identifiers are kept to the same rule.
    const [identifier, actions] = approvalRegistration();
    for (const id of [identifier, ...actions.map((action) => action.identifier)]) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toMatch(/[:-]/);
    }
  });

  test('every action carries a button title an operator can act on', async () => {
    await registerNotificationCategories();

    const [, actions] = approvalRegistration();
    for (const action of actions) {
      expect(action.buttonTitle.trim().length).toBeGreaterThan(0);
    }
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
