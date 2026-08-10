import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { FontFamily, Palette } from '@/constants/tokens';

export default function TabsLayout() {
  return (
    <NativeTabs
      backgroundColor={Palette.background}
      blurEffect="systemChromeMaterialDark"
      shadowColor={Palette.border}
      iconColor={{
        default: Palette.textTertiary,
        selected: Palette.accentWarm,
      }}
      tintColor={Palette.accentWarm}
      indicatorColor={Palette.accentMuted}
      labelStyle={{
        default: {
          color: Palette.textSecondary,
          fontFamily: FontFamily.sans,
          fontSize: 11,
          fontWeight: '500',
        },
        selected: {
          color: Palette.textPrimary,
          fontFamily: FontFamily.sansSemiBold,
          fontSize: 11,
          fontWeight: '600',
        },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home' }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="chat">
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md={{ default: 'chat', selected: 'chat' }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bolt', selected: 'bolt.fill' }}
          md={{ default: 'bolt', selected: 'bolt' }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="terminal">
        <NativeTabs.Trigger.Label>Tools</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'terminal', selected: 'terminal.fill' }}
          md={{ default: 'terminal', selected: 'terminal' }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
