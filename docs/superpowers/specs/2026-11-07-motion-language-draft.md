# Versutus motion language (draft, 2026-11-07)

Status: DRAFT for Ethan. Nothing here is built or measured. Every cost claim is a design argument
until section 6 is run on the A54.

Sources read: `src/lib/motion/*` (presets, hooks, ambient-parallax, approval-exit),
`src/constants/tokens.ts` (`Motion`), `src/lib/stage/*` (choreography, lamp, motion, shader,
signals), `src/components/layout/AmbientCanvas.native.tsx`, `src/components/chat/*`
(streaming-indicator, composer-lens, message-bubble, chat-screen list setup),
`src/components/ui/*` (PressableScale, Skeleton, SegmentedControl, BaseSheet),
`src/components/voice/handsfree-call-indicator.native.tsx`, `src/lib/haptics.ts`,
`docs/plans/overnight-performance.md`, `docs/visual-direction-2026-09.md`, and the light lab
(`scratchpad/light-preview/src/lab.ts`) for the working reaction curves.

API claims were checked against the installed packages' type definitions, not the docs website:
react-native-reanimated 4.5.1, react-native-worklets 0.10.1, @shopify/react-native-skia 2.6.2,
react-native 0.86.3, expo 57.0.31, expo-haptics 57.0.3. Not installed: expo-linear-gradient,
expo-blur, lottie, FlashList / Legend List. The docs.expo.dev v57 pages were not fetched for this
draft; re-check before implementation.

---

## 0. What already moves (build on it, do not duplicate)

| Existing | Where | Keep / change |
|---|---|---|
| Lamp warm-up from dark (2400 ms smootherstep gain) | `choreography.ts` `lampOnMs`, `AmbientCanvas.native.tsx` | Keep the curve; move it to the Veil (section 2.2), so it stops redrawing the field for 2.4 s |
| Room change crossfade with a 20% dip (1600 ms) | `tintMs`, `tintDipGain` | Keep the dip; shorten to `t.light` 600 ms so it fits the 0.4-0.8 s field-reaction window |
| Send swell (field uniform `uSwell`, 2100 ms) | `swellUniform` | Replace with a layer swell (M14). 2.1 s of full-rate field redraw breaks the agreed engine |
| Speaking brighten (gain 1.14, tau 420 up / 1500 down) | `STAGE_GAIN.speaking` | Keep the taus; drive it through the Veil |
| Gate dim (0.72 reaching, 0.34 offline, tau 800) | `connectionGain` | Keep the levels; drive them through the Veil |
| Scroll parallax as a uniform, fed by a JS `setState` scroll handler | `ambient-parallax.ts` | Replace: parallax becomes a transform of the field layer, read with `useScrollOffset` on the UI thread |
| Tilt from `useAnimatedSensor(GRAVITY, 33 ms)` into uniforms | `TiltSource` | Keep the sensor maths; output to the field layer's transform instead of uniforms |
| Approval and failure tints (amber 0.38 mix, red 0.5 dip over 1100 ms) | lab only | Adopt; failure shortened to 600 ms |
| Tool breath ±5% (period about 2.4 s), call level pulse and 3 rings | lab only | Adopt; breath through the Veil, rings in the Glint |
| Message rise (FadeInDown, 200 ms, 6 px) | `presets.entering.rise`, `message-bubble.tsx` | Keep; newest cell only |
| Press scale 0.97 + clamped spring | `usePressScale`, `PressableScale` | Keep as the universal press |
| Streaming orb breath (900 ms half-cycle) | `streaming-indicator.tsx` | Keep; lock its phase to the shared breath clock |
| Composer lens: kindle 260 ms, keystroke shimmer 70/560 ms, listening breath 1100 ms, sweep 1050 ms, orb bloom | `composer-lens.tsx` | Keep; retime to tokens, lock breath to the clock |
| Sheet slide (`BaseSheet`, timing on translateY), swipe-to-dismiss | `BaseSheet.tsx`, `sheet-swipe.ts` | Keep |
| Segmented indicator spring | `SegmentedControl.tsx` | Keep |
| Skeleton opacity loop (850 ms) | `Skeleton.tsx` | Replace with the light-sweep skeleton (M49) on the breath clock |
| Approval card exit (approve 280 ms, deny 320 ms, scale 0.92) | `approval-exit.ts` | Keep the timings; add the resolve beat (M26) |
| Call indicator: one Skia circle driven by level | `handsfree-call-indicator.native.tsx` | Grows into the Call signature moment |

Conflict to settle: the visual-direction motion lock says "150-250 ms" and "no bouncy spring
defaults". This draft keeps every touch response inside that window and keeps all UI springs
clamped, but adds longer light-borne motion (600 ms field reactions, 2400 ms breath) and one
spring with about 1% overshoot used only by signature moments. See decision D1.

---

## 1. Personality

Using Versutus should feel like sitting in a dark room with one good lamp that is paying attention.
The lamp is the Bot: its colour is the room, it brightens when the Bot talks, breathes while it
works, turns amber and holds its breath when it needs you, flinches red for a beat when something
fails, and dims when the line goes quiet. The interface itself is calm and exact: surfaces settle
into place with no wobble, presses answer instantly, text never dances. Light moves first and the
UI follows a few frames behind, so every event reads as one physical thing happening in the room,
not a set of widgets animating. When nothing is happening, almost nothing moves, and that stillness
is what makes the reactions land.

---

## 2. Engine additions this language relies on

Two cheap layers make the rest possible. Both are design proposals, both unmeasured.

### 2.1 Layer stack (bottom to top)

1. **Field**: the lamp shader, 1/2 size, upscaled with dither, 24/s ambient (decided).
   Drawn about 3% oversize (about 12 dp margin each side) so it can be moved by transform.
2. **Veil**: one full-screen ink `View` (`#0A0A0B`, the stage base) whose opacity is a shared
   value. Darkening the field by a transparent ink layer is a single alpha blend: class A.
3. **Surfaces and content**: base, raised, overlay (decided rules).
4. **Glint**: one small Skia canvas, at most 280 x 280 dp, mounted once per screen, repositioned
   by transform, drawing at most 3 simple shapes. Hidden (opacity 0, no animation) when idle.
5. **Modals**: the only layer with an elevation shadow (decided).

### 2.2 The Veil: brightness reactions without redrawing the field

Every reaction that changes only brightness (warm-up, speaking, tool breath, Gate dim, failure
dip depth, call pulse) becomes a Veil opacity change, so the field keeps its 24/s ambient rate and
never redraws for them. Only hue changes (Bot switch, approval amber, failure red, Gate relight
tint) redraw the field at display rate, and only for `t.light`.

To brighten without an additive layer, the field is rendered at its speaking level (gain 1.14) and
the Veil rests at `1 - 1/1.14 = 0.123`:

| State | Field gain (old model) | Veil opacity |
|---|---|---|
| Lamp off (launch frame 0) | 0 | 1.0 |
| Resting | 1.0 | 0.123 |
| Speaking | 1.14 | 0.0 |
| Tool breath | 1.0 ±5% | 0.123 ±0.044 |
| Gate reaching | 0.72 | 0.368 |
| Gate offline | 0.34 | 0.702 |
| Call peak | capped at 1.14 | 0.0 |

The AA ceiling in `lamp.ts` still holds by construction: the Veil can only darken, and the field
at 1.14 is already proven under the ceiling by the exposure curve. Caveat (UNVERIFIED): an sRGB
alpha blend is not identical to a linear-light gain before the exposure curve. Side-by-side the two
in the lab before adopting (decision D3).

### 2.3 Field-layer transform for parallax and tilt

Scroll parallax and tilt move the field layer by translate (max 10 dp) and the Veil does not move.
Today both are uniforms, which forces a full field redraw each frame while scrolling or tilting.
Read scroll with `useScrollOffset` (exists in Reanimated 4.5.1) instead of the JS `setState`
handler in `ambient-parallax.ts`.

### 2.4 The shared breath clock

One shared value, `breath`, a `withRepeat(withTiming(1, t.breath/2, ease.inOut), -1, true)` that
runs only while at least one subscriber is mounted and visible (ref-counted). Every breathing thing
(tool Veil breath, streaming orb, listening composer, skeleton sweep, approval edge) derives from it,
so they breathe in phase. One clock, one heartbeat; never two loops out of phase on screen.

---

## 3. Motion tokens (11)

| Token | Value | Use |
|---|---|---|
| `t.ui` | 200 ms (existing `Motion.duration.normal`) | Enter, exit, fades, crossfades of UI |
| `t.stage` | 420 ms | Structural moves: route push, sheet open, card expand, call open |
| `t.light` | 600 ms | Every field reaction (hue change); light-borne layer moves |
| `t.breath` | 2400 ms full cycle | The shared breath clock |
| `ease.out` | `Easing.bezier(0, 0, 0.2, 1)` (existing `decelerate`) | Anything arriving |
| `ease.inOut` | `Easing.bezier(0.2, 0, 0, 1)` (existing `standard`) | Anything travelling or crossfading; exits use it at `t.ui * 0.75` |
| `spring.snap` | `{ damping: 30, stiffness: 320, mass: 0.9, overshootClamping: true }` (existing `springSnappy`) | Press release, indicators, toggles, drawer follow |
| `spring.settle` | `{ duration: 420, dampingRatio: 0.82 }` (about 1.1% overshoot) | Signature moments only: approval card land, Bot crest land, call orb land. See D1 |
| `stagger` | 40 ms per item, max 6 items (240 ms) | Lists, chips, menu rows |
| `rise` | 6 dp (existing `RISE_DISTANCE`); travel moves use `rise * 4` = 24 dp | Entering offset |
| `press` | scale 0.97, in via `withTiming(120 ms, ease.out)`, out via `spring.snap` | Every pressable |

`spring.settle` uses Reanimated 4's duration + dampingRatio form, which the installed types define
(`SnappySpringConfigWithDuration` and siblings in `animation/spring/springConfigs.d.ts`).
Deprecated in this language: `Motion.duration.fast` (150, folded into `press`), `slow` (250),
`easing.spring` (`Easing.elastic`, never used for UI).

Field-reaction envelopes use the existing worklet curves in `choreography.ts`
(`easeInOutCubic`, `smootherstep`, `approach`). No new curve library.

---

## 4. Signature moments

These are the hero of the redesign. Each is built only from classes A to C.
Timings are from the trigger (t = 0). "Light leads" means the field or Veil starts first.

### S1. First Light (app launch)

What Ethan sees: a black screen that is not quite black. A thin warm line appears along the top
edge where the lamp would hang, then the room fills with the active Bot's colour from the upper
left down, like someone turned on a dimmer. The header and the last messages surface out of the
dark in a short cascade, and the composer is the last thing to arrive, already lit.

| t (ms) | Beat | Class |
|---|---|---|
| 0 | Field draws one frame at the room colour; Veil at 1.0 hides it | C (one frame) |
| 0-1800 | Veil opacity 1.0 to 0.123 on `smootherstep` (the existing lamp-on curve, shortened from 2400) | A |
| 120 | Lamp hairline: a 1 dp View at the top edge, room colour, scaleX 0 to 1 from the left over `t.stage`, then fades to the lit-edge resting alpha | A |
| 500 | Header: opacity 0 to 1, translateY -`rise` to 0, `t.ui`, `ease.out` | A |
| 600-800 | The last 5 visible messages: rise, `stagger` from the bottom-most up | A |
| 900 | Composer: rise 24 dp with `spring.settle`; its lit top edge fades in with it | A |
| 1100 | Bot crest in the header: one crest wink (M65) | A |

Cost: zero field redraws beyond the first frame. Reduced motion: Veil 1.0 to 0.123 over 200 ms,
everything else appears at once.

### S2. Changing Rooms (Bot switch)

What Ethan sees: he taps a Bot in the drawer. Its crest swells slightly under his thumb, the room
exhales (darkens a touch) and comes back in the new Bot's colour, every lit edge on screen
re-lights in the new colour a few frames after the field, and the thread content crossfades
underneath, with the new Bot's name rising into the header.

| t (ms) | Beat | Class |
|---|---|---|
| 0 | Crest press: `press`; haptic `selection` | A |
| 60 | Drawer closes on `spring.snap` (M38) | A |
| 60-660 | Field hue crossfade old to new over `t.light`, with the existing `tintDipGain` dip | C |
| 140 | Lit edges: the new-colour edge layer fades in over the old one, `t.ui` (two stacked 1 dp Views, opacity only) | A |
| 160 | Old thread: opacity to 0 and translateY -`rise`, `t.ui * 0.75`, `ease.inOut` | A |
| 300 | New thread: rise from +`rise`, `t.ui`, newest 4 rows on `stagger` | A |
| 320 | Header name and crest: crossfade, crest scale 0.9 to 1 on `spring.settle` | A |

Cost: one 600 ms field reaction (the decided budget), everything else transform/opacity.
Reduced motion: field crossfade over 220 ms (existing `reducedTintMs`), content swaps with a
150 ms opacity fade.

### S3. Send and Answer

What Ethan sees: he hits send. The button dips, the message lifts out of the composer into the
thread, and a soft band of the room's light rises behind it and dissolves around the middle of the
screen. A small orb in the Bot's colour appears where the reply will be and breathes. When the first
words land the orb fades into the start of the reply and the whole room brightens a little and stays
bright while the Bot talks. When it finishes, the room relaxes and a single highlight runs along
the reply's top edge, like a page being set down.

| t (ms) | Beat | Class |
|---|---|---|
| 0 | Send button `press`; haptic `light` | A |
| 0 | Swell layer: a radial-gradient View (static `experimental_backgroundImage`, room colour, alpha capped) starting at the composer, translateY up to 45% screen height, scale 0.6 to 1.6, opacity 0 to peak at 10% then down, over 1100 ms `ease.out` | A |
| 40 | Composer lit edge: one flash, opacity +0.4 then back over `t.light` | A |
| 60 | Bubble: existing rise, from composer side, `t.ui` | A |
| 260 | Thinking orb (M16) fades in, locked to the breath clock | A |
| first token | Orb fades out `t.ui * 0.75` while the reply's first line fades in at the orb's anchor; Veil 0.123 to 0 on `approach` tau 420 | A |
| streaming | No per-token motion. Text arrives with flushes. Veil holds at 0 | A (idle) |
| done | Veil back to 0.123 on tau 1500; sheen sweep along the reply's top edge (M48), 700 ms | A |

Cost: zero field redraws. This replaces the 2.1 s `uSwell` field redraw. Reduced motion: bubble
fades in 150 ms, Veil change runs as a 200 ms fade, no swell, no sheen.

### S4. The Ask (approval)

What Ethan sees: mid-run, the room slowly turns amber, like a warning lamp warming rather than an
alarm. A card rises from the bottom and lands with the faintest settle; its top edge glows amber
and breathes with the room. When he taps Approve the card presses, its edge flashes back to the
Bot's colour, it shrinks into a small "Approved" chip that drops into the thread, and the amber
drains out of the room.

| t (ms) | Beat | Class |
|---|---|---|
| 0 | Field eases toward amber (0.38 mix) over `t.light`, then holds; held amber needs no redraw once settled | C |
| 0 | Haptic `warning` | - |
| 120 | Card rises 24 dp on `spring.settle`, opacity over `t.ui` | A |
| 320 | Card's amber edge joins the breath clock (opacity 0.6 to 1) | A |
| tap Approve | `press`; haptic `success`; edge crossfades amber to room colour, `t.ui` | A |
| +120 | Card scale 1 to 0.92, opacity to 0 (existing 280 ms); chip fades and rises in at the card's top-left anchor, `t.ui` | A |
| +120 | Field amber to room colour over `t.light` | C |
| Deny | Same, 320 ms (existing), edge fades to neutral grey, no red, haptic `light` | A + C |

Cost: two 600 ms field reactions per approval. The 520 ms sinusoidal amber shimmer in the lab is
dropped: a held hue must not redraw the field. The breathing lives on the card edge instead.
Reduced motion: field hue change over 220 ms, card fades in and out, no breath.

### S5. The Call (voice)

What Ethan sees: he taps the voice button. The button's orb grows until it fills the screen as a
dark pool of the Bot's colour and the chat recedes behind it. A bright orb rests mid-screen, and
when the Bot speaks, rings ripple out of it with the voice and the whole room pulses with it. When
Ethan talks, the orb leans toward him (it drops lower and widens). Hanging up pulls everything back
into the button.

| t (ms) | Beat | Class |
|---|---|---|
| 0 | Voice button `press`; haptic `medium` | A |
| 0-420 | Expanding pool: a circle View at the button, room colour at 40% alpha (Ethan, 2026-11-07, so the lamp stays visible during a call), scale 1 to cover (about 16x) over `t.stage` `ease.inOut`; chat scale 1 to 0.96, opacity to 0.3 | A |
| 200 | Central orb lands on `spring.settle` | A |
| connected | Field to 1.14 gain via Veil 0; hue unchanged, so no field redraw | A |
| Bot speaking | Glint around the orb: 3 rings, radius = base + i*22 + level*54 dp, opacity 0.2 - i*0.05 (the lab's formula); Veil opacity = 0.123*(1 - level) | B + A |
| user speaking | Orb translateY +8 dp, scaleX 1.06, on `approach` tau 90; rings off | A |
| mute | Orb opacity to 0.4, rings to 0, a 1 dp slash line scales in over `t.ui` | A |
| end | Reverse of open over `t.stage`; haptic `light` | A |

Level is read on the UI thread from the existing shared value in the call indicator. Cost: one
Glint, no field redraws. Reduced motion: crossfade to the call screen, no rings, orb opacity
follows level (no scale).

---

## 5. Catalogue

Cost classes: **A** transform/opacity on UI-thread shared values; **B** one Glint shape;
**C** field uniform (hue redraw for `t.light`); **D** needs a decision or a measurement first.
"RM" is the reduced-motion variant. Every A entry assumes the style runs in a `useAnimatedStyle`
worklet that calls only worklets.

### 5.1 Launch and first light

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M1 | First Light | Cold start | S1 | S1 | A (+1 C frame) | 200 ms Veil fade |
| M2 | Warm return | App returns from background over 30 s | Veil 0.4 to 0.123, `t.light`; no cascade | `t.light` | A | none |
| M3 | Lamp hairline | First Light, Gate relight | 1 dp top line scaleX 0 to 1 from left, then settles to edge alpha | `t.stage`, `ease.out` | A | appears |

### 5.2 Routes

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M4 | Push | Navigate deeper | Incoming: opacity 0 to 1, translateY +`rise`*2, scale 0.985 to 1. Outgoing: opacity to 0.6 then cut, scale 0.985. No horizontal slide | `t.stage`, `ease.out` | A (D: depends on what the router's native stack allows; see D6) | 150 ms fade |
| M5 | Pop | Back | Reverse of push at `t.ui` | `t.ui`, `ease.inOut` | A | fade |
| M6 | Field follows route | Route enters a different room | Room hue change, same as S2 field beat | `t.light` | C | 220 ms |
| M7 | Parallax depth | Any scroll | Field layer translateY = clamp(scroll/480) * 10 dp; surfaces scroll 1:1, so the light lags behind the content | continuous | A | off |

### 5.3 Tabs and Bot switching

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M8 | Tab indicator glide | Tab change | Indicator translateX on `spring.snap` (as SegmentedControl); icon of new tab scale 0.9 to 1 | `spring.snap` | A | jumps |
| M9 | Tab content swap | Tab change | Old opacity to 0 at `t.ui*0.75`; new rise `rise` | `t.ui` | A | fade |
| M10 | Changing Rooms | Bot switch | S2 | S2 | C + A | 220 ms |
| M11 | Lit-edge relight | Any field hue reaction | Every surface's 1 dp top edge: two stacked edges, new one fades in 80 ms after the field starts | `t.ui` | A | instant |
| M12 | Roster crest hover-light | Finger down on a roster row | Row's crest scale 1.04 on `press` timings, row fill opacity +0.06 | `press` | A | fill only |

### 5.4 The chat

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M13 | Message send | Send | S3 bubble beat: existing rise | `t.ui`, `ease.out` | A | fade 150 |
| M14 | Send swell | Send | S3 swell layer | 1100 ms, `ease.out` | A | none |
| M15 | Message arrival | Non-streamed message lands (history, other device) | Rise `rise`, newest cell only; older cells mounted by scroll never animate | `t.ui` | A | fade |
| M16 | Thinking orb | Turn started, no tokens yet | Existing orb + halo, phase-locked to the breath clock, Bot colour | `t.breath` | A | static orb at 0.8 opacity |
| M17 | Orb handoff | First token | Orb opacity out, reply's first line fades in at the same anchor | `t.ui*0.75` | A | instant |
| M18 | Speaking glow | Bot streaming | Veil 0.123 to 0 (tau 420 up, 1500 down) | tau | A | 200 ms fade |
| M19 | Streaming text | Each flush | Nothing animates per token. The streaming bubble's height grows by layout; the list stays pinned (M24). One trailing caret dot rides the breath clock | - | A | caret static |
| M20 | Tool card arrival | Tool call starts | Card rises `rise`; its left 2 dp status rail breathes with the clock while running | `t.ui`, `t.breath` | A | rail static |
| M21 | Tool work breath | Any tool/agent run active | Veil 0.123 ±0.044 on the breath clock | `t.breath` | A | off |
| M22 | Tool card expand / collapse | Tap tool card | Chevron rotate 0 to 180 on `spring.snap`; body content opacity 0 to 1 + translateY -`rise` to 0 after layout lands. The height change itself snaps (no height animation) | `t.ui` | A. A smooth push-down of rows below is D (D5) | instant |
| M23 | Tool done tick | Tool call succeeds | Rail stops breathing, flashes room colour once (opacity 1 to 0.5 over `t.light`); a check icon scales 0.6 to 1 on `spring.snap` | `t.light` | A | icon appears |
| M24 | Pinned follow | Content grows while pinned to bottom | Coalesced scroll-to-end at most every 100 ms, not animated (per perf plan P2) | - | A (JS cost: D) | same |
| M25 | Approval arrives | Approval needed | S4 | S4 | C + A | 220 ms |
| M26 | Approval resolved | Approve / Deny | S4 resolve beat | 280 / 320 ms | A + C | fade |
| M27 | Failure flinch | Turn or tool fails | Field dips toward red: 0.5 mix on `sin(pi*p)` over `t.light`, Veil +0.15 on the same envelope; error card rises `rise`; haptic `error` | `t.light` | C + A | 220 ms tint, card fades |
| M28 | Error card shake-free nudge | Error card appears | Card translateX 0 to -3 to 0 dp once, 160 ms (a nudge, not a shake loop) | `ease.inOut` | A | none |
| M29 | Jump-to-bottom pill | Scrolled up more than one screen | Pill rises `rise*4` on `spring.snap`; unread count digit swaps with a 6 dp vertical roll (two Text layers, translateY + opacity) | `spring.snap` | A | fade |

### 5.5 The composer

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M30 | Kindle | Focus | Existing lens kindle, retimed to `t.stage` `ease.out`; lit top edge opacity 0.5 to 1 | `t.stage` | A | instant |
| M31 | Keystroke shimmer | Typing | Existing 70/560 ms shimmer, throttled to one start per 250 ms | existing | A | off |
| M32 | Send morph | Text goes from empty to non-empty | Mic icon opacity/scale out (0.8), send arrow in from scale 0.8 + rotate -45 to 0 deg | `spring.snap` | A | crossfade |
| M33 | Voice hold | Press and hold mic | Existing listening breath, locked to the clock; a Glint ring around the button grows with input level | `t.breath` | A + B | static ring |
| M34 | Attachment add | File picked | Thumbnail chip rises from the paperclip, scale 0.6 to 1 on `spring.snap`; composer row grows by layout (snap) | `spring.snap` | A | appears |
| M35 | Attachment remove | Tap x | Chip scale to 0.6, opacity 0, `t.ui*0.75`; siblings close the gap by layout snap | `t.ui` | A | disappears |
| M36 | Slash palette | Type "/" | Palette rows rise `rise` on `stagger` (max 6); highlighted row fill tracks selection with translateY on `spring.snap` | `stagger` | A | instant |

### 5.6 Lists and drawers

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M37 | List first paint | A list screen mounts | First 6 visible rows rise on `stagger`; rows 7+ and any row mounted by scrolling never animate | `stagger`, `t.ui` | A | none |
| M38 | Drawer follow | Drag drawer | Drawer translateX tracks the finger 1:1 (gesture-handler worklet); content behind scale 1 to 0.97, opacity to 0.7; release on `spring.snap` with velocity | `spring.snap` | A | release without spring, 150 ms |
| M39 | Swipe row action | Swipe a row | Row translateX follows finger; action icon scale 0.6 to 1 as it is revealed (interpolated, clamped); past threshold a haptic `selection` once | gesture | A | same, no scale |
| M40 | Row delete | Confirmed delete | Row opacity to 0 and translateX -24 dp, `t.ui*0.75`; list closes the gap by layout snap | `t.ui` | A | fade |

### 5.7 Sheets and menus

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M41 | Sheet open | Open any sheet | Existing BaseSheet translateY, retimed to `t.stage` `ease.out`; scrim opacity 0 to 0.5; content rows rise on `stagger` (max 6) after 120 ms | `t.stage` | A | slide kept at 200 ms, no stagger |
| M42 | Sheet dismiss | Swipe or tap scrim | translateY follows finger (existing), release with `spring.snap` or `t.ui` timing | `spring.snap` | A | 150 ms |
| M43 | Menu pop | Long-press a message | Menu scale 0.92 to 1 + opacity, origin at the touch point (transformOrigin), `spring.snap`; the pressed bubble holds at `press` scale while the menu is open; the rest of the thread opacity 0.6 | `spring.snap` | A | fade |
| M44 | Modal lift | Confirm dialog | Modal scale 0.96 to 1, opacity; shadow is static (never animated) | `t.ui` | A | fade |

### 5.8 Buttons, toggles, press

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M45 | Press | Any pressable | `press` | `press` | A | opacity 0.85 instead of scale |
| M46 | Touch ripple | Press on a raised or base surface | Glint moves to the touch point; one ring, radius 14 to 134 dp on `easeOutCubic`, opacity 0.16 to 0 over 750 ms (the lab's ripple) | 750 ms | B | none |
| M47 | Toggle | Switch flip | Knob translateX on `spring.snap`; track fill crossfade (two stacked fills, opacity); knob scale 1.1 mid-travel via interpolate | `spring.snap` | A | jumps |
| M48 | Sheen sweep | Reply done, success moments | A 1 dp x 80 dp linear-gradient highlight (static `experimental_backgroundImage`) translateX across a surface's top edge, 700 ms `ease.inOut` | 700 ms | A (D: gradient support, see D4) | none |

### 5.9 Empty, loading, skeleton

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M49 | Skeleton light sweep | Loading | Skeleton blocks are static; one gradient band translateX across the whole group on the breath clock (one band, not one per block) | `t.breath` | A (D4) | static blocks |
| M50 | Empty state lamp | Empty thread / roster | The empty-state glyph floats ±3 dp on the breath clock; the field layer translates toward the finger while it drags on the empty area (max 10 dp) | `t.breath` | A | static |
| M51 | Content replaces skeleton | Data arrives | Skeleton opacity to 0 and real rows rise on `stagger`, crossfaded in the same 200 ms | `t.ui` | A | instant |

### 5.10 Voice call

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M52 | Call open | Start call | S5 pool expansion | `t.stage` | A | crossfade |
| M53 | Connecting | Dialling | Orb opacity on the breath clock, at double rate (half `t.breath`), Veil at 0.368 (reaching level) | `t.breath/2` | A | static, dim |
| M54 | Listening | User speaks | S5 lean | tau 90 | A | none |
| M55 | Speaking | Bot speaks | S5 rings + Veil pulse | level-driven | B + A | orb opacity only |
| M56 | Mute | Mute toggle | S5 mute | `t.ui` | A | instant |
| M57 | Call end | Hang up | S5 reverse | `t.stage` | A | crossfade |

### 5.11 Gate connection

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M58 | Gate lost | Connection drops | Veil to 0.702 on tau 800 (existing `connectionTau`); lit edges fade to 30%; the status dot stays the signal | tau 800 | A | 200 ms fade |
| M59 | Reaching | Reconnecting | Veil at 0.368; status dot on the breath clock | `t.breath` | A | static |
| M60 | Relight | Connection restored | Veil back to 0.123 on tau 800, lamp hairline (M3) re-runs, lit edges back; haptic `light` | tau 800 | A | 200 ms fade |
| M61 | Queued message wait | Message sent while offline | Bubble at opacity 0.6 with a static clock glyph; on relight it rises to 1.0 with the swell (M14) | `t.ui` | A | opacity only |

### 5.12 Success and completion

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M62 | Run complete | Long agent run (over 30 s) finishes | Sheen sweep on the run card (M48); crest wink (M65); haptic `success` | 700 ms | A | haptic only |
| M63 | Saved / copied | Copy, save, pin | Icon swaps to a check: scale 0.6 to 1 on `spring.snap`, reverts after 1200 ms | `spring.snap` | A | swap |
| M64 | Pairing success | Gate paired | Lamp hairline (M3) + Veil 0.4 to 0.123 over `t.light` + one Glint ring from the pairing glyph | `t.light` | A + B | fade |

### 5.13 Delightful micro-moments

| # | Name | Trigger | What moves | Token | Cost | RM |
|---|---|---|---|---|---|---|
| M65 | Crest wink | A Bot finishes a long run, or is mentioned by name | Crest scale 1 to 1.06 to 1 on `spring.settle`; a sheen crosses it | `spring.settle` | A | none |
| M66 | Lamp on a string | Overscroll at the top of a thread | Field layer translateY follows overscroll (max 10 dp) and springs back with `spring.snap` | `spring.snap` | A | none |
| M67 | Lamp click | Pull-to-refresh passes threshold | Veil blinks +0.08 for 2 frames then back over `t.ui`; haptic `selection` | 2 frames | A | haptic only |
| M68 | Tilt glint | Phone tipped while the empty state shows | Field layer follows the existing gravity maths (max 10 dp); the crest sheen offset follows the same shared value | sensor 33 ms | A | off |
| M69 | Night lamp | Local time after 23:00 | Resting Veil 0.123 to 0.2: the room is a little dimmer at night (set at route mount, not animated in place) | static | A | same |
| M70 | Bot greeting | First message to a newly created Bot | The Bot's crest drops in from -24 dp on `spring.settle` above the empty thread, then fades into the header slot | `spring.settle` | A | fade |

Count: 70 entries (signature moments counted inside M1, M10, M13-14, M25-26, M52-57).
By cost class: A only 61, B (alone or with A) 4 (M33, M46, M55, M64), C (alone or with A) 5
(M6, M10, M25, M26, M27). Of the A entries, 5 are D-gated (M4 route transition, M22 smooth
push-down, M24 JS cost of pinned follow, M48/M49 gradient support); each has an A fallback
written above.

---

## 6. Choreography rules

1. **Light leads, UI follows.** For any event with both, the field or Veil starts at t = 0 and the
   UI starts 60 to 140 ms later. The eye reads the light as the cause.
2. **One owner of the room.** Failure > approval > work > speaking. The strongest owns the hue;
   weaker ones may only move the Veil. A new reaction replaces, never queues or stacks (decided).
3. **One hero per event.** Each event has exactly one signature element (the swell, the crest, the
   card). Everything else in that event uses `t.ui` and `rise`, never `spring.settle`.
4. **`spring.settle` is rationed.** Only S2's crest, S4's card, S5's orb, M65 and M70 use it.
   Everything else is clamped. If two settle springs would run at once, the second uses `spring.snap`.
5. **One heartbeat.** Everything that breathes uses the shared clock, in phase. No other infinite
   loop is allowed in the app.
6. **Vertical only for content.** Messages, cards and sheets move vertically (existing lock).
   Horizontal motion is reserved for things the finger drags (drawer, swipe rows) and indicators.
7. **Anchors.** Things appear from where they came from: the bubble from the composer, the
   approval chip from the card's corner, the menu from the touch point, the call pool from the voice
   button, the thinking orb hands off to the reply's first line. No element appears from nowhere if
   it has an origin on screen.
8. **Stagger caps.** Max 6 staggered items, max 240 ms total. Rows mounted by scrolling never animate.
9. **Exits are faster than entrances** (`t.ui * 0.75`) and never use springs.
10. **Stillness is the default.** With nothing happening, only the 24/s field drift moves. It does
    NOT sleep after 40 s idle (Ethan, 2026-11-07: he wants the continuous drift; the governor is the
    safety valve instead of an idle timer). A screen with no event in flight should show zero
    running Reanimated animations.
11. **Text never moves on its own.** Text fades or rises as part of its container. No per-word or
    per-character motion, ever, including streaming.
12. **Haptics ride the beat.** One haptic per event, on the beat the hero element starts. Haptics are
    JS calls: from a worklet, hop with `scheduleOnRN` (react-native-worklets 0.10.1); never call
    `haptics.*` inside a worklet directly.

Carnival test (apply before merging any new motion): at any moment, can the user name the one thing
that is happening? If two heroes, one loop out of phase, or motion with no event behind it is on
screen, cut it.

---

## 7. Cost budget

### 7.1 Caps

| Resource | Cap |
|---|---|
| Field reactions (hue redraw) in flight | 1 (decided), max `t.light` long |
| Running A animations per screen | 8 at once, of which at most 1 is a loop (the breath clock) |
| Glint canvases | 1 per screen, at most 280 x 280 dp, at most 3 shapes |
| Glint shapes | ripple 1, call rings 3, pairing ring 1; never more than 3 total |
| `spring.settle` in flight | 1 |
| Staggered items | 6 |
| Layout animations (`entering`/`exiting`) in flight | 2 (newest message + one card) |
| Gradient Views (`experimental_backgroundImage`) on screen | 3 (swell, sheen, skeleton band) |
| Per-frame allocations in worklets | 0: style worklets return fixed-shape objects, no array building in loops |

### 7.2 During scroll

While the transcript or any list is being dragged or flung (`onBeginDrag` to momentum end, tracked
in a UI-thread shared value):
- Field drift clock holds (no new field frames); parallax continues as a field-layer transform.
- Breath clock pauses where it is.
- Glint ripples are suppressed (press feedback stays as `press`).
- No new `entering` animations; rows mounted by scroll never animate anyway.
- Field hue reactions that arrive during a scroll still run (they are events), but the Veil-only
  ones (tool breath) hold.

### 7.3 During streaming

- Field drift holds for the whole stream (perf plan P5). The Veil speaking glow is the only
  light motion.
- No per-token animation; the caret dot rides the breath clock.
- Pinned follow is coalesced to at most 10 per second and never animated.
- Tool cards that start during a stream rise; their expansion is user-driven only.

### 7.4 Governor degradation order (motion)

The governor steps field 24/s to 12/s to smaller field to rest (decided). Motion steps down with it.
Each step includes everything above it.

| Governor step | Motion removed or thinned |
|---|---|
| 0. Field 24/s | Full language |
| 1. Field 12/s | (a) Glint touch ripples off; (b) tilt sensor unmounted (M68 off); (c) stagger caps at 3 items; (d) keystroke shimmer off |
| 2. Smaller field | (e) breath clock stops: tool Veil breath, skeleton sweep, card-edge breath go static; (f) swell becomes opacity only (no translate/scale); (g) call rings 3 to 1; (h) sheen sweeps off; (i) `spring.settle` becomes `spring.snap` |
| 3. Rest | (j) all field hue reactions become 220 ms reduced-motion tints; (k) every entry falls to its RM variant except: press, sheet and drawer follow, toggles, pinned follow, and the call orb's level opacity (these are functional feedback) |

The governor's step signal must reach motion code as a shared value so worklets can read it.

---

## 8. Verification on the A54

### 8.1 How each cost class is measured

Package `com.versutus.app`, release build (memory: Android release build + Taildrop), device on
adb, display at its default refresh mode. Each scenario runs 10 s, 3 repeats.

- **Frames and jank:** `adb shell dumpsys gfxinfo com.versutus.app reset`, run the scenario, then
  `adb shell dumpsys gfxinfo com.versutus.app framestats`. Read total frames, janky %, and the 90th/95th
  percentile frame times.
- **Threads:** Perfetto, `adb shell perfetto -o /data/misc/perfetto-traces/trace -t 10s sched freq gfx view`,
  then inspect UI thread, RenderThread and the Reanimated/JS thread slices.
- **Memory:** `adb shell dumpsys meminfo com.versutus.app` before and after each scenario, plus
  free RAM from `adb shell cat /proc/meminfo` (the phone has about 80-100 MB free).
- **JS thread:** React DevTools profiler on a dev build, plus the Perf Monitor's JS FPS (the perf
  plan's method), only to attribute; pass/fail is on the release build.

| Class | Isolation scenario |
|---|---|
| A | Field and Veil frozen; run the class in a loop (e.g. 8 concurrent A animations on the chat screen) |
| B | Field frozen; Glint ripple every 400 ms for 10 s; then call rings with a synthetic level |
| C | One field hue reaction every 1.5 s for 10 s (Bot switch back and forth) |
| Veil | Field at 24/s; Veil breath running; compare with Veil static |
| D | Each D item gets its own A/B comparison against its written fallback |

### 8.2 Interactions that must be profiled

1. Transcript scroll, slow drag and hard fling, 200-message thread.
2. Drawer open/close by drag, 5 times.
3. Streaming a long reply while pinned (the perf plan's thresholds apply).
4. Streaming plus one tool card expand mid-stream.
5. Bot switch (S2) 5 times.
6. Send (S3) 5 times in a row.
7. Approval arrive and resolve (S4).
8. Voice call 10 s with the Bot speaking (S5).
9. Launch (S1), cold.
10. Each of 1 to 8 again with the governor forced to step 1 and step 2.

### 8.3 Pass/fail

| Metric | Pass |
|---|---|
| Frames in budget (60 fps target) | at least 95% |
| Dropped frames per scenario | 0 |
| Janky % (gfxinfo) during 1 to 8 | under 5% |
| UI-thread frame p95 | under 16.7 ms |
| Field redraw window per hue reaction | at most `t.light` + 1 frame (count Skia draws) |
| Idle screen (no event) | 0 running Reanimated animations, field at drift rate or resting |
| Memory added by Glint + Veil + oversize field | under 8 MB total (measured, not estimated) |
| Touch to press feedback | under 100 ms |

Any scenario that fails moves its contributors down the degradation order permanently, not just
under the governor.

### 8.4 UNVERIFIED (assumed, not measured)

- Nothing in this draft has been run on the A54. All costs are by construction only.
- The 1/2-size field's own cost on the phone (decided engine, prototype unmeasured).
- Interaction cost: scroll, drawer, streaming and voice have never been measured; only idle was.
- That a full-screen alpha View (the Veil) over a Skia canvas costs about nothing on the A54's
  RenderThread, and that it looks close enough to the linear-light gain (section 2.2).
- That one Skia canvas of 280 x 280 dp is cheap in GPU and memory, and that moving it by transform
  does not recreate its surface.
- That `experimental_backgroundImage` gradients render correctly and cheaply on Android in RN 0.86.3
  (the type exists in `StyleSheetTypes.d.ts`; behaviour, cost and the `experimental_` stability are
  unknown).
- That a field layer drawn about 3% oversize and translated costs no extra redraws.
- That Reanimated `entering` on the newest FlatList cell is cheap with `removeClippedSubviews` on.
- Whether the A54 renders at 120 Hz while Reanimated animations run, which would double frame
  production for every A animation. The bar is 60 fps; capping refresh rate needs native code (D7).
- docs.expo.dev v57 pages were not read for this draft; APIs were checked against installed
  type definitions only.
- `useScrollOffset` was confirmed in the hook exports; its behaviour with the existing JS
  `onScroll` handler on the same FlatList was not checked.

---

## 9. Decisions for Ethan

| # | Decision | Kind |
|---|---|---|
| D1 | Amend the visual-direction motion lock: keep 150-250 ms for touch, allow 420 ms structural moves, 600 ms light, 2400 ms breath, and one rationed spring with about 1% overshoot (`spring.settle`) | Taste |
| D2 | Replace the 2.1 s field swell, the 2.4 s field warm-up, and the uniform-driven parallax/tilt with layer versions (Veil, swell View, field-layer transform). Shortens room change from 1600 to 600 ms | Taste + measurement |
| D3 | DECIDED (Ethan, 2026-11-07): adopt the Veil for all brightness reactions. Ethan judges its brightness against the true gain curve on the first device build; if it reads wrong, tune the Veil's opacity mapping, do not drop the Veil | Decided, verify at first build |
| D4 | Use RN's `experimental_backgroundImage` gradients (no new dependency) for swell, sheen and skeleton band, or draw them in the Glint instead. Adding `expo-linear-gradient` would be a new native dependency | Measurement, possibly dependency |
| D5 | Smooth push-down when a tool card expands: either Reanimated `itemLayoutAnimation` on the list (exists in the installed `FlatList` types, cost unknown) or accept the snapped layout with a content fade (default in this draft) | Measurement |
| D6 | Route transitions: what the router's native stack allows for a vertical fade-rise push versus the platform default; a JS-driven custom stack transition would be a cost risk | Measurement |
| D7 | Whether to cap the app's refresh rate to 60 Hz on Android (native code, `Surface.setFrameRate` or a display-mode preference) so every animation costs half the frames on the A54 | New native code |
| D8 | Night lamp (M69) and Lamp on a string (M66) are taste calls; cut either if they feel cute | Taste |
| D10 | Sections 7.2 and 7.3 hold the field drift during scroll and for a whole stream. That is a guess at where the cost is, and it makes the light freeze exactly while the Bot is talking. Ethan loves the continuous drift, so default to NOT holding, measure scroll and streaming on the A54, and add the hold only if those scenarios fail the bar | Taste + measurement |
| D9 | Call open covers the chat with the pool (S5) versus keeping the chat visible with rings over the composer (the lab's version) | Taste |
