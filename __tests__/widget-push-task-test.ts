import {
  handleWidgetPush,
  WIDGET_PUSH_TASK,
  widgetPayloadFromData,
} from '@/lib/widget/widget-push-task';

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('expo-notifications', () => ({ registerTaskAsync: jest.fn(async () => undefined) }));

describe('the widget push task', () => {
  test('is registered under the name the notifier kind addresses', () => {
    expect(WIDGET_PUSH_TASK).toBe('versutus-widget-push');
  });

  test('a message with no widget key carries no payload', () => {
    expect(widgetPayloadFromData({ kind: 'routine', jobId: 'j1' })).toBeNull();
    expect(widgetPayloadFromData(null)).toBeNull();
  });

  test('a widget payload is carried through as its JSON string', () => {
    const widget = { v: 2, status: 'Connected', connected: true, work: 'No runs in flight', approvalsPending: 0, writtenAt: 5 };
    expect(JSON.parse(widgetPayloadFromData({ widget }) ?? 'null')).toEqual(widget);
  });

  test('a valid payload is written to the Glance module; an absent one writes nothing', async () => {
    const setPayload = jest.fn(async () => true);
    const load = jest.fn(async () => ({ setPayload, clearPayload: jest.fn() }) as never);
    const widget = { v: 2, status: 'Connected', connected: true, work: 'No runs in flight', approvalsPending: 0, writtenAt: 5 };

    await expect(handleWidgetPush({ widget }, load)).resolves.toBe(true);
    expect(setPayload).toHaveBeenCalledWith(JSON.stringify(widget));

    setPayload.mockClear();
    await expect(handleWidgetPush({ kind: 'reply' }, load)).resolves.toBe(false);
    expect(setPayload).not.toHaveBeenCalled();
  });
});
