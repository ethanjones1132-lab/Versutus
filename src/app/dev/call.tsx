// ─── The call banner, in every state, with no call behind it ──────────────
// A call can only be watched on a phone with a Gate, a microphone and a Bot
// that answers, and most of what the banner has to get right happens for half a
// second at a time. This page draws the real banner for each state at once,
// with a microphone level that rises and falls like speech, so the motion and
// the words can be judged side by side — on a phone or in a browser.
//
// Dev builds only: the layout above redirects everything else away.

import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  Easing,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Screen, Text } from '@/components/ui';
import {
  HandsfreeCallBannerView,
  type HandsfreeCallBannerState,
} from '@/components/voice/handsfree-call-banner';
import { Spacing } from '@/constants/tokens';

type Scene = {
  title: string;
  note: string;
  state: Partial<HandsfreeCallBannerState> & Pick<HandsfreeCallBannerState, 'phase'>;
  /** Whether this scene's microphone should sound like someone talking. */
  voiced?: boolean;
};

const SCENES: Scene[] = [
  {
    title: 'Connecting',
    note: 'The link and the engine are still coming up. It does not say Listening yet.',
    state: { phase: 'starting' },
  },
  {
    title: 'Listening, quiet room',
    note: 'A slow breath: alive, and hearing nothing.',
    state: { phase: 'listening' },
  },
  {
    title: 'Listening, someone talking',
    note: 'The light swells with the voice; the words appear as they are heard.',
    state: { phase: 'listening', partial: 'So I was thinking about the release plan, and' },
    voiced: true,
  },
  {
    title: 'Thinking',
    note: 'The turn has been sent. A small light circles until the answer starts.',
    state: { phase: 'sending' },
  },
  {
    title: 'Thinking, slowly',
    note: 'Past ten seconds the wait is named, with the seconds.',
    state: { phase: 'sending', sendingSinceMs: -1 },
  },
  {
    title: 'Speaking',
    note: 'Rings leave the light while the reply is audible. Skip appears.',
    state: { phase: 'speaking' },
  },
  {
    title: 'Muted',
    note: 'A hollow, still ring. The microphone is off.',
    state: { phase: 'muted', muted: true },
  },
  {
    title: 'A turn failed',
    note: 'The call carries on; the line says who failed, in one sentence.',
    state: { phase: 'listening', turnError: 'OpenCode stopped before it answered.' },
  },
  {
    title: 'A tool needs approval',
    note: 'The ask is the news, and the two answers sit above the call controls.',
    state: {
      phase: 'sending',
      approval: { turnId: 't1', approvalId: 'a1', summary: 'Run git status in Versutus', state: 'pending' },
    },
  },
  {
    title: 'A fallback engine',
    note: 'The footer says where the voice runs; a fallback gets a sentence saying why.',
    state: { phase: 'listening', engine: 'phone', engineReason: 'the PC voice models are still loading' },
  },
];

const noop = () => undefined;

export default function DevCallScreen() {
  // One clock for every scene, so the call timers tick together.
  const [startedAtMs] = useState(() => Date.now() - 73_000);
  // A slow turn: its wait began well before the page opened.
  const [slowSinceMs] = useState(() => Date.now() - 14_000);
  const quiet = useSharedValue(0.002);
  const voiced = useSharedValue(0.004);

  // Speech, roughly: syllables of different weights with a breath between
  // phrases. Levels are linear RMS, as the capture loop reports them.
  useEffect(() => {
    const beat = (to: number, ms: number) => withTiming(to, { duration: ms, easing: Easing.inOut(Easing.quad) });
    voiced.value = withRepeat(
      withSequence(
        beat(0.07, 140), beat(0.02, 120), beat(0.11, 160), beat(0.03, 110),
        beat(0.06, 150), beat(0.09, 130), beat(0.015, 200), beat(0.004, 520),
        beat(0.05, 150), beat(0.12, 170), beat(0.03, 140), beat(0.004, 700),
      ),
      -1,
      false,
    );
  }, [voiced]);

  const scenes = useMemo(
    () => SCENES.map((scene) => {
      const state: HandsfreeCallBannerState = {
        partial: '',
        label: 'Atlas',
        level: scene.voiced ? voiced : quiet,
        engine: 'local',
        engineReason: undefined,
        muted: false,
        mute: noop,
        unmute: noop,
        skipReply: noop,
        end: noop,
        startedAtMs,
        sendingSinceMs: null,
        turnError: null,
        approval: null,
        approvalBusy: false,
        decideApproval: async () => undefined,
        ...scene.state,
      };
      if (scene.state.sendingSinceMs === -1) state.sendingSinceMs = slowSinceMs;
      return { ...scene, state };
    }),
    [quiet, slowSinceMs, startedAtMs, voiced],
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.page}>
        {scenes.map((scene) => (
          <View key={scene.title} style={styles.scene}>
            <Text variant="eyebrow" color="tertiary">{scene.title}</Text>
            <Text variant="caption" color="secondary">{scene.note}</Text>
            <HandsfreeCallBannerView call={scene.state} docked={false} />
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: Spacing.three,
    gap: Spacing.four,
    paddingBottom: Spacing.six,
  },
  scene: {
    gap: Spacing.two,
  },
});
