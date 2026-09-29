# Nocturne — the Versutus design language

Status: **2026-09-25**, builds on `visual-direction-2026-09.md` (palette, structure, drawer —
all still locked) and `ui-audit-claude-2026-09-24.md`. Those documents decided *what to
remove*. This one decides *what the product feels like once the chrome is gone*.

**2026-09-28 — the stage is the lamp.** The operator made the stage the centrepiece: the one
still glow became a real light (see **The stage**). This supersedes the audit's "at most one
faint still glow" (item 6). Its objections still bind — no busy art, no loops, no battery
drain — and the lamp is built to meet them.

## The idea in one line

A private office at night: a dark, quiet room, one warm lamp of violet, and the work set in
type you would expect to find in a well-made book.

Enterprise agent software usually looks like a monitoring console. Versutus should look like
the thing a principal hands their chief of staff — calm, legible, expensive by restraint.

## Five rules

1. **Type carries the luxury.** Instrument Serif for titles, greetings and names; Instrument
   Sans for everything you operate; JetBrains Mono only for things a machine wrote. Never
   more than one serif line competing on a screen.
2. **Light, not paint.** Colour appears as *light*: the lamp over the stage, the send orb, a
   focus ring, a selected row. It is never a fill for whole cards or a colour for body text.
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

Raised surfaces that float (sheets, menus) carry one `specular` hairline on
their top edge — `rgba(255,255,255,0.07)` — the way light catches the lip of a glass. Cards
on the stage carry nothing.

A control that rests *in* the lamp's light (the roster's search) is `stageGlass` — smoked
glass, `rgba(14,14,18,0.58)` — so the light glows dimly through it instead of the control
reading as a hole cut in the light. Dark enough that tertiary text keeps AA over it.

Panels resting on the stage — row groups, cards, run cards on Activity, Runs and Settings —
are the `stage` variant, `stagePanel` `rgba(28,28,34,0.72)`: over the dark stage it composites
to the elevated step exactly (`#18181C`), and near the top the lamp glows through it, so the
room's light reaches the UI and not only the backdrop. Tertiary text on it keeps AA under
every lamp colour (`glass-variants-test`). Sheets and menus keep the opaque steps.

## Identity

Bots are people on a team, not status lights. Each Bot gets a **monogram crest**: its initial
in Instrument Serif on a two-stop gradient disc, the hue derived from the Bot id from a
curated set that excludes every status hue (mint, amber, red). Unroutable Bots carry a small
amber notch — the only status mark on an avatar.

The crest is lit like polished stone, not painted like a sticker: a soft sheen pools at the
upper left, and a rim of light runs bright along the top edge and falls into shadow underneath.
The ten tones spread across hue *and* value (brand violet, cobalt, lagoon, ocean, mulberry,
orchid, raspberry, platinum, and two twilight tones that turn between hues).

**No two teammates share a crest.** A hash alone cannot promise that (six Bots over ten tones
collide more often than not), so tones are assigned across the fleet whenever the inventory
is read (`registerCrestFleet` in `src/lib/bot-avatar.ts`): each Bot keeps its natural tone
when free, and only colliders step to the next free one. It is order-free and deterministic,
and a Bot that owns its natural tone never moves.

An empty thread lights the crest with a halo of its own tone: the one still glow on that
screen.

## The stage

A dark room lit by one lamp that hangs just above the top edge, over the upper left — the
same light that pools the sheen on every crest. It is a GPU shader, written once
(`src/lib/stage/shader.ts`) and run by WebGL on the web and by a Skia runtime effect on the
phone, so both platforms show the same light.

- **The lamp.** A soft pool with an inverse-square-like falloff: it lights the header and the
  greeting, and the room is dark again by the middle of the screen, where you read. Its hue
  runs from the crest's deep stop at the fringe to its lit stop at the hot core.
- **The air.** Slow, layered haze — broad billows and finer wisps a layer nearer — that is
  only ever seen *in* the light. It morphs in place; nothing slides. Faint shafts turn through
  the key light, and a sparse dust of motes drifts upward in the beam.
- **Whose room it is.** The lobby (roster, Activity, Tools, Settings) and a direct chat are
  lit in the house violet. A Bot's thread is lit in that Bot's crest tone. A group room hangs
  one lamp per member across the ceiling, and their light mixes where the pools meet.
- **The room answers.** The session's first light warms up from a dark room. A room change
  crossfades, the light breathing out and in on the way. A sent message rises from the
  composer as a swell of light that lifts the dust as it passes. While a Bot replies the room
  is a little brighter. An offline Gate dims every lamp. On the phone, tilting it moves the
  light like a reflection. None of these is a *signal* — the caret, the dot and the count
  still carry the state; the room only feels it.

**The ceiling.** Every lamp colour is its crest stop re-made in OKLCH — hue kept, chroma as
vivid as the sRGB gamut allows — and carried at one fixed luminance, so every room is equally
bright and only the colour changes. All light meets the stage through one exposure curve
(1 − e^−x), so no pixel can pass the stage plus one lamp colour. That ceiling keeps the dimmest
words on the stage (`textTertiary`) at 4.5:1 everywhere, dither included. A lamp hue also
keeps 45° (OKLCH) clear of every status hue: at night a pink turns crimson, and a crimson room
reads as a failure. `__tests__/stage-shader-test.ts` renders the real shader in Skia and holds
the brightest pixel of every room to AA.

**Discipline.** One WebGL context app-wide on the web. The air draws at 24 fps (it moves too
slowly for more to show) and only a change gets every frame. The stage sleeps when its screen
is hidden or off-screen, when the app is in the background, and when nobody has touched it for
40 s — the air stills, and a touch wakes it. Under Reduce Motion the air stands still, a room
change is a 220 ms fade, and nothing rises. If the shader cannot run, a still disc of the
room's colour stands in.

## The Lens

The composer is a piece of curved glass lit by the room it sits in. It takes the **room's
tone**: the crest of the Bot the thread talks to, the house violet anywhere else
(`src/lib/stage/composer-light.ts`, `src/components/chat/composer-lens.tsx`).

- **At rest** the glass is `raised` with a depth gradient (light at the top lip, falling to
  nothing) and a white rim lit at its upper-left, the way a lens catches a lamp above it.
- **On focus** the rim kindles into the tone's gradient, a soft halo of the tone rises
  around the pill, and one glint of light crosses the glass (1.05 s).
- **Typing** shimmers the rim for each burst (70 ms up, 560 ms decay). Only a growing draft
  shimmers; the draft clearing after a send doesn't count as typing.
- **The send orb** blooms in (scale 0.62 → 1, 220 ms) when there is text: a jewel cut from
  the tone, its body running from the lit stop at the lip to the deep stop past the middle,
  with the light kept in a sheen. Its arrow is white whenever white clears the 3:1 an icon
  needs; only platinum, too pale for that, takes the stage's near-black.
- **On send** a ring of the tone leaves the orb (1 → 2.6×, 760 ms) and a glint crosses the
  glass as the stage's swell rises. The ring lives in the send slot, so it outlasts the orb
  turning into the plain white Stop. Stop changes material because it changes meaning.
- **Hold-to-talk** makes the rim breathe at 1.1 s, the caret's own rhythm, while the mic
  listens.
- Under **Reduce Motion** the glint, shimmer, breath, bloom and ring all stand down. The rim
  still lights on focus, because that shows state.

## Motion

- 150 ms for presses and toggles, 200 ms for content arriving, 250 ms for sheets and the drawer.
- Content enters with **fade + 6 pt rise**. Nothing slides sideways, nothing bounces.
- The streaming caret breathes at 1.1 s. It is the only animated thing on a reply.
- The stage's light keeps its own time (**The stage**): the air moves slower than the eye
  tracks; a room change takes 1.6 s, a swell 2.1 s, the first light 2.4 s.

## Surfaces, screen by screen

- **Roster (Chat home):** greeting in serif with its last word in italic ("Good *evening*"),
  the Gate as a quiet status line, Bots as crest rows with their one-line purpose (no model
  ids; the thread header carries the model), group rooms, then "Grow the team": creation
  as rows in the roster's own rhythm, never a wrap of pills.
- **Thread:** flat header (back · name, then model ⌄ · what the thread has cost, on one
  line) · menu. The reply sits on the stage; list markers are drawn dots in the tertiary tone,
  and violet is kept for quote rules and links. The user bubble sits on `raised`, activity is
  one expandable line, and the composer is **the Lens** (below). An empty thread greets
  you by the Bot's name under its halo and offers starters as centred pills that fill the
  composer and never send.
- **Drawer:** the mark and wordmark, a New chat pill, then Chats / Activity / Tools, the Bots
  you talk to, and Settings, with the Gate at the foot as a single status line.
- **Activity:** the serif title, then *the day at a glance* — three figures in the display
  serif (needs you · working · done today; "failed" only on a day something did), and the
  last day as a ribbon of light: every run a bead in its Bot's crest colour, on a perspective
  (square-root) time scale with honest 6h / 1h ticks, the waiting run carrying the one amber
  ring. A waiting approval is lit by the Bot that asks (a pool of its crest light). Every run
  on Activity — a row or a bead — opens Runs *on that run*: found, scrolled to, and lit.
- **Runs:** Activity opened out — the same title, status line and ribbon, the start box on a
  lit panel, sentence-case section names, and run cards in Activity's words and colours
  (waiting amber, working violet, done mint, failed red) with the Bot's crest. A card rings
  only for focus or failure. Scorecards carry crests and the roster's names.
- **Settings / Spend:** no header bar; the serif title in the lamp's light, with the Gate's
  identity (mark, name, connection) as Settings' one status line. Grouped rows and lit
  panels; voice engines as a radio list, not boxed paragraphs; an empty section is one
  quiet line, never a box holding a sentence.
- **Crests** read the fleet's tone assignment through `useBotCrest`, which hands the
  assignment to a pure function — the React Compiler infers memo inputs from use, and a
  crest drawn before the team loaded must redraw in its assigned tone.

## Seeing it without a Gate

`npx expo start --web --port 8083`, then open `http://localhost:8083/chat?showcase=1`. The
showcase fleet (`src/lib/demo/showcase-fleet.ts`) mounts the real screens against a fixed
Gate, six Bots, a group room, runs and an approval. `?showcase=0` leaves it. Dev web only.
