import { useId } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import { FontFamily, Palette } from '@/constants/tokens';
import { botCrestFromId } from '@/lib/bot-avatar';

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
 * A faint inner rim catches light along the top so the disc reads as an
 * object on the stage rather than a flat sticker.
 */
export function BotAvatar({ botId, name, size = 40, attention = false }: BotAvatarProps) {
  const { tone, initial } = botCrestFromId(botId, name);
  const gradientId = `crest-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const r = size / 2;
  const notch = Math.max(8, Math.round(size * 0.26));

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={tone.from} />
            <Stop offset="1" stopColor={tone.to} />
          </LinearGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${gradientId})`} />
        <Circle
          cx={r}
          cy={r}
          r={r - 0.75}
          fill="none"
          stroke="rgba(255,255,255,0.22)"
          strokeWidth={0.75}
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
    textShadowColor: 'rgba(0, 0, 0, 0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
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
