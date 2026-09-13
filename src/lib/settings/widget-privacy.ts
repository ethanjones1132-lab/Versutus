// ─── The widget's privacy switch ──────────────────────────────────
// A device preference, not a gateway one: the widget draws on a locked home
// screen, so the operator can keep the newest result and the Bot names off it
// while the counts and the honest stamp stay. The fold reads it; the Settings
// screen writes it; a subscriber set lets a toggle reach the app's one write.

import { keyValueStorage } from '@/lib/storage/key-value';

export const WIDGET_RESULT_HIDDEN_STORAGE_KEY = 'versutus:widget-result-hidden';

export const WIDGET_PRIVACY_LABEL = 'Hide result text on the widget';

export const WIDGET_PRIVACY_SUMMARY =
  'Keeps the newest result and Bot names off the home screen. Counts and the written time stay.';

export function widgetResultHiddenFromStored(value: unknown): boolean {
  return value === true;
}

const listeners = new Set<() => void>();

/** Subscribe to preference changes; returns the unsubscribe. */
export function subscribeWidgetPrivacy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadWidgetResultHidden(): Promise<boolean> {
  try {
    const raw = await keyValueStorage.getItem(WIDGET_RESULT_HIDDEN_STORAGE_KEY);
    if (raw === null) return false;
    return widgetResultHiddenFromStored(JSON.parse(raw) as unknown);
  } catch {
    return false;
  }
}

export async function saveWidgetResultHidden(hidden: boolean): Promise<void> {
  try {
    await keyValueStorage.setItem(
      WIDGET_RESULT_HIDDEN_STORAGE_KEY,
      JSON.stringify(widgetResultHiddenFromStored(hidden)),
    );
  } finally {
    for (const listener of listeners) listener();
  }
}
