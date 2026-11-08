# Versutus ambient redesign: light, surfaces and motion (design)

Date: 2026-11-07. Status: design approved section by section in conversation; written spec awaiting review.
Companion: [`2026-11-07-motion-language-draft.md`](2026-11-07-motion-language-draft.md) holds the full motion
catalogue (70 entries), tokens, hero-moment timings and per-motion cost classes. This document is the
decision record and rollout; the draft is its motion appendix and wins on motion detail.

## 1. Why

Ethan reports low FPS and wants a visual performance boost and polish, while keeping the colour-changing
lamp lighting. Measured on the Galaxy A54 (release build, wireless adb, 2026-11-07):

- The ambient lamp shader is the only continuous render cost found. With it off: 0 frames rendered and
  RenderThread at 0%. With it on: 55 to 68% janky frames on a fresh screen.
- The shader runs 4 fbm calls x 4 octaves per pixel at full size, redrawn at 24 Hz, and the stage sleeps
  after about 40 s idle.
- Not measured: scroll, drawer, streaming and voice cost; JS-thread cost under interaction; the 1/2-size
  prototype on the phone. The phone is short on RAM (about 80 to 100 MB free).

## 2. Goals and bar

- Keep the colour-changing lamp that takes the active Bot's colour. The look of the real lamp is a
  must-keep (Ethan, 2026-11-07).
- Scope: lighting plus surfaces and motion. Feeling: alive, light that reacts to the conversation, agent
  work, the voice call, and touch and motion.
- Performance bar on the A54: at least 95% of frames in budget and zero dropped frames in every scenario
  in section 7. Continuous ambient drift stays (Ethan, 2026-11-07: he loves it), so it must be cheap.

## 3. Engine

1. **Field.** The real stage shader at 1/4 size (decided by Ethan 2026-11-08; the design started at 1/2), upscaled
   with the shader's own dither so dark gradients do not band. Default 24 draws per second, always on while the app is in front. The idle sleep is removed.
   It still stops when the app is backgrounded, the screen is off, or reduced motion is on.
2. **Two kinds of reaction.** *Field reactions* change hue or position (Bot switch, approval amber, failure
   red, gate lost and relit): the field redraws every frame for the transition only (about 0.6 s), then
   returns to 24 per second. *Layer reactions* change brightness or add a shape (send swell, speaking,
   tool breath, call pulse, touch ripple, parallax): they ride cheap layers at display rate and never
   redraw the field.
3. **Veil.** One full-screen ink layer whose opacity is a shared value. The field is rendered at its
   speaking level and the Veil rests at 0.123, so every brightness change is a single alpha change.
   Decided (D3): adopt the Veil. Ethan judges its brightness against the true gain curve on the first
   device build; if it reads wrong, tune the opacity mapping, do not drop the Veil.
4. **Layer stack, bottom to top:** field, Veil, surfaces and content, one small Skia layer (Glint) for
   ripples and rings, modals.
5. **Governor.** Watches dropped frames and steps down: 24 per second, 12 per second, a smaller field,
   rest. Steps up only after a long clean stretch. Starts at 12 under battery saver. Starting thresholds
   (step down after 3 drops in a 2 s window, step up after 20 s clean) are guesses to tune on the A54.
   Motion degrades in step with it (motion draft section 7.4).
6. **Priority.** Failure beats approval beats work beats speaking. The strongest owns the hue; weaker ones
   only move the Veil. A new reaction replaces and never queues or stacks.
7. **Unchanged.** Lamp colours, Bot light choreography and gain curves in `src/lib/stage/`.

## 4. Reactions

| Moment | Reaction | Kind |
|---|---|---|
| Send | Brief swell of light rising from the composer | Layer |
| Bot speaks | Slow brightening while text streams | Layer |
| Tool or agent work | Gentle breath of about 5% | Layer |
| Approval needed | Room eases to amber and holds until answered | Field |
| Failure | Quick red dip, then back | Field |
| Bot or room switch | Crossfade to the new Bot's colour | Field |
| Gate lost or connected | Dims when lost, relights when connected | Field |
| Voice call | Level-driven pulse and rings | Layer |
| Touch | Ripple from the touch point | Layer |
| Scroll and tilt | Parallax drift as a transform of the field layer | Layer |

Reduced motion: short opacity fades, no ripples, rings or breathing, no ambient drift.
Amber and red are never the only signal.

## 5. Surfaces and motion

Full detail is in the motion draft. Decisions:

- No backdrop blur anywhere; no elevation shadows except modals. Tinted translucent fills (70 to 85%
  opaque) over the field. Depth comes from 1 px lit top edges in the room's light colour that follow the
  field's colour a beat behind it. Three surface levels (base, raised, overlay). Text contrast is fixed
  and never borrowed from the lamp.
- Animate only transform and opacity, as UI-thread worklets that call only worklets. 11 motion tokens.
  Max about 8 concurrent animations per screen, one loop (the shared breath clock), one Glint canvas.
- Five hero moments: First Light, Changing Rooms, Send and Answer, The Ask, The Call. 70 catalogue
  entries in total, 61 pure transform/opacity, 4 using the Glint, 5 using field reactions.
- Draft decisions taken: D3 adopt the Veil (above); the call pool is 40% opaque so the lamp stays visible
  during a call (Ethan, 2026-11-07).
- Assumed, to confirm at review: D1, the amendment of the visual-direction motion lock to allow 420 ms
  structural moves, 600 ms light moves, a 2400 ms breath, and one rationed spring with about 1% overshoot.
  Ethan said he likes the motions in the lab; he has not ruled on the amendment explicitly.
- The motion draft's D10: do not hold the field drift during scroll or streaming by default. Measure those
  scenarios and add a hold only if they fail the bar.

## 6. Reference prototypes

The lamp lab and the motion lab (built this session in the scratchpad) run the app's real shader and
curves in the browser and are the visual reference for this spec. They are tailnet-previewed only and not
yet in the repo; plan to commit them under `tools/light-lab/`. They are browser WebGL and DOM, not the
app's Skia path: they show look and choreography, not the app's frame cost.

## 7. Verification

- Release build on the A54 over wireless adb, `dumpsys gfxinfo` and per-thread CPU as in the baseline,
  turned into a repeatable harness at `scripts/perf/` with results recorded in `docs/perf/`.
- Scenarios, 3 runs of 10 s each: transcript scroll (slow and fling, 200 messages), drawer drag, streaming
  a long reply, streaming plus a tool-card expand, Bot switch, send, approval, a 10 s call, cold launch;
  each again with the governor forced down one and two steps.
- Pass: at least 95% of frames in budget; zero dropped frames; janky frames under 5%; UI-thread p95 under
  16.7 ms; touch to press feedback under 100 ms; the new layers add under 8 MB; an idle screen runs zero
  Reanimated animations apart from the 24-per-second drift.
- The A54 has a 120 Hz display. Judge the 16.7 ms budget and record the refresh rate every run. Build the
  native 60 Hz cap (D7) only if animations fail the bar because of it.
- CI keeps pure logic only: reaction curves, the governor state machine, and a test pinning the motion
  tokens and caps, alongside the existing worklets-call-worklets gate. Device performance is a manual
  release gate. A failing scenario moves its contributors down the degradation order permanently.

## 8. Rollout

| Phase | Lands | Visible change | Gate |
|---|---|---|---|
| 0 | `scripts/perf/` harness and a baseline of today's build including scroll, drawer, streaming | None | Runs repeatably |
| 1 | 1/2-size field with dither, 24 per second, governor, no idle sleep | Almost none | Frame bar; idle cost recorded |
| 2 | Veil, shared breath clock, layer versions of swell, warm-up and parallax | Subtle | Frame bar; Ethan judges brightness (D3) |
| 3 | Motion tokens, unified press/enter/exit, surface rules | UI settles into one language | Frame bar |
| 4 | Hero moments in order: Send and Answer, The Ask, Changing Rooms, The Call, First Light | Large | Each passes before the next |
| 5 | Remaining catalogue by area | Polish | Frame bar per group |

Phases 3 to 5 sit behind one developer setting, "New motion," off by default; it flips on by default after
phase 4 is done and measured. Phases 1 and 2 ship straight through because they change cost, not feel.
Each phase is its own commit series and can be reverted alone. Each becomes a Versutus backlog item with a
measurable check; workers implement in worktrees and a reviewer from a different model family lands them.
Phone builds merge every in-flight branch so Ethan tests everything in one pass. Nothing deploys or
releases without Ethan's "ship."

## 9. Unverified

- Nothing here has been run in the app. The 1/2-size field, the Veil, the Glint and the gradient layers
  are unmeasured on the A54.
- Interaction cost (scroll, drawer, streaming, voice) has never been measured; only the idle and ambient
  shader cost was.
- That Reanimated's frame callback gives timestamps good enough for the governor to detect drops.
- Whether the A54 renders at 120 Hz during animations, doubling frame production per animation.
- That `experimental_backgroundImage` gradients render correctly and cheaply on Android in RN 0.86.3.
- Why the stage slept at about 57 s instead of 40 s, and the 314 MB graphics-memory difference seen
  between builds in the A/B runs.
- The Expo v57 docs pages were not read for the motion draft; APIs were checked against installed type
  definitions only. Re-check before implementation.

## 10. Decisions still with Ethan

- D1 (above): confirm the motion-lock amendment.
- D4 gradients via `experimental_backgroundImage` (no new dependency) versus drawing them in the Glint;
  D5 smooth push-down on tool-card expand; D6 route-transition style the router allows; D7 the native
  60 Hz cap; D8 night lamp and lamp-on-a-string touches; D9 the call pool covers the chat or not. These are
  measurement or taste calls for the phases that reach them; none blocks phases 0 to 2.

## 11. Outcome (2026-11-08)

Built and merged on the local `ambient-redesign` branch (not on master, not pushed): the perf harness (`scripts/perf/`),
the governor, the render-scale module, the Veil, the swell layer, the breath clock and the `working` signal. The full
gate is green (868 Jest suites, 8,660 tests, 2,336 gate tests) before the 1/4 default below.

Measured on the A54 (`docs/perf/README.md`, raw runs under `docs/perf/raw/`): the shipping build had 0% of frames
inside 16 ms in every scenario; phase 1 (half-size field, governor) reached about 62-82% at idle and 64-72% under
scroll, fling and drawer. Phase 2 (the Veil and layers) did not improve on phase 1. A bisect showed the Veil, the Glint
canvas and the wrapper transform are not the cost: the shader draw is (each draw about 30 ms of GPU when the inputs
change only on the 24 Hz clock), and the idle metric is flattered by tilt-driven input changes.

**Decision (Ethan, 2026-11-08): the default field size is 1/4, the shader is not changed, and nothing further is
measured.** The 1/4 default is therefore UNMEASURED on the device, and the bar in section 2 (at least 95% of frames in
budget) has not been met or shown to be met. The governor's rungs are now 24 Hz at 1/4, 12 Hz at 1/4, 12 Hz at 1/5, rest.

Not done: phases 3-5 (tokens and surfaces, the five hero moments, the rest of the catalogue), measurement of streaming,
send, tool-card expand and the call (needs a paired Gate), cheaper shader work (baked noise, fewer noise passes),
dither-banding check at 1/4, the native 60 Hz cap (D7), battery-saver start level. The motion draft is unchanged.

