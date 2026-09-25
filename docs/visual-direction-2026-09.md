# Versutus visual direction — 2026-09

Status: **ACCEPTED 2026-09-23** (palette + Chat-first) · **CORRECTED 2026-09-24** (structure over paint)

Peer bar: Claude mobile, Codex mobile, Grok Bot / ChatGPT.

Authoritative correction: `docs/ui-audit-claude-2026-09-24.md`. That audit outranks any reading of this file as “recolour the existing dashboard violet.”

## Verdict locked 2026-09-24

`sprint/2026-09-23-ui-overhaul` landed palette + Chat-as-default cleanly. It did **not** land premium structure. Peers look expensive because they **remove** chrome. Versutus still boxes everything.

**Done (keep):** cool near-black stage, soft electric violet brand, Chat default route, colour discipline, honest empty/fail/loading, WCAG AA on main/secondary/violet.

**Not done (required):** unboxed assistant replies, pill composer, empty one-row header, almost no borders, quiet tool/thinking chrome, still/minimal stage, swipeable sheets, Regular body type, 150–250ms motion, plain-language copy.

## North star

A dark, quiet stage where the **assistant’s words** are the hero. Chrome disappears. Surfaces are told apart by **value steps and spacing**, not hairlines. Every high-value action ≤3 taps from Chat.

## Locked palette (unchanged)

| Decision | Lock |
|---|---|
| Accent | Soft electric violet (brand) — start `#8B7CFF` |
| Stage | Cool near-black `#0A0A0B`–`#111113` |
| Type | Bright white primary; secondary ≥ `#8A8F98` (raise from `#6B7280`) |
| Gold | Defined for rarity only — **do not ship until distinct from warning amber** |
| Status | Semantic green/amber/red — **never** reuse as bot avatar colours |
| Light mode | Out of scope |

## Locked structure (NEW — 2026-09-24)

| Surface | Lock |
|---|---|
| Assistant message | Full-width text on stage; **no** card, **no** border, **no** avatar initial required, timestamp only in overflow/long-press |
| User message | Soft grey bubble, **no** border, **no** selected violet tint |
| Tools / thinking | One quiet collapsible line (`Used N tools · Thought Ns ›`); never taller than the answer by default |
| Header | **One** row: back · title (+ model as tappable subtitle) · one menu. Everything else in the menu |
| Composer | **One** pill: borderless `+` left; mic → round send when there is text. No chip row, no floating terminal icon on the thread |
| Streaming | **Exactly one** continuous signal (prefer caret or subtle presence). Ban header “Streaming…”, RUNNING badge, bouncing dots, and border-colour flash together |
| Background | Flat stage. Delete tilted panels, grain, drifting glows, stray lines. At most one faint **still** glow |
| Surfaces | Widen steps e.g. `#0A0A0B` / `#141416` / `#1C1C20`. Drop most borders; ~70 border declarations is a failure mode |
| Settings / Activity | Grouped rows (label · value · chevron). Ban marketing-card stacks with violet ALL-CAPS section labels |
| Sheets | Grab handle + swipe-to-dismiss on BaseSheet |
| Type | Load Regular (400) for body; Medium+ for UI chrome only; tighten tracking on large headings |
| Motion | 150–250ms; messages fade + slight rise (no L/R slide); no bouncy spring defaults |
| Copy | Plain words only — no PROFILE-SCOPED / slash-command / Hermes-registry user-facing strings |

## Build order (structural — replaces prior token→paint order)

1. **Message layout** — unbox assistant; soften user; collapse tools/thinking
2. **Pill composer**
3. **One-row header**
4. **Strip stage noise + most borders**; widen surface steps
5. **Swipeable sheets**
6. Then human decides: **kill bottom tabs → side drawer** (item still open)
7. Plain-language pass + dim-text AA + avatar/status de-clash + motion/type weights

## Explicit non-goals / forbidden

- “Read X as brand violet” / residual recolour as a green
- New feature families while structure is wrong
- Honesty-only / ErrorCard-only unless ship-blocker
- Weakening the verify gate
- Using gold until it is visually distinct from warning amber
- Four equal dashboard tabs as the end state (tabs may remain temporarily; drawer is the open product call)

## Still open (human)

- Side drawer vs keep thin tabs (audit item 15) — biggest single step toward peer feel
- Exact violet hex saturation
- Whether Home disappears entirely vs thin Gate status
