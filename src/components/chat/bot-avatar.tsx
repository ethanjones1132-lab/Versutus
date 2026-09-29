import { StyleSheet, View } from 'react-native';

import { BotFigure, type FigureMood } from '@/components/avatar/bot-figure';
import { Palette } from '@/constants/tokens';
import { useBotLook } from '@/hooks/use-bot-look';

type BotAvatarProps = {
  botId: string;
  /** The name the initial is taken from; the id is used when absent. */
  name?: string;
  /** Width and height in points. */
  size?: number;
  /**
   * The Bot cannot route. Drawn as one small amber notch on the figure — the
   * only status mark an avatar ever carries, so identity never reads as state.
   */
  attention?: boolean;
  /** The Bot is working on a reply: its eyes turn up and away, and light gathers round it. */
  mood?: FigureMood;
  /** The Bot looks up as its thread opens. */
  wake?: boolean;
  /** Bump to make the Bot light up at a touch. */
  reaction?: number;
  /** Hold the face still (swatches, dense lists). */
  animated?: boolean;
};

/**
 * A Bot as the operator knows it: its figure — the form it is cut as, the
 * face it wears, its colour (src/lib/avatar) — natural until the operator
 * chooses otherwise in the Look studio.
 */
export function BotAvatar({
  botId,
  name,
  size = 40,
  attention = false,
  mood,
  wake,
  reaction,
  animated,
}: BotAvatarProps) {
  // Subscribed so a figure drawn before the fleet or the stored looks were
  // known redraws in its assigned colour and chosen form.
  const look = useBotLook(botId, name);
  const notch = Math.max(8, Math.round(size * 0.26));

  return (
    <View style={{ width: size, height: size }}>
      <BotFigure look={look} size={size} seed={botId} mood={mood} wake={wake} reaction={reaction} animated={animated} />
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
 * A group room's crest: up to three member figures overlapped on a diagonal,
 * each keylined in the stage colour along its own silhouette so they read as
 * separate people whatever form each is cut as.
 */
export function GroupAvatar({
  memberIds,
  size = 40,
}: {
  memberIds: string[];
  size?: number;
}) {
  const shown = memberIds.slice(0, 3);
  // Each member carries its keyline inside its own box, so the box is a size up.
  const mini = Math.round(size * (shown.length > 2 ? 0.66 : 0.75));
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
        <View key={id} style={[styles.member, { left: positions[index].left, top: positions[index].top }]}>
          <GroupMember botId={id} size={mini} />
        </View>
      ))}
    </View>
  );
}

function GroupMember({ botId, size }: { botId: string; size: number }) {
  const look = useBotLook(botId);
  return <BotFigure look={look} size={size} seed={botId} animated={false} cutout={Palette.background} />;
}

const styles = StyleSheet.create({
  notch: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    borderWidth: 2,
    borderColor: Palette.background,
  },
  member: {
    position: 'absolute',
  },
});
