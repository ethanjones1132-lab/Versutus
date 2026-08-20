import '@/global.css';

import { fetch as expoFetch } from 'expo/fetch';

import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import { Stack, ThemeProvider, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AppBootstrap } from '@/components/app-bootstrap';
import { ConnectedToast } from '@/components/connected-toast';
import { FontProvider } from '@/components/font-provider';
import { TlsFingerprintGuard } from '@/components/gateway/tls-fingerprint-guard';
import { VersutusDarkTheme } from '@/constants/navigation-theme';
import { GatewayProvider } from '@/context/gateway-provider';
import { installStreamingFetch } from '@/lib/net/streaming-fetch';

// React Native's global fetch cannot stream a response body, so SSE readers
// throw on device. Install the WinterCG implementation before any gateway
// client is constructed. See streaming-fetch.ts for why it is installed here
// rather than imported by the transport.
installStreamingFetch(expoFetch as unknown as typeof globalThis.fetch);

function NotificationRouter() {
  const router = useRouter();
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(() => {
      // Approvals + live runs are monitored on Activity (chat still has the sheet).
      router.navigate('/activity');
    });
    return () => subscription.remove();
  }, [router]);
  return null;
}

function GatewayDeepLinkRouter() {
  const router = useRouter();
  const url = Linking.useURL();
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!url || handledRef.current === url) return;
    const parsed = Linking.parse(url);
    const path = (parsed.path ?? '').replace(/^\/+/, '');
    if (path !== 'add' && path !== 'gateway/add') return;

    handledRef.current = url;
    const query = parsed.queryParams ?? {};
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
    const params = Object.fromEntries(
      Object.entries(query)
        .map(([key, value]) => [key, first(value)] as const)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
    );

    router.push({ pathname: '/gateway/add', params });
  }, [router, url]);

  return null;
}

export default function RootLayout() {
  return (
    <FontProvider>
      <GatewayProvider>
        <ThemeProvider value={VersutusDarkTheme}>
           <StatusBar style="light" />
           <NotificationRouter />
           <GatewayDeepLinkRouter />
          <AppBootstrap>
            <View style={styles.root}>
              <AnimatedSplashOverlay />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: VersutusDarkTheme.colors.background },
                }}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="onboarding" options={{ headerShown: false }} />
                <Stack.Screen
                  name="gateway/add"
                  options={{
                    presentation: 'modal',
                    headerShown: true,
                    title: 'Add Gateway',
                    headerStyle: { backgroundColor: VersutusDarkTheme.colors.card },
                    headerTintColor: VersutusDarkTheme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="gateway/settings"
                  options={{
                    presentation: 'modal',
                    headerShown: true,
                    title: 'Settings',
                    headerStyle: { backgroundColor: VersutusDarkTheme.colors.card },
                    headerTintColor: VersutusDarkTheme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="gateway/setup"
                  options={{
                    presentation: 'modal',
                    headerShown: true,
                    title: 'Gate setup',
                    headerStyle: { backgroundColor: VersutusDarkTheme.colors.card },
                    headerTintColor: VersutusDarkTheme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="gateway/capabilities"
                  options={{
                    presentation: 'modal',
                    headerShown: true,
                    title: 'Capabilities',
                    headerStyle: { backgroundColor: VersutusDarkTheme.colors.card },
                    headerTintColor: VersutusDarkTheme.colors.text,
                  }}
                />
                {__DEV__ ? <Stack.Screen name="dev" options={{ headerShown: false }} /> : null}
              </Stack>
              <ConnectedToast />
              <TlsFingerprintGuard />
            </View>
          </AppBootstrap>
        </ThemeProvider>
      </GatewayProvider>
    </FontProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
