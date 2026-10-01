import { Drawer, type DrawerContentComponentProps } from 'expo-router/drawer';

import { SideDrawerContent } from '@/components/nav/side-drawer-content';
import { Palette } from '@/constants/tokens';

/**
 * The drawer's content renderer, built once at module level: a fresh function
 * identity on every render of this layout is one more reason the navigator
 * rebuilds a drawer that is usually closed.
 */
const renderDrawerContent = (props: DrawerContentComponentProps) => <SideDrawerContent {...props} />;

/**
 * Navigation IA per docs/visual-direction-2026-09.md + CHARTER (LOCKED
 * 2026-09-24): side drawer, **zero** bottom tabs. Chat is the product
 * surface; Activity, Tools, settings, and a thin Gate/connect status live in
 * the drawer. Home stays routable at `/home` for deep links and the residual
 * Gate dashboard, but it is not a co-equal drawer pillar.
 *
 * The `(tabs)` group name is historical — Expo Router group folders do not
 * affect URLs, so `/chat`, `/activity`, `/terminal`, and `/home` keep working.
 */
export default function TabsLayout() {
  return (
    <Drawer
      initialRouteName="chat"
      drawerContent={renderDrawerContent}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        swipeEnabled: true,
        swipeEdgeWidth: 44,
        overlayColor: 'rgba(0, 0, 0, 0.55)',
        drawerStyle: {
          backgroundColor: Palette.backgroundElevated,
          width: 300,
        },
      }}>
      <Drawer.Screen
        name="chat"
        options={{
          title: 'Chats',
          drawerLabel: 'Chats',
        }}
      />
      <Drawer.Screen
        name="activity"
        options={{
          title: 'Activity',
          drawerLabel: 'Activity',
        }}
      />
      <Drawer.Screen
        name="terminal"
        options={{
          title: 'Tools',
          drawerLabel: 'Tools',
        }}
      />
      <Drawer.Screen
        name="home"
        options={{
          title: 'Gate',
          drawerItemStyle: { display: 'none' },
        }}
      />
      <Drawer.Screen
        name="index"
        options={{
          drawerItemStyle: { display: 'none' },
        }}
      />
    </Drawer>
  );
}
