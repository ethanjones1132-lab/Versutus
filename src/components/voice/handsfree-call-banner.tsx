// ─── The in-call banner ────────────────────────────────────────────────────
// Drawn for the whole call, as a sibling of the root Stack, so every in-app
// route keeps Mute, Skip reply and End. It is unmistakably separate from the
// composer: the permanent "speech auto-sends" label states what the call does,
// and the transcript never passes through the composer writer.
//
// It answers, in this order and at a glance: what the call is doing right now
// (the orb and the state beside it), who it is with and for how long, and the
// one thing worth saying about this moment — an approval that is waiting, a
// turn that failed, a slow answer, or what it is hearing. One line of news at a
// time: a banner that stacked all of them was five lines of small grey text
// and no way to tell which mattered.

import { useCallback, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface, PressableScale, Text } from '@/components/ui';
import { HandsfreeCallIndicator } from '@/components/voice/handsfree-call-indicator';
import { Radius, Spacing } from '@/constants/tokens';
import { useHandsfreeVoice, type HandsfreeVoiceContextValue } from '@/context/handsfree-voice-provider';
import { useTokens } from '@/hooks/use-tokens';
import { callOrbMode } from '@/lib/voice/call-orb-motion';
import {
  HANDSFREE_AUTOSEND_LABEL,
  HANDSFREE_BANNER_TITLE,
  HANDSFREE_CONFIRMING_HINT,
  HANDSFREE_END_LABEL,
  HANDSFREE_MUTE_LABEL,
  HANDSFREE_SKIP_LABEL,
  HANDSFREE_SPEAKING_HINT,
  HANDSFREE_UNMUTE_LABEL,
  handsfreeApprovalCopy,
  handsfreeCallClock,
  handsfreeElapsedCopy,
  handsfreeEngineFallbackCopy,
  handsfreeEngineLine,
  handsfreePhaseHint,
  handsfreePhaseLabel,
  handsfreeSlowTurnCopy,
  handsfreeTurnFailureCopy,
} from '@/lib/voice/handsfree-call-copy';

export function HandsfreeCallBanner() {
  const { active } = useHandsfreeVoice();
  if (!active) return null;
  return <ActiveHandsfreeCallBanner />;
}

function ActiveHandsfreeCallBanner() {
  return <HandsfreeCallBannerView call={useHandsfreeVoice()} />;
}

/** Everything the banner draws from: the call's state and its four controls. */
export type HandsfreeCallBannerState = Pick<
  HandsfreeVoiceContextValue,
  | 'phase'
  | 'partial'
  | 'label'
  | 'level'
  | 'engine'
  | 'engineReason'
  | 'muted'
  | 'mute'
  | 'unmute'
  | 'skipReply'
  | 'end'
  | 'startedAtMs'
  | 'sendingSinceMs'
  | 'turnError'
  | 'approval'
  | 'approvalBusy'
  | 'decideApproval'
>;

/**
 * The banner itself, drawn from a call's state and nothing else, so it can be
 * shown for any state without a call behind it (`/dev/call`). `docked` pins it
 * above the bottom inset over whatever route is showing, which is how a live
 * call wears it; undocked it sits in the flow of a page.
 */
export function HandsfreeCallBannerView({
  call,
  docked = true,
}: {
  call: HandsfreeCallBannerState;
  docked?: boolean;
}) {
  const { phase, partial, label, level, engine, engineReason, muted, mute, unmute, skipReply, end, startedAtMs, sendingSinceMs, turnError, approval, approvalBusy, decideApproval } =
    call;
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  // The elapsed time is wall-clock truth: the per-second clock is an
  // external store the banner subscribes to for the whole call, so React
  // owns when the fold re-runs and no impure Date.now() is read during
  // render — a call whose start is unknown stays silent, never zero.
  const subscribeElapsedSeconds = useCallback((onStoreChange: () => void) => {
    const id = setInterval(onStoreChange, 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedSeconds = useSyncExternalStore(
    subscribeElapsedSeconds,
    () => Math.floor(Date.now() / 1000),
  );
  const nowMs = elapsedSeconds * 1000;
  // Two folds of the same clock: digits for the eye, words for a screen reader.
  const clock = handsfreeCallClock(startedAtMs, nowMs);
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
  // A turn that died is named: the call carries on and the Gate reopens
  // listening, so silence about it read as a call stuck on a reply.
  const turnFailureCopy = handsfreeTurnFailureCopy(turnError);
  const approvalCopy = handsfreeApprovalCopy(approval);

  const phaseLabel = handsfreePhaseLabel(phase);
  const speaking = phase === 'speaking';
  // What a screen reader is told in one breath: the state and its hint. The
  // confirming grace window keeps its Listening label but is not silent: a
  // re-arming hold is finishing a turn it has already heard, not dead.
  const phaseLine = speaking
    ? `${phaseLabel} · ${HANDSFREE_SPEAKING_HINT}`
    : phase === 'confirming'
      ? `${phaseLabel} · ${HANDSFREE_CONFIRMING_HINT}`
      : phaseLabel;
  // A fallback is named, never silent: the call says which engine it is on
  // and why, in a sentence, not in a footer that truncates.
  const fallbackCopy = handsfreeEngineFallbackCopy(engine, engineReason);
  const hint = handsfreePhaseHint(phase);

  // The one line of news, most urgent first. What is being heard comes after
  // anything that needs a decision; a standing hint is last, there for the
  // eye while nothing else needs saying.
  const news = approvalCopy
    ? { text: approvalCopy, urgent: true, live: false }
    : turnFailureCopy
      ? { text: turnFailureCopy, urgent: true, live: false }
      : slowTurnCopy
        ? { text: slowTurnCopy, urgent: true, live: false }
        : partial
          ? { text: partial, urgent: false, live: true }
          : fallbackCopy
            ? { text: fallbackCopy, urgent: false, live: false }
            : hint
              ? { text: hint, urgent: false, live: true }
              : null;
  const engineLine = handsfreeEngineLine(engine);
  const who = [label, clock].filter(Boolean).join(' · ');

  return (
    <View
      pointerEvents="box-none"
      style={docked ? [styles.host, { bottom: insets.bottom + Spacing.three }] : styles.inline}>
      <GlassSurface
        variant="hero"
        padding={0}
        style={[styles.banner, { borderColor: tokens.accentWarmMuted }]}>
        <View
          style={styles.body}
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${HANDSFREE_BANNER_TITLE} with ${label ?? 'this chat'}, ${phaseLine}${elapsedCopy ? `, ${elapsedCopy}` : ''}`}>
          <HandsfreeCallIndicator
            mode={callOrbMode(phase, muted)}
            level={level}
            color={tokens.accent}
            mutedColor={tokens.textTertiary}
          />
          <View style={styles.text}>
            <Text variant="headline" color={muted ? 'secondary' : 'primary'} numberOfLines={1}>
              {phaseLabel}
            </Text>
            {who ? (
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {who}
              </Text>
            ) : null}
          </View>
        </View>

        {news ? (
          // A live partial changes every few hundred milliseconds; it is for
          // the eye, so it is kept out of the screen reader's way. Everything
          // else on this line is news the operator has to hear.
          <View
            style={styles.news}
            accessible={news.live ? false : undefined}
            importantForAccessibility={news.live ? 'no' : 'auto'}>
            <Text variant="callout" color={news.urgent ? 'accentWarm' : 'secondary'} numberOfLines={2}>
              {news.text}
            </Text>
          </View>
        ) : null}

        {approval?.approvalId && (!approval.state || approval.state === 'pending') ? (
          <View style={styles.controls}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Approve tool once"
              disabled={approvalBusy}
              onPress={() => { void decideApproval('approve').catch(() => undefined); }}
              style={[styles.control, { borderColor: tokens.accentWarmMuted }]}>
              <Text variant="callout" color="primary">Approve once</Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Deny tool approval"
              disabled={approvalBusy}
              onPress={() => { void decideApproval('deny').catch(() => undefined); }}
              style={[styles.control, { borderColor: tokens.statusDisconnected }]}>
              <Text variant="callout" color="primary">Deny</Text>
            </PressableScale>
          </View>
        ) : null}

        <View style={styles.controls}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={muted ? HANDSFREE_UNMUTE_LABEL : HANDSFREE_MUTE_LABEL}
            onPress={muted ? unmute : mute}
            style={[styles.control, { borderColor: tokens.border }]}>
            <Text variant="callout" color="primary">
              {muted ? 'Unmute' : 'Mute'}
            </Text>
          </PressableScale>

          {speaking ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={HANDSFREE_SKIP_LABEL}
              onPress={skipReply}
              style={[styles.control, { borderColor: tokens.border }]}>
              <Text variant="callout" color="primary">
                Skip reply
              </Text>
            </PressableScale>
          ) : null}

          <View style={styles.spacer} />

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={HANDSFREE_END_LABEL}
            onPress={end}
            style={[styles.control, styles.end, { backgroundColor: tokens.statusDisconnected }]}>
            <Text variant="callout" color="inverse">
              End
            </Text>
          </PressableScale>
        </View>

        <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.footer}>
          {HANDSFREE_BANNER_TITLE} · {HANDSFREE_AUTOSEND_LABEL}
          {engineLine ? ` · ${engineLine}` : ''}
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
  inline: {
    alignItems: 'center',
  },
  banner: {
    width: '100%',
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: 'hidden',
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  text: {
    flex: 1,
    gap: Spacing.half,
  },
  news: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  // 44 pt tall: a control used without looking, mid-conversation.
  control: {
    minHeight: 44,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  spacer: {
    flex: 1,
  },
  end: {
    borderWidth: 0,
  },
  footer: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
