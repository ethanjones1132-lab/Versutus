// ─── The glanceable widget's target ───────────────────────────────
// Item 4b of FUTURE-ITEMS.md §4: the React component the widget extension
// renders, written in `@expo/ui/swift-ui` and registered under the name the
// plugin entry carries. It draws item 4a's snapshot and nothing else — no
// gateway client, no read of its own, no clock of its own: every fact it shows
// arrived in its props, which is what lets a snapshot frozen since the last
// write still say when it was written.
//
// The extension bundles this module with `react`, `react-native` and
// `react-native-reanimated` stubbed out (expo-widgets/metro.config.js), so it
// reaches only for `@expo/ui/swift-ui`, `expo-widgets` and the pure fold beside
// it — never `@/lib/widget/widget-device`, which owns the react-native import.
// Nothing imports this module statically: the seam is the only caller, on the
// first write, so a client without the native side draws nothing rather than
// dying at boot.

import { Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import { glanceableWidgetLines, WIDGET_NAME } from '@/lib/widget/widget-target';

/** The quietest line the widget draws: the stamp, and nothing else. */
const STAMP_STYLE = { type: 'hierarchical', style: 'secondary' } as const;

/**
 * The widget body. The second argument is the layout's environment, used only
 * to drop the newest outcome in the small family: four stacked lines do not fit
 * a 2x2 square, and the lines that stay are the ones that are actually waiting
 * on someone. The colours are the system's own — a widget is drawn over the
 * operator's wallpaper, so it takes the foreground style it is drawn in rather
 * than a hex from the app's dark palette.
 */
const GlanceableWidget = (props: GlanceableSnapshot, environment: WidgetEnvironment) => {
  'widget';

  const lines = glanceableWidgetLines(props);
  const hasRoomForResult = environment.widgetFamily !== 'systemSmall';

  return (
    <VStack alignment="leading" spacing={4}>
      <Text modifiers={[font({ weight: 'semibold', size: 15 }), lineLimit(1)]}>{lines.status}</Text>
      <Text modifiers={[font({ size: 13 }), lineLimit(1)]}>{lines.work}</Text>
      {lines.result && hasRoomForResult ? (
        <Text modifiers={[font({ size: 13 }), lineLimit(2)]}>{lines.result}</Text>
      ) : null}
      <Text modifiers={[font({ size: 11 }), foregroundStyle(STAMP_STYLE), lineLimit(1)]}>
        {lines.written}
      </Text>
    </VStack>
  );
};

export default createWidget(WIDGET_NAME, GlanceableWidget);
