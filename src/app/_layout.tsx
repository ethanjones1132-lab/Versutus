import * as Notifications from 'expo-notifications';
import { ThemeProvider, useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AppBootstrap } from '@/components/app-bootstrap';
import { FontProvider } from '@/components/font-provider';
import { VersutusDarkTheme } from '@/constants/navigation-theme';
import { GatewayProvider } from '@/context/gateway-provider';

function NotificationRouter() {
  const router = useRouter();
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(() => {
      // Approval requests and run events live on the chat surface.
      router.navigate('/chat');
    });
    return () => subscription.remove();
  }, [router]);
  return null;
}

export default function RootLayout() {
  return (
    <FontProvider>
      <GatewayProvider>
        <ThemeProvider value={VersutusDarkTheme}>
          <StatusBar style="light" />
          <NotificationRouter />
          <AppBootstrap>
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
              {__DEV__ ? <Stack.Screen name="dev" options={{ headerShown: false }} /> : null}
            </Stack>
          </AppBootstrap>
        </ThemeProvider>
      </GatewayProvider>
    </FontProvider>
  );
}