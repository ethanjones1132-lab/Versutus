# Chat streaming layout and ordering — investigation draft and plan

Status: **draft for human review. Source-only investigation. Nothing reproduced.**
Worktree: `C:\rh-wt\20261101-0050-versutus-vs-overnight-20261101-ha`, HEAD `4b0fe4a`
("VS-OVERNIGHT-20261101 roster_diagnosis: …"); parents `b026c05` (activity) and `b258652`
(markdown). Author: unattended Ralph iteration (`streaming_diagnosis`), one pass, no device, no live
Gate, no network call, no credentials.

Labels used throughout:

- **[SOURCE]** — read in this worktree at the cited `file:line`; a statement about code, not about a
  running system.
- **[INFERENCE]** — a conclusion drawn from two or more [SOURCE] facts. Still not a measurement.
- **[HYPOTHESIS]** — plausible cause; needs the stated measurement to become fact.
- **[UNVERIFIED]** — a claim from the report, or something this tree cannot confirm.
- **[NOT RUN]** — a check a human must run; I did not run it and claim no result.

> This document deliberately does **not** say the reported behaviour was reproduced. It reports no
  device FPS, no frame timings, no captured SSE body, and no Gate version. The Ralph check for this
  step is `grep -q Evidence docs/plans/overnight-chat-streaming.md`; it proves the word "Evidence"
  appears, nothing more. A human must read the diff and run the full `npm run verify` before any
  merge.

---

## 1. The request as received

> "fast tool, message, and thinking streams reportedly overlap tool cards or reorder text; errors
> may appear Done. Trace event order, chat parts, layout and status handling; preserve visuals and
> document reproduction and regression test design."

Three separable claims hide in that sentence, and they have different causes:

1. **Overlap** — a layout/paint claim: tool cards drawn where text should be, or text drawn under a
   card. Section 2, H1.
2. **Reorder** — a sequencing claim: text and thinking appearing in an order other than the one the
   model produced. Section 2, H2–H4.
3. **"Errors appear Done"** — a status claim: a failed or cancelled thing rendering with a success
   badge. Section 3. This one is largely independent of both of the others and is the claim with the
   strongest source evidence in this tree.

"Preserve visuals" is read strictly here: every proposal below is a behaviour/status/layout fix, not
a redesign. The one streaming signal (a breathing orb, `src/components/chat/streaming-indicator.tsx:15-19`),
the collapsed "Used N tools · Thought" chip, the no-caret body text, and the list's existing
window/batch settings are treated as fixed constraints.

Two adjacent streaming affordances are deliberately left alone and should not be "fixed" by any step
below: the header avatar's thinking mood while a Bot replies
(`src/components/chat/chat-screen.tsx:2600` → `chat-header.tsx:122`), and the composer's Stop control
(`src/components/chat/chat-composer.tsx:190-204`). They are different surfaces from the bubble, and a
report about overlap or ordering does not implicate them.

Not in scope: the low-FPS/latency report (separate `performance_diagnosis` draft), the roster HTML
failure (separate draft), the OpenCode 2.x dialect work, and the `fold_cache` incremental-fold issue.

---

## Evidence

All of the following is read from this worktree. Nothing below is a measurement.

### E1. The live chat pipeline, in order

**[SOURCE]**

- `src/context/gateway-provider.tsx:4459-4472` — the send raises one streaming placeholder
  (`addStreamingPlaceholder`) and creates one batcher for the turn id.
- `src/context/gateway-provider.tsx:4512-4534` — `client.streamChat(...)` wires three callbacks into
  that batcher: `queueDelta` (text), `queueTool` (tool call), `queueReasoning` (thinking).
- `src/context/gateway-provider.tsx:4580-4582` — after the stream resolves: `batcher.flush()` then
  `finalizeStreamingMessage`.
- `src/lib/gateway/turns.ts:262-342` — `readChatFrames` is the one reader for both a live
  `/v1/chat/completions` SSE body and a `GET /v1/turns/{id}/events` replay. It parses each `data:`
  payload through `interpretChatStreamChunk` and dispatches text → reasoning → tools, per frame
  (`turns.ts:304-311`).
- `src/lib/gateway/http-transport.ts:262-275` — frames are consumed **line by line**, and a `data:`
  payload is handed to the callback per line; `id:` lines are handled separately and surfaced through
  `onId` (`http-transport.ts:264-268`).

**[INFERENCE]** Order of *delivery* is therefore the order the Gate wrote the frames, with no
re-ordering in transport. Any reorder the operator sees is produced app-side, by (a) the fixed field
order in the flush, (b) the fixed block order in the bubble, or (c) a re-parse. Those are H2–H4.

### E2. The batcher does not reorder text — it only coarsens *when*

**[SOURCE]** `src/lib/gateway/stream-batching.ts:85-100`: one flush applies, in this fixed order,
`appendStreamDelta`, then `appendReasoningDelta`, then each queued tool call. `cancel()`
(`:129-137`) throws the pending buffer away.

**[INFERENCE]** Because text, reasoning and tool calls land in three separate fields of one
`ChatMessage` (`src/lib/gateway/types.ts:259-267`), the *final* state of a flush equals the state of
applying those same deltas one by one. The batcher cannot reorder content. It does, however,
irreversibly merge everything that arrived inside one ~16 ms window, so the *interleaving* the model
produced is gone — and the data model has nowhere to put it anyway (H2).

### E3. Thinking and text have fixed, separate homes in the bubble

**[SOURCE]** `src/components/chat/message-bubble.tsx:124-173`: when the message has any tool calls or
any reasoning, the bubble renders an "activity" block **above** the body: reasoning first
(`:160-166`, inside a `ScrollView` capped at 200 px), then one `ToolCallCard` per tool call
(`:167-169`). The body text is rendered after it (`:210-218`). There is no path that renders a
thinking block *below* text, or between two text paragraphs.

**[INFERENCE]** A turn that thinks → answers → calls a tool → answers again cannot be represented
faithfully. The operator sees: thinking (top), tool cards (middle), *all* answer text (bottom). On a
fast model this reads exactly like "thinking and tool cards reordered the text". This is structural,
not a race.

### E4. The activity block has no clipping and no scroll container

**[SOURCE]** `src/components/chat/message-bubble.tsx:158-171` — the activity card is a plain `<View>`
holding a `ScrollView` for reasoning plus an unbounded `map` of `ToolCallCard`s.
`styles.activityCard` (`:411-416`) is `{ borderRadius, padding, gap, maxHeight: 320 }` — **no**
`overflow` and **no** scroll. `styles.reasoningScroll` (`:417-419`) caps only the reasoning.

**[INFERENCE]** With more tool cards than fit in 320 px, the children keep their intrinsic heights
(RN's default `flexShrink` is 0) and the column overflows the card's box. Without `overflow: 'hidden'`
the overflow is painted, not clipped — over the body text that follows in layout.

### E5. The activity block is open *while streaming* and collapses when the turn ends

**[SOURCE]** `src/components/chat/message-bubble.tsx:57-61`:

```
const [activityUserOverride, setActivityUserOverride] = useState<boolean | null>(null);
// …
const activitySettled = !!message.streaming;
const isActivityOpen = activityUserOverride !== null ? activityUserOverride : activitySettled;
```

`activitySettled` is true *while* the message is still streaming, which is the opposite of what the
name says (already logged at `QUALITY-SCAN-2026-10-11.md:1331-1335`). Its effect: the activity card is
expanded during the stream and collapses the moment `streaming` flips false.

### E6. Tool status can be reset to `running` by a later fragment

**[SOURCE]** `src/lib/gateway/chat-stream-delta.ts:119` — `status` defaults to `'running'` whenever a
frame does not say `complete`/`error`; every emitted tool call carries a status (`:134-137`).
`src/lib/gateway/message-reducer.ts:196-199` merges with `{ ...item, ...toolCall }`, so a later
fragment's implied `running` overwrites an existing `complete`/`error`.

**[INFERENCE]** Sequence "tool → complete (or error) → one more argument/name fragment" leaves the
card at `Running`, and `finalizeStreamingMessage` (`message-reducer.ts:217-222`) then promotes
`running → complete`. A tool that errored can therefore end the turn showing **Done**.

### E7. Array-form tool blocks ignore the status the provider sent

**[SOURCE]** `src/lib/gateway/chat-stream-delta.ts:141-180`: array-form `delta.content` blocks of the
known types (`:40-45`) are reduced to `{ name, status: 'running' }` (`:178`), and the unknown-kind
fallback does the same (`:170`). `item.status` is never read on this path, although it *is* read on
the OpenAI `tool_calls` path (`:119`).

**[INFERENCE]** Any array-form backend that marks a call errored has that verdict discarded, and E6's
promotion turns the card into "Done" at the end of the turn.

### E8. History loading forces every tool to `complete`, and drops tool results

**[SOURCE]** `src/lib/gateway/messages.ts:69-76` — `push()` defaults the status to `'complete'`;
`:88-91` passes `'complete'` for every OpenAI `tool_calls` entry; `:105-119` passes `'complete'` for
every content block. Separately, `historyToChatMessages` keeps only `user`/`assistant`/`system`
(`:138-140`), so a `role: 'tool'` result message — the only place a live backend records whether the
tool worked — never reaches the transcript.

**[INFERENCE]** After any history reload (a reconnect, a pull-to-refresh, `settleInterruptedFromTurns`
doing `done` → history, or a reconcile), failed tool calls render exactly like successful ones.

### E9. A tool card with no status renders "Done" by default

**[SOURCE]** `src/components/chat/tool-call-card.tsx:26` — `const status = toolCall.status ?? 'complete'`,
and `STATUS_LABEL.complete` is `'Done'` (`:17-21`).

### E10. A command bubble with no status renders "Done", and Cancel is exactly that case

**[SOURCE]** `src/components/chat/message-bubble.tsx:117-120` —
`COMMAND_STATUS_LABEL[commandStatus ?? 'complete']` with tone `COMMAND_STATUS_TONE[... ?? 'complete']`.
`src/context/gateway-provider.tsx:5512-5527` — the cancelled path *clears* the status
(`status: undefined`), keeping the streamed text unless it is still the placeholder.

**[INFERENCE]** A cancelled command bubble shows a success-toned "Done" badge next to text that may read
`Cancelled: /label` (or the half-streamed output). Reported "errors appear Done" is satisfied by this
path alone, with no model involved.

### E11. Frames at or below `after` are dropped — except error frames

**[SOURCE]** `src/lib/gateway/turns.ts:291-302`: the error branch runs **before** the
`seq <= after` gate. So a replayed, already-passed error frame still sets `streamError`, which
`assertChatStreamComplete` (`src/lib/gateway/http-transport.ts:83-87`) throws, while every other
field of that same frame is dropped as stale.

**[INFERENCE]** A re-attach (`gateway-provider.tsx:2578`, `after === 0` resets text; `after > 0`
keeps it) depends on `?after=` being honoured. A journal replay that includes a historical error
frame — or a proxy that ignores the query — ends a turn that the Gate considers healthy with an
error, and `convertStreamError` then replaces the streamed text with `Error: …`
(`message-reducer.ts:250-255`). `QUALITY-SCAN-2026-10-11.md:643-645` records the neighbouring
complaint (that reader reports every frame regardless of `after`); at this HEAD that is already
partly untrue — `turns.ts:302` does gate text/reasoning/tool dispatch on `seq` — but only when the
frame carries an `id:`, and the error branch above it is gated by nothing.

### E12. Failure wipes already-streamed text; interruption keeps it

**[SOURCE]** `src/context/gateway-provider.tsx:4687-4697` (connection error) flushes, marks the bubble
interrupted and keeps the partial text. `:4699-4706` (any other failure) calls `batcher.cancel()` —
discarding unflushed deltas — and `convertStreamError`, which sets `text: "Error: …"`
(`message-reducer.ts:250-255`).

**[INFERENCE]** Two failure classes with very different visible outcomes, decided by
`isConnectionError`. A refused turn loses text the operator was reading; nothing in the source says
that is intended, but nothing says it is a bug either. Flagged for a decision, not claimed as one.

### E13. During streaming, the whole body is one plain paragraph

**[SOURCE]** `src/components/chat/markdown/markdown-text.tsx:135` memoises on `(text, streaming)`;
`src/components/chat/markdown/parser.ts:359-370` returns a single `paragraph` block while
`streaming` is true, and only parses markdown once it is false.

**[INFERENCE]** Lists, headings, bold and fenced code appear as literal markers during the stream and
are re-laid-out the instant it completes. On a long answer that is a whole-body reflow at the end of
the turn, and it is the one place where text *visibly changes* rather than grows.

### E14. The transcript list is not inverted and jumps without animation while streaming

**[SOURCE]** `src/components/chat/chat-screen.tsx:3077-3092` — `FlatList` with
`removeClippedSubviews`, `initialNumToRender={12}`, `maxToRenderPerBatch={16}`, `windowSize={9}`.
`:1824-1833` — on content-size change, if pinned, `scrollToEnd({ animated: !isStreaming })`.
`:2529-2538` — `transcriptItems` rebuilds every element object whenever `messages` changes;
`:2540-2556` — `renderMessage` keeps a stable identity, and `MessageBubble` is `memo`
(`message-bubble.tsx:41`).

**[INFERENCE]** Only the streaming bubble's `message` identity changes per flush
(`message-reducer.ts:165`), so memo should contain the re-render to one bubble. The FlatList still
re-creates cells for its mounted window each flush, and Android's clipped-subview recycling during
fast content growth is a known source of stale/blank cells — to be measured, not assumed (M6).

### E15. The web-specific stacking hazard is documented in this file, for this row

**[SOURCE]** `src/components/chat/message-bubble.tsx:80-85` — the row's
`entering={entering.rise}` is disabled on web because "Reanimated's entering keyframes leave cells
that the windowed list recycles parked out of flow, stacking turns on top of each other".

**[INFERENCE]** If the reporter is on the web build, "tool cards overlap text" has a known precedent
in this exact component, and any future entering animation added to a *row child* (a card, a badge)
reintroduces it. Cheap to rule in/out by asking which platform the report came from.

### E16. Existing coverage, and the gap it leaves

**[SOURCE]** Present today:

- `__tests__/gateway-stream-batching-test.ts:35-95` — coalescing, text+reasoning in one flush, tools
  flushed with text.
- `__tests__/message-reducer-test.ts:44` "tool call deltas merge by name", `:54` "same-name tool calls
  stay separate when their ids differ".
- `__tests__/message-reducer-tool-status-test.ts:42` "finalize preserves error and complete statuses",
  `:61` "stream error promotes a running tool to error".
- `__tests__/chat-turn-reattach-dedupe-test.ts` — replay-at-0 replaces text/reasoning/tools.
- `__tests__/chat-stream-unknown-delta-test.ts` — unknown block kinds surface as tool calls.
- `__tests__/chat-transcript-render-cost-test.ts` — source-scan assertions on memo/window settings.
- `__tests__/message-bubble-toggles-expanded-test.ts` — source-scan assertions on the activity/raw
  toggles.

**[INFERENCE]** Nothing exercises: a `complete`/`error` tool call followed by a status-less fragment
(E6); an array-form block that carries `status: 'error'` (E7); a command bubble with `status:
undefined` (E10); the *number* of rendered tool cards for two same-named array-form calls; or the
activity card's overflow contract (E4). That is precisely the reported surface. These are covered in
Section 6.

---

## 2. Ranked hypotheses

Confidence is about the *mechanism*, not about the report. "High" = the code path is proven and the
only unknown is whether the backend produces the input.

### H1 — Tool cards paint outside the activity card, over the body text. **High**

Evidence: E4. The card is `maxHeight: 320` with no `overflow` and no scroll container for the tool
list. With ≥5 tool cards in one turn the column exceeds the box.

Platform nuance that must not be guessed: RN `View` defaults to `overflow: 'visible'`, but Android
clipping behaviour for children differs by case, so the visible symptom may be "drawn over the text"
(iOS/web) or "cut off at the card's edge" (Android). Both are bugs; they are *different* bugs.

Falsified if: a device capture with 6+ tool cards shows the card clipped or scrolled exactly at 320 px
with no paint outside it.

### H2 — Thinking can never appear after the text that followed it. **High**

Evidence: E3. Reasoning has exactly one home, above the body. Any interleaving is flattened by
construction.

Falsified only by a renderer change, not by measurement: the current tree has no code path that
satisfies the report's implied expectation. This is a *design* answer, so the plan below is a
decision (keep the collapse, document it) rather than a bug fix — unless the human wants an ordered
parts model, which is a larger change and out of this step's scope.

### H3 — The stream → complete transition re-lays-out the whole answer. **Medium-High**

Evidence: E13 (single paragraph while streaming, parsed at completion) plus E5 (activity card
collapses on the same transition). Both happen in the same `setMessages`/render that flips
`streaming` false.

Symptom shape: text appears to "jump/reorder" once, at the end, exactly when the turn finishes — not
during streaming.

Falsified if: a recording of a turn with a list and a code fence shows no visible reflow at completion.

### H4 — Id-less same-name tool calls collapse into one card. **Medium**

Evidence: `message-reducer.ts:193-195` matches by `item.id` when present, else by `!item.id && item.name === toolCall.name`.
Array-form blocks never carry an id (E7), so two `read_file` calls in one frame merge into one card,
whose `detail` becomes the later call's arguments.

This is the intended merge for *fragmented* OpenAI `tool_calls` (accumulating name/args across
frames), so the fix is a discriminator, not a rule change: array-form blocks are complete invocations
and must not be merged by name.

Falsified if: captured frames show array-form backends always carrying a per-invocation id.

### H5 — An errored tool card can finish as "Done". **High (mechanism), unknown (frequency)**

Evidence: E6 + E7 + E9, with E8 explaining the post-reload variant.

Falsified if: no backend in use emits a status-less fragment after a terminal tool frame. The
regression test in Section 6 pins the invariant regardless.

### H6 — A cancelled command shows the success-toned "Done" badge. **High**

Evidence: E10. Purely app-side, no backend involvement.

Falsified if: no command bubble ever reaches render with `command.status === undefined` — which the
cancelled path at `gateway-provider.tsx:5523` contradicts.

### H7 — A stale error frame fails a turn that the Gate considers healthy. **Low-Medium**

Evidence: E11. Needs either a journal that replays past the requested `after`, or a proxy that ignores
the query — both are documented hazards in this file, neither is observed.

Falsified if: `GET /v1/turns/{id}/events?after=N` never returns frames with `id: <= N` (measurable
with a local Gate and a saved journal; M5).

### H8 — Fast streaming scrolls/recycles cells into a stale render. **Low, and not this step**

Evidence: E14. This is squarely the performance draft's territory; it is listed here only so the
layout claim is not silently attributed to it.

---

## 3. What "errors may appear Done" can honestly mean

Four distinct paths, in descending order of source certainty. A report that says only "errors appear
Done" cannot distinguish them; the first question to the reporter should be *which surface* — chat
tool card, command bubble, or a run in Activity.

| # | Path | Where | Evidence |
|---|------|-------|----------|
| 1 | Cancelled command bubble defaults to the success badge | `message-bubble.tsx:117-120`, `gateway-provider.tsx:5512-5527` | H6, [SOURCE]+[INFERENCE] |
| 2 | Any tool card without a status defaults to "Done" — including everything loaded from history | `tool-call-card.tsx:26`, `messages.ts:69-119`, `messages.ts:138-140` | E8, E9 |
| 3 | A terminal tool status is downgraded by a later fragment, then promoted to `complete` at finalize | `chat-stream-delta.ts:119`, `message-reducer.ts:196-222` | E6, E9 |
| 4 | Array-form tool blocks discard the provider's `status`, so an errored call is promoted to `complete` | `chat-stream-delta.ts:170`, `:178` | E7 |

None of these is "the model said an error and the UI lied"; they are all *status plumbing* losing a
verdict. That is a much cheaper fix than it sounds, and it does not touch wire semantics.

Adjacent, deliberately **not** claimed as part of this: a turn whose text is an upstream model-ID
refusal arriving as a normal completion (`gate/__tests__/backend-routes.test.mjs:3354` documents the
adjacent Stop-vs-abort history).

---

## 4. Proposed measurements (all [NOT RUN])

Nothing here was executed. Each item says what result would move a hypothesis from H to fact.

- **M1 — Which surface.** Ask the reporter for: platform (iOS/Android/web), the Chat tab vs a Bot, one
  screenshot at the moment of overlap, and whether the answer was still streaming. Web alone would
  promote E15's precedent; Android alone changes the H1 symptom from "paint over" to "clipped".
- **M2 — Card overflow, device.** Stream a turn that emits ≥6 tool calls (a scripted local Gate or the
  existing provider stub extended with tool frames — `gate/__tests__/fixtures/provider-stub.mjs:66-73`
  currently writes text only). Record a screen capture with the activity card open, then expanded by
  tap after the turn ends. Expected under H1: cards continue past the 320 px box, over the answer.
- **M3 — Reflow at completion.** Same turn, with one unordered list and one fenced code block in the
  answer. Screen-record at 60 fps and step frame-by-frame across the `streaming: true → false`
  transition. Expected under H3: the body's glyph positions change wholesale in one frame.
- **M4 — Batcher vs sequential equivalence, hermetic.** A pure test (Section 6, T1) that compares a
  batched flush against one-delta-at-a-time application on the final message. If they differ, the
  batcher *is* reordering and every other hypothesis is secondary.
- **M5 — Replay past `after`, hermetic or local.** With a saved turn journal containing a mid-turn
  error frame, request `events?after=<seq beyond it>` and record the frames actually returned.
  Result informs H7 without a live provider.
- **M6 — Re-render containment (shared with the performance draft).** React DevTools Profiler, one
  30 s turn: how many `MessageBubble` commits, and are all non-streaming bubbles absent from them.
  This confirms or refutes E14's memo inference. It is listed here only because H1/H3 changes must
  not regress it; the FPS work belongs to `performance_diagnosis`.

Explicitly **not** measured and not to be claimed: device FPS, time-to-first-token, markdown parse
cost per token, or any Gate-side latency.

---

## 5. Proposed fix steps (plan only — no code in this step)

Each step is independently landable, keeps the visual language, and comes with its own acceptance
test. Order is by confidence, not dependency: S1–S4 are independent.

**S1 — Clip or scroll the activity card (H1).**
Scope: `src/components/chat/message-bubble.tsx` only. Either give the tool list its own bounded
`ScrollView` (`nestedScrollEnabled`, matching `styles.reasoningScroll`) or set `overflow: 'hidden'`
on `styles.activityCard`. Prefer the scroll container if the card is expected to hold many calls,
because hiding them silently loses the evidence a card exists to show; if the decision is clipping,
say so in a comment. Do not change the 320 px cap without a design call.
Acceptance: T5 (props-level) plus M2 (device) recorded in the PR.

**S2 — Preserve terminal tool status (H5).**
Scope: `src/lib/gateway/chat-stream-delta.ts` (remember the last explicitly reported status per index
in `ChatStreamAcc`, and never emit an implied `running` over it) and, if needed,
`src/lib/gateway/message-reducer.ts` (merge must not downgrade `complete`/`error`). Read `item.status`
on the array-form path as the `tool_calls` path already does. No wire change.
Acceptance: T2, T3.

**S3 — Stop defaulting status to Done (H6, E8/E9).**
Scope: `src/components/chat/message-bubble.tsx` (command badge), `src/components/chat/tool-call-card.tsx`
(no-status card). Choose explicit copy — for example a neutral caption for a command bubble whose
status was cleared, and "Unknown" for a history tool card — rather than silently inheriting success.
`src/lib/gateway/messages.ts` may need to stop forcing `'complete'`; that is a data change, so it must
come with a test asserting what a reloaded failed tool now shows.
Acceptance: T4, T6. This is the step a reviewer is most likely to have an opinion on: it changes
visible copy for history turns, so it needs a design ack.

**S4 — Make the stale-error gate consistent (H7).**
Scope: `src/lib/gateway/turns.ts`. Move the `seq <= after` decision above the error branch, or record
the error with its seq and drop it with the frame. Keep the live-send semantics identical
(`after === 0` must still fail on an error frame).
Acceptance: T7.

**S5 — Document the flattening instead of "fixing" it (H2).**
Scope: comment only, in `message-bubble.tsx` next to the activity block, stating that thinking has one
home above the body and that interleaved thinking is deliberately not represented. If the human wants
real interleaving, that is an ordered-parts redesign (new message model + migration of persisted
transcripts) and must be its own plan; this draft does not propose it.
Acceptance: no test; a reviewer's ack that the comment matches the design.

**S6 — (Only if H4 is confirmed) separate array-form invocations.**
Scope: `chat-stream-delta.ts` / `message-reducer.ts`. Give array-form calls a per-frame discriminator
(e.g. include the block's own `id` when it has one, else mark the call as a complete invocation so the
by-name fragment merge does not apply). No rendering change.
Acceptance: T8.

**S7 — (Decision needed) failure copy vs streamed text.**
E12: a refused turn replaces the partial answer with `Error: …`. If the intended rule is "keep what
streamed", mirror the interrupted path; if not, document why. No change without an ack.

---

## 6. Regression test design

All of these are hermetic: pure functions or `react-test-renderer` (`create` is already used in
`__tests__/activity-pull-sequential-reads-test.tsx` and others). None needs a device, a network call,
or a live Gate. Every test below is written to fail *before* its fix — a test that passes on today's
code is listed as a pin, not a regression test.

**T1 — Batcher preserves final state (pin).** `__tests__/chat-stream-batching-order-test.ts`: apply a
scripted frame list through `createStreamBatcher` with an injected scheduler, and compare the final
`ChatMessage` against applying the same deltas through the three `append*Delta` reducers one at a
time. Asserts text, reasoning and the ordered tool array are equal. Pins that coalescing never
reorders, and would catch any future "apply tools before text" change.

**T2 — Terminal status survives a status-less fragment (red today).**
`__tests__/chat-stream-delta-terminal-status-test.ts`: interpret `complete` (and separately `error`)
for index 0, then a name/args-only fragment for index 0; assert the second interpretation reports the
terminal status, and that the reducer still holds it.

**T3 — Array-form status is honoured (red today).** Same file: an array-form block
`{ type: 'tool_use', name: 'read_file', status: 'error' }` must produce `status: 'error'`, and
`finalizeStreamingMessage` must leave it errored. Uses the existing fixture style of
`__tests__/chat-stream-unknown-delta-test.ts`.

**T4 — A cancelled command is not "Done".** `__tests__/message-bubble-command-status-test.tsx`:
render `MessageBubble` with a `command` whose `status` is `undefined` and text `Cancelled: /run`, and
assert the badge label is not "Done" and not success-toned. Pin the chosen copy after S3.

**T5 — The activity card cannot paint outside its box.** Two honest options, take one:
(a) props-level: render with 8 tool calls and assert the tool list is inside a `ScrollView` with the
bounded style, or that `styles.activityCard` carries `overflow: 'hidden'`; (b) source-scan, in the
idiom of `__tests__/chat-transcript-render-cost-test.ts`. Whichever is chosen, the test asserts the
*contract* (bounded, never painted over the body), not a pixel height.

**T6 — History does not invent success.** `__tests__/messages-tool-status-test.ts`: a history message
carrying a `role: 'tool'` result with an error marker, and the matching assistant `tool_calls` entry,
must produce a card whose status is not `complete` (or must be excluded with an explicit reason —
whichever S3 decides, the test pins it and the comment says which).

**T7 — Stale error frames are stale.** `__tests__/turn-events-after-gate-test.ts`: feed `readChatFrames`
an SSE body where the error frame carries `id: 1` and `after: 3`, followed by a normal delta at
`id: 4` and `[DONE]`. Assert the turn completes and the error is not thrown. A second case with the
error at `id: 4` asserts it still fails. Existing `transport` is injectable in that signature
(`turns.ts:262-269`).

**T8 — Two array-form invocations are two cards (only if S6).**
`__tests__/message-reducer-tool-identity-test.ts`: two id-less `read_file` blocks with different
arguments must produce two cards with their own details.

**T9 — The streaming→complete render is deliberate (pin).**
`__tests__/markdown-streaming-contract-test.ts`: `markdownBlocksForDisplay(text, true)` is one
paragraph; `(text, false)` yields the parsed blocks for the same text. Pins E13 so a future "parse
while streaming" optimisation is a deliberate change, not a silent one.

No existing test is to be modified, skipped, or loosened to make any of these pass. `message-reducer-test.ts:44`
("merge by name") and `message-reducer-tool-status-test.ts:42` ("finalize preserves error and complete
statuses") stay exactly as they are; T2/T3 add cases they do not cover, and if either existing test
contradicts a fix, that is a design conflict to escalate, not to edit away.

---

## 7. Reproduction protocol for a human

Ordered cheapest-first. Steps 1–3 need no device.

1. **Hermetic, no Gate:** run `npx jest --runInBand __tests__/gateway-stream-batching-test.ts __tests__/chat-stream-delta-test.ts __tests__/message-reducer-tool-status-test.ts` at this HEAD and record the output. This is a baseline, not evidence of the bug.
2. **Hermetic, scripted frames:** extend `gate/__tests__/fixtures/provider-stub.mjs` (text-only today,
   `:66-73`) with a tool-heavy turn: two same-name calls, one array-form error block, one
   status-less trailing fragment, reasoning interleaved with text. Drive it through
   `client.streamChat` in a Jest test with the stub as the transport target. This reproduces the
   *ordering and status* claims without any real provider.
3. **Hermetic, render:** mount `MessageBubble` with that final message via `react-test-renderer` and
   snapshot the tree order (activity block before body) and the number of `ToolCallCard`s. This is
   where H4 shows up as a count, not a screenshot.
4. **Device, layout only:** with an authorised dev Gate, run the M2 turn and capture a screen
   recording. Record the platform, the model id, and whether the overlap persisted after the turn
   ended (H1 says yes; a scroll race says no).
5. **Local Gate, journal only:** M5, against a throwaway Gate on localhost with a saved journal. Do
   not point this at any live service.

What to attach to the eventual PR: the jest outputs from 1–3, the recording from 4, and the frame list
from 5. What **not** to attach or claim: FPS numbers, "reproduced" language without 4 or 5, or a
provider id inferred from a locked model.

---

## 8. Risks, and what would make this draft wrong

- **H1 could be a platform artifact.** If the report is Android-only and children are clipped there,
  the symptom is "cards cut off", which is a different fix (scroll, not clip). S1 covers both, but the
  copy and the acceptance test differ.
- **H2 might be the actual complaint** rather than a footnote. If the operator expects thinking to
  appear where it happened, no layout tweak satisfies them; S5's comment would be papering over it.
  Ask before merging S5.
- **S2/S3 touch status semantics**, which the activity draft and the runs surfaces also read. The
  `ChatToolCall.status` union is shared (`types.ts:216-223`); no new value should be invented without
  checking every reader (`ToolCallCard`, `message-actions-sheet.tsx:41`, the tools pane).
- **E11's fix could mask real failures** if `after` is ever wrong. T7 keeps the non-stale case red-on-
  failure, which is the guard.
- **This tree cannot see the backend.** Every statement about what a provider emits is an inference
  from what the app *accepts*. If the real backends never produce the inputs in H4–H7, those
  hypotheses are dead on arrival and the cost is the tests only.

---

## 9. Handoff

- Check for this step: `grep -q Evidence docs/plans/overnight-chat-streaming.md` — passes only on the
  word, nothing else.
- Required before merge: full `npm run verify` (config, `tsc`, lint, coverage, ratchet, gate tests) by
  a reviewer, plus a read of the diff to confirm no test was weakened and no visual language changed.
- This draft modifies **only** this file. It contains no code change, no test, no fixture.
- Next steps, in the order this draft argues for: S2, S3 (status truth), S1 (layout containment), S4
  (stale frames), S6 only if H4 is confirmed, S5/S7 on a human ack.
