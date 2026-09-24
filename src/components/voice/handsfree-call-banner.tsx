// ─── The in-call banner ────────────────────────────────────────────────────
// Drawn for the whole call, as a sibling of the root Stack, so every in-app
// route keeps Mute, Skip reply and End. It is unmistakably separate from the
// composer: the permanent "speech auto-sends" label states what the call does,
// and the transcript never passes through the composer writer.

import { useCallback, useSyncExternalStore } from 'react';
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
  HANDSFREE_CONFIRMING_HINT,
  HANDSFREE_END_LABEL,
  HANDSFREE_MUTE_LABEL,
  HANDSFREE_SKIP_LABEL,
  HANDSFREE_SPEAKING_HINT,
  HANDSFREE_UNMUTE_LABEL,
  handsfreeElapsedCopy,
  handsfreePhaseLabel,
  handsfreeSlowTurnCopy,
} from '@/lib/voice/handsfree-call-copy';

export function HandsfreeCallBanner() {
  const { active, phase, partial, label, level, engine, engineReason, mute, unmute, skipReply, end, startedAtMs, sendingSinceMs } =
    useHandsfreeVoice();
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  // The elapsed time is wall-clock truth: the per-second clock is an
  // external store the banner subscribes to for the whole call, so React
  // owns when the fold re-runs and no impure Date.now() is read during
  // render — A call whose start is unknown stays silent, never zero.
  const subscribeElapsedSeconds = useCallback((onStoreChange: () => void) => {
    const id = setInterval(onStoreChange, 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedSeconds = useSyncExternalStore(
    subscribeElapsedSeconds,
    () => Math.floor(Date.now() / 1000),
  );
  const nowMs = elapsedSeconds * 1000;
  const elapsedCopy =
    startedAtMs !== undefined
      ? handsfreeElapsedCopy(startedAtMs, nowMs)
      : null;
  // A slow turn is named, not silent: while the call waits on the PC past a
  // fair window the banner says so. The provider stamps when the wait began
  // (it folds call events; render may neither read a ref nor set state), and
  // the per-second clock above is what re-runs this fold, so the wait ticks.
  const slowTurnCopy =
    sendingSinceMs !== null ? handsfreeSlowTurnCopy(sendingSinceMs, nowMs) : null;

  if (!active) return null;

  const phaseLabel = handsfreePhaseLabel(phase);
  const muted = phase === 'muted';
  const speaking = phase === 'speaking';
  // The confirming grace window keeps its Listening label but is not silent:
  // a re-arming hold is finishing a turn it has already heard, not dead.
  const phaseLine = speaking
    ? `${phaseLabel} · ${HANDSFREE_SPEAKING_HINT}`
    : phase === 'confirming'
      ? `${phaseLabel} · ${HANDSFREE_CONFIRMING_HINT}`
      : phaseLabel;

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
          accessibilityLabel={`${HANDSFREE_BANNER_TITLE} with ${label ?? 'this chat'}, ${phaseLine}${elapsedCopy ? `, ${elapsedCopy}` : ''}`}>
          <HandsfreeCallIndicator level={level} active={!muted} color={tokens.accent} />
          <View style={styles.text}>
            <Text variant="caption" color="primary" numberOfLines={1}>
              {HANDSFREE_BANNER_TITLE}
              {label ? ` · ${label}` : ''}
              {elapsedCopy ? ` · ${elapsedCopy}` : ''}
            </Text>
            <Text variant="caption" color="accentWarm" numberOfLines={1}>
              {phaseLine}
            </Text>
            {engine ? (
              // A fallback is named, never silent: the banner says which engine
              // the call is on and, when the Gate fell back, why.
              <Text variant="micro" color="tertiary" numberOfLines={1}>
                Using {engine}
                {engineReason ? ` — ${engineReason}` : ''}
              </Text>
            ) : null}
            {slowTurnCopy ? (
              // The turn has waited on the PC past a fair window: name the
              // wait so silence does not read as a dead call.
              <Text variant="micro" color="accentWarm" numberOfLines={1}>
                {slowTurnCopy}
              </Text>
            ) : null}
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
            style={[styles.control, { borderColor: tokens.border }]}>
            <Text variant="caption" color="primary">
              {muted ? 'Unmute' : 'Mute'}
            </Text>
          </PressableScale>

          {speaking ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={HANDSFREE_SKIP_LABEL}
              onPress={skipReply}
              style={[styles.control, { borderColor: tokens.border }]}>
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
