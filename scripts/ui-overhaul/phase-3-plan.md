# Phase 3 — Fable 5 Screen Elevation (Android-first)

## Quality bar (Fable 5 = second-look test)

Every screen must feel **intentionally designed in one session**, not assembled from templates:

1. **One surface language** — Compose `LazyColumn` / M3 sheets on Android; no Compose-header + RN-card seams
2. **Token integrity** — `useTokens()` everywhere; zero stray `Palette.*` in screens
3. **Hierarchy** — hero → surface → inset → chip elevation tiers; one focal point per screen
4. **Motion** — presets-only; collapsibles use layout springs; state changes fade
5. **Native affordances** — FAB, `AssistChip`, `ModalBottomSheet`, `SegmentedButton` where RN pressables were used

## Implementation order

| # | Screen | Android file | Key move |
|---|--------|--------------|----------|
| 1 | Onboarding | `onboarding.android.tsx` | Single hero card; validated `TextField` |
| 2 | Home | `(tabs)/index.android.tsx` | Hero + floating settings FAB; collapsibles |
| 3 | Chat | `(tabs)/chat.android.tsx` | Token banner; native sheet (done in P2) |
| 4 | Terminal | `terminal.android.tsx` + `command-chip.android` | Inset pane; M3 chips |
| 5 | Settings | `settings.android.tsx` | Full `LazyColumn` journey |
| 6 | Add | `add.android.tsx` | Compose form + expandable advanced |

## Exit criteria

3-minute emulator walkthrough: onboarding → home → chat → terminal → settings → add — no light/dark mismatch, no hybrid seams.