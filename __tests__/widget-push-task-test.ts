import * as TaskManager from 'expo-task-manager';

import * as widgetDevice from '@/lib/widget/widget-device';
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

  test('the defined background task survives a native failure and handles the next push', async () => {
    const [name, task] = jest.mocked(TaskManager.defineTask).mock.calls[0];
    expect(name).toBe(WIDGET_PUSH_TASK);
    const setPayload = jest.fn()
      .mockRejectedValueOnce(new Error('Native write failed'))
      .mockResolvedValue(true);
    const load = jest.spyOn(widgetDevice, 'loadAndroidWidgetModule')
      .mockResolvedValue({ setPayload, clearPayload: jest.fn() } as never);
    const body = {
      data: { widget: { v: 2 } },
      error: null,
      executionInfo: { eventId: 'widget-push-event', taskName: WIDGET_PUSH_TASK },
    };

    try {
      await expect(task(body)).resolves.toBeUndefined();
      await expect(task(body)).resolves.toBeUndefined();
      expect(setPayload).toHaveBeenCalledTimes(2);
      expect(setPayload).toHaveBeenLastCalledWith(JSON.stringify(body.data.widget));
      expect(TaskManager.defineTask).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });

  test('a message with no widget key carries no payload', () => {
    expect(widgetPayloadFromData({ kind: 'routine', jobId: 'j1' })).toBeNull();
    expect(widgetPayloadFromData(null)).toBeNull();
  });

  test('a widget payload is carried through as its JSON string', () => {
    const widget = { v: 2, status: 'Connected', connected: true, work: 'No runs in flight', approvalsPending: 0, writtenAt: 5 };
    expect(JSON.parse(widgetPayloadFromData({ widget }) ?? 'null')).toEqual(widget);
  });

  test('an unavailable native module writes nothing', async () => {
    await expect(handleWidgetPush({ widget: { v: 2 } }, async () => null)).resolves.toBe(false);
  });

  test('a native module load failure resolves without writing', async () => {
    const load = jest.fn(async () => { throw new Error('Module unavailable'); });
    await expect(handleWidgetPush({ widget: { v: 2 } }, load)).resolves.toBe(false);
  });

  test('a failed native write resolves and a later push can still write', async () => {
    const setPayload = jest.fn()
      .mockRejectedValueOnce(new Error('Native write failed'))
      .mockResolvedValue(true);
    const load = async () => ({ setPayload, clearPayload: jest.fn() }) as never;
    const data = { widget: { v: 2 } };

    await expect(handleWidgetPush(data, load)).resolves.toBe(false);
    await expect(handleWidgetPush(data, load)).resolves.toBe(true);
    expect(setPayload).toHaveBeenCalledTimes(2);
    expect(setPayload).toHaveBeenLastCalledWith(JSON.stringify(data.widget));
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
