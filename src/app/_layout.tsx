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
import {
  GatewayProvider,
  useGateway,
  type SendChatInputOutcome,
} from '@/context/gateway-provider';
import type { ChatSurface } from '@/lib/gateway/bots';
import type { ConnectionStatus } from '@/lib/gateway/types';
import { installStreamingFetch } from '@/lib/net/streaming-fetch';
import {
  approvalDecisionFor,
  approvalRefusalReason,
  decisionCanReachGateway,
  isApprovalActionFor,
} from '@/lib/notifications/approval-action';
import { botReplyFromResponse, type BotReply } from '@/lib/notifications/bot-reply';
import {
  BOT_MESSAGE_REPLY_ACTION_ID,
  registerNotificationCategories,
} from '@/lib/notifications/categories';
import {
  isLaunchReplay,
  readLaunchResponse,
  type LaunchTap,
} from '@/lib/notifications/launch-response';
import {
  notifyApprovalDecided,
  notifyApprovalRefused,
  notifyBotReplyNotSent,
} from '@/lib/notifications/local';
import type { RunFocus } from '@/lib/notifications/run-focus';
import { routeForTap } from '@/lib/notifications/tap-route';

// React Native's global fetch cannot stream a response body, so SSE readers
// throw on device. Install the WinterCG implementation before any gateway
// client is constructed. See streaming-fetch.ts for why it is installed here
// rather than imported by the transport.
installStreamingFetch(expoFetch as unknown as typeof globalThis.fetch);

/**
 * The provider calls a quick reply needs, narrowed to the shape the reply path
 * uses so the listener can hold them in a ref.
 */
type BotReplySender = {
  openBot: (botId: string) => Promise<void>;
  sendChatInput: (
    text: string,
    destination?: { botId?: string; sessionId?: string },
  ) => Promise<SendChatInputOutcome>;
  requestSurface: (surface: ChatSurface) => void;
};

/**
 * Hand a reply typed on a bot-message notice to the ordinary chat send path —
 * never a second pipeline of its own.
 *
 * The reply belongs in that Bot's canonical Bot Chat (ADR 0012), so the Bot is
 * opened first: `openBot` resolves the Bot's pinned chat, creates it if it is
 * missing and makes it the session a send goes to. The open is skipped while
 * the connection is not `connected` — it is a gateway read that could only
 * fail, and its failure path reports a gateway error about a gateway that is
 * merely offline.
 *
 * The text goes to `sendChatInput` either way, because that call's own
 * pre-flight guard is what parks an unsendable reply in the durable offline
 * outbox and answers 'queued' — the same route a composer send takes, so the
 * reply is re-surfaced and flushed after a reload exactly like any other queued
 * chat. That outcome is what the follow-up notice reports.
 *
 * The destination rides with the words: the reply's Bot and the session the
 * notice was about are handed to `sendChatInput`, so a reply parked in the
 * outbox is still a reply for that Bot Chat — the flush opens it before the
 * text moves, instead of sending into whatever thread is current by then.
 *
 * A reply whose Bot Chat could not be opened is NOT sent: `sendChatInput` would
 * fall back to whichever session the client still held, putting the operator's
 * words in a conversation they did not choose. Nothing is sent, and the notice
 * says only that.
 *
 * Opening the Bot Chat reloads the transcript the chat context shares, but the
 * screen showing it keeps its own record of which surface is up — its header,
 * its panes and its backends picker all read that state. So the screen is asked
 * to move to that Bot Chat once the open has landed; a reply that never opened
 * one asks for nothing, since then nothing on screen has changed.
 */
async function deliverBotReply(
  reply: BotReply,
  sender: BotReplySender,
  status: ConnectionStatus,
): Promise<void> {
  if (decisionCanReachGateway(status)) {
    try {
      await sender.openBot(reply.botId);
    } catch {
      void notifyBotReplyNotSent('bot-chat-unavailable');
      return;
    }
    sender.requestSurface({ kind: 'bot', botId: reply.botId });
  }
  const outcome = await sender.sendChatInput(reply.text, {
    botId: reply.botId,
    sessionId: reply.sessionId,
  });
  if (outcome === 'queued') void notifyBotReplyNotSent('queued');
}

function NotificationRouter() {
  const router = useRouter();
  const {
    isBootstrapped,
    pendingRunApproval,
    resolveRunApproval,
    status,
    openBot,
    sendChatInput,
    requestSurface,
    requestRunFocus,
  } = useGateway();
  // The launch tap is read once, and its route is held until bootstrap has
  // mounted the Stack: navigating any earlier loses to the boot overlay's
  // first-run redirect (the wait GatewayDeepLinkRouter already does). A tap
  // delivered to the live listener during that same window is held here too.
  const launchReadRef = useRef(false);
  const pendingTapRef = useRef<'/chat' | '/activity' | null>(null);
  // The run a held tap named, applied with the held destination. A run notice
  // is usually tapped from a cold start, and a focus dropped on the way through
  // the bootstrap wait is the mis-landing this router exists to prevent.
  const pendingRunFocusRef = useRef<RunFocus | null>(null);
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

  // The live connection status, for the same reason the approval is mirrored:
  // a decision can only reach its run while the connection is up, and the
  // listener's deps must stay [router, isBootstrapped] so a status flip never
  // re-registers it (and never re-runs the held-tap apply below).
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // The Bot Chat send path a quick reply reuses, mirrored for the same reason
  // the approval and the status are: the listener below is registered once, and
  // `openBot` / `sendChatInput` are rebuilt whenever the gateway or session
  // scope changes — putting them in the listener's deps would re-register it
  // (and re-run the held-tap apply) on every one of those changes.
  const replySenderRef = useRef<BotReplySender | null>(null);
  useEffect(() => {
    replySenderRef.current = { openBot, sendChatInput, requestSurface };
  }, [openBot, sendChatInput, requestSurface]);

  // The run-focus request, mirrored for the same reason the reply sender is:
  // the listener below is registered once, and `requestRunFocus` must not join
  // its deps.
  const runFocusRef = useRef<((focus: RunFocus) => void) | null>(null);
  useEffect(() => {
    runFocusRef.current = requestRunFocus;
  }, [requestRunFocus]);

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

    // The run a payload named, if it named one. The destination above drops the
    // id — Activity is one tab, so there is no route to carry it — and the run
    // rides beside it instead: the tab drops whatever Bot filter could be
    // hiding it. A notice naming no run asks for no focus at all, and the id
    // never selects a row: a run this device does not hold has no row to reach.
    const runFocusFor = (data: unknown): RunFocus | null => {
      const route = routeForTap(data);
      return route?.kind === 'run' ? { runId: route.runId } : null;
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
      // identifier is the discriminator, the payload must name the approval
      // pending right now, and the connection must still be live so the
      // decision can reach the run. A decision that lands leaves the tap path
      // — the operator decided, so nothing else happens.
      const decision = approvalDecisionFor(response.actionIdentifier);
      const pendingApproval = approvalRef.current;
      if (
        decision &&
        pendingApproval &&
        decisionCanReachGateway(statusRef.current) &&
        isApprovalActionFor(response.notification.request.content.data, pendingApproval.runId)
      ) {
        pendingApproval.resolve(decision === 'approve');
        // The decision landed, so acknowledge it: the resolve above hands the
        // decision to the driver, which reports it to the gateway and carries
        // the run on (or stops it). The copy names the decision and what it
        // asks of the run, never a gateway verdict the app is not shown.
        void notifyApprovalDecided(decision);
        return;
      }
      if (decision) {
        // Fail closed, and say the true reason. A notice with nothing waiting
        // behind it is not a gateway problem — a decided notice sits in the
        // tray until it is cleared, and the payload may name a run this app is
        // no longer driving — so only a payload naming the run this app IS
        // driving gets the unreachable copy. Either way the approval stays
        // pending and the destination below brings the operator to the surface
        // where they can still decide it.
        const reason = approvalRefusalReason(
          statusRef.current,
          response.notification.request.content.data,
          pendingApproval?.runId ?? null,
        );
        if (reason) void notifyApprovalRefused(reason);
      }
      // A reply typed into a bot-message notice is the operator's own text, and
      // it goes to the same send path the chat composer uses. The action
      // identifier says it is a reply; the payload and the typed text have to
      // name a Bot (botReplyFromResponse), or there is nothing to send and the
      // tap's destination below is all that is left to do.
      if (response.actionIdentifier === BOT_MESSAGE_REPLY_ACTION_ID) {
        const reply = botReplyFromResponse(
          response.notification.request.content.data,
          response.userText,
        );
        const sender = replySenderRef.current;
        if (reply && sender) {
          void deliverBotReply(reply, sender, statusRef.current);
          return;
        }
      }
      const destination = destinationFor(response.notification.request.content.data);
      const runFocus = runFocusFor(response.notification.request.content.data);
      if (!isBootstrapped) {
        // Boot overlay: the Stack is not mounted yet, so navigating now
        // loses to the first-run redirect. Hold the destination in the same
        // slot the launch tap uses; the run below routes it once the Stack
        // is up.
        pendingTapRef.current = destination;
        pendingRunFocusRef.current = runFocus;
        return;
      }
      router.navigate(destination);
      // The tab may be filtered to a Bot the notice's run does not belong to,
      // so the filter is dropped. The tab applies the request and clears it.
      if (runFocus) runFocusRef.current?.(runFocus);
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
        pendingRunFocusRef.current = runFocusFor(launch.notification.request.content.data);
      }
    }

    // The one place a held tap is routed, whichever path held it: bootstrap
    // has mounted the Stack, so the destination now survives the boot
    // overlay's first-run redirect.
    if (isBootstrapped && pendingTapRef.current) {
      const destination = pendingTapRef.current;
      pendingTapRef.current = null;
      const runFocus = pendingRunFocusRef.current;
      pendingRunFocusRef.current = null;
      router.navigate(destination);
      if (runFocus) runFocusRef.current?.(runFocus);
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
                  name="gateway/spend"
                  options={{
                    presentation: 'modal',
                    headerShown: true,
                    title: 'Spend',
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
