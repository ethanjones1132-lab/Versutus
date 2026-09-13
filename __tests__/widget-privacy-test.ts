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
});
