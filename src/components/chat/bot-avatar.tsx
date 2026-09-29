import { useId } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { FontFamily, Palette } from '@/constants/tokens';
import { useBotCrest } from '@/hooks/use-crest-fleet';

type BotAvatarProps = {
  botId: string;
  /** The name the initial is taken from; the id is used when absent. */
  name?: string;
  /** Diameter in points. */
  size?: number;
  /**
   * The Bot cannot route. Drawn as one small amber notch on the crest — the
   * only status mark an avatar ever carries, so identity never reads as state.
   */
  attention?: boolean;
};

/**
 * A Bot's monogram crest: its initial in the display serif on a two-stop
 * gradient disc whose tone is derived from the id (src/lib/bot-avatar.ts).
 * It is lit like a polished stone rather than painted like a sticker: a soft
 * sheen pools at the upper left, and a rim of light runs bright along the top
 * edge and fades out underneath, where the disc turns away from the lamp.
 */
export function BotAvatar({ botId, name, size = 40, attention = false }: BotAvatarProps) {
  // Subscribed so a crest drawn before the fleet was known redraws in its tone.
  const { tone, initial } = useBotCrest(botId, name);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const bodyId = `crest-body-${uid}`;
  const sheenId = `crest-sheen-${uid}`;
  const rimId = `crest-rim-${uid}`;
  const r = size / 2;
  const notch = Math.max(8, Math.round(size * 0.26));
  // Hairlines stay a physical ~0.75pt at every size; small crests keep a rim.
  const rim = Math.max(0.75, size / 48);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <LinearGradient id={bodyId} x1="0.15" y1="0" x2="0.85" y2="1">
            <Stop offset="0" stopColor={tone.from} />
            <Stop offset="1" stopColor={tone.to} />
          </LinearGradient>
          <RadialGradient id={sheenId} cx="0.32" cy="0.18" rx="0.62" ry="0.5" fx="0.32" fy="0.18">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.34} />
            <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity={0.06} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </RadialGradient>
          <LinearGradient id={rimId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.42} />
            <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.08} />
            <Stop offset="1" stopColor="#000000" stopOpacity={0.28} />
          </LinearGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${bodyId})`} />
        <Circle cx={r} cy={r} r={r} fill={`url(#${sheenId})`} />
        <Circle
          cx={r}
          cy={r}
          r={r - rim / 2}
          fill="none"
          stroke={`url(#${rimId})`}
          strokeWidth={rim}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <RNText
          allowFontScaling={false}
          style={[
            styles.initial,
            { fontSize: Math.round(size * 0.5), lineHeight: Math.round(size * 0.62) },
          ]}>
          {initial}
        </RNText>
      </View>
      {attention ? (
        <View
          style={[
            styles.notch,
            {
              width: notch,
              height: notch,
              borderRadius: notch / 2,
              backgroundColor: Palette.statusConnecting,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/**
 * A group room's crest: up to three member crests overlapped on a diagonal,
 * each ringed in the stage colour so they read as separate people.
 */
export function GroupAvatar({
  memberIds,
  size = 40,
}: {
  memberIds: string[];
  size?: number;
}) {
  const shown = memberIds.slice(0, 3);
  const mini = Math.round(size * (shown.length > 2 ? 0.58 : 0.66));
  const positions =
    shown.length > 2
      ? [
          { left: 0, top: size * 0.04 },
          { left: size - mini, top: 0 },
          { left: (size - mini) / 2, top: size - mini },
        ]
      : [
          { left: 0, top: 0 },
          { left: size - mini, top: size - mini },
        ];

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}>
      {shown.map((id, index) => (
        <View
          key={id}
          style={[
            styles.member,
            {
              left: positions[index].left - 1.5,
              top: positions[index].top - 1.5,
              borderRadius: (mini + 3) / 2,
            },
          ]}>
          <BotAvatar botId={id} size={mini} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    fontFamily: FontFamily.serif,
    color: '#FFFFFF',
    textAlign: 'center',
    // Serif capitals sit high in their box; nudge to the optical centre.
    marginTop: 1,
    // Letterpress: the initial sits pressed into the stone, not floating on it.
    textShadowColor: 'rgba(0, 0, 0, 0.32)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1.5,
  },
  notch: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    borderWidth: 2,
    borderColor: Palette.background,
  },
  member: {
    position: 'absolute',
    padding: 1.5,
    backgroundColor: Palette.background,
  },
});
