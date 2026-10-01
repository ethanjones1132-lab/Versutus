import { keyValueStorage } from '@/lib/storage/key-value';
import {
  WIDGET_RESULT_HIDDEN_STORAGE_KEY,
  loadWidgetResultHidden,
  saveWidgetResultHidden,
  subscribeWidgetPrivacy,
  widgetResultHiddenFromStored,
} from '@/lib/settings/widget-privacy';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const storage = keyValueStorage as jest.Mocked<typeof keyValueStorage>;

describe('the widget privacy preference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('only a stored true hides the result', () => {
    expect(widgetResultHiddenFromStored(true)).toBe(true);
    expect(widgetResultHiddenFromStored(false)).toBe(false);
    expect(widgetResultHiddenFromStored('true')).toBe(false);
    expect(widgetResultHiddenFromStored(undefined)).toBe(false);
  });

  test('a stored flag is read as a JSON boolean', async () => {
    storage.getItem.mockResolvedValue('true');
    await expect(loadWidgetResultHidden()).resolves.toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith(WIDGET_RESULT_HIDDEN_STORAGE_KEY);
  });

  test('saving writes the flag and wakes every subscriber', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeWidgetPrivacy(listener);
    await saveWidgetResultHidden(true);
    expect(storage.setItem).toHaveBeenCalledWith(WIDGET_RESULT_HIDDEN_STORAGE_KEY, 'true');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await saveWidgetResultHidden(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // The write used to be `try { await setItem } finally { notify }` with no
  // catch, so an unhappy AsyncStorage rejected into the `void`-ed call in
  // Settings: the Switch was already showing the new value and the preference
  // was not stored. The writer settles either way and says which happened.
  test('a stored write settles true, and the caller never has to catch', async () => {
    storage.setItem.mockResolvedValue(undefined);
    await expect(saveWidgetResultHidden(true)).resolves.toBe(true);
  });

  test('a refused write settles false rather than rejecting at the caller', async () => {
    storage.setItem.mockRejectedValue(new Error('The database is full'));
    await expect(saveWidgetResultHidden(true)).resolves.toBe(false);
  });

  test('a refused write still wakes the subscribers, which must re-read the store', async () => {
    storage.setItem.mockRejectedValue(new Error('The database is full'));
    const listener = jest.fn();
    const unsubscribe = subscribeWidgetPrivacy(listener);
    await expect(saveWidgetResultHidden(true)).resolves.toBe(false);
    // The fold reads the stored value, so a write that failed still has to wake
    // it — otherwise the widget keeps drawing what was there before.
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
