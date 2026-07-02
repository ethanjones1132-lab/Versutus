import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AmbientCanvas } from '@/components/layout/AmbientCanvas';
import { useTokens } from '@/hooks/use-tokens';

import type { ScreenProps } from './types';

export function Screen({ children, edges = ['top', 'bottom'], style, ambient = true }: ScreenProps) {
  const tokens = useTokens();

  return (
    <View style={[styles.root, { backgroundColor: tokens.background }]}>
      {ambient ? <AmbientCanvas /> : null}
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