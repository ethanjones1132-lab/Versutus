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
import { GatewayProvider, useGateway } from '@/context/gateway-provider';
import { installStreamingFetch } from '@/lib/net/streaming-fetch';
import { approvalDecisionFor, isApprovalActionFor } from '@/lib/notifications/approval-action';
import { registerNotificationCategories } from '@/lib/notifications/categories';
import {
  isLaunchReplay,
  readLaunchResponse,
  type LaunchTap,
} from '@/lib/notifications/launch-response';
import { routeForTap } from '@/lib/notifications/tap-route';

// React Native's global fetch cannot stream a response body, so SSE readers
// throw on device. Install the WinterCG implementation before any gateway
// client is constructed. See streaming-fetch.ts for why it is installed here
// rather than imported by the transport.
installStreamingFetch(expoFetch as unknown as typeof globalThis.fetch);

function NotificationRouter() {
  const router = useRouter();
  const { isBootstrapped, pendingRunApproval, resolveRunApproval } = useGateway();
  // The launch tap is read once, and its route is held until bootstrap has
  // mounted the Stack: navigating any earlier loses to the boot overlay's
  // first-run redirect (the wait GatewayDeepLinkRouter already does). A tap
  // delivered to the live listener during that same window is held here too.
  const launchReadRef = useRef(false);
  const pendingTapRef = useRef<'/chat' | '/activity' | null>(null);
  // The launch tap's identifier while its replay window is open, so the same
  // tap arriving at the live listener cannot route a second time.
  const launchTapRef = useRef<LaunchTap | null>(null);
  // The approval pending right now, for the Approve / Deny buttons: only a run
  // this app initiated can be approved (CONTEXT.md), and the listener below is
  // registered once, so it reads this ref instead of closing over an approval
  // that has already been decided.
  const approvalRef = useRef<{
    runId: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  useEffect(() => {
    approvalRef.current = pendingRunApproval
      ? { runId: pendingRunApproval.runId, resolve: resolveRunApproval }
      : null;
  }, [pendingRunApproval, resolveRunApproval]);

  // The Approve / Deny buttons only exist once the category is registered, and
  // a notice may not reference a category the device has never seen — so this
  // runs at mount, ahead of any notice the provider can post.
  useEffect(() => {
    void registerNotificationCategories();
  }, []);

  useEffect(() => {
    // Route on the payload's kind: a routine notice opens Chat (its roster
    // is the Bot list). Runs, approvals and anything unrecognized stay on
    // Activity, where they are monitored (chat still has the sheet).
    const destinationFor = (data: unknown): '/chat' | '/activity' => {
      const route = routeForTap(data);
      return route?.kind === 'routine' ? '/chat' : '/activity';
    };

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const identifier = response.notification.request.identifier;
      if (isLaunchReplay(launchTapRef.current, identifier)) {
        // The tap that launched the app, delivered a second time: one tap,
        // one route.
        launchTapRef.current = null;
        return;
      }
      // An Approve / Deny button decides the run from the banner: the action
      // identifier is the discriminator, and the payload must name the
      // approval pending right now. A decision that lands leaves the tap
      // path — the operator decided, so nothing else happens; a decision that
      // cannot be applied falls through to the destination below, exactly as
      // any other tap on this notice does.
      const decision = approvalDecisionFor(response.actionIdentifier);
      const pendingApproval = approvalRef.current;
      if (
        decision &&
        pendingApproval &&
        isApprovalActionFor(response.notification.request.content.data, pendingApproval.runId)
      ) {
        pendingApproval.resolve(decision === 'approve');
        return;
      }
      const destination = destinationFor(response.notification.request.content.data);
      if (!isBootstrapped) {
        // Boot overlay: the Stack is not mounted yet, so navigating now
        // loses to the first-run redirect. Hold the destination in the same
        // slot the launch tap uses; the run below routes it once the Stack
        // is up.
        pendingTapRef.current = destination;
        return;
      }
      router.navigate(destination);
    });

    // A tap that LAUNCHED the app is not replayed to a listener registered
    // during boot (Expo v57 notifications docs, "Responding to a notification
    // tap"), and a routine notice is usually tapped exactly that way, so the
    // launch response is read — once; the read retires it — and routed
    // through the same decision the live listener applies.
    if (!launchReadRef.current) {
      launchReadRef.current = true;
      const launch = readLaunchResponse();
      if (launch) {
        launchTapRef.current = {
          identifier: launch.notification.request.identifier,
          at: Date.now(),
        };
        pendingTapRef.current = destinationFor(launch.notification.request.content.data);
      }
    }

    // The one place a held tap is routed, whichever path held it: bootstrap
    // has mounted the Stack, so the destination now survives the boot
    // overlay's first-run redirect.
    if (isBootstrapped && pendingTapRef.current) {
      const destination = pendingTapRef.current;
      pendingTapRef.current = null;
      router.navigate(destination);
    }

    return () => subscription.remove();
  }, [router, isBootstrapped]);
  return null;
}

function GatewayDeepLinkRouter() {
  const router = useRouter();
  const url = Linking.useURL();
  const { isBootstrapped } = useGateway();
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    // Wait for bootstrap before pushing: the Stack is not mounted until then,
    // and needsOnboarding has not settled — a cold-start deep link used to
    // race the boot overlay and lose to the first-run redirect.
    if (!isBootstrapped || !url || handledRef.current === url) return;
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
  }, [router, url, isBootstrapped]);

  return null;
}

export default function RootLayout() {
  return (
    // GatewayProvider stays outside FontProvider on purpose: FontProvider
    // withholds its children until useFonts resolves, while the provider's
    // bootstrap effect (storage reads + auto-connect) must run during that
    // wait, not after it. The native splash still hides on font resolution
    // and AppBootstrap still gates the Stack on isBootstrapped.
    <GatewayProvider>
      <FontProvider>
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
      </FontProvider>
    </GatewayProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
