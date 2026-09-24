# Versutus visual direction — 2026-09-23

Status: **ACCEPTED 2026-09-23 ~22:44 ET**
Peer bar: Claude mobile, Codex mobile, Grok Bot.

Outranks honesty/ErrorCard queue. `.sprint/CHARTER.md` on `sprint/2026-09-23-ui-overhaul` is rewritten against this file.

## Why we paused free-mimo
Free-mimo was shipping honesty/ErrorCard nits. Useful, not the bar. Product still doesn’t feel like a flagship agentic client. Free-mimo checkout stays **PAUSED**; this overhaul runs in a separate worktree.

## North star
A dark, quiet stage where the agent is the hero; chrome disappears; every high-value action is at most three taps from the Chat tab.

## Locked defaults (ACCEPTED 2026-09-23 ~22:44 ET)
Human accepted Claude/Codex/Grok-class sleek minimal luxury with contrast that pops and ≤3 taps. Locks:

| Decision | Lock | Rationale |
|---|---|---|
| Accent | Soft electric violet (brand) | Claude-adjacent; calm luxury; pops on near-black without Grok-loud blue or terminal-green “dev tool” read |
| Stage | Cool near-black (`#0A0A0B`–`#111113`), not brown-black | Kill muddy champagne-glass on `#030304` |
| Type | Bright white / cool near-white primary; muted cool gray secondary | Drop parchment warmth as default |
| Luxury punch | Metallic gold accents — **tasteful minimum** | Gold is highlight / rarity only, not champagne-glass everywhere; not the brand accent |
| Material | Flat elevated panels + hairline borders first | Glass only on sheets/modals |
| Default land | **Chat** (roster → Bot Chat) | Conversation-first like the peer bar |
| Home | Demote: thin status / fold into Chat chrome — not a co-equal product | Four equal tabs currently fight the product |
| Activity / Tools | Keep; lower visual weight vs Chat | Power stays; Chat is the hero |
| ≤3 taps from Chat root | Bot Chat, model, sessions, pending approvals, settings entry, connect gateway | Non-negotiable IA test |
| Motion | Fast 150–250ms; streaming/presence is the only continuous Chat motion | Ambient parallax stays subliminal or goes |
| Light mode | Out of scope until dark language is undeniable | — |
| Honesty-only greens | Forbidden unless ship-blocker | — |

Accent hex to refine at token pass (starting point, not sacred): violet primary `#8B7CFF`, muted `rgba(139,124,255,0.18)`, on-accent text near-white. Metallic gold highlight token (e.g. `#D4AF37` / cool metallic) for rare luxury punches only. Status green/amber/red stay semantic and are **not** the brand accent.

## Current system (honest read)
- Tokens: warm champagne / bronze glass (`src/constants/tokens.ts`) → baroque dashboard, not quiet agent stage.
- Tabs: Home · Chat · Activity · Tools as equal pillars; Home is a command-center dashboard.
- Density: StatTiles, stacked glass cards, competing title/headline roles.
- Aug 10 “flagship” roadmap closed capability gaps; it did **not** land this visual language.

## Build order (structural only)
1. Token contrast pass — cool near-black stage, bright white type, soft electric violet brand accent, metallic gold highlight (minimal); flatten glass defaults in primitives.
2. Chat shell overhaul — roster + Bot Chat + composer as the luxury surface.
3. Tab IA — Chat as initial route; Home demoted or merged; badge approvals on Activity + Chat entry.
4. Sheet language — one modal material system (flat/hairline, glass only if needed).
5. Home residual — status strip / overflow only; no dashboard reincarnation.
6. Residual screens — Activity / Tools / settings inherit the same language.

## Explicit non-goals
- No new feature families while the visual system is replaced.
- No ErrorCard-only / honesty-only iterations unless ship-blocker.
- Do not weaken the verify gate.
- Free-mimo is **not** primary for this overhaul — DeepSeek V4.1 Flash via Hermes OpenRouter.

## Still open (only if human cares later)
- Exact violet / gold hex saturation (token pass can tune).
- Whether Home tab **disappears** vs becomes a thin “Gate” status tab.
- Whether Tools stays a tab or moves behind Chat overflow.
