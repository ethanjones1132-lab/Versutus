import { StyleSheet, View } from 'react-native';

import { useTokens } from '@/hooks/use-tokens';
import { linearToSrgb, STAGE_BASE, type StageRoom } from '@/lib/stage/lamp';
import { useStageLights } from '@/lib/stage/use-stage-lights';

export type AmbientCanvasProps = {
  parallaxX?: number;
  parallaxY?: number;
  /** Whose light the stage is lit with; the house violet when absent. */
  room?: StageRoom;
};

/**
 * The stage when the lamp shader cannot run (native Skia boundary): one still
 * disc of the room's light over the upper left, no air in it. It keeps the
 * room's colour, so a Bot's thread is still lit in its own tone.
 */
export function AmbientFallback({ room }: AmbientCanvasProps = {}) {
  const tokens = useTokens();
  const { key } = useStageLights(room);
  const channel = (i: number) => Math.round(linearToSrgb(STAGE_BASE[i] + key.edge[i]) * 255);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.glow,
          { backgroundColor: room ? `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})` : tokens.accentMuted },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  glow: {
    position: 'absolute',
    top: '-18%',
    left: '-12%',
    width: 420,
    height: 420,
    borderRadius: 210,
    opacity: 0.55,
  },
});
