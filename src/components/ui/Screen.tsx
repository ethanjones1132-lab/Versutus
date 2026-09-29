import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AmbientCanvas } from '@/components/layout/AmbientCanvas';
import { useTokens } from '@/hooks/use-tokens';
import { signalTouched } from '@/lib/stage/signals';

import type { ScreenProps } from './types';

export function Screen({
  children,
  edges = ['top', 'bottom'],
  style,
  ambient = true,
  parallaxX,
  parallaxY,
  room,
}: ScreenProps) {
  const tokens = useTokens();

  return (
    // A touch anywhere tells the stage the operator is here, so the air that
    // stilled while they were away moves again.
    <View style={[styles.root, { backgroundColor: tokens.background }]} onTouchStart={() => signalTouched()}>
      {ambient ? <AmbientCanvas parallaxX={parallaxX} parallaxY={parallaxY} room={room} /> : null}
      <SafeAreaView style={[styles.safe, style]} edges={edges}>
        {children}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  safe: {
    flex: 1,
  },
});