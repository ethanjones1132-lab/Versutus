# Handoff: Versutus UI Overhaul — PR4 through PR8

**For:** Fresh agent session  
**Project:** `C:\Users\ethan\Versutus`  
**Goal:** Complete the remaining UI overhaul PRs (4–8) with **luxury-grade** quality as the baseline. Do not cut corners on glass surfaces, motion, or native platform components.

---

## Mission

Versutus is an Expo SDK 56 mobile client for OpenClaw gateway (Tailscale + chat + terminal). The app was scaffolded from an Expo starter; PR1–3 replaced the foundation. **Your job is PR4–8:** shared components → screens → polish.

**Hard constraint:** Do **not** modify business logic in [`src/context/gateway-provider.tsx`](../../src/context/gateway-provider.tsx) or gateway lib code unless fixing a UI-induced type error.

**Docs rule:** Read [Expo v56 docs](https://docs.expo.dev/versions/v56.0.0/) before writing native UI code ([`AGENTS.md`](../../AGENTS.md)).

---

## Progress tracker

Update [`status.json`](./status.json) after each PR (`completed` + `completedAt` ISO timestamp).

| PR | Status | Scope |
|----|--------|-------|
| PR1 | ✅ Done | Tokens, fonts, dark root theme |
| PR2 | ✅ Done | `src/components/ui/` primitives |
| PR3 | ✅ Done | NativeTabs shell |
| PR4 | ⏳ Pending | Shared components rebuild |
| PR5 | ⏳ Pending | Home + Onboarding screens |
| PR6 | ⏳ Pending | Chat screen (highest complexity) |
| PR7 | ⏳ Pending | Terminal + Settings/Add |
| PR8 | ⏳ Pending | Brand assets, motion, haptics, final polish |

**Full plan:** [`plan.md`](file:///C:/Users/ethan/.grok/sessions/C%3A%5CUsers%5Cethan%5C019ee6fe-3f3f-7023-9a89-ec399e6b75cb/plan.md) (design direction, architecture diagrams, success criteria)

**Per-PR prompts:** `pr4-prompt.txt` … `pr8-prompt.txt` in this folder.

---

## What PR1–3 already delivered

### Design system
- [`src/constants/tokens.ts`](../../src/constants/tokens.ts) — semantic palette, typography, spacing, radius, motion
- [`src/hooks/use-tokens.ts`](../../src/hooks/use-tokens.ts) — `useTokens()` hook
- [`src/constants/theme.ts`](../../src/constants/theme.ts) — legacy `Colors` shim for migrating `ThemedText`/`ThemedView`
- [`src/constants/navigation-theme.ts`](../../src/constants/navigation-theme.ts) — `VersutusDarkTheme`
- Fonts: Instrument Sans + JetBrains Mono via [`src/components/font-provider.tsx`](../../src/components/font-provider.tsx)
- Dark-first root: [`src/app/_layout.tsx`](../../src/app/_layout.tsx), splash `#08080A` in [`app.json`](../../app.json)

### UI primitives (`src/components/ui/`)
Import from `@/components/ui` or individual files. Platform splits: `.ios.tsx`, `.android.tsx`, `.web.tsx` + `.tsx` fallback.

| Component | Notes |
|-----------|-------|
| `GlassSurface` | iOS: `expo-glass-effect`; Android: Compose `Surface`; Web: CSS blur |
| `Button` | iOS: SwiftUI glass buttons; Android: Compose; Web: Reanimated press |
| `Text` | Token-driven typography |
| `TextField` | Native fields on iOS/Android; styled RN on web |
| `Card` | GlassSurface wrapper |
| `Screen` | Safe area + subtle ambient gradient orbs |
| `ScreenHeader` | Title + SF Symbol trailing action |

### Native tab shell
- [`src/app/(tabs)/_layout.tsx`](../../src/app/(tabs)/_layout.tsx) — `NativeTabs` with SF Symbols / Material icons
- Deleted dead template: `app-tabs.tsx`, `app-tabs.web.tsx`

### Installed deps (relevant)
`@expo/ui`, `expo-glass-effect`, `react-native-reanimated`, `expo-symbols`, `expo-haptics`, `@expo-google-fonts/instrument-sans`, `@expo-google-fonts/jetbrains-mono`

---

## Design direction (do not drift)

**Mood:** Dark premium + Liquid Glass — deep blacks (`#08080A`), translucent depth, restrained sapphire (`#3B6FD9`) + champagne gold (`#C9A962`) accents.

**Platform strategy:** Native-first (SwiftUI / Compose via `@expo/ui`) on iOS/Android; Reanimated + CSS glass fallbacks on web. Visual parity = same hierarchy and tokens, not identical blur physics.

**Glass requires native builds** — Expo Go will not show Liquid Glass. Acceptable Material/CSS fallbacks on Android/web.

---

## PR4 — Shared components (do this first)

Rebuild using `ui/` primitives. Migrate off `ThemedText`/`ThemedView` where you touch these files.

| File | Requirements |
|------|----------------|
| [`connection-badge.tsx`](../../src/components/connection-badge.tsx) | Reanimated pulsing dot on `connecting`/`reconnecting`; glass pill; gold accent for `pairing` |
| [`home-status-card.tsx`](../../src/components/home-status-card.tsx) | Hero glass card; connection phase stepper; `Button` CTA; `FadeIn` on state change |
| [`pairing-panel.tsx`](../../src/components/pairing-panel.tsx) | Numbered steps; `expo-haptics` on copy; gold urgency border; iOS `ContextMenu` on device ID |
| [`gateway-card.tsx`](../../src/components/gateway-card.tsx) | iOS `SwipeActions` delete; glass row; active gateway glow ring |
| [`discovered-gateway-row.tsx`](../../src/components/discovered-gateway-row.tsx) | Discovery scan animation while scanning |

**Still using legacy blue `#208AEF` in these files** — replace with `Palette.accent` / `useTokens()`.

---

## PR5 — Home + Onboarding

| File | Requirements |
|------|----------------|
| [`src/app/(tabs)/index.tsx`](../../src/app/(tabs)/index.tsx) | `Screen` + `ScreenHeader` (settings gear → `/gateway/settings`); `HomeStatusCard` hero; collapsible glass troubleshooting/discovery panels; optional `GradientMesh` background (create `src/components/layout/GradientMesh.tsx` if needed). **Remove duplicate "Home" title** — NativeTabs labels tabs. |
| [`src/app/onboarding.tsx`](../../src/app/onboarding.tsx) | Branded Versutus wordmark + tagline over glass; single `TextField` with live validation; stepped connection timeline (`searching → connecting → pairing → connected`); iOS `withAnimation` between steps. User approved this onboarding direction. |

---

## PR6 — Chat (highest risk)

[`src/app/(tabs)/chat.tsx`](../../src/app/(tabs)/chat.tsx)

- Asymmetric glass bubbles: user = `accent` tint, assistant = neutral glass
- Reanimated three-dot streaming indicator (not static `…`)
- Floating glass composer above tab bar; send → stop when streaming
- iOS `ContentUnavailableView` empty state
- Pairing: slide-down glass sheet, not inline `PairingPanel`
- Message enter: `SlideInRight` / `SlideInLeft`
- **Preserve** all `useGateway()` send/receive/history logic

---

## PR7 — Terminal + Settings

| File | Requirements |
|------|----------------|
| [`terminal.tsx`](../../src/app/(tabs)/terminal.tsx) | Dark inset pane `#0D0D0F`; glass command chips; segmented Shell \| Gateway RPC \| Agent (`@expo/ui` Picker / SegmentedButton); log output in `BottomSheet` / `ModalBottomSheet` |
| [`gateway/settings.tsx`](../../src/app/gateway/settings.tsx) | iOS: `Form` + `Section`; Android: `LazyColumn` + `ListItem` |
| [`gateway/add.tsx`](../../src/app/gateway/add.tsx) | Mobile `BottomSheet`; native `TextField`; `DisclosureGroup` for advanced options |

---

## PR8 — Brand + motion polish

- [`animated-icon.tsx`](../../src/components/animated-icon.tsx) + [`.web.tsx`](../../src/components/animated-icon.web.tsx) — Versutus splash dissolve (palette already partially updated)
- Create [`src/lib/motion/presets.ts`](../../src/lib/motion/presets.ts) + `hooks.ts` — centralize Reanimated springs/durations from `tokens.Motion`
- Wire `expo-haptics` on copy/send (pairing panel, chat)
- Replace Expo template assets (`assets/images/expo-logo.png`, glow, etc.) with Versutus identity; update `assets/expo.icon`
- **Final grep:** zero `#208AEF` in `src/` (currently ~15 occurrences across screens + shared components)
- Mark all PRs complete in `status.json`

---

## Files still on legacy patterns

Screens/components still import `ThemedText` / `ThemedView` and hardcoded `#208AEF`:

```
src/app/(tabs)/chat.tsx
src/app/(tabs)/index.tsx
src/app/(tabs)/terminal.tsx
src/app/onboarding.tsx
src/app/gateway/add.tsx
src/app/gateway/settings.tsx
src/components/home-status-card.tsx
src/components/gateway-card.tsx
src/components/discovered-gateway-row.tsx
```

`themed-text.tsx` has `linkPrimary: '#3B6FD9'` — migrate to tokens when touching.

---

## Verification (run after each PR)

```powershell
pushd C:\Users\ethan\Versutus
npx tsc --noEmit
```

Optionally: `npx expo start` and spot-check on iOS simulator + Android emulator. Native glass only visible in dev builds, not Expo Go.

---

## Implementation order

Strict sequence — each PR builds on the last:

```
PR4 → PR5 → PR6 → PR7 → PR8
```

Do not skip PR4; screens depend on rebuilt shared components.

---

## Suggested skills for next session

| Skill | When |
|-------|------|
| [`implement`](file:///C:/Users/ethan/.grok/bundled/skills/implement/SKILL.md) | Default for luxury-grade implement → review loop |
| [`verification-before-completion`](file:///C:/Users/ethan/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/verification-before-completion/SKILL.md) | Before claiming any PR done |
| [`frontend-design`](file:///C:/Users/ethan/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md) | PR5–6 screen polish |
| [`diagnose`](file:///C:/Users/ethan/.agents/skills/diagnose/SKILL.md) | If native `@expo/ui` Host/bridge issues arise |

---

## Scheduler note (stopped — do not auto-run)

Automated headless scheduling was attempted and **stopped**. If rescheduling later, read [`SCHEDULING.md`](./SCHEDULING.md).

**Key lesson:** Never use `grok --continue` headless. Use `--prompt-file` + `--cwd` + `--yolo` with self-contained prompts.

**Recommended approach for next session:** Implement PR4–8 **sequentially in this chat**, not via background scheduler.

---

## First message for the new agent

```
Continue the Versutus UI overhaul. Read:
- C:\Users\ethan\Versutus\scripts\ui-overhaul\HANDOFF.md
- C:\Users\ethan\Versutus\scripts\ui-overhaul\status.json
- pr4-prompt.txt (then proceed PR4→PR8 in order)

Luxury-grade UI is the baseline. Do not touch gateway-provider business logic.
Start with PR4 now.
```