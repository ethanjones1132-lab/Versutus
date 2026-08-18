# Phase 1 — Frontend Luxury Pass: Implementation Plan

**Date:** 2026-08-17 · Scope: 4 workstreams (splash beat, composer chips, chat identity/time, living background) · Baseline: `e6fa133` + P0 glass-variants fix (uncommitted).

## 1. Plug in the dead logo animation at launch

**Files:** `src/components/animated-icon.tsx`

- Mount `AnimatedIcon` (halo + mark keyframes, never mounted today) **inside** `AnimatedSplashOverlay`.
- Restructure the overlay timeline: black field zooms from launcher scale (existing `INITIAL_SCALE_FACTOR`) → 1 while the icon blooms in (halo 0.9→1.05, mark elastic pop) → whole overlay dissolves ~78–100% of a ~900ms total.
- Keep opacity easing non-elastic (current code applies `Easing.elastic` to opacity — overshoot flicker); use `inOut(ease)` for fades.
- Web overlay stays `null` (no native-splash equivalent; unchanged).

**Verify:** visual on web preview + no regressions on native screens.

## 2. Quick-action chips in the composer

**Files:** `src/components/chat/chat-composer.tsx`, `src/components/chat/chat-screen.tsx`

- New `quickActions?: { label: string; draft: string; icon: IconName }[]` prop on `ChatComposer`.
- Render chips in the **empty left `chipGroup`** (dead space + dead `contextChip` style): visible only when `quickActions` present && `!isStreaming` && `!draft.trim()`.
- Parent wires three: **Run** (`/run `), **Status** (`/status`), **Help** (`/help`) — real gateway commands from the slash registry.
- Remove dead `contextChip` style (replaced by `quickChip`).

**Verify:** preview lab / chat renders chips; tapping seeds the draft; palette opens on `/`.

## 3. Timestamps, day dividers, gateway monograms

**Files:** `src/lib/format.ts`, `src/components/chat/message-bubble.tsx`, `src/components/chat/chat-screen.tsx`

- `formatDayDivider(ts)` in `lib/format.ts`: Today / Yesterday / weekday (<7d) / short date.
- `MessageBubble`:
  - micro `formatClockTime` caption under each bubble (user right, assistant left), only when `timestamp` exists.
  - assistant-side **monogram**: 26px hairline circle with first letter of gateway identity (new `identity?: string` prop) — only for assistant messages.
- `ChatScreen`: day divider between messages whose `formatDayDivider` changes (FlatList `renderItem(index)`), rendered as hairline + micro label centered.

**Verify:** preview chat-streaming mock shows timestamps + monogram + at least one divider.

## 4. Living background (glow + grain)

**Files:** `assets/images/grain.png` (new, generated), `scripts/gen-grain.mts` (new, reproducible), `src/components/layout/AmbientCanvas.tsx`, `src/components/chat/chat-screen.tsx`, `src/components/terminal/terminal-screen.tsx`

- **Grain:** small PNG generator script (node zlib, deterministic seed) → 256×256 RGBA noise tile; render in `AmbientCanvas` via RN `Image` `resizeMode="repeat"` at ~0.14 opacity (≈1–2% effective per-pixel — film grain).
- **Glow:** two large soft orbs (`accentWarmMuted` / `accentMuted`, ~5–8% opacity, oversized border-radius) drifting via Reanimated `withRepeat(withTiming, …, reverse)` over 40–70s — sub-perceptual movement that kills the "static plate" feel.
- Keep the metallic sightlines (brand), soften nothing else.
- **Re-enable ambient on Chat + Tools** (drop `ambient={false}`) — the two most-used surfaces are currently flat black.

**Verify:** home + preview lab show glow/grain; chat/terminal show background again; no perf regression on web render.

## Verification

`npx tsc --noEmit` (0 errors) · `npm run smoke:portal` (ALL PASS) · `npm run lint` (exit 0) · web render check of home + dev preview lab.

## Status — IMPLEMENTED & VERIFIED 2026-08-17

All four workstreams landed in the working tree (uncommitted). Gates green: tsc 0, smoke ALL PASS, lint exit 0. Rendered verification via Metro web: home shows grain + drifting glow with no glitches; preview lab chat-streaming shows YESTERDAY/TODAY dividers (DOM-confirmed), 3 timestamps, 2 monograms, streaming caret.

- **Splash:** `AnimatedIcon` now lives inside `AnimatedSplashOverlay` (900ms black-field zoom-through, non-elastic opacity fades).
- **Composer:** `quickActions` prop (Run/Status/Help) renders pill chips in the previously-empty left chipGroup; dead `contextChip` style replaced.
- **Chat:** `formatDayDivider` added; `MessageBubble` gains `identity` prop → 26px monogram + mono micro timestamp under each bubble; `DayDivider` extracted to `src/components/chat/day-divider.tsx` and composed into both the real FlatList and the preview lab.
- **Background:** `scripts/gen-grain.mts` (deterministic, reproducible) generates `assets/images/grain.png`; AmbientCanvas now layers two 40–70s drifting gold glow orbs (Reanimated, cleanup-cancelled) + tiled grain Image at 0.16; Chat/Tools re-enable ambient.
- **Also fixed en route:** RN 0.85 removed `StyleSheet.absoluteFillObject` (use explicit position props).

## Out of scope (Phase 2+ per audit)

Structured RPC output, terminal ANSI, onboarding theater, pull-to-refresh, connected-ceremony toast, web icon parity, capability visualizations.