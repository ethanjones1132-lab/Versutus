# Rendering performance (low FPS and latency) - investigation draft and plan

Status: **draft for human review. Source-only investigation. Nothing reproduced, nothing measured.**
Worktree: `C:\rh-wt\20261101-0050-versutus-vs-overnight-20261101-ha`, author: one unattended Ralph
iteration (`performance_diagnosis`), one pass, no device, no profiler, no live Gate, no network call,
no credentials.

Labels used throughout:

- **[SOURCE]** - read in this worktree at the cited `file:line`; a statement about code, not about a
  running system.
- **[INFERENCE]** - a conclusion drawn from two or more [SOURCE] facts, plus any stated arithmetic.
  Still not a measurement of this app on any device.
- **[HYPOTHESIS]** - plausible cause; becomes fact only with the measurement named beside it.
- **[UNVERIFIED]** - a claim from the report, or something this tree cannot confirm.
- **[NOT RUN]** - a check a human must run; I ran none of them and claim no result.

> This document deliberately does **not** assert a cause, a frame rate, a render duration or a
> device model. The Step check is `grep -q Evidence docs/plans/overnight-performance.md`; that
> proves the word appears and nothing else. A human must read the diff, run the full
> `npm run verify`, and run the measurements in section 4 on a real device before any fix is
> trusted.

---

## 1. The request as received

> "low FPS and latency are reported. Trace rerender, markdown parsing, animated graphics and list
> paths. Propose JS vs UI-thread profiling and practical thresholds. Do not assert cause or
> measured performance."

That sentence contains four claims that need four different instruments. They are not
interchangeable, and a fix for one is not evidence for another:

1. **Steady-state FPS while a reply streams** - a JS-thread question (how many React commits per
   second, and how long each takes). Section 4.2, experiments A and B.
2. **FPS/responsiveness while the operator scrolls** - a layout/raster and list-recycling question.
   Section 4.2, experiments C and F.
3. **Latency** - two unrelated numbers: touch-to-feedback (JS thread availability) and
   time-to-first-token (network + Gate + model). This draft can only speak to the first from
   source; the second has no app-side evidence in this tree at all.
4. **A single hitch at the end of a turn** - the streaming-to-settled transition. Section 4.2,
   experiment E.

Scope constraints, read strictly:

- **Preserve visuals.** The breathing orb (`src/components/chat/streaming-indicator.tsx:20-51`),
  the lamp stage (`src/components/layout/AmbientCanvas.native.tsx`,
  `src/components/layout/stage-gl.ts`), the transcript's spacing/motion presets and every markdown
  style below are treated as fixed design. No proposal here changes how anything looks.
- **No feature rewrites.** Every proposed step in section 5 is a bounded change to when work
  happens, never to what is drawn.
- **Out of scope:** the Activity screen diagnosis, the roster HTML failure, the chat streaming
  ordering/overlap draft, and the `fold_cache` event-fold work. Those are separate drafts in this
  same folder; two of them own paths this document touches only in passing.

---

## Evidence

Everything below is read from this worktree. Nothing below is a measurement.

### E1. Where transcript state lives, and who re-renders when it changes

**[SOURCE]**

- `src/context/gateway-provider.tsx:772-778` - `ChatSurfaceContextValue` is deliberately narrow:
  `{ messages, isSending, isCommandRunning }`.
- `src/context/gateway-provider.tsx:7890-7897` - the nested context value is memoised on exactly
  those three fields, so a streamed frame rebuilds it.
- `src/context/gateway-provider.tsx:7737` and `:7865-7887` - the outer `GatewayContext` value is a
  separate memo whose dependency list does **not** contain `messages` (it lists gateways, settings,
  both pickers, approvals, roster/group state, and so on). This split is real and working: a
  streamed frame does not re-render the tabs and screens that only read `useGateway()`.
- `src/components/chat/chat-screen.tsx:536` - `ChatScreen` reads `useChatSurface()`.
- `src/components/chat/chat-screen.tsx:540` - `ChatScreen` also reads `useHandsfreeVoice()`.

**[INFERENCE]** Every streamed frame re-renders `ChatScreen`, because `ChatScreen` is a direct
consumer of the context value that changes per frame. `__tests__/chat-surface-context-test.ts:42-69`
already pins this wiring, and the screen's own comment states the cost out loud at
`src/components/chat/chat-screen.tsx:1202-1205` ("This screen re-renders on every coalesced delta
batch"). The outer-context split bounds the blast radius; it does not remove this render.

### E2. The flush cadence is one state write per animation frame

**[SOURCE]**

- `src/lib/gateway/stream-batching.ts:64-69` - the default scheduler is `requestAnimationFrame`,
  with a `setTimeout(..., STREAM_BATCH_MS)` fallback where RAF is absent (Jest, node).
- `src/lib/gateway/stream-batching.ts:20` - `STREAM_BATCH_MS = 16`.
- `src/lib/gateway/stream-batching.ts:85-105` - one flush drains the buffer into **one**
  `setMessages` call, applying text, then reasoning, then each tool call.
- `src/lib/gateway/stream-batching.ts:107-121` - queueing is per delta; the first queued delta in a
  frame schedules the flush, later deltas in the same frame ride along.
- `src/context/gateway-provider.tsx:4472` - one batcher per turn; `:4512-4534` wires the three
  stream callbacks into it; `:4580-4582` flushes and finalises after the stream resolves.
- `src/lib/gateway/stream-batching.ts:138-140` - the batcher exposes `flushCount`, which nothing in
  `src/` reads. That is the cheapest honest rate metric already in the code.

**[INFERENCE]** The ceiling on state writes is one per display frame, i.e. up to ~60/s on a 60 Hz
device, and it is bounded only by how fast the Gate emits tokens. The comment at
`src/context/gateway-provider.tsx:4468-4471` describes "100 rapid chunks coalesce to ~1-2 renders";
that is the coalescing working, and it still leaves one commit per frame at a fast token rate.
`__tests__/gateway-stream-batching-test.ts:27-149` already proves the coalescing contract
(1 call for 100 deltas, separate calls across frames, cancel discards).

### E3. What one flush actually costs on the JS thread

**[SOURCE]** Each flush does all of the following inside `ChatScreen`'s render:

1. `src/lib/gateway/message-reducer.ts:153-167` - `appendStreamDelta` copies the message array
   (`[...messages]`) and replaces the streaming message with `{ ...copy[idx], text: ... }`, so the
   array identity and that one message's identity change; every other message keeps its identity.
   The same shape is used for reasoning (`:170-181`) and tools (`:184+`).
2. `src/lib/gateway/messages.ts:176-186` - the in-memory window is capped at
   `MESSAGE_WINDOW_CAP = 200`, so those copies are small (<=200 slots). The array copy itself is not
   the suspected cost; its identity change is what matters to React.
3. `src/components/chat/chat-screen.tsx:2529-2538` - `transcriptItems` is a `useMemo` over
   `[messages]` that maps **every** message to a new `{ message, label, showDivider }` object, so
   every item identity changes on every flush. Both `formatDayDividerCached` calls per message are
   already cached per calendar day (`src/lib/format.ts:64-91`).
4. `src/components/chat/chat-screen.tsx:2540-2556` - `renderMessage` is a stable `useCallback` that
   returns a fragment `{divider}` + `<MessageBubble message={item.message} .../>`.
5. `src/components/chat/chat-screen.tsx:3077-3095` - the FlatList is fed `data={transcriptItems}`,
   an inline `keyExtractor`, `removeClippedSubviews`, `initialNumToRender={12}`,
   `maxToRenderPerBatch={16}`, `windowSize={9}`.

**[INFERENCE]** Per flush: one `ChatScreen` function call whose body is 2,919 lines
(`:453-3371`) holding 18 `useMemo`, 47 `useCallback`, 31 `useEffect` and ~50 `useState` calls, the
whole JSX tree for header/transcript/composer/sheets rebuilt, a fresh `transcriptItems` array holding
a new object per message in the window, a FlatList data-identity change (full key diff), and a
`renderMessage` call for every
mounted cell. `MessageBubble`'s memo (`src/components/chat/message-bubble.tsx:41`) then stops the
deep work in all but the streaming bubble - see E5 - so what is paid per frame is the wrapper work,
not the bubble subtrees.

### E4. The list also does native work on every flush

**[SOURCE]**

- `src/components/chat/chat-screen.tsx:1824-1833` - `onContentSizeChange` calls
  `listRef.current?.scrollToEnd({ animated: !isStreaming })` whenever the transcript is pinned. The
  comment explains why it is unanimated while streaming (an animated scroll restarted dozens of
  times a second twitched), but it still issues a scroll per content-size change, i.e. per flush
  while the reply grows.
- `src/components/chat/chat-screen.tsx:3086-3087` - `onScroll={handleScroll}` with
  `scrollEventThrottle={16}`; `:1811-1822` folds the scroll event into two refs and a
  `setJumpVisible` that flips only on a threshold crossing.
- `src/components/chat/chat-screen.tsx:1017` - `useAmbientParallaxScroll()`; `:2581` passes its
  `parallaxY` into `<Screen>`.
- `src/lib/motion/ambient-parallax.ts:14-26` - the hook `setState`s only when the mapped Y moves by
  >= 0.04, i.e. roughly every 19 px of scroll (480 px maps to 0..1). Scrolling therefore re-renders
  `ChatScreen` several times per fling, on top of stream flushes.

**[INFERENCE]** Two independent native-pipeline costs sit on the per-flush path: a requested scroll
(which implies layout of the growing content) and, for any scroll the OS reports back, a possible
parallax `setState` that re-enters the same 2,919-line render. Whether `scrollToEnd` actually
produces `onScroll` events on each platform is **not** established here and is experiment C in
section 4.2.

### E5. What does *not* re-render per frame (negative findings, stated so nobody "fixes" them)

**[SOURCE]**

- `src/components/chat/message-bubble.tsx:41` - `MessageBubble` is `memo`'d on its props.
  `message` is the only per-frame-changing prop for the streaming row; the four callbacks passed by
  `renderMessage` (`:2540-2556`) are stable.
- `src/components/chat/chat-header.tsx:213`, `src/components/chat/chat-composer.tsx:107`,
  `src/components/chat/chat-roster.tsx:570` - header, composer and roster are all `memo`'d, and the
  `ChatComposer` prop list at `src/components/chat/chat-screen.tsx:3181-3213` is built from stable
  `useCallback`s plus `useMemo`ed arrays, so they should skip the per-frame render. This is worth
  re-checking with the section 4.1 item 2 render counters rather than trusting by inspection.
- `src/components/chat/streaming-indicator.tsx:24-37` - the orb animates with Reanimated
  `withRepeat`/`withTiming` on shared values, i.e. on the UI thread; the component does not set React
  state per frame. It must stay that way.
- `src/components/chat/message-bubble.tsx:80-85` - the entering animation is `entering.rise` on mount
  only, and is disabled on web.

**[INFERENCE]** The steady-state cost is therefore concentrated in the screen-level render and the
list diff, not in bubble internals. A first fix that memoises `MessageBubble` harder, or replaces the
orb with an `Animated` JS-driver loop, would be wasted work or a regression.

### E6. Markdown parsing is not on the per-token path today

**[SOURCE]**

- `src/components/chat/markdown/parser.ts:359-370` - `markdownBlocksForDisplay(text, streaming)`
  returns a single plain paragraph (`[{ type: 'paragraph', spans: [{ text }] }]`) while streaming,
  and only calls `parseMarkdown` once streaming is false.
- `src/components/chat/markdown/parser.ts:246-357` - `parseMarkdown` normalises newlines, splits into
  lines, then runs the fence/heading/hr/quote/list/paragraph state machine with `parseInline` per
  block.
- `src/components/chat/markdown/markdown-text.tsx:135` - `useMemo(() => markdownBlocksForDisplay(text,
  streaming), [text, streaming])`; the block tree is memoised on text **and** streaming.
- `src/components/chat/message-bubble.tsx:211,217` - the body is a `MarkdownText` with
  `streaming={!!message.streaming}`.
- `src/components/chat/markdown/code-block.tsx:16-78` - fenced code renders as one `selectable`
  monospace `RNText` inside a horizontal `ScrollView`; there is no syntax highlighter, so a code
  block is one text node.

**[INFERENCE]** The reported "markdown parsing" cost cannot be a per-token cost in this code: while
streaming, the parser is short-circuited to a single span, and the memo is keyed on text so a
re-render without a text change does not re-parse. Parsing runs **once** at the streaming -> settled
transition (both `text` and `streaming` change), and **once per cell mount**. That makes markdown a
candidate for the *end-of-turn hitch* (H4) and for *scroll re-mount* cost (H7), not for steady-state
FPS.

### E7. The stage shader is awake, and therefore drawing, during normal chat use

**[SOURCE]**

- `src/components/ui/Screen.tsx:14` - `ambient` defaults to `true`; `:24` an `onTouchStart` on the
  screen root calls `signalTouched()`; `:25` mounts `<AmbientCanvas>`.
- `src/components/chat/chat-screen.tsx:2581` - `ChatScreen`'s `<Screen>` does not pass `ambient`, so
  the stage is mounted on the chat screen with its default.
- `src/lib/stage/signals.ts:69-76` - `signalTouched` notifies at most once a second.
- `src/components/layout/AmbientCanvas.native.tsx:158-197` - each stage-signal notification re-arms
  an idle timer of `STAGE_TIMING.idleAfterMs` (40 s), so any touch, send, or connection change
  restarts the awake window.
- `src/components/layout/AmbientCanvas.native.tsx:199-212` - `running = focused && !reduced &&
  awake`; only then is the `useFrameCallback` clock active. `:214-233` derives the uniforms;
  `:243-247` draws a full-screen Skia `<Canvas>` with the runtime effect.
- `src/lib/stage/choreography.ts:35-39` - `scrollTau: 240` (the scroll parallax eases over
  `scrollTau * 2` = 480 ms, `AmbientCanvas.native.tsx:154-156`), `idleAfterMs: 40_000`, and
  `driftFrameMs: 1000 / 24` (the air clock is handed to the shader ~24 times a second).
- `src/components/layout/AmbientCanvas.native.tsx:130-156,171-188` - every ease (`withTiming`) writes
  a shared value that the uniforms derive from: lamp-on (2400 ms), room tint (1600 ms), send swell
  (2100 ms), scroll parallax (480 ms), speaking and connection settles. While any ease is running the
  uniforms change on every UI frame, so the Canvas redraws per frame for its duration; between eases
  the ~24 fps drift rate is the only source of change.
- `src/components/layout/AmbientCanvas.native.tsx:70-97` - while running, a gravity sensor at a
  33 ms interval feeds `tiltX`/`tiltY`, which are uniforms, so tilt motion alone schedules redraws.
- Web equivalent: `src/components/layout/stage-gl.ts:160-187` - one shared rAF loop draws every
  visible stage when `entry.dirty || step.animating || step.drifting` at the same
  `driftFrameMs - 1` spacing, and `:202-208` resets the idle clock on capture-phase
  `pointerdown/keydown/wheel/touchstart/scroll`. `:30` caps web render resolution at
  `MAX_PIXELS = 1_300_000`; the native path has no equivalent cap
  (`AmbientCanvas.native.tsx:214-232` passes the layout size and the device `pixelRatio`).

**[INFERENCE]** During a chat session the operator touches the screen constantly and scrolls the
transcript, so `awake` is effectively always true: the stage is drawing at ~24 fps of drift, at 60
fps through every ease, and it is drawing *behind* the transcript the whole time. The parallax ease
adds a 480 ms animating tail after every scroll step. This is by design ("the room reacts"), not a
bug; whether it costs frame time is a GPU question and must be measured, not assumed.

### E8. Derived per-fragment work of the stage shader (arithmetic, not a measurement)

**[SOURCE]** `src/lib/stage/shader.ts`:

- `:56-60` `hash12`; `:62-71` `vnoise` (4 `hash12` per call); `:73-82` `fbm` (4 `vnoise` per call).
- `:118-165` `shade()` calls `fbm` **four** times (the two warp components at `:127`, the air at
  `:128`, the wisps at `:132`), `shafts` at `:139` (2 `vnoise`), `motes` at `:159` (2 layers x 3
  `hash12`), and `finish` at `:177-182` adds 2 more `hash12`.

**[INFERENCE]** Counting by hand: 4 `fbm` x 4 `vnoise` x 4 `hash12` = 64, plus 8 from `shafts`, 6
from `motes`, 2 from `finish` = **~80 `hash12` evaluations per fragment**, plus one `exp` for the
exposure curve, one for the swell falloff, one per motes layer, and a vector `pow` in the sRGB curve
(`:170-174`). With the stated assumption of a 1080 x 2400 device surface (~2.6 M fragments) that is
~2.1 x 10^8 `hash12` per drawn frame; at the 24 drawn frames/s of cruise, ~5 x 10^9/s. These are
arithmetic consequences of the source and an assumed screen size - **not** a timing of any GPU. They
are included only so the measurement in section 4 has a concrete thing to confirm or refute.

### E9. The handsfree provider fans a fresh context value out per frame

**[SOURCE]**

- `src/app/_layout.tsx:622-624` - `HandsfreeVoiceProvider` sits between the gateway provider and the
  font/theme/Stack subtree.
- `src/context/handsfree-voice-provider.tsx:285` - it subscribes to `useChatSurface()`, so it
  re-renders on every streamed frame.
- `src/context/handsfree-voice-provider.tsx:1540-1574` - its context value is a **fresh object
  literal**, not a `useMemo`. Every consumer of `useHandsfreeVoice()` therefore re-renders whenever
  the provider does.
- `src/context/handsfree-voice-provider.tsx:356-390` - a dependency-less `useEffect` rebuilds a
  `latest` object every render (intentional for staleness, per its comment).
- Consumers: `src/components/chat/chat-screen.tsx:540`,
  `src/components/voice/handsfree-call-banner.tsx:32,39`
  (mounted at `src/app/_layout.tsx:740`; it returns `null` when no call is active, `:33`).
- `src/context/handsfree-voice-provider.tsx:988-1033` - the reply effect does scan `messages` on
  every change, but returns immediately unless the call is in `sending|waiting|speaking` (`:991`),
  so an idle phone pays only the render, not the scan.

**[INFERENCE]** Per streamed frame the provider's body runs - the file's ~50 hook call sites
(2 `useState`, 11 `useRef`, 9 `useEffect`, 26 `useCallback`) plus the `latest` mirror allocation -
and its context value changes, but the only mounted
consumers are `ChatScreen` (already
re-rendering) and a banner that renders `null` outside a call. The cost is small today; it becomes
real if a third consumer with visible content is added, and it makes the "only the chat surface
re-renders" claim in `gateway-provider.tsx:7890-7893` true only because of what happens to be
mounted.

### E10. Per-render allocations worth naming

**[SOURCE]**

- `src/hooks/use-tokens.ts:13-15` - `useTokens()` returns `{ scheme: 'dark', ...Palette }`: a new
  object every call, every render. Called per bubble (`message-bubble.tsx:42`), per tool card
  (`tool-call-card.tsx:25`), per code block (`code-block.tsx:17`), per screen (`Screen.tsx:19`).
- `src/components/chat/message-bubble.tsx:43` - `useWindowDimensions()` per bubble (a subscription,
  not a per-frame cost).
- `src/components/chat/chat-screen.tsx:3080` - inline `keyExtractor`, so its identity changes per
  render.
- `src/components/chat/group-room-view.tsx:641-658` - the group transcript's `renderItem` is an
  inline arrow and each bot entry renders `<MarkdownText text={item.text} />` with **no** row
  component and no memo; the markdown parse is still memoised by text
  (`markdown-text.tsx:135`), so a parent re-render costs element recreation, not re-parsing.
- `src/context/demo-gateway-provider.tsx:147-160` - the showcase provider streams a canned reply on
  a **70 ms `setInterval`**, two words per tick, after a 650 ms beat. It does **not** go through the
  rAF batcher.

**[INFERENCE]** None of these is a plausible sole cause of low FPS. They are listed because they
inflate the per-frame numbers in experiment A and because the demo provider's 70 ms cadence makes it
a poor stand-in for a fast model (section 8, risk 1).

### E11. Existing coverage pins the *shape* of these optimisations, not their cost

**[SOURCE]**

- `__tests__/chat-transcript-render-cost-test.ts:12-46` - source-regex assertions only: bubble is
  `memo(...)`, `renderMessage` has no `messages` dependency, `transcriptItems` is built outside
  `renderItem`, the FlatList mounts a bounded window. It never renders anything or counts renders.
- `__tests__/roster-render-cost-test.ts:19-66` - same style for the roster list.
- `__tests__/gateway-stream-batching-test.ts:26-149` - behavioural, on the batcher with an injected
  scheduler: coalescing, ordering within a flush, cancel, `STREAM_BATCH_MS === 16`.
- `__tests__/format-day-divider-cache-test.ts:3-38` - behavioural: same-day reuse, cross-day compute,
  day rollover invalidation.
- `__tests__/chat-surface-context-test.ts:28-82` - the context split and the ref-mirrored send path.
- `__tests__/ambient-parallax-test.ts`, `__tests__/stage-shader-test.ts`,
  `__tests__/stage-motion-test.ts`, `__tests__/group-room-history-rerender-test.tsx` - the parallax
  mapping, shader source/uniform layout, choreography, and group-room re-render survival.

**[INFERENCE]** There is no test anywhere that counts React commits, measures a render, or asserts a
memo actually skipped. The render-cost tests would keep passing if the screen doubled its render
work per frame.

### E12. There is no performance instrumentation in the app

**[SOURCE]** A repository-wide search for `InteractionManager`, `performance.now`,
`getPerformance`, `console.time`, `requestIdleCallback` over `src/**/*.ts,tsx` returns only
`src/components/layout/stage-gl.ts:151,203,216,236,288` - the web stage's own frame clock. There is
no frame counter, no commit counter, no `flushCount` reader, and no dev HUD for render cost.

**[INFERENCE]** Any per-frame number quoted about this app today is either from an external
profiler or unverifiable. That is the gap section 4 fills.

---

## 2. Ranked hypotheses

Ranking is by *mechanism confidence x expected share of the reported symptom*. It is not a claim
about which one is happening on the operator's device.

### H1 - A streamed reply re-renders the whole ChatScreen (and diffs the whole list) once per frame. **High mechanism, unknown share**

Evidence: E1, E2, E3, E4. The state that changes per frame is consumed by a 2,919-line component
that also owns the FlatList, the header, the composer and eight sheets; the array and item
identities change with it.

**Confirmed by:** section 4.1 item 1 (commit count/duration per second during a fast reply) and item
2 (render counters). **Refuted if:** commits/s is low (<10) because the Gate's token rate is low, or
p95 commit duration is <3 ms, i.e. the screen is not the bottleneck at this size.

### H2 - Auto-scroll per flush adds layout work and can feed back into another render. **Medium-High**

Evidence: E4. Each content-size change requests `scrollToEnd`, and reported scroll positions update
the ambient parallax state (>= 0.04 steps), which re-enters the same render.

**Confirmed by:** experiment C, counting `onContentSizeChange` and `onScroll` events per second and
the extra `ChatScreen` renders they cause while pinned. **Refuted if:** `scrollToEnd` produces no
`onScroll` on the test device, or the render count equals the flush count exactly.

### H3 - The stage shader is a significant, always-on GPU cost during chat. **Medium, device-dependent**

Evidence: E7, E8. It is drawn by design, it is awake within 40 s of every touch, and it is a
~80-`hash12`/fragment runtime effect over the full screen (24 fps cruising, 60 fps through each
ease) with no native resolution cap.

**Confirmed by:** experiment D (JS FPS vs UI FPS with `ambient={false}` as the control on the same
screen and stream) and a GPU trace (section 4.4). **Refuted if:** UI FPS is unchanged with the stage
off, or the GPU trace shows the stage's frame time is a small fraction of the frame budget. Note the
design is deliberate; refuting this hypothesis is a *good* outcome because it removes a tempting but
wrong "just simplify the shader" change.

### H4 - The streaming -> settled transition costs a visible hitch (full markdown parse plus a full re-layout). **Medium**

Evidence: E6. At settlement `parseMarkdown` runs over the whole answer, the bubble swaps one plain
paragraph for a block tree of many `RNText` nodes, and `scrollToEnd` fires once more.

**Confirmed by:** experiment E (a single long frame at the end of the turn, correlated with the
`streaming: false` transition). **Refuted if:** the settle frame's duration is within one frame of
the streaming average, or the parse is <1 ms for a realistic 4,000-character answer.

### H5 - Re-mounting recycled cells re-parses markdown while scrolling a long thread. **Low-Medium**

Evidence: E6, E3 (`windowSize={9}`, `removeClippedSubviews`), `markdown-text.tsx:135` (memo is
per-mount, not global).

**Confirmed by:** experiment F, counting `parseMarkdown` calls while scrolling up and down a long
thread without streaming. **Refuted if:** no re-mount occurs in the window, or parse time is
negligible.

### H6 - The stage's gravity sensor and parallax ease add UI-thread work that is invisible to JS FPS. **Low**

Evidence: E7 (sensor at 33 ms, `scrollTau * 2` = 480 ms ease). **Confirmed by:** a UI-thread/GPU
trace while the stage is awake and between eases, correlating gravity-sample updates with redraws.
**Refuted if:** no redraws occur between eases even while the phone is moved, or the trace shows the
sensor callback is immaterial. Reduce Motion is not a valid control here: it switches the whole
clock off (`AmbientCanvas.native.tsx:201`), not just the sensor.

### H7 - The handsfree provider's unmemoized value multiplies renders. **Low today, rising later**

Evidence: E9. **Confirmed by:** the section 4.1 item 2 counters, showing more than one `ChatScreen`
render per flush. **Refuted if:** renders per flush == 1 and no visible component
consumes the value outside a call. The fix is still worth taking on its own merits (it is three
lines and removes a fan-out trap).

### Explicitly not hypothesised here

- **Markdown parsing per token** - contradicted by E6. Do not "optimise" it without evidence.
- **The orb animating in JS** - contradicted by E5; it is already UI-thread.
- **A too-small `windowSize`/`maxToRenderPerBatch`** - the values match the roster list and are
  conventional; nothing in source suggests they cause jank, and changing them trades memory for
  scroll blanking.
- **The Gate, the model provider, or the network** - outside this tree's evidence; a slow first token
  is [UNVERIFIED] and belongs to a live-traffic measurement, not this draft.

---

## 3. What this investigation could not establish

- **No FPS number, no frame time, no render duration, no memory figure** for this app on any device.
- **No profiler capture** of either the JS or the UI thread.
- **No device or OS information** behind the report; the symptom may be Android, iOS, web, or all
  three, and the three paths differ (native Skia vs one shared WebGL context blitted into 2D
  canvases, `stage-gl.ts:160-187`).
- **No token rate** for the reported case. H1's magnitude is directly proportional to it, and the
  demo provider's 70 ms cadence (`demo-gateway-provider.tsx:147-160`) is far slower than a fast
  hosted model.
- **No live Gate**, so no real streaming cadence, no real history size, and no real device thermals.
- **No reproduction steps.** "Low FPS and latency" arrived without a thread size, reply length,
  platform, or whether it happens at rest, while streaming, while scrolling, or at turn end.
- **No evidence about the web build's actual GPU path** on the reported machine; `MAX_PIXELS`
  (`stage-gl.ts:30`) suggests it was tuned before, which is a hint, not a measurement.

Every statement above that sounds like a cause is labelled [HYPOTHESIS] or [INFERENCE] on purpose.

---

## 4. Proposed measurements (all [NOT RUN])

### 4.1 Instrumentation to add temporarily (never committed as product code)

All of these are dev-only and must be removed before merge; the shipped step for any fix is the
regression test in section 6, not a permanent HUD.

1. **Commit counter around the chat screen.** React `<Profiler id="ChatScreen" onRender>` around the
   `ChatScreen` element (and a second one around the FlatList region only). Record: commits/s, p50,
   p95, max `actualDuration`, and the `phase` (`mount`/`update`) distribution. This answers
   experiments A and B.
2. **Render counters, in development only.** One `useRef` counter incremented in `ChatScreen`'s body,
   one in `MessageBubble`, one in `ChatComposer`, one in `ChatHeader`; log deltas once a second.
   Counters answer "did the memo skip it?" without trusting inspection.
3. **Flush rate from existing code.** `createStreamBatcher` already exposes `flushCount`
   (`stream-batching.ts:138-140`). A dev log of `flushCount` per second gives the achieved flush rate
   with no new plumbing.
4. **Parser counter.** A dev-only `let markdownParseCount` incremented inside `parseMarkdown`
   (`parser.ts:246`), logged with the same one-second cadence. Used only for H4/H5.
5. **Stage state sampler.** Log `focused / reduced / awake / running` once a second from
   `LampCanvas` (`AmbientCanvas.native.tsx:199-212`) so a frame dip can be correlated with the stage
   being awake rather than guessed.

### 4.2 Isolation experiments

Run each twice on the same device, same thread, same reply, warm cache; keep the phone off a charger
and record battery level and ambient temperature, because thermal throttling looks exactly like this
bug.

- **A. Baseline streaming.** A pinned transcript with >= 40 messages, a reply of >= 1,500 tokens,
  no touching after send. Record JS FPS, UI FPS, commits/s, p95 commit, flush/s, dropped frames.
- **B. Rate sweep.** Same, but drive the stream at three rates (slow: ~5 tokens/s, fast: ~60
  tokens/s, burst: 200 tokens in one frame). If commit count tracks token rate, H1's mechanism is
  confirmed and the batching window is the lever. If FPS is flat across rates, H1's *share* is
  small and the constant costs (H3) dominate.
- **C. Pinned vs unpinned scroll during a stream.** Same reply, half the run with the transcript
  scrolled away from the bottom (auto-scroll suspended). Delta in JS FPS and commits isolates H2.
- **D. Stage on vs off.** The same screen and stream with `<Screen ambient={false}>`
  (`Screen.tsx:14,25`) as a local experiment. This is the only clean way to separate H3 from H1
  without changing the shipped default. Also record a run with the device's system Reduce Motion on
  (all stage motion is off, `AmbientCanvas.native.tsx:201`), as a coarse second control.
- **E. Turn-end hitch.** Send one long reply, then measure the single frame containing the
  `streaming: false` transition. Report its duration and whether it lands before or after the last
  `scrollToEnd`.
- **F. Scroll-only, no stream.** A 200-message thread, fling to the top and back, no reply running.
  Count parses and unmount/remount events. Isolates H5.
- **G. Idle app, chat open.** No stream, no touch for 60 s. Establishes the floor: if this is already
  poor, the report is not about streaming at all.

### 4.3 Practical thresholds (proposed, to accept or reject each hypothesis)

On the reference device (a mid-tier Android phone, e.g. Pixel 6a class, and a recent iPhone):

| Metric | Target | Why this number |
| --- | --- | --- |
| UI FPS p5 while streaming, pinned | >= 55 | 60 Hz budget; p5 catches the stutter the eye notices, not the mean |
| JS FPS p5 while streaming | >= 55 | below this, touches start to lag |
| Commit p95 for a streamed flush | <= 8 ms | half of a 16.7 ms frame, leaving room for layout and paint |
| Commits per second while streaming | <= 30 | a coalesced flush does not need every frame; 30 still reads as live text |
| Touch-to-press-feedback | <= 100 ms | perceived as immediate |
| Frames dropped per 10 s stream (Android `framestats`) | <= 6 | ~1 % of 600 frames; a 10 % jank rate is the reported symptom |
| Turn-end hitch | <= 33 ms extra over the streaming mean | one extra frame budget |
| Time-to-first-token | recorded separately, not gated here | network/Gate property |

If the baseline already meets these, the honest conclusion is "not reproduced on this device" and
the work below should be re-ranked rather than force-shipped.

### 4.4 Instruments and commands (exact, unrun)

- **JS thread:** React DevTools Profiler (Expo dev build), plus the counters above. The React Native
  Dev Menu's Perf Monitor shows **both** JS and UI FPS - that single screen is the fastest
  JS-vs-UI discriminator.
- **Android UI thread / jank:** `adb shell dumpsys gfxinfo <package> reset`, run the scenario, then
  `adb shell dumpsys gfxinfo <package> framestats` and read the frame-interval columns; or record a
  Perfetto trace (`adb shell perfetto -o /data/misc/perfetto-traces/trace -t 10s
  sched freq gfx view`) and inspect the UI/RenderThread slices.
- **Android GPU:** Android GPU Inspector or a Perfetto GPU counter capture, to attribute the stage
  shader's frame cost (H3) rather than inferring it from `hash12` arithmetic.
- **iOS:** Instruments - Time Profiler (JS/native CPU), Core Animation (FPS), and Metal System Trace
  for the Skia stage.
- **Web (if the report is the demo build):** Chrome DevTools Performance with 4x CPU throttling,
  plus the Rendering panel's "Frame rendering stats" and "Paint flashing"; correlate with
  `stage-gl.ts:160-187`'s single rAF loop.

---

## 5. Proposed work, one independent step per item

Each step stands alone: it has its own gate, its own acceptance test, and none requires another step
to land first. None of them changes a visual, a copy string, or a wire format.

### Step P1 - Give the transcript its own memo boundary

**What:** extract the list region (`chat-screen.tsx:3076-3141`) into a `ChatTranscript` component
that receives `messages`-derived props and its own stable callbacks, so a streamed flush re-renders
the transcript tree and not the header, composer and sheets. `ChatScreen` keeps ownership of state
and handlers.

**Acceptance:** R2 - the extracted `ChatTranscript` commits once per append, and only the streaming
row re-renders; a source assertion that `ChatScreen` no longer contains the `renderItem`/FlatList
block, so the list cannot re-render with the screen; the existing source tests in
`__tests__/chat-transcript-render-cost-test.ts` still pass, updated only where they assert the
block's file location (never weakened); no visual change.

**Risk:** prop plumbing mistakes cause stale callbacks. Mitigate with the existing ref-mirror idiom
already used in this file (`chat-screen.tsx:1030-1035`, the `messagesRef` mirror, and
`handsfree-voice-provider.tsx:356-390`).

### Step P2 - Coalesce auto-scroll instead of firing it per content-size change

**What:** keep "no animation while streaming" exactly as it is (`:1824-1833`), but request at most
one `scrollToEnd` per frame and only when the transcript is pinned and the content grew. A pure
`nextAutoScroll(state, event)` helper makes the decision testable.

**Acceptance:** R7 - ten content-size changes inside one frame produce one scroll request; pinned
false produces none; the settled (non-streaming) path still uses `animated: true` on a pill tap.

**Do not:** remove auto-follow. The transcript is expected to follow a live reply.

### Step P3 - Keep unchanged transcript items referentially stable

**What:** hoist the `transcriptItems` fold into a pure, exported helper that reuses the previous item
object when `message` and the divider flag are unchanged (a `WeakMap` keyed by the message object, or
a small cache keyed by `message.id` with the message identity checked). Dividers stay decided outside
`renderItem`.

**Acceptance:** R1 - appending a delta leaves every other item identity identical, and divider flags
equal a from-scratch rebuild; the existing divider and cache tests pass.

**Note:** this does not by itself stop the FlatList diff (the array identity still changes), so it is
listed separately and is expected to be a smaller win than P1. It must not be sold as a fix on its
own.

### Step P4 - Memoize the handsfree provider's context value

**What:** wrap the object at `handsfree-voice-provider.tsx:1540-1572` in `useMemo` on the same fields
it reads, so consumers stop re-rendering when nothing they read changed. Keep the `latest` ref effect
as is (it guards staleness, not rendering).

**Acceptance:** R4 - a pure builder returns the same reference for equal inputs, and the provider's
value survives a streamed `messages` change with an unchanged identity.

**Do not:** stop the provider from reading `messages`; the reply effect needs it for an active call.

### Step P5 - Pause the stage clock while a reply is streaming (measurement-gated)

**What:** only if experiment D shows a real attribution to the stage: hold the air clock (and the
parallax ease) while `isStreaming` is true, resuming on settle. The air drifts at 0.004-0.021 units
per second (`shader.ts:127-132`), so a pause of a turn's length is visually indistinguishable - but
this must be confirmed against the design owner, not asserted.

**Acceptance:** a choreography test (R5) proving the uniforms at pause/resume equal the unpaused
uniforms at the same elapsed time (i.e. time did not advance, nothing jumped), plus a device FPS
delta recorded in the PR description from experiment D.

**Do not** ship this without experiment D. If the stage is not the cost, this is an unnecessary
visual change and should be dropped.

### Step P6 - Cache parsed markdown across cell re-mounts (measurement-gated)

**What:** only if experiment F shows re-parse cost: a small bounded LRU in `markdown-text.tsx`
keyed by `(text, streaming)` so a recycled cell reuses its blocks. The streaming fast path
(`parser.ts:365-369`) must be untouched.

**Acceptance:** R6 - identical blocks for the same text, parse count bounded, cache size capped, and
a different text never returns a stale tree.

**Do not:** cache by message id; the same text can legitimately change while streaming.

### Step P7 - Record the baseline in the repo, not just in a PR comment

**What:** after section 4 runs once, add the measured numbers (device, build, token rate, JS/UI FPS,
p95 commit, flush/s, hitch) to a short table in this document, dated. No code change.

**Acceptance:** the numbers exist and are labelled as measured, with the device named. Until then,
this document stays a draft and no P1-P6 claim may cite a number.

---

## 6. Regression test design (hermetic; no device, no Gate, no network)

The existing render-cost tests are source-regex only (E11). The tests below add behaviour; they must
not delete or weaken the source ones.

- **R1 `transcript-items-identity-test.ts`** - pure helper from P3: (a) appending a delta keeps every
  other item identity; (b) a rebuilt-from-scratch list is deep-equal in `label`/`showDivider`;
  (c) a day rollover changes the first item of the new day and nothing else; (d) an empty thread and
  a one-message thread behave.
- **R2 `chat-transcript-memo-test.tsx`** - render the extracted `ChatTranscript` with
  `react-test-renderer`, in the mocking style `__tests__/agentic-run-transcript-windowed-mount-test.tsx:1-30`
  already uses for reanimated/UI (plus whatever the transcript row pulls in): wrap the transcript in
  `<Profiler onRender>` and give it a `memo`'d counting row child; a 20-message transcript, then one
  `appendStreamDelta`. Assert one commit of the transcript, one row render for the streaming message,
  and zero for the rest. If the extracted component cannot
  be mounted hermetically without weakening the surrounding code, fall back to asserting the same
  facts on the pure item/row-props path (R1) plus the source assertion from P1 - and say so in the
  test's header rather than shipping a hollow render test.
- **R3 `stream-batching-cadence-test.ts`** - extend the existing injected-scheduler pattern
  (`gateway-stream-batching-test.ts:26-149`): 1,000 deltas delivered across 10 scheduler frames
  produce exactly 10 flushes and a `flushCount` of 10; interleaved text/reasoning/tools keep their
  within-flush order; `cancel()` leaves `flushCount` unchanged.
- **R4 `handsfree-provider-value-test.ts`** - the extracted builder returns the same reference for
  equal inputs, a new reference for each differing field, and `startBlocker` still reflects
  `isSending`/`isCommandRunning`/`pendingRunApproval`.
- **R5 `stage-clock-pause-test.ts`** - `stageUniforms` at a paused clock equals `stageUniforms` at
  the same `timeSec` unpaused, field for field (this is the "no visual jump" proof); resume advances
  from the paused value, never from wall time.
- **R6 `markdown-parse-cache-test.ts`** - same text returns the identical blocks array; different
  text returns a fresh parse; the cache does not grow past its cap; a streaming body still returns
  the single-paragraph fast path with no `parseMarkdown` call.
- **R7 `chat-auto-scroll-coalesce-test.ts`** - pure decision helper: pinned + growth -> one request
  per frame; not pinned -> none; ten events in one frame -> one; settled pill tap -> animated.

Every test above fails on the current tree for a reason that names the missing behaviour, and none
of them asserts a timing threshold (flaky by nature). Wall-clock FPS stays a human measurement in
section 4; the tests only pin the *shape* of the work.

---

## 7. Reproduction protocol for a human [NOT RUN]

1. Cold-start the app on the reference device, connect to a Gate with >= 40 messages in the thread.
2. Enable the dev counters from section 4.1 and the RN Perf Monitor (JS FPS + UI FPS visible).
3. Send one prompt that produces a >= 1,500-token answer with tool calls and markdown.
4. Touch nothing for the whole reply; record JS FPS p5, UI FPS p5, commits/s, p95 commit, flush/s,
   and the max frame.
5. Repeat with the transcript scrolled away from the bottom (auto-scroll suspended), then with
   `ambient={false}`, then with the system Reduce Motion on. Same reply each time.
6. Repeat the whole set with a 200-message thread and a fling to the top and back, no stream.
7. Record the settle frame separately, and note the time-to-first-token.
8. Attach: device model, OS build, Expo/RN versions, build type (dev vs release), battery level and
   thermal state, and the Gate's token rate. Without those, the numbers cannot be compared.

A **release build** is required for any number that will justify a change; dev builds carry
Metro/React-dev overhead, and this document will not accept a dev-build FPS as evidence.

---

## 8. Risks, and what would make this draft wrong

1. **The demo provider is not a fast model.** 70 ms per two words (`demo-gateway-provider.tsx:147-160`)
   is ~14 updates/s and bypasses the rAF batcher, so demo-based measurement understates H1's
   mechanism by up to 4x and cannot measure batching at all. Use a live Gate for section 4, or add a
   dev-only fast replay path in the harness (not in product code).
2. **Dev-build overhead.** React DevTools, the Profiler, and dev-mode double-invocation inflate
   commit counts. Only release-build numbers gate a decision.
3. **Thermal throttling.** A 10-minute streaming test on a warm phone looks exactly like a JS or GPU
   regression. Record temperature; re-run cold before believing a delta.
4. **The stage may be innocent, and that is a useful result.** E8's arithmetic is a hypothesis-
   generator, not evidence. If experiment D shows no delta, H3 dies and the "shader is too heavy"
   change must not be made.
5. **The report may be about the web demo, not the app.** The web stage is a different renderer
   (`stage-gl.ts`) with a resolution cap; the native path has none. Measuring one and fixing the
   other would be wasted work - confirm the platform first.
6. **A fix that hides jank instead of removing it.** Raising `windowSize`, lowering the sampled
   frame rate, or dropping the orb/parallax are all "fixes" that trade the design away. This draft
   forbids them.
7. **Attribution error between the drafts.** Overlap/reordering complaints (streaming draft) and
   dropped frames can look alike on a fast model. If section 4 shows no frame-time problem, the
   reported "latency" is more likely the streaming-order story, not this one.
8. **Unmeasured claims in this document.** Every number here is either read from source (lines,
   `MESSAGE_WINDOW_CAP`, `STREAM_BATCH_MS`, `driftFrameMs`, `idleAfterMs`, `hash12` counts) or
   explicitly derived with its assumption stated. If a reviewer finds a count that does not match
   the source, the count is wrong, not the measurement plan.

---

## 9. Handoff

- **State:** draft only. No product code changed in this step; the only file touched is this one.
- **To land any of P1-P6:** run section 4 first (release build, one mid-tier Android and one iPhone),
  record the baseline in the table from P7, then take exactly one of P1-P6, add its R-test, and run
  the full `npm run verify` plus the device re-measure.
- **Do not** treat `grep -q Evidence` as proof of anything. It proves this file mentions the word.
- **Open questions for the operator:** which platform was the report about (Android, iOS, web demo)?
  Roughly how long was the reply and how many messages were in the thread? Did the poor FPS happen
  while touching/scrolling, while idle, or only at the end of a turn?
