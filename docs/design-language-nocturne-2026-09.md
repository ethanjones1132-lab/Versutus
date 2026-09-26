# Nocturne — the Versutus design language

Status: **2026-09-25**, builds on `visual-direction-2026-09.md` (palette, structure, drawer —
all still locked) and `ui-audit-claude-2026-09-24.md`. Those documents decided *what to
remove*. This one decides *what the product feels like once the chrome is gone*.

## The idea in one line

A private office at night: a dark, quiet room, one warm lamp of violet, and the work set in
type you would expect to find in a well-made book.

Enterprise agent software usually looks like a monitoring console. Versutus should look like
the thing a principal hands their chief of staff — calm, legible, expensive by restraint.

## Five rules

1. **Type carries the luxury.** Instrument Serif for titles, greetings and names; Instrument
   Sans for everything you operate; JetBrains Mono only for things a machine wrote. Never
   more than one serif line competing on a screen.
2. **Light, not paint.** Violet appears as *light*: one still glow on the stage, the send orb,
   a focus ring, a selected row. It is never a fill for whole cards or a colour for body text.
3. **Value steps, not lines.** Surfaces are told apart by `stage → inset → surface → raised`
   and by space. A border is drawn only when it means something (focus, selection, failure).
4. **One signal per state.** A streaming reply shows one breathing caret. A connected Gate
   shows one mint dot. A pending approval shows one count. Never two indicators for one fact.
5. **Plain words.** Say what the operator gets, not what the system does. "Needs you",
   not "PENDING APPROVALS (PROFILE-SCOPED)".

## Type

| Role | Face | Size / line | Use |
|---|---|---|---|
| `display` | Instrument Serif 400 | 40 / 44, −0.4 | Greetings, first-run, empty hero |
| `title` | Instrument Serif 400 | 32 / 38, −0.3 | Screen titles |
| `headline` | Instrument Sans 600 | 17 / 22, −0.2 | Card and row-group titles, chat header |
| `body` | Instrument Sans 400 | 16 / 24 | Reading — messages, descriptions |
| `callout` | Instrument Sans 500 | 15 / 20 | Row titles, buttons |
| `caption` | Instrument Sans 500 | 13 / 18 | Secondary lines, metadata |
| `micro` | Instrument Sans 500 | 11 / 14, +0.2 | Timestamps, counts |
| `eyebrow` | Instrument Sans 600 | 12 / 16, +0.2 | Section names — sentence case, tertiary |
| `mono` | JetBrains Mono 500 | 13 / 20 | Code, ids, tool output |

Italic serif (`Instrument Serif Italic`) is allowed for one emphasised word inside a display
line — e.g. "Good *evening*." Nowhere else.

## Surfaces

| Token | Hex | Use |
|---|---|---|
| `background` | `#0A0A0B` | The stage |
| `backgroundInset` | `#111114` | Wells: inputs, code, tool detail |
| `backgroundElevated` | `#18181C` | Cards, row groups, the drawer |
| `backgroundRaised` | `#222228` | Sheets, menus, the user bubble, pressed rows |

Raised surfaces that float (sheets, menus, the composer) carry one `specular` hairline on
their top edge — `rgba(255,255,255,0.07)` — the way light catches the lip of a glass. Cards
on the stage carry nothing.

## Identity

Bots are people on a team, not status lights. Each Bot gets a **monogram crest**: its initial
in Instrument Serif on a two-stop gradient disc, the hue derived from the Bot id from a
curated set that excludes every status hue (mint, amber, red). Unroutable Bots carry a small
amber notch — the only status mark on an avatar.

## Motion

- 150 ms for presses and toggles, 200 ms for content arriving, 250 ms for sheets and the drawer.
- Content enters with **fade + 6 pt rise**. Nothing slides sideways, nothing bounces.
- The streaming caret breathes at 1.1 s. It is the only animated thing on a reply.

## Surfaces, screen by screen

- **Roster (Chat home):** greeting in serif, the Gate as a quiet status line, Bots as crest
  rows with their one-line purpose, group rooms, and creation as a single quiet row.
- **Thread:** flat header (back · name + model · menu), the reply on the stage, the user
  bubble on `raised`, activity as one expandable line, a jewel composer with a violet orb.
  An empty thread greets you by the Bot's name and offers starting points.
- **Drawer:** new chat, the Bots you talk to, recent conversations, then Activity, Tools and
  Settings, with the Gate at the foot as a single status line.
- **Activity / Settings / Gate:** grouped rows — label, value, chevron. No eyebrow stacks.

## Seeing it without a Gate

`npx expo start --web --port 8083`, then open `http://localhost:8083/chat?showcase=1`. The
showcase fleet (`src/lib/demo/showcase-fleet.ts`) mounts the real screens against a fixed
Gate, six Bots, a group room, runs and an approval. `?showcase=0` leaves it. Dev web only.
