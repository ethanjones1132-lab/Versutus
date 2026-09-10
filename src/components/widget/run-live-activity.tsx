// ─── A run's Live Activity target (§7's iOS half) ──────────────────────────
// Item 7's iOS surface: what the Lock Screen banner and the Dynamic Island draw
// while a run is in flight, written in `@expo/ui/swift-ui` and registered under
// the name the seam's factory is built with. It draws item 7a's props and
// nothing else — no gateway client, no read of its own, no clock of its own:
// every fact it shows arrived in its props, which is what lets a banner frozen
// since the process died still say when it was true.
//
// The extension bundles this module with `react`, `react-native` and
// `react-native-reanimated` stubbed out (expo-widgets/metro.config.js), so it
// reaches only for `@expo/ui/swift-ui`, `expo-widgets` and the pure fold beside
// it — never `@/lib/notifications/run-activity-device`, which owns the
// react-native import. Nothing imports this module statically: the seam is the
// only caller, on the first sync, so a client without the native side starts
// nothing rather than dying at boot.

import { Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';

import { RUN_ACTIVITY_NAME, type RunActivityProps } from '@/lib/notifications/run-activity';

/** The quietest line the banner draws: the stamp, and nothing else. */
const STAMP_STYLE = { type: 'hierarchical', style: 'secondary' } as const;

/**
 * The banner's body.
 *
 * The colours are the system's own — an activity is drawn over the operator's
 * wallpaper, so it takes the foreground style it is drawn in rather than a hex
 * from the app's dark palette, the same rule the Home widget's lines follow.
 *
 * The layout's environment is not read: every branch it offers (a reduced
 * luminance, a stale stamp, a smaller family) is a reason to drop a line, not to
 * re-word one, and what §7 asks the Lock Screen for is the run's own reading.
 * The smaller family's banner falls back to this one
 * (ios/Widgets/LiveActivityBanner.swift:11-14).
 *
 * The compact Dynamic Island's trailing region is the one place a line is drawn
 * alone: it carries the elapsed line and nothing else, because that is the
 * reading that moves while the run does. The line keeps item 7a's own words and
 * the system truncates what does not fit, rather than this layout abbreviating a
 * fact to fit — the line is on the banner above it in full.
 */
const RunLiveActivity = (props: RunActivityProps) => {
  'widget';

  return {
    banner: (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ weight: 'semibold', size: 15 }), lineLimit(1)]}>{props.status}</Text>
        {props.elapsed ? (
          <Text modifiers={[font({ size: 13 }), lineLimit(1)]}>{props.elapsed}</Text>
        ) : null}
        {props.step ? (
          <Text modifiers={[font({ size: 13 }), lineLimit(2)]}>{props.step}</Text>
        ) : null}
        <Text modifiers={[font({ size: 11 }), foregroundStyle(STAMP_STYLE), lineLimit(1)]}>
          {props.updated}
        </Text>
      </VStack>
    ),
    compactTrailing: props.elapsed ? (
      <Text modifiers={[font({ size: 12 }), lineLimit(1)]}>{props.elapsed}</Text>
    ) : null,
    expandedBottom: (
      <VStack alignment="leading" spacing={2}>
        {props.step ? (
          <Text modifiers={[font({ size: 13 }), lineLimit(2)]}>{props.step}</Text>
        ) : null}
        <Text modifiers={[font({ size: 11 }), foregroundStyle(STAMP_STYLE), lineLimit(1)]}>
          {props.updated}
        </Text>
      </VStack>
    ),
  };
};

export default createLiveActivity(RUN_ACTIVITY_NAME, RunLiveActivity);
