import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from 'expo-router/drawer';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PulsingDot, statusColor, statusLabel } from '@/components/connection-badge';
import { ListRow, Text } from '@/components/ui';
import type { IconName } from '@/components/ui/Icon';
import { Palette, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';

type NavHref = '/chat' | '/activity' | '/terminal' | '/gateway/settings' | '/home';

type NavTarget = {
  key: string;
  title: string;
  subtitle: string;
  href: NavHref;
  icon: IconName;
  routeNames?: string[];
};

const PRIMARY: NavTarget[] = [
  {
    key: 'chat',
    title: 'Chats',
    subtitle: 'Roster and conversations',
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
    subtitle: 'Approvals, cron, spend',
    href: '/activity',
    icon: { ios: 'bolt', android: 'bolt', web: 'bolt' },
    routeNames: ['activity'],
  },
  {
    key: 'terminal',
    title: 'Tools',
    subtitle: 'Shell, RPC, agent commands',
    href: '/terminal',
    icon: { ios: 'terminal', android: 'terminal', web: 'terminal' },
    routeNames: ['terminal'],
  },
  {
    key: 'settings',
    title: 'Settings',
    subtitle: 'Gateway, voice, devices',
    href: '/gateway/settings',
    icon: { ios: 'gearshape', android: 'settings', web: 'settings' },
  },
];

/**
 * Side drawer IA per CHARTER / visual-direction (LOCKED): chats, Activity,
 * Tools, settings entry, and a thin Gate/connect status. Home is not a
 * co-equal destination — Gate status here is the residual, with a quiet tap
 * through to `/home` for the full dashboard when needed. Zero bottom tabs.
 */
export function SideDrawerContent(props: DrawerContentComponentProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tokens = useTokens();
  const { status, statusDetail, activeGateway, gateways } = useGateway();
  const routeName = props.state.routes[props.state.index]?.name;

  const go = (href: NavHref) => {
    props.navigation.closeDrawer();
    router.push(href);
  };

  const gateSubtitle =
    activeGateway?.name ??
    (gateways.length === 0 ? 'No gateway yet' : statusDetail || statusLabel(status));

  return (
    <DrawerContentScrollView
      {...props}
      contentContainerStyle={[
        styles.scroll,
        {
          paddingTop: Math.max(insets.top, Spacing.three),
          paddingBottom: insets.bottom + Spacing.four,
        },
      ]}
      style={styles.root}>
      <View style={styles.brand}>
        <Text variant="headline">Versutus</Text>
        <Text variant="caption" color="secondary">
          Conversation first
        </Text>
      </View>

      <View style={styles.section}>
        {PRIMARY.map((item) => {
          const active = item.routeNames?.includes(routeName) ?? false;
          return (
            <ListRow
              key={item.key}
              title={item.title}
              subtitle={item.subtitle}
              icon={item.icon}
              onPress={() => go(item.href)}
              chevron
              accessibilityLabel={`${item.title}. ${item.subtitle}`}
              style={active ? styles.activeRow : undefined}
            />
          );
        })}
      </View>

      <View style={styles.gate}>
        <Text variant="micro" color="secondary" style={styles.gateLabel}>
          GATE
        </Text>
        <ListRow
          title={statusLabel(status)}
          subtitle={gateSubtitle}
          leading={
            <PulsingDot
              color={statusColor(tokens, status)}
              active={status === 'connecting' || status === 'reconnecting'}
            />
          }
          onPress={() => go('/home')}
          chevron
          accessibilityLabel={`Gate status: ${statusLabel(status)}. ${gateSubtitle}. Open Gate details.`}
        />
      </View>
    </DrawerContentScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: Palette.backgroundElevated,
  },
  scroll: {
    paddingHorizontal: Spacing.two,
    gap: Spacing.four,
  },
  brand: {
    paddingHorizontal: Spacing.two,
    gap: Spacing.one,
  },
  section: {
    gap: Spacing.one,
  },
  activeRow: {
    backgroundColor: Palette.backgroundRaised,
  },
  gate: {
    gap: Spacing.one,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border,
  },
  gateLabel: {
    paddingHorizontal: Spacing.two,
    letterSpacing: 0.8,
  },
});
