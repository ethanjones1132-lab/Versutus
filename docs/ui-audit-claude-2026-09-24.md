# Claude UI audit — sprint/2026-09-23-ui-overhaul

Date: 2026-09-24 ~21:49 ET  
Auditor: Claude (operator-relayed)  
Branch: `sprint/2026-09-23-ui-overhaul` (~71 commits on master; ~40 overhaul)  
Method: throwaway mock at `/dev/audit?view=thread` (live Gate token not used in browser). Web build; no native tab bar/blur. `npm run verify` not run.

**Status: ACCEPTED as project direction 2026-09-24.** Outranks prior “paint the chrome violet” interpretation of `docs/visual-direction-2026-09.md`.

## Verdict

The branch **recolours** the app but does **not restructure** it. Violet near-black palette landed cleanly; Chat opens first. The layout underneath is the same dense dashboard, now painted violet. Most overhaul commits are titled like “read X as brand violet.”

ChatGPT, Claude, and Grok look expensive because they **remove** things: assistant reply unboxed on the background, one-pill composer, nearly empty header, almost no borders. Versutus does the opposite on every one of those.

## What’s good

- Design direction doc is the right brief.
- Colour discipline: ~20 hard-coded colours left in components.
- Chat is default; settings reachable from inside chat.
- Main / secondary / violet meet WCAG AA (≥4.5:1).
- Loading, failed, empty states are honest and distinct.

## Biggest problems (why it doesn’t feel premium)

1. **Message layout** — Assistant replies in bordered cards (`message-bubble.tsx:98`) with “O” initial + monospace timestamp under every message. User bubble has violet border + tint (reads “selected”). Peers: assistant text full-width on background; user soft grey bubble, no border.
2. **Tool calls crowd the answer** — Tool cards with DONE + Detail taller than the reply; order tools → Thinking → answer. Collapse to one quiet line (“Used 2 tools · Thought 3s ›”) expandable on tap.
3. **Header is a two-row floating card** — Up to 9 items; labels truncate at phone width. Target: one row — back, title + tappable model subtitle, one menu. Rest in menu.
4. **Composer** — Up to four boxed square buttons + Run/Status/Help chips + floating terminal. Placeholder wraps at 375px. Target: single pill — borderless “+” left; mic that becomes round send once typing.
5. **Streaming signalled five ways** — header text, pulsing dot, amber RUNNING, ▍ cursor, bouncing dots, plus border colour change. Direction doc says pick one.
6. **Busy background** — tilted panels, stray lines, vertical left line, grain, drifting violet glows; diagonal through “TODAY” divider. Against “chrome disappears”; animation costs battery. Delete, or at most one faint still glow.
7. **Surface layers invisible** — bg vs card ~1.05:1, vs top ~1.10:1 → ~70 borders / ~79 cards (wireframe look). Widen steps (e.g. `#0A0A0B` / `#141416` / `#1C1C20`) and drop most borders, or use spacing instead of boxes.
8. **Everything is a card** — Settings/Activity = stacked bordered cards with violet ALL-CAPS labels. Target: plain grouped rows (label, value, chevron).
9. **Dim text fails AA** — `#6B7280` at 3.7–4.1:1 in ~177 places (incl. 11px timestamps). Raise toward `#8A8F98`.
10. **Gold unused** — defined but unused; warning amber `#D6B76A` nearly same hue → future gold reads as warning.
11. **Bot icon vs status clash** — avatar list includes exact “connected” mint; “No listen key” shows green dot → reads online.
12. **Sheets not swipeable** — no grab handle; BaseSheet has no drag. Swipe-to-dismiss is the premium phone interaction.
13. **Body weight** — Medium everywhere (only 500–700 loaded). Load Regular (400) for reading; tighten tracking on big headings.
14. **Motion contradicts doc** — defaults 300/600ms + bouncy spring; doc says 150–250ms. Messages slide L/R; peers fade + slight rise.
15. **Four bottom tabs** (Home last) — peers have none: one conversation + side drawer. Biggest step; human call (doc left open).
16. **Engineer wording leaks** — e.g. “Ready for chat and slash commands”, Hermes registry copy, “PROFILE-SCOPED”, etc. Plain-language pass needed.
17. **Smaller** — roster row indent mismatch; not-connected empty stacks three big-gap buttons including “Go to Home.”
18. **Side note** — `/dev/preview` crashes on web (`Keyboard.metrics()` missing). Also on master; lab never visually checked this overhaul.

## Suggested order (~80% of the feel)

1. Message layout (item 1)
2. Pill composer (item 4)
3. One-row header (item 3)
4. Strip background + borders (items 6–7)
5. Swipeable sheets (item 12)

Then decide drawer / kill tabs (item 15).

**Operator decision 2026-09-24 ~21:51 ET:** Drawer — kill bottom tabs. Locked in visual-direction + charter.

## Operator notes

- Sprint paused 2026-09-24 ~21:50 ET at `2f7ab2c` so direction can absorb this audit before more violet residual commits.
- Do not treat “read X as brand violet” as progress against this document.
