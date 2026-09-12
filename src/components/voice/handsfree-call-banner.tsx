// ─── The in-call banner ────────────────────────────────────────────────────
// Drawn for the whole call, as a sibling of the root Stack, so every in-app
// route keeps Mute, Skip reply and End. It is unmistakably separate from the
// composer: the permanent "speech auto-sends" label states what the call does,
// and the transcript never passes through the composer writer.

import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface, PressableScale, Text } from '@/components/ui';
import { HandsfreeCallIndicator } from '@/components/voice/handsfree-call-indicator';
import { Radius, Spacing } from '@/constants/tokens';
import { useHandsfreeVoice } from '@/context/handsfree-voice-provider';
import { useTokens } from '@/hooks/use-tokens';
import {
  HANDSFREE_AUTOSEND_LABEL,
  HANDSFREE_BANNER_TITLE,
  HANDSFREE_END_LABEL,
  HANDSFREE_MUTE_LABEL,
  HANDSFREE_SKIP_LABEL,
  HANDSFREE_SPEAKING_HINT,
  HANDSFREE_UNMUTE_LABEL,
  handsfreePhaseLabel,
} from '@/lib/voice/handsfree-call-copy';

export function HandsfreeCallBanner() {
  const { active, phase, partial, label, level, mute, unmute, skipReply, end } =
    useHandsfreeVoice();
  const tokens = useTokens();
  const insets = useSafeAreaInsets();

  if (!active) return null;

  const phaseLabel = handsfreePhaseLabel(phase);
  const muted = phase === 'muted';
  const speaking = phase === 'speaking';
  const speakingLine = speaking ? `${phaseLabel} · ${HANDSFREE_SPEAKING_HINT}` : phaseLabel;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { bottom: insets.bottom + Spacing.three }]}>
      <GlassSurface
        variant="hero"
        padding={0}
        style={[styles.banner, { borderColor: tokens.accentWarmMuted }]}>
        <View
          style={styles.body}
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${HANDSFREE_BANNER_TITLE} with ${label ?? 'this chat'}, ${speakingLine}`}>
          <HandsfreeCallIndicator level={level} active={!muted} color={tokens.accent} />
          <View style={styles.text}>
            <Text variant="caption" color="primary" numberOfLines={1}>
              {HANDSFREE_BANNER_TITLE}
              {label ? ` · ${label}` : ''}
            </Text>
            <Text variant="caption" color="accentWarm" numberOfLines={1}>
              {speakingLine}
            </Text>
            {partial ? (
              // A live partial changes every few hundred milliseconds; it is
              // for the eye, so it is kept out of the screen reader's way.
              <View accessible={false} importantForAccessibility="no">
                <Text variant="micro" color="tertiary" numberOfLines={1}>
                  {partial}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.controls}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={muted ? HANDSFREE_UNMUTE_LABEL : HANDSFREE_MUTE_LABEL}
            onPress={muted ? unmute : mute}
            style={[styles.control, { borderColor: tokens.glassBorder }]}>
            <Text variant="caption" color="primary">
              {muted ? 'Unmute' : 'Mute'}
            </Text>
          </PressableScale>

          {speaking ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={HANDSFREE_SKIP_LABEL}
              onPress={skipReply}
              style={[styles.control, { borderColor: tokens.glassBorder }]}>
              <Text variant="caption" color="primary">
                Skip reply
              </Text>
            </PressableScale>
          ) : null}

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={HANDSFREE_END_LABEL}
            onPress={end}
            style={[styles.control, styles.end, { borderColor: tokens.statusDisconnected }]}>
            <Text variant="caption" color="inverse">
              End
            </Text>
          </PressableScale>
        </View>

        <Text variant="micro" color="tertiary" style={styles.autoSend}>
          {HANDSFREE_AUTOSEND_LABEL}
        </Text>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
  },
  banner: {
    width: '100%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: 'hidden',
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  controls: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  control: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  end: {
    backgroundColor: '#7f1d1d',
  },
  autoSend: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    textTransform: 'uppercase',
  },
});
