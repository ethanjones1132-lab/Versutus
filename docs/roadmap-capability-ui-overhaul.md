# Versutus — Full Capability & UI Overhaul Roadmap

Date: 2026-08-10
Trigger: first end-to-end streamed chat message (Android → Hermes → streamed response) works.
Goal: (1) close every client-side gap to full gateway capability and integration, (2) rebuild the UI to a flagship standard.
Constraint: read https://docs.expo.dev/versions/v56.0.0/ before writing any code (AGENTS.md). All implementation targets Expo SDK 56 / RN 0.85 / React 19.

---

## Execution log

**M2 — Chat flagship (completed 2026-08-10)**
- Custom dependency-free markdown engine (`components/chat/markdown/`): fenced code (language label + copy via `expo-clipboard`), headings, lists, quotes, hr, bold/italic/code/strike/links (links open in `expo-web-browser`); snake_case-safe italic rules; 20-case tsx harness passes.
- `MessageBubble` v2: markdown bodies for assistant messages, streaming cursor, tool-call cards (dormant until streams carry them — `ChatMessage.toolCalls` type added), command cards with status `Badge`, long-press → `MessageActionsSheet` (copy / retry / delete-local, details).
- Scroll UX: pinned-to-bottom tracking, no more yank-to-bottom while reading history, animated "Latest" jump pill.
- `ChatComposer` v2: model/session quick chips, icon utility actions, slash palette v2 (danger icons, family badges), focus-aware border, icon send/stop morph.
- `ChatHeader` v2: pulsing orb (shared `PulsingDot`/`statusColor` from connection-badge), streaming presence, model + session chips, overflow → `ChatOverflowSheet` (session StatTiles: messages/tokens/cost, reload, new session, disconnect).
- Sheets v2: model picker (availability badges, ctx/price/provider meta, current highlight, EmptyState), session selector (rich rows: preview, msgs/tokens/cost/relative-time, New session, delete with confirm).
- Provider: `historyLoading`, `createNewSession`, `deleteSessionById`, `deleteLocalMessage`; `PortalClient.deleteSession?` added (Hermes implements structurally).
- `chat.tsx`/`chat.android.tsx` collapsed to thin wrappers over shared `components/chat/chat-screen.tsx` (divergence class removed); history skeletons; `ErrorCard` banner; `EmptyState` empty states.
- Gate: `tsc` 0 errors, `lint` 0 problems.

**M3 — Command center (completed 2026-08-10)**
- Command route coverage audited against `GATEWAY_COMMANDS`: 46 RPC methods total, 16 evidence-backed Hermes routes and 30 explicit guidance entries; added the real `runs.create` route plus guidance for `models.authStatus`, `plugins.uiDescriptors`, `exec.approvals.get`, and `doctor.memory.status`.
- `npm run smoke:portal`: all identification, URL, mapping, route, capability, and unmapped-method coverage checks pass.
- Provider now tracks app-initiated runs in memory (`ActivityRun`): gateway id acquisition, live event previews capped at 50, approval state, completion/failure/cancelled status, summaries, elapsed history, local abort + best-effort server stop.
- Added fourth native tab, **Activity**: pending approval card with Approve/Deny, live run monitor cards, expandable event logs, stop-run action, recent run history, and empty states.
- Home command center upgraded: animated connection orb, status badge/version, Chat/Activity/Tools actions, approval presence card, glanceable Gateway/Run/Capability StatTiles, existing gateway/capability surfaces retained.
- Gate: `tsc --noEmit` 0 errors, `expo lint` 0 problems.

**M4 — Agents & terminal (completed 2026-08-10)**
- Terminal routes collapsed to shared `components/terminal/terminal-screen.tsx`; Android/iOS/web no longer maintain divergent implementations.
- Added ANSI/CSI stripping and bounded line storage (`lib/terminal/output.ts`, 2,000-line cap) plus a virtualized `TerminalOutput` FlatList with tail auto-scroll.
- Shell session remains alive while switching Shell/RPC/Agent modes; only gateway changes, connection loss, or unmount close it. Added shell input history (ArrowUp/ArrowDown plus recent command chips).
- Terminal RPC/Agent command output remains separate from the live shell buffer; errors use the structured `ErrorCard` primitive.
- Added honest configured-target Agents surface under Activity: gateway profiles, optional `agentId`, model, connection status, active target, and direct chat switching. Hermes registry absence is explicitly explained instead of fabricating remote agent data.
- Gate: `tsc --noEmit` 0 errors, `expo lint` 0 problems.

**M5 — Integration (completed 2026-08-10)**
- Deep-link router uses Expo Linking v56 `useURL`/`parse`; `versutus://add?url=…&token=…&name=…&agentId=…` opens the add flow with fields prefilled. Add flow exposes transport security before saving.
- Offline chat outbox: disconnected input creates a visible queued user bubble, persists in memory through reconnect, and flushes through the normal chat/command pipeline once the connection is live.
- Gateway profiles now persist discovered `tlsFingerprint`; `TransportSecurityCard` distinguishes TLS/WSS from cleartext and explicitly says the discovery fingerprint is observed, not verified by Expo fetch. No cosmetic “pinned” claim remains in the new settings surfaces.
- Onboarding routes collapsed to shared `components/onboarding/onboarding-screen.tsx`: secure-storage copy, stronger hierarchy, haptics, connection timeline, structured error card, and unified Android/iOS/web behavior.
- Settings upgraded into grouped startup, primary route, device identity, transport, discovery, and saved-profile sections.
- Gate: `tsc --noEmit` 0 errors, `expo lint` 0 problems.

**M6 — Ship shape (completed 2026-08-10)**
- Added Expo/Jest verification setup (`jest-expo`), four pure test suites covering markdown, route coverage, terminal output, and formatters: **4 suites / 11 tests passing**.
- Added GitHub Actions CI for `tsc`, lint, Jest, and portal smoke checks.
- Rewrote README around the actual Hermes HTTP/SSE primary architecture, Activity/Tools surfaces, `gatewayHosts` config, deep links, and explicit relay/pinning limits; provider reads the old host key as a migration fallback.
- Added safe haptic vocabulary (`lib/haptics.ts`) for new interaction surfaces; new primitives and feature cards expose accessibility roles/labels and spring/fade motion.
- `npx expo export --platform web` succeeds with 14 static routes, including Activity, onboarding, gateway add/settings, chat, and terminal. Expo's expected web-notifications listener warning remains informational.
- Final local gates: `npx tsc --noEmit` pass, `npm run lint` pass, `npm test -- --coverage=false` pass, `npm run smoke:portal` pass, `npx expo config --type public` pass.
- Live `npm run smoke:gateway-commands` was attempted and remains **0/18** because this shell has no reachable gateway; no live endpoint claim is made.

**M1 — Foundation (completed 2026-08-10)**
- Tokens v2: dark-only `Palette` (LightPalette/paletteForScheme/legacyColorMap removed), elevation ramp (`backgroundRaised`), hero glass tier, muted status variants, `borderSubtle`, `overlay` scrim, `Typography.micro`, `Radius.xs/xxl`.
- `useTokens()` simplified to the single dark palette (hook kept as the consumption contract); deleted legacy layer: `constants/theme.ts`, `themed-text/view`, `use-theme`, `use-color-scheme(+web)`, `hint-row`, `ui/collapsible`, `Button.web`, `TextField.web`.
- `GlassSurface` v2: **variant-aware** (`hero/surface/inset/chip`) on all platforms via shared `glassVariantStyles`; Android no longer rides the web re-export; iOS `GlassView` + web backdrop-blur kept.
- `Button`/`TextField` consolidated to shared implementations (iOS keeps SwiftUI variants); `Button` gains `size`.
- New primitives: `Icon` (SymbolView wrapper), `Badge`, `Chip`, `Divider`, `Skeleton`, `EmptyState`, `ErrorCard`, `StatTile`, `ListRow`, `SegmentedControl`; `Text` gains `micro` + status colors.
- Refinement recorded: with dark-only committed, `Palette` IS the token source — module-scope `StyleSheet` usage of `Palette` in existing feature components is accepted (same object as `useTokens`); new code consumes `useTokens()`.
- Lint debt 32 → **0** (import dupes, unused vars, exhaustive-deps via `gatewayId`/ref patterns, `Array<T>` → `T[]`, import/first); repaired an eslint `--fix` import-merge mangling in `gateway-provider.tsx`.
- `global.css` side-effect import moved to root `_layout.tsx` (was riding the deleted `theme.ts`).
- Gate: `tsc --noEmit` 0 errors, `expo lint` 0 problems.

---

## Part 0 — Where the app actually is (scan findings)

### Working today
- Auto-connect journey: discovery (mDNS + Tailscale candidates) → probe → connect → reconnect w/ backoff → AppState heal. Solid.
- Streaming chat over Hermes SSE with command routing (`sendChatInput`), last-20-turn context window.
- Slash-command engine: 23 Hermes RPC methods mapped (`rpc-routes.ts`), actionable `METHOD_GUIDANCE` for 40+ unmapped, confirmation previews, per-gateway recents.
- Sessions: REST CRUD + history reload + session selector sheet + `createSession` fallback.
- Runs: client API complete (start/status/events/stop/approval); `/run` with approval gates + `ApprovalSheet` + local notifications (ADR-0001).
- Model picker (per-request override persisted on profile), capability snapshot, pairing flow, terminal (Shell/RPC/Agent, authed).
- Design tokens (`tokens.ts`), `BaseSheet`, `GlassSurface`, haptics sprinkled, luxury dark palette.

### Gaps found in this scan (beyond prior audit)

**Capability**
1. `MessageBubble` renders plain `<Text>` — no markdown, no code blocks, no inline code, no lists. Agent output is unreadable for anything non-trivial.
2. No tool-call visibility in chat (Hermes sessions track `tool_call_count`; stream deltas for tool calls are not surfaced).
3. No message actions: copy (`expo-clipboard` installed, unused in chat), regenerate, delete, per-message timestamp.
4. No usage/cost surfacing — `HermesSession` carries `input_tokens`, `estimated_cost_usd`, etc.; UI shows none of it.
5. No run monitor: `runTask` exists in the provider but there is no run list, live event stream view, run history, or stop UI outside the approval sheet.
6. No agents surface: agent registry/status only reachable as slash-command text; `agentId` targeting exists on the profile but has no UI.
7. Terminal output is one concatenated string in a `ScrollView` — no ANSI parsing, no virtualization, degrades on long sessions; session dies on tab switch.
8. Remaining unmapped command families execute nothing (guidance-only): channels detail, approvals list, env, artifacts, agents, devices, talk, logs, session abort/compact — several have real Hermes REST routes available.
9. Deep-link add (`versutus://add?url=…&token=…`) — scheme registered in `app.json`, zero handling code.
10. No offline outbox: sending while disconnected just fails.
11. TLS fingerprint from beacons displayed, never verified.
12. iOS is a re-export in places (`settings.ios.tsx`); `.android.tsx` splits have diverged from base files; web gets little QA.

**UI/UX**
13. Hardcoded `Palette.*` usage bypasses `useTokens()` (e.g. `gateway-home-dashboard.tsx`, `(tabs)/_layout.tsx`) — theming is half-wired.
14. Chat screen header is a static card; no streaming presence, no model/session chips, no connection richness.
15. Composer is minimal: no multiline growth, no model/session quick chips, slash palette is text-only.
16. Home dashboard is a stack of cards — no hero state, no activity, no glanceable run/approval presence.
17. No skeletons/shimmer anywhere; loading states are spinners-in-text or nothing.
18. Scroll UX in chat: `onContentSizeChange → scrollToEnd` yanks the user to bottom while reading history; no scroll-to-bottom pill.
19. Empty states are plain text lines; onboarding is utilitarian; settings is bare rows.
20. No icon system beyond tab icons (`expo-symbols`); in-app iconography is text glyphs and dots.
21. Motion is enter-fades only; no shared transitions, stagger, or press physics beyond `PressableScale`.

### Documented but out of this repo's reach (flagged, not planned here)
- True push + relay server (Phase D), manifest-driven custom transport (Phase E) — need a server component / Hermes-side work. Noted in `docs/repo-scope-multi-agent-remote-gateway.md`.

---

## Part 1 — Capability & integration track

Ordered by user-visible value per unit of effort. Each item lists target files.

### Phase C1 — Chat core completeness (the product's heart)
1. **Markdown rendering** in `MessageBubble`: themed renderer (headings, bold/italic, lists, blockquotes, inline code, fenced code blocks with mono font + copy button). Validate library choice against SDK 56 (or build a small custom renderer for full token control). Files: `components/chat/message-bubble.tsx`, new `components/chat/markdown/`.
2. **Tool-call cards**: extend `ChatMessage` (`lib/gateway/types.ts`, `messages.ts`) with tool-call entries parsed from the stream; render as compact status rows (icon, name, duration, expandable payload).
3. **Message actions**: long-press action sheet — Copy (`expo-clipboard`), Copy as markdown, Retry (assistant), Delete (local). Timestamps on grouping boundaries.
4. **Scroll UX**: track user scroll position; only auto-scroll when pinned to bottom; floating "scroll to latest" pill with new-message indicator. Files: `app/(tabs)/chat.android.tsx`, `chat.tsx`.
5. **Session management UI**: rename/delete/new session in `SessionSelectorSheet`; show per-session message count + cost (data already in `HermesSession`).
6. **Usage footer**: per-message token/cost metadata where the stream provides it; session totals in the header overflow menu.

### Phase C2 — Command engine completion
7. Map remaining Hermes REST routes in `rpc-routes.ts` for families that genuinely have endpoints (session abort/compact, logs tail, config schema, channels, agents list, devices). Keep `METHOD_GUIDANCE` only where no route exists. Evidence: Hermes route surface in `docs/openclaw-gateway-followup.md`.
8. Live-verify mapped commands against a real gateway with `npm run smoke:gateway-commands`; fill `verified/unverified` flags. Files: `scripts/smoke-gateway-commands.mjs`.

### Phase C3 — Runs & approvals surface
9. **Run monitor**: new screen (`app/(tabs)/` activity or a Home section) listing runs with live status, event stream viewer (`streamRunEvents` already client-side), stop action, token/cost per run. Files: `lib/gateway/runs.ts`, `client.ts:368-431`, new `components/runs/`.
10. **Pending approvals presence**: badge on Home + chat header when `pendingRunApproval` or a run needs consent; approval sheet already exists — wire entry points everywhere, not just chat.

### Phase C4 — Agents surface
11. Agents view: list from `agents.list` (route-mapped in C2), per-agent status/model/capability rows, "chat as this agent" → sets profile `agentId`. Files: new `components/agents/`, provider `selectAgent`.
12. Per-agent session scoping in the session selector when `agentId` is set.

### Phase C5 — Terminal upgrade
13. Append-only virtualized output (FlatList of chunks), ANSI color parsing, keep-alive across tab switches (move `TerminalSession` into a provider-scoped ref), input history (up-arrow style recall), structured command blocks. Files: `app/(tabs)/terminal.android.tsx`, `lib/terminal/client.ts`, `components/terminal/`.

### Phase C6 — Integration & remote-readiness
14. **Deep-link add**: handle `versutus://add?url=&token=&name=` → prefill `gateway/add` → one-tap save. Files: `app/gateway/add.tsx`, `expo-linking` handler in `_layout.tsx`.
15. **Offline outbox**: queue `sendChatInput` payloads when `status !== 'connected'`; flush on connect with user-visible "queued" state on the bubble. Files: provider, `lib/gateway/messages.ts`.
16. **TLS pinning**: verify beacon `tlsFingerprint` on first HTTPS connect (TOFU), surface mismatch as a blocking error card. Files: `lib/gateway/url.ts`, `client.ts`.
17. Background/foreground polish: local notification for run-complete while app is alive but backgrounded is done (ADR-0001) — extend to stream-completion only when backgrounded (suppress when foregrounded).

### Phase C7 — Hygiene & trust
18. Lint debt: 15 pre-existing errors → 0; add `tsc --noEmit` + lint to a CI workflow (GitHub Actions) with the smoke harness.
19. Tests: start with the pure layers — `rpc-routes`, `slash-commands` parsing, `messages` windowing, client state machine against a mock gateway. (Vitest or jest-expo; decide per SDK 56 guidance.)
20. Docs drift: rewrite README protocol section (Hermes HTTP, not OpenClaw WS v4), rename `extra.openClawGatewayHosts` → `gatewayHosts` with back-compat read.
21. iOS parity pass: resolve `.ios.tsx` re-exports vs `.android.tsx` divergence (base file + platform overrides only where truly needed).

---

## Part 2 — UI overhaul track ("extreme")

Direction: keep and **amplify** the established identity — deep black, champagne gold, restrained glass, mono accents — but rebuild every surface to flagship execution. State-first Home, action-first Chat (per `ui-polish-loop-plan.md` principles, which this supersedes).

### Phase U0 — Design system 2.0 (foundation; everything else builds here)
- **Token hardening**: semantic elevation ramp (base/inset/raised/overlay), glass v2 (border + highlight + blur tiers), status color roles, density scale. Extend `tokens.ts`; kill every hardcoded `Palette.*` outside tokens — all components consume `useTokens()`.
- **Theme provider**: single source of truth; dark-first, light palette finished (currently forced dark, `app.json userInterfaceStyle: "dark"` — decide: ship dark-only v1, or finish light).
- **Type system**: display moments (Instrument Sans 600 at 28–40 for hero states), refined caption/mono usage, numeric tabular figures for stats.
- **Icon system**: adopt `expo-symbols`/`SymbolView` consistently in-app (Android md glyphs), or a small custom SVG set via `react-native-svg` for brand marks (gateway orb, run states, agent glyphs).
- **Core primitives v2**: `Card`, `Button`, `TextField`, `Screen`, `BaseSheet`, `PressableScale` — refined press physics (scale + opacity + haptic tiers), focus/disabled states, skeleton component (`Shimmer`), empty-state component (icon + title + cause/next action), structured `ErrorCard` (cause / affected / next — already the convention, make it a primitive).
- New `components/ui/` additions: `Chip`, `SegmentedControl`, `StatTile`, `ListRow`, `Badge`, `Divider`, `BottomSheet` (native-feeling, drag-to-dismiss).

### Phase U1 — Chat experience rebuild (the centerpiece)
- **Header**: slim contextual bar — gateway orb (animated connection state), session title (tap → session selector), model chip (tap → picker), overflow (usage, history reload, disconnect). Live streaming presence (orb pulses while streaming).
- **Messages**: markdown bodies (C1), tool-call cards, day/time dividers, avatar-less asymmetric bubbles with refined radii (user = warm accent tint, assistant = glass), streaming cursor, staggered entrance, command cards redesigned (status pill + title + duration + expandable raw + retry/cancel).
- **Composer**: growing multiline field, send/stop morph, slash palette v2 (icons, descriptions, danger badges, recents), model + session quick chips, haptic tiers (send, stream-start, complete).
- **Sheets**: model picker, session selector, confirmation, approval, pairing — rebuilt on `BaseSheet` v2 with drag gestures, detents, and richer content (model rows with provider/context/price/auth; session rows with cost + recency).
- **Edge states**: skeleton message list while history loads; structured error banner; queued-message state (offline outbox, C6).

### Phase U2 — Home as command center
- **Hero status**: animated gateway orb/aurora reflecting connection status/phase (disconnected → dim, connecting → breathing gold, connected → steady, pairing → pulsing), gateway name + version + latency.
- **Glanceables**: stat tiles (sessions, runs today, tokens, cost), pending-approval banner, live-run ticker.
- **Gateways**: redesigned profile rows (kind badge, reachability dot, last-connected), swipe actions (connect/remove), add via deep link/QR/manual.
- **Capabilities**: feature-family grid with live status colors; degraded-state repair cards (exists — restyle + make actionable).

### Phase U3 — Activity/Runs + Terminal UI
- Runs/activity surface UI (pairs with C3): run cards with live event stream, stop with haptic warning, approval inline actions.
- Terminal v2 UI (pairs with C5): console blocks, mode segmented control, command chips, log sheet restyle.

### Phase U4 — Onboarding, settings, dev
- Onboarding: multi-step guided flow (welcome → PC address → token → connecting → success), progress indicator, inline validation, troubleshoot accordion.
- Settings: grouped sections, device identity card, notification preferences, appearance, about/version, danger zone.
- Dev screens (`app/dev/`): keep, but gate behind a hidden gesture in settings.

### Phase U5 — Motion & haptics choreography
- Motion tokens v2 (springs over beziers for interactive elements), shared-axis transitions between tabs, sheet spring physics, list stagger presets, orb/ambient animations on Reanimated worklets.
- Haptic map: define once (`lib/haptics.ts`) — selection, impact light/medium, notify success/warning/error — applied consistently; remove ad-hoc direct calls.

### Phase U6 — Parity, accessibility, performance
- iOS pass on every rebuilt surface; web QA pass.
- Accessibility: labels/roles on all interactive elements, dynamic type sanity, contrast audit vs tokens.
- Performance: list memoization, `removeClippedSubviews` where appropriate, image/asset audit, re-render profiling on chat during streaming.

---

## Part 3 — Execution sequence (interleaved milestones)

UI without the capability underneath is hollow; capability without UI is invisible. Interleave:

| Milestone | Contents | Exit criteria |
|---|---|---|
| **M1 — Foundation** | U0 design system + C7 hygiene start (lint zero, tsc gate) | tokens consumed everywhere; no hardcoded palette; lint clean |
| **M2 — Chat flagship** | C1 chat core + U1 chat UI rebuild | markdown, tool cards, actions, scroll UX, composer v2, sheets v2 on Android |
| **M3 — Command center** | C2 route completion + C3 runs/approvals + U2 home + U3 activity | run monitor live; approvals reachable from Home; home hero shipped |
| **M4 — Agents & terminal** | C4 agents + C5 terminal + U3 terminal UI | agents view; terminal blocks + persistence |
| **M5 — Integration** | C6 deep-link/outbox/TLS + U4 onboarding/settings | deep-link add works end-to-end; queued sends flush; onboarding v2 |
| **M6 — Ship-shape** | C7 tests/CI/docs + U5 motion/haptics + U6 parity | CI green (tsc+lint+unit+smoke), iOS parity, a11y pass |

Per-milestone validation (standing): `npx tsc --noEmit`, `npm run lint`, `npm run smoke:gateway-commands` (where gateway-available), manual pass on Android device: connect → chat → slash → run → approve → terminal → background/foreground heal.

## Decisions (2026-08-10)
1. **Dark-only v1** — commit to the dark theme; remove light-mode debt (`LightPalette`, scheme switching); revisit later.
2. **Markdown renderer**: evaluate `react-native-markdown-display` against SDK 56 first; fall back to custom renderer. (Decide at M2.)
3. **Runs/agents placement**: **new 4th tab ("Activity")** for runs, approvals, and agent activity; Home keeps glanceable summaries that deep-link into it.
4. **Tests framework**: jest-expo per Expo v56 docs. (M6.)
5. **Phase D relay / true push** — out of scope (server component).
6. **Execution**: milestones in order, starting M1 immediately.
