# Versutus Frontend — Quality Gap Audit

**Date:** 2026-08-17 · **Scope:** full frontend surface (src/app, src/components, src/constants, src/lib/motion) + rendered verification via the Metro web target at HEAD `e6fa133`.

**Method:** code read of every screen and UI primitive, live rendering of the web build (home, chat, activity, tools, dev preview lab), and one root-cause fix landed to unblock inspection. Gates after fix: `tsc --noEmit` 0 errors, `expo lint` exit 0.

---

## 0. Blocker found & fixed (P0)

**Web and iOS were fully broken at HEAD.** `GlassSurface.web.tsx:5` and `GlassSurface.ios.tsx:6` import `glassVariantStyles` from `'./GlassSurface'`. Under platform-aware Metro resolution (`*.web.tsx` / `*.ios.tsx` outrank `*.tsx`), a relative `'./GlassSurface'` specifier **from inside** `GlassSurface.web.tsx` resolves to the file itself — a self-import cycle. The binding is undefined at module init, so every `variant="chip"` surface threw `Cannot read properties of undefined (reading 'chip')` at render time:

- Home screen (ScreenHeader's settings orb) → **the entire home screen crashed on web.**
- `/dev/preview` (their own visual QA lab) → crashed on load.
- iOS: any chip-variant surface (Sheet eyebrows/trailing controls) would crash identically; only Android worked — which is why it was never noticed (Android ships; iOS/web don't).

**Fix (landed, uncommitted):** extracted the variant map to a neutral module `src/components/ui/glass-variants.ts` (no platform suffix); all three surface files import it; base file re-exports for compatibility. Verified: web renders home/chat/activity/tools/preview lab, `tsc` 0 errors, `lint` 0. iOS landmine removed by the same change.

---

## 1. What is genuinely strong (protect these)

- **Design token system** (`tokens.ts`): elevation ramp, glass tiers, semantic status ramps, motion/easing constants, per-variant font caps. Rare discipline.
- **Interaction craft:** PressableScale on every control, haptics on 100+ sites, animated send→stop morph, spring composer palette, skeleton loading, jump-to-latest pill, slash palette with danger classification, streaming dots + caret.
- **Accessibility:** a11y roles/labels on interactive elements, `maxFontSizeMultiplier` caps on chrome text (uncapped body for large-text users), selectable error strings, generous hitSlop.
- **Error UX:** ErrorCard with cause/affected/next, troubleshooting collapsible, run approval sheets with feedback. An onboarding connection timeline with live phase mapping.
- **Status vocabulary:** pulsing orbs, reachability pills with latency, capability pills with count semantics (`3/5 ready`), stale-data age display.
- **Markdown + code blocks** with copy action, language header, horizontal scroll — above-average for a mobile chat.

**Rendered assessment (web, clean headless screenshots):** home + chat empty states read as genuinely premium (~8–8.5/10 by visual inspection — restraint, glassmorphism, gold on obsidian). The weakness is not the foundation; it is that the foundation stops 70% of the way.

---

## 2. Missing that should be there

### 2.1 Chat is timeless and anonymous
- **No inline timestamps, no day dividers.** `formatClockTime()` exists but is only reachable via long-press → message-actions sheet. A live agent console with no sense of "when" at a glance reads as a mock-up. Add micro-captions on long/hover reveal + "Today / Yesterday / Aug 12" sticky dividers (both sides' messages are date-grouped server-side already — `messages.ts`).
- **No sender identity.** Bubbles are distinguished by alignment only. Add a small gateway monogram (Versutus mark or a 24px letter tile) on assistant messages — instantly breaks the "wall of text" and adds the signature brand moment per turn.
- **No delivery/failure choreography on send.** Queued badge exists (good); nothing animates a send landing (a quick bubble scale-in exists via `entering.slideInRight` — it is subtle enough to be invisible; consider a 0.97→1 spring like iMessage).

### 2.2 The brand's one animated moment is dead code
- `AnimatedIcon` (halo + logo keyframes) in `animated-icon.tsx` is **never mounted anywhere**. Only `AnimatedSplashOverlay` is used — and that is a *black screen fade*. The expo splash (native, static PNG) → black overlay → app is a non-event. Mount `AnimatedIcon` inside the overlay for an actual brand beat: background-glow → mark breathing in → dissolve.

### 2.3 No living background
- `AmbientCanvas` is three rotated static Views + hairline rules. Deliberate ("architectural, no blobs") — but at phone scale it reads as *artifacts* (flagged in screenshot review) and it never moves. Chat and Terminal set `ambient={false}` — the two most-used surfaces sit on flat `#030304`.
- Luxury-frontier move: slow aurora sweep (reanimated: two 60–120s drifting radial gradients at ≤8% opacity), optional film-grain (a 512px PNG noise tile at 3–5% opacity), and subtle plate parallax on scroll. Keep the sightlines; add life. Cost: one component, no new deps (Reanimated 4.5 already in).

### 2.4 Zero in-app imagery
- `assets/images/` contains only launcher/splash icons. No noise tile, no gradient field, no texture. Everything is rect+border. One signature visual asset (a metallic gradient field for the onboarding hero, a grain overlay) would lift every surface at once.

### 2.5 First-run has no ceremony
- Onboarding = logo card + form + timeline. Functional, not frontier. First frame should be a brand moment: the mark breathing in, an auto-discovery "scanning" state with animated probe steps, then the form recedes. The connection timeline already exists — choreograph it as the hero instead of a mid-form detail.

### 2.6 Web is a second-class citizen
- Web renders NativeTabs as a top text-only bar (no icons), and ScreenHeader's web path renders a literal `'\u2699'` text glyph in the settings orb. If web is a supported target, it needs the same icon system (`expo-symbols` has a web path via `@expo/vector-icons`-style mapping or inline SVG) — right now it visibly degrades.

---

## 3. Implemented at merely mediocre

### 3.1 Terminal / RPC results
- RPC command output = raw `JSON.stringify(result, null, 2)` dumped as mono text in a card. Functional, zero structure. Frontier version: collapsible JSON tree, type-aware coloring, exit-code accents, per-key copy.
- `TerminalOutput` is plain single-color mono text: no ANSI parsing (a real shell emits color), no prompt-line styling, no scroll-to-tail affordance beyond autoscroll, no "connected · vX" fluff in the pane. It is a text box, not a terminal.

### 3.2 Gateway command panel
- Flat grid of buttons + one summary line. No per-command help, no categories, no history, danger commands only dim-bordered. The data model (`dashboard.ts` GatewayCommand) already carries danger/transport semantics — the UI under-uses them.

### 3.3 Dashboard (connected home)
- Hero card + 3 stat tiles + gateway list + capability pills. Competent, generic. No sparkline of activity, no "live since 14:02", no run-progress visualization, no animated capability hive. StatTile shows numbers with no trend context.

### 3.4 Composer: visibly half-built
- The composer's left utility row is an **empty `<View style={styles.chipGroup} />`** and the `contextChip` style is dead code (`chat-composer.tsx:63`, `:234`). A planned context/quick-action chip strip was never shipped. Either ship it (Examples / Attach / Paste / Session context chips) or remove the dead space — right now it is a designed-in hole.

### 3.5 Activity
- Run cards are good (live elapsed, ticker, expandable events). But there is no pull-to-refresh, no run filtering, and the empty state is static text. Approval cards are correctly prominent — keep.

### 3.6 Onboarding form details
- The PC-address field gets validation states (good), but the hero uses the small 52px mark in a card that is 60% empty space. The form is the second thing you see; it should be the third (after discovery theater).

---

## 4. Other smells (low effort, high polish)

- `preview-scenario-chip.tsx:45` referenced `styles` before its `const` declaration (line 54) — survived only because the cycle crash masked it; TDZ-under-HMR hazard for any future hot edit. Move the `StyleSheet.create` above the component.
- No pull-to-refresh anywhere (three ScrollViews, zero RefreshControls).
- No "connected" ceremony — status flips silently; a 1.2s HUD toast ("Gateway online · v0.5.2") would punctuate the win.
- Chat overflow sheet is text-dense; session stats (tokens, cost) exist but are not visualized (a mini bar or meter would sell the "command center" fantasy).
- `//` dead comments in TSX around reanimated shared values (eslint-disabled) are noise in a codebase this clean — consider a lint rule instead of inline suppressions.

---

## 5. Roadmap toward luxury frontier

**Phase 1 — cheap, immediate, highest signal (≈ half a day)**
1. Mount `AnimatedIcon` in the splash overlay (dead code → brand beat).
2. Composer quick-action chips (or remove dead chipGroup).
3. Message timestamps + day dividers + assistant monogram avatars.
4. Living AmbientCanvas (aurora sweep + grain overlay) incl. re-enable on chat/terminal.
5. Web icon parity (kill the `\u2699` glyph, real icons in nav).

**Phase 2 — medium (1–2 days)**
6. Structured RPC output (collapsible JSON, exit-code colors).
7. Terminal ANSI + prompt styling + connection banner inside pane.
8. Onboarding discovery-theater choreography (timeline as hero).
9. Pull-to-refresh; connected-ceremony toast; capability hive micro-visualization.

**Phase 3 — frontier (design system investment)**
10. Skia grain/aurora layer + per-surface parallax.
11. Session analytics visuals (token/cost meters, weekly sparkline).
12. Haptic-tuned run approval (approve = success chime + card shrink, deny = warning + card red edge) — pads exist, choreography doesn't.

---

## Appendix — verification evidence

- `npx tsc --noEmit` → exit 0 (after fix).
- `npm run lint` → exit 0.
- Web render at HEAD before fix: home + preview lab crash on `'chip'`; after fix all four tabs + preview lab render.
- Fix diff: 3 files touched, 7 insertions / 17 deletions + 1 new file (`glass-variants.ts`). Uncommitted (working tree).