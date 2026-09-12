// ─── The glanceable widget's target on Android ────────────────────
// Item 4 of FUTURE-ITEMS.md §4: the sibling of `glanceable-widget.tsx`, the
// React component the Android widget renders, written in
// `@expo/ui/jetpack-compose` and registered under the same name the plugin
// entry carries. It draws item 4a's snapshot and nothing else — no gateway
// client, no read of its own, no clock of its own: every fact it shows arrived
// in its props, which is what lets a snapshot frozen since the last write still
// say when it was written.
//
// The extension bundles this module with React, React Native and reanimated
// stubbed out (expo-widgets/metro.config.js), so it reaches only for
// `@expo/ui/jetpack-compose`, `expo-widgets` and the pure fold beside it —
// never `@/lib/widget/widget-device`, which owns the React Native import.
// Nothing imports this module statically: the seam is the only caller, on the
// first write, so a client without the native side draws nothing rather than
// dying at boot.
//
// Colours are the system's own: a widget is drawn over the operator's
// wallpaper, so it leaves the Glance theme's foreground in place rather than a
// hex from the app's dark palette. Nothing here hands a `color` to a `Text`;
// the stamp is de-emphasized by size alone.

import { Column, Text } from '@expo/ui/jetpack-compose';
import { createWidget } from 'expo-widgets';

import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import { glanceableWidgetLines, WIDGET_NAME } from '@/lib/widget/widget-target';

/**
 * The widget body: the same four lines, order and sizes as the iOS sibling.
 * The status word, the work line, the newest outcome when the fold emits one,
 * and the stamp. There is no family gate here — `widgetFamily` is iOS
 * vocabulary, and the plugin entry's 4x2 cell target is exactly the room the
 * result line needs.
 */
const GlanceableWidget = (props: GlanceableSnapshot) => {
  'widget';

  const lines = glanceableWidgetLines(props);

  return (
    <Column horizontalAlignment="start">
      <Text style={{ fontSize: 15, fontWeight: '600' }} maxLines={1}>
        {lines.status}
      </Text>
      <Text style={{ fontSize: 13 }} maxLines={1}>
        {lines.work}
      </Text>
      {lines.result ? (
        <Text style={{ fontSize: 13 }} maxLines={2}>
          {lines.result}
        </Text>
      ) : null}
      <Text style={{ fontSize: 11 }} maxLines={1}>
        {lines.written}
      </Text>
    </Column>
  );
};

export default createWidget(WIDGET_NAME, GlanceableWidget);
