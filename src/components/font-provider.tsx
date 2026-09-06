import {
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
} from '@expo-google-fonts/instrument-sans';
import {
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

// If the font download stalls (offline CDN, hung request), useFonts never
// resolves and the native splash would cover the app forever. After this
// window the provider falls back to children on system fonts instead.
export const FONT_LOAD_TIMEOUT_MS = 5000;

export function FontProvider({ children }: { children: React.ReactNode }) {
  const [loaded, error] = useFonts({
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (loaded || error) {
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), FONT_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loaded, error]);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [loaded, error]);

  useEffect(() => {
    if (timedOut) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [timedOut]);

  // During initial load, show ActivityIndicator instead of blank
  if (!loaded && !error) {
    if (timedOut) {
      return children;
    }
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={undefined} />
      </View>
    );
  }

  return children;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "transparent",
  },
});