# Phase 3 — luxury frontier design

Date: 2026-08-18
Source: `docs/audit-frontend-quality.md` §5 items 10–12
Branch: current working tree (`fix/secret-ref-guard` plus Phase 2 close)

The luxury foundation (tokens, glass, Phase 1 living background, Phase 2 hive/toast/ANSI) is in
place. Phase 3 is the design-system investment that makes those surfaces feel *directed*: a real
paint engine on the phone, session usage you can read at a glance, and an approval that lands as a
decision rather than a button tap.

---

## Problem

**P1 — Ambient is still Views pretending to be light.** Phase 1 added Reanimated orbs and a tiled
`grain.png`. That is the right hierarchy, but the glow is an opaque `View` disk and the grain is a
stretched bitmap. The audit’s frontier move is a Skia layer: true radial gradients, an image shader
for grain, and a few pixels of per-surface parallax so the field sits *behind* the content instead
of under it.

**P2 — Session stats are three numbers.** Chat overflow shows Messages / Tokens / Cost as
`StatTile`s. The data already exists (`HermesSession` tokens, cost, `last_active`, plus the fetched
session list). Nothing visualises “this session versus recently” or a week of activity.

**P3 — Approval haptics fire and the card just vanishes.** Activity’s pending-approval card and
Chat’s `ApprovalSheet` already call `expo-haptics`. Approve on the sheet uses `Warning` (wrong
pairing). There is no scale-out on approve and no red-edge on deny. The pads exist; the
choreography does not.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Ambient engine | Literal `@shopify/react-native-skia` on native |
| Web ambient | Keep today’s Reanimated + PNG grain. Same props. Never import Skia on web. |
| Platform preference | Stay cross-compatible where cheap; **Android wins** any real conflict |
| Analytics home | Chat overflow only. No Home dashboard sparkline. |
| Sparkline data | Last 7 calendar days of the already-fetched `sessionList`. No new gateway call. |
| Approval motion | Activity card only. Chat sheet: haptic pairing fix, no motion, no delayed resolve. |
| “Chime” | Haptic notification only. No audio asset. |

## Non-goals

- No Skia on web (no WASM canvas, no dual paint path for meters).
- No weekly usage API, no billing dashboard, no invented quota / context-window cap.
- No Screen-level scroll context. Screens that already scroll pass a parallax value down.
- No provider / gateway-state changes. `sessionList` is already on the Chat screen.
- No approval motion on `ApprovalSheet`. No success/deny sound file.
- No light theme, no fleet view, no true push (those are polish-roadmap Tier 4).
- No component-render test harness. This repo tests pure layers; React surfaces are covered by
  `tsc`, lint, and the existing suites.

## Constraints

- Read https://docs.expo.dev/versions/v57.0.0/ before adding Skia or changing native UI. Pin the
  Skia version Expo 57 / RN 0.86 documents (`npx expo install` if it knows the package).
- Adding Skia requires a **local** Android rebuild (`assembleRelease` / `expo run:android`). EAS
  cloud builds are quota-blocked until 2026-09-01.
- New JS logic is test-first. Visual choreography is driven by a tested duration/state helper so
  timings are not invented in JSX.
- Haptics go through `src/lib/haptics.ts` (never throw).
- Copy stays honest: the sparkline is “from recent sessions,” not a billing week.

---

## F1 — Skia ambient + per-surface parallax

### Contract

Both engines implement the same props. `Screen` forwards them.

```ts
export type AmbientCanvasProps = {
  /** Clamped conceptually to [-1, 1]. 0 is rest. */
  parallaxX?: number;
  parallaxY?: number;
};
```

`useAmbientParallax(scrollYPx: number): { parallaxX: number; parallaxY: number }` is a **pure**
mapper (tested):

- `parallaxY = clamp(scrollYPx / 480, -1, 1)`
- `parallaxX = 0` in this phase (lists are vertical). The prop exists so a future horizontal
  surface does not change the canvas API.
- Input `NaN` / non-finite → `{ parallaxX: 0, parallaxY: 0 }`.

Wired on Home, Activity, Chat (`FlatList.onScroll`), Tools. Onboarding does not scroll a content
list and stays at rest.

`Screen` gains optional `parallaxX` / `parallaxY` and passes them to `AmbientCanvas`. Screens that
do not pass them keep today’s still field.

### Native — `AmbientCanvas.native.tsx`

One Skia `Canvas` (`StyleSheet.absoluteFill`, `pointerEvents="none"`) **behind** the existing
sightline Views (plates, gold rules, vignette, center line stay React Native). Skia is paint, not
architecture.

Skia draws, in order:

1. Two radial auroras — champagne gold and sapphire — at ≤12% opacity, positions matching today’s
   orb anchors (`-15%/-22%` and `58%/62%`). Drift is a Reanimated `withRepeat(withTiming)` loop
   (52s and 68s, reverse) driving Skia transform uniforms. Do not use a Skia clock — Reanimated is
   already how every other motion in the app cancels on unmount.
2. Film grain as an `ImageShader` of `assets/images/grain.png` (the Phase 1 tile), not procedural
   noise. Opacity ~0.16 so it matches the current field.

Android-first fallback: if Skia fails to mount (missing native binary, canvas error), render
`ambient-fallback.tsx` rather than a black screen. That module **is** the Reanimated field. The
native canvas imports it; there is no `Platform.OS` branch inside the Skia file.

### Web — `AmbientCanvas.web.tsx`

Re-exports `ambient-fallback.tsx` (today’s Reanimated + `Image` grain, plus the 8px parallax
budget). Metro resolves `.web.tsx` on web, `.native.tsx` on Android/iOS. `AmbientCanvas.tsx`
re-exports the fallback so any non-native, non-web platform still paints.

### Out of this feature

Procedural Skia noise, blur-heavy backdrop, per-finger parallax, gyroscope. Those are later.

---

## F2 — Session analytics in Chat overflow

### Pure module — `src/lib/gateway/session-analytics.ts`

```ts
export type SessionUsage = { tokens: number; costUsd: number | null };

export function sessionUsage(session: {
  input_tokens?: number;
  output_tokens?: number;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
}): SessionUsage;

export type WeekBucket = { startMs: number; tokens: number; costUsd: number };

/** Seven calendar days ending on `now`'s local date. Index 0 is oldest. */
export function weekBuckets(
  sessions: { last_active?: number; input_tokens?: number; output_tokens?: number; actual_cost_usd?: number | null; estimated_cost_usd?: number | null }[],
  now: number,
): WeekBucket[];

export type RelativeMeter = { value: number; peak: number; ratio: number };

/** Peak is max(value, weekMax, 0). Ratio is 0 when peak is 0, else value / peak. */
export function relativeMeter(value: number, weekMax: number): RelativeMeter;
```

Rules:

- `sessionUsage.tokens` = `max(0, input + output)`. Missing fields count as 0.
- `sessionUsage.costUsd` = `actual_cost_usd ?? estimated_cost_usd`. Both missing → `null` (not 0).
  Buckets still sum costs as 0 when null so a week of unknown cost does not become `$NaN`.
- `last_active` uses the same ms-vs-seconds heuristic as `format.ts` (`> 1e12` → already ms).
- Sessions with no `last_active` are skipped. They do not land in “today.”
- There is **no quota**. The meter is “this session vs the busiest day in the window (or itself).”
- Sparkline plots **daily tokens** (cost is often null; tokens are the reliable series).

### UI — `SessionAnalytics`

Replaces the three `StatTile`s in `ChatOverflowSheet`.

- Two thin meters: Tokens (formatted via `formatTokenCount`), Cost (`formatCost` or `—` when
  `null`).
- A 7-point sparkline drawn with `react-native-svg` (already a dependency). Not Skia — web and
  Android must match. Empty week (all zeros) → hairline track, no fake mountain.
- Micro caption: `Last 7 days · from recent sessions`.
- Message count remains as a single caption under the meters (`N messages`), not a third meter.

`ChatOverflowSheet` gains `sessions` (the already-loaded list). `ChatScreen` passes `sessionList`.
`gateway-provider.tsx` is not modified.

---

## F3 — Approval choreography

### Pure module — `src/lib/motion/approval-exit.ts`

```ts
export type ApprovalExit = 'idle' | 'approving' | 'denying';

export function nextApprovalExit(current: ApprovalExit, action: 'approve' | 'deny' | 'reset'): ApprovalExit;
export function approvalExitDuration(kind: ApprovalExit): number;
```

| State | Duration | Visual | Then |
|---|---|---|---|
| `idle` | 0 | rest | — |
| `approving` | 280 | scale 1 → 0.92, opacity 1 → 0 | `resolveRunApproval(true)` |
| `denying` | 320 | border color → `statusDisconnected` (no shrink) | `resolveRunApproval(false)` |

`nextApprovalExit`:

- `idle` + `approve` → `approving`
- `idle` + `deny` → `denying`
- any non-idle + `approve`/`deny` → unchanged (double-tap is a no-op)
- any + `reset` → `idle`

### Activity card

The pending-approval card on `activity.tsx` is the only choreographed surface. On press:

1. Transition via `nextApprovalExit`.
2. Fire `haptics.success()` (approve) or `haptics.warning()` (deny).
3. Run the Reanimated visual for `approvalExitDuration`.
4. **Then** call `resolveRunApproval`. The gateway must not be called first — that unmounts the
   card mid-motion.
5. Buttons disable as soon as the exit is not `idle`.

Extract the card into `src/components/activity/approval-decision-card.tsx` so the screen does not
grow another inline state machine.

### Chat `ApprovalSheet`

- Approve → `haptics.success()` (today it fires `Warning`).
- Deny → `haptics.warning()` (today it fires `Light`).
- Resolve immediately. No delay, no shrink, no red edge.

### Out of this feature

Audio. Haptic sequences beyond the existing `haptics` vocabulary. Choreography on `RunCard` after
the decision (the pending card is the decision; the run card is the aftermath).

---

## File map

**New**

- `src/lib/gateway/session-analytics.ts`
- `src/lib/motion/approval-exit.ts`
- `src/lib/motion/ambient-parallax.ts` (`useAmbientParallax` mapper lives here as a named pure
  function `mapAmbientParallax`; the hook is a one-liner around it)
- `src/components/chat/session-analytics.tsx`
- `src/components/activity/approval-decision-card.tsx`
- `src/components/layout/AmbientCanvas.native.tsx`
- `src/components/layout/AmbientCanvas.web.tsx`
- `src/components/layout/ambient-fallback.tsx`
- `__tests__/session-analytics-test.ts`
- `__tests__/approval-exit-test.ts`
- `__tests__/ambient-parallax-test.ts`

**Modified**

- `src/components/layout/AmbientCanvas.tsx` — re-export / default fallback
- `src/components/ui/Screen.tsx` — optional parallax props
- `src/components/ui/types.ts` — `ScreenProps` parallax fields
- `src/app/(tabs)/index.tsx`, `activity.tsx`, `src/components/chat/chat-screen.tsx`,
  `src/components/terminal/terminal-screen.tsx` — pass `parallaxY` from scroll
- `src/components/chat/chat-overflow-sheet.tsx` — `sessions` prop + `SessionAnalytics`
- `src/components/chat/approval-sheet.tsx` — haptic pairing only
- `package.json` / lockfile — `@shopify/react-native-skia` via Expo 57 pin

**Not modified**

- `src/context/gateway-provider.tsx`
- Gate server, session APIs, run RPC

---

## Testing

| Unit | Assertions |
|---|---|
| `mapAmbientParallax` | 0 → rest; 480 → `parallaxY = 1`; −480 → `-1`; 10_000 clamped to 1; `NaN` → rest; `parallaxX` always 0 |
| `sessionUsage` | sums tokens; prefers actual cost; null when both costs missing; treats missing token fields as 0 |
| `weekBuckets` | 7 buckets; oldest first; local-day grouping; skips missing `last_active`; seconds vs ms |
| `relativeMeter` | 0/0 → ratio 0; value above week max uses value as peak; never > 1 |
| `nextApprovalExit` | idle→approving/denying; non-idle ignores a second tap; reset returns idle |
| `approvalExitDuration` | idle 0, approving 280, denying 320 |

No React Testing Library. Visual checks: Home/Chat/Tools/Activity scroll for parallax; overflow
sheet meters + sparkline; Activity approve/deny motion; Chat sheet haptic-only.

## Verification

`npm run verify` (tsc, lint, jest, gate tests) after each slice.

Expo web must still bundle: `AmbientCanvas.web.tsx` has no Skia import. A grep of the web graph
for `@shopify/react-native-skia` must be empty on web.

Native: local Android rebuild, then a 2-minute walkthrough — scroll Home and Chat (parallax),
open Chat overflow (meters + sparkline), trigger a run approval on Activity (shrink / red edge).

---

## Execution order

1. Pure mappers + tests (`mapAmbientParallax`, session analytics, approval-exit).
2. `SessionAnalytics` + overflow wiring (visible without a native rebuild).
3. `ApprovalDecisionCard` + sheet haptic fix (visible without a native rebuild).
4. Skia dependency, native canvas, web split, `Screen` parallax plumbing, local Android rebuild.
