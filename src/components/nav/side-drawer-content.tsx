import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from 'expo-router/drawer';
import { useRouter } from 'expo-router';
import { useEffect, useId, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { BotAvatar } from '@/components/chat/bot-avatar';
import { PulsingDot, statusColor, statusLabel } from '@/components/connection-badge';
import { Icon, PressableScale, Text } from '@/components/ui';
import type { IconName } from '@/components/ui/Icon';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import { teamPresence, type TeamPresence } from '@/lib/activity/presence';
import { botReportedRoutable } from '@/lib/gateway/roster-tap';
import { haptics } from '@/lib/haptics';

type NavHref = '/chat' | '/activity' | '/terminal' | '/gateway/settings' | '/home';

type NavTarget = {
  key: string;
  title: string;
  href: NavHref;
  icon: IconName;
  routeNames?: string[];
};

const PRIMARY: NavTarget[] = [
  {
    key: 'chat',
    title: 'Chats',
    href: '/chat',
    icon: {
      ios: 'bubble.left.and.bubble.right',
      android: 'chat',
      web: 'chat',
    },
    routeNames: ['chat'],
  },
  {
    key: 'activity',
    title: 'Activity',
    href: '/activity',
    icon: { ios: 'bolt', android: 'bolt', web: 'bolt' },
    routeNames: ['activity'],
  },
  {
    key: 'terminal',
    title: 'Tools',
    href: '/terminal',
    icon: { ios: 'terminal', android: 'terminal', web: 'terminal' },
    routeNames: ['terminal'],
  },
];

const SETTINGS: NavTarget = {
  key: 'settings',
  title: 'Settings',
  href: '/gateway/settings',
  icon: { ios: 'gearshape', android: 'settings', web: 'settings' },
};

/** How many Bots the drawer lists before the roster takes over. */
const DRAWER_TEAM_LIMIT = 6;

/**
 * The drawer is part of the lit room: the house violet pools behind the mark
 * at the top, and the panel's leading edge catches a hairline of light.
 */
function DrawerLight() {
  const tokens = useTokens();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height={260} style={styles.pool}>
        <Defs>
          <RadialGradient id={`pool-${id}`} cx="18%" cy="4%" rx="75%" ry="80%" fx="18%" fy="4%">
            <Stop offset="0" stopColor={tokens.accent} stopOpacity={0.34} />
            <Stop offset="0.5" stopColor={tokens.accentDeep} stopOpacity={0.1} />
            <Stop offset="1" stopColor={tokens.accentDeep} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height={260} fill={`url(#pool-${id})`} />
      </Svg>
      <Svg width={1} height="100%" style={styles.edge}>
        <Defs>
          <LinearGradient id={`edge-${id}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.14} />
            <Stop offset="0.45" stopColor="#FFFFFF" stopOpacity={0.04} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width={1} height="100%" fill={`url(#edge-${id})`} />
      </Svg>
    </View>
  );
}

function PresenceNote({ presence }: { presence: TeamPresence }) {
  const tokens = useTokens();
  const color = presence === 'needs-you' ? tokens.statusConnecting : tokens.accent;
  return (
    <View style={styles.presence}>
      <View style={[styles.presenceDot, { backgroundColor: color }]} />
      <Text variant="micro" style={{ color }}>
        {presence === 'needs-you' ? 'needs you' : 'working'}
      </Text>
    </View>
  );
}

function DrawerRow({
  title,
  icon,
  leading,
  active = false,
  count,
  note,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  icon?: IconName;
  leading?: React.ReactNode;
  active?: boolean;
  /** A number that needs the operator (pending approvals). Hidden at zero. */
  count?: number;
  /** A quiet line at the row's end: what a teammate is doing right now. */
  note?: React.ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const tokens = useTokens();
  return (
    <PressableScale
      onPress={async () => {
        await haptics.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ selected: active }}
      style={[styles.row, active ? { backgroundColor: tokens.rowSelected } : null]}>
      {/* Where you are: the same lit lift and violet light bar as the current
          row in every sheet — one way the app says "this one". */}
      {active ? <View pointerEvents="none" style={[styles.activeBar, { backgroundColor: tokens.accent }]} /> : null}
      {leading ?? (icon ? <Icon name={icon} size={19} color={active ? 'textPrimary' : 'textSecondary'} /> : null)}
      <Text
        variant="callout"
        color={active ? 'primary' : 'secondary'}
        numberOfLines={1}
        style={styles.rowTitle}>
        {title}
      </Text>
      {note}
      {count ? (
        // What needs you wears the attention amber, as it does on Activity.
        <View style={[styles.count, { backgroundColor: tokens.statusConnecting }]}>
          <Text variant="micro" style={[styles.countText, { color: tokens.textInverse }]}>
            {count > 99 ? '99+' : String(count)}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

/**
 * Side drawer IA per CHARTER / visual-direction (LOCKED): chats, Activity,
 * Tools, settings entry, and a thin Gate/connect status. Home is not a
 * co-equal destination — Gate status here is the residual, with a quiet tap
 * through to `/home` for the full dashboard when needed. Zero bottom tabs.
 *
 * Nocturne adds the team: the Bots the operator talks to are one tap from
 * anywhere, the way a messages app keeps your people in its sidebar.
 */
export function SideDrawerContent(props: DrawerContentComponentProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tokens = useTokens();
  const {
    status,
    statusDetail,
    activeGateway,
    gateways,
    settings,
    listBots,
    openBot,
    requestSurface,
    clearBot,
    pendingApprovals,
    activityRunsForActiveGateway,
  } = useGateway();
  const presence = teamPresence(activityRunsForActiveGateway);
  const routeName = props.state.routes[props.state.index]?.name;
  const [team, setTeam] = useState<PublicBot[]>([]);

  // The drawer keeps its own short read of the team: it is mounted beside
  // every screen, so it cannot borrow the Chat screen's roster.
  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (!cancelled) setTeam(bots);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [listBots, status]);

  const go = (href: NavHref) => {
    props.navigation.closeDrawer();
    router.push(href);
  };

  const openTeammate = (bot: PublicBot) => {
    props.navigation.closeDrawer();
    router.push('/chat');
    // The same two steps a quick reply takes: open the Bot's chat, then ask
    // the Chat screen to move onto it. A failed open leaves the roster up.
    void openBot(bot.id)
      .then((opened) => {
        if (opened) requestSurface({ kind: 'bot', botId: bot.id });
      })
      .catch(() => undefined);
  };

  // A fresh conversation with no Bot in between — the drawer's first answer
  // to "I want to ask something", the way every assistant's sidebar opens.
  const startNewChat = () => {
    props.navigation.closeDrawer();
    router.push('/chat');
    clearBot();
    requestSurface({ kind: 'configurable' });
  };

  const gateName = settings.pcName ?? activeGateway?.name;
  const gateSubtitle =
    status === 'connected'
      ? statusLabel(status)
      : gateways.length === 0
        ? 'No gateway yet'
        : statusDetail || statusLabel(status);
  const routableTeam = team.filter(botReportedRoutable).slice(0, DRAWER_TEAM_LIMIT);

  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top, Spacing.two) + Spacing.three }]}>
      <DrawerLight />
      <View style={styles.brand}>
        <VersutusMark size={28} />
        <Text variant="title" style={styles.wordmark}>
          Versutus
        </Text>
      </View>

      <PressableScale
        onPress={async () => {
          await haptics.selection();
          startNewChat();
        }}
        accessibilityRole="button"
        accessibilityLabel="New chat"
        accessibilityHint="Talk to any model, no Bot in between"
        style={[styles.newChat, { backgroundColor: tokens.backgroundRaised, borderTopColor: tokens.specular }]}>
        <Icon
          name={{ ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' }}
          size={17}
          color="textPrimary"
        />
        <Text variant="callout" style={styles.newChatLabel}>
          New chat
        </Text>
      </PressableScale>

      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scroll}
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          {PRIMARY.map((item) => (
            <DrawerRow
              key={item.key}
              title={item.title}
              icon={item.icon}
              active={item.routeNames?.includes(routeName) ?? false}
              count={item.key === 'activity' ? pendingApprovals.length : undefined}
              accessibilityLabel={
                item.key === 'activity' && pendingApprovals.length > 0
                  ? `Activity, ${pendingApprovals.length} waiting for you`
                  : item.title
              }
              onPress={() => go(item.href)}
            />
          ))}
        </View>

        {routableTeam.length > 0 ? (
          <View style={styles.section}>
            <Text variant="eyebrow" color="tertiary" style={styles.sectionLabel}>
              Your team
            </Text>
            {routableTeam.map((bot) => (
              <DrawerRow
                key={bot.id}
                title={bot.displayName}
                leading={<BotAvatar botId={bot.id} name={bot.displayName} size={26} />}
                note={presence.get(bot.id) ? <PresenceNote presence={presence.get(bot.id)!} /> : undefined}
                accessibilityLabel={`Chat with ${bot.displayName}${
                  presence.get(bot.id) === 'needs-you'
                    ? ', needs you'
                    : presence.get(bot.id) === 'working'
                      ? ', working'
                      : ''
                }`}
                onPress={() => openTeammate(bot)}
              />
            ))}
          </View>
        ) : null}
      </DrawerContentScrollView>

      <View style={[styles.foot, { paddingBottom: insets.bottom + Spacing.three }]}>
        <DrawerRow title={SETTINGS.title} icon={SETTINGS.icon} onPress={() => go(SETTINGS.href)} />
        <PressableScale
          onPress={async () => {
            await haptics.selection();
            go('/home');
          }}
          accessibilityRole="button"
          accessibilityLabel={`Gate status: ${statusLabel(status)}. ${gateName ?? gateSubtitle}. Open Gate details.`}
          style={[styles.gate, { backgroundColor: tokens.backgroundRaised }]}>
          <PulsingDot
            color={statusColor(tokens, status)}
            active={status === 'connecting' || status === 'reconnecting'}
          />
          <View style={styles.gateText}>
            <Text variant="callout" numberOfLines={1}>
              {gateName ?? 'Gate'}
            </Text>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {gateSubtitle}
            </Text>
          </View>
          <Icon
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            size={14}
            color="textTertiary"
          />
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Palette.backgroundElevated,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingHorizontal: Spacing.four - 4,
    paddingBottom: Spacing.four - 4,
  },
  wordmark: {
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.3,
  },
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    minHeight: 44,
    marginHorizontal: Spacing.two,
    marginBottom: Spacing.four - 4,
    paddingHorizontal: Spacing.three - 2,
    borderRadius: Radius.full,
    // The lip of light every floating surface carries (Nocturne: Surfaces).
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  newChatLabel: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: Spacing.two,
    paddingTop: 0,
    gap: Spacing.four,
  },
  section: {
    gap: 2,
  },
  sectionLabel: {
    paddingHorizontal: Spacing.three - 4,
    paddingBottom: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 2,
    minHeight: 44,
    paddingHorizontal: Spacing.three - 4,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    top: 11,
    bottom: 11,
    width: 3,
    borderRadius: 2,
  },
  pool: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  edge: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  presence: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  presenceDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  rowTitle: {
    flex: 1,
  },
  count: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    letterSpacing: 0,
    fontWeight: '700',
  },
  foot: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
    gap: Spacing.two,
  },
  gate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.three - 4,
    borderRadius: Radius.lg,
  },
  gateText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
});
