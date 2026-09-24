import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { FontFamily, Palette } from '@/constants/tokens';

// Quiet selected label for the non-hero tabs: cool white at the resting
// medium weight, never the brand-violet lift Chat earns on the bar.
const quietSelectedLabel = {
  color: Palette.textPrimary,
  fontFamily: FontFamily.sans,
  fontWeight: '500' as const,
};

/**
 * Tab IA per docs/visual-direction-2026-09.md (ACCEPTED): Chat is the hero
 * and holds the first (leftmost) trigger; Home is demoted to the trailing
 * slot — still one tap away, no longer a co-equal pillar. `/` itself redirects
 * to `/chat` (see `index.tsx`), so the cold start lands on the roster.
 *
 * Selected chrome wears the violet pair the tokens define for selection:
 * `accentWarm` (brighter violet selected/focus) on tint and icon, `accentMuted`
 * on the Android indicator. Chat inherits that full brand lift as the hero;
 * Activity and Tools opt their triggers down to a quiet cool-white selected
 * icon + medium-weight label so only Chat lights up violet on the bar.
 */
export default function TabsLayout() {
  return (
    <NativeTabs
      sidebarAdaptable
      labelVisibilityMode="labeled"
      backBehavior="history"
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
        <NativeTabs.Trigger.Label selectedStyle={quietSelectedLabel}>
          Activity
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bolt', selected: 'bolt.fill' }}
          md={{ default: 'bolt', selected: 'bolt' }}
          selectedColor={Palette.textPrimary}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="terminal">
        <NativeTabs.Trigger.Label selectedStyle={quietSelectedLabel}>
          Tools
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'terminal', selected: 'terminal.fill' }}
          md={{ default: 'terminal', selected: 'terminal' }}
          selectedColor={Palette.textPrimary}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="home">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home' }}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
