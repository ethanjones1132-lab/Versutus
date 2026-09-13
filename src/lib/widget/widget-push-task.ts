// ─── The widget's push-carried snapshot ───────────────────────────
// A data-only push (the Gate's M3 companion message) can update the widget
// while the app is closed. Android delivers only data-only messages to a
// headless background task (expo-notifications v57), and Doze may delay them —
// which is fine: the card always stamps the data it is showing.

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { loadAndroidWidgetModule, type AndroidWidgetModule } from '@/lib/widget/widget-device';

/** The task name the Gate's companion message is delivered under. */
export const WIDGET_PUSH_TASK = 'versutus-widget-push';

/** The v2 widget payload in a notification's data, as JSON, or null when it carries none. */
export function widgetPayloadFromData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const widget = (data as Record<string, unknown>).widget;
  if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return null;
  return JSON.stringify(widget);
}

/** Hand a push message's widget payload to the Glance module; true when one was written. */
export async function handleWidgetPush(
  data: unknown,
  load: () => Promise<AndroidWidgetModule | null> = loadAndroidWidgetModule,
): Promise<boolean> {
  const payload = widgetPayloadFromData(data);
  if (!payload) return false;
  const module = await load();
  if (!module) return false;
  await module.setPayload(payload);
  return true;
}

TaskManager.defineTask(WIDGET_PUSH_TASK, async ({ data }) => {
  await handleWidgetPush(data);
});

/** Ask Android to run the task for data-only pushes. */
export async function registerWidgetPushTask(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.registerTaskAsync(WIDGET_PUSH_TASK);
}
