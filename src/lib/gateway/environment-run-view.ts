import type { EnvironmentRunEvent } from './environment-types';

/** Lifecycle of a CLI run as the operator sees it. */
export type EnvironmentRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * The assembled view of one run: streamed stdout folded into a single reply,
 * stderr kept aside as diagnostics, and the terminal outcome. Built purely
 * from the event log so the launcher can re-render it on every event.
 */
export type EnvironmentRunView = {
  status: EnvironmentRunStatus;
  /** Assembled stdout — the buyer's streamed reply. */
  replyText: string;
  /** Assembled stderr — diagnostics, not part of the reply. */
  stderrText: string;
  exitCode: number | null;
  /** Human detail for a failed run (message or exit code). */
  failureDetail: string | null;
  /** Lines for events that carry no output text and are not lifecycle. */
  notes: string[];
};

function eventText(payload: Record<string, unknown>): string | null {
  const candidate = payload.text ?? payload.delta ?? payload.output;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function noteFor(event: EnvironmentRunEvent): string {
  const payload = JSON.stringify(event.payload ?? {});
  return `${event.type} ${payload}`.trim();
}

/**
 * What one event contributes to the fold. A part depends only on its own
 * event, never on the events folded before it — the terminal-is-one-way rule
 * lives in `applyPart` — so a part can be computed once and reused.
 */
type RunPart =
  | { kind: 'start' }
  | { kind: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'completed'; exitCode: number | null }
  | { kind: 'failed'; exitCode: number | null; failureDetail: string }
  | { kind: 'cancelled'; failureDetail: string | null }
  | { kind: 'none' };

const TERMINAL_EVENT = /^run\.(completed|failed|cancelled)$/;

/** Read one event's contribution. Unknown shapes degrade to notes, never throw. */
function derivePart(event: EnvironmentRunEvent): RunPart {
  if (TERMINAL_EVENT.test(event.type)) {
    const payload = event.payload ?? {};
    const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
    if (event.type === 'run.completed') return { kind: 'completed', exitCode };
    if (event.type === 'run.failed') {
      const message = typeof payload.message === 'string' ? payload.message : '';
      return {
        kind: 'failed',
        exitCode,
        failureDetail: message || (exitCode !== null ? `exited with code ${exitCode}` : 'run failed'),
      };
    }
    const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : null;
    return { kind: 'cancelled', failureDetail: reason };
  }
  if (event.type === 'run.started') return { kind: 'start' };
  if (event.type === 'run.output') {
    const payload = event.payload ?? {};
    const text = eventText(payload);
    if (!text) return { kind: 'note', text: noteFor(event) };
    return { kind: 'output', stream: payload.stream === 'stderr' ? 'stderr' : 'stdout', text };
  }
  // Approval requests render as their own action card in the launcher.
  if (/approval/i.test(event.type)) return { kind: 'none' };
  // A Gate-emitted note carries operator-facing text (e.g. a dead credential
  // binding warning); show its message rather than raw JSON.
  if (event.type === 'run.note') {
    const message = event.payload?.message;
    return { kind: 'note', text: typeof message === 'string' && message ? message : noteFor(event) };
  }
  return { kind: 'note', text: noteFor(event) };
}

/**
 * Parts are memoised per event object, so a frame that survives several folds
 * pays for its payload read, note stringify and exit-code interpretation once.
 * The event object itself is only ever read, never written.
 */
const parts = new WeakMap<EnvironmentRunEvent, RunPart>();

function partFor(event: EnvironmentRunEvent): RunPart {
  const memoised = parts.get(event);
  if (memoised) return memoised;
  const part = derivePart(event);
  parts.set(event, part);
  return part;
}

/**
 * Chunks of one stream in arrival order, as an **immutable** persistent log:
 * appending at the tail or evicting the head returns a new log that shares
 * every block with the log it came from.
 *
 * Sharing is what lets two windows — an ancestor and the window that grew out
 * of it — both stay folded. Folding a frame therefore returns new state; it
 * never mutates the state a previous window is cached under, so re-reading
 * that window is still a cache hit and a repeated append is still cheap.
 *
 * Blocks are fixed-size arrays of chunks, so a push copies at most one block
 * plus the block index; a shift only advances an offset and compacts the block
 * index once half of it is dead, which is O(1) amortised. Retained memory is
 * bounded by roughly twice the retained chunks, so the cap still caps the heap.
 */
const CHUNK_BLOCK = 256;

type ChunkLog = {
  /** Sealed chunks; `blocks[start]` holds the oldest retained chunk. */
  readonly blocks: readonly (readonly string[])[];
  /** Index of the live head block. Earlier blocks are dead. */
  readonly start: number;
  /** Offset of the oldest retained chunk inside `blocks[start]`. */
  readonly offset: number;
  /** How many chunks are retained. */
  readonly length: number;
};

const EMPTY_LOG: ChunkLog = { blocks: [], start: 0, offset: 0, length: 0 };

function loneLog(text: string): ChunkLog {
  return { blocks: [[text]], start: 0, offset: 0, length: 1 };
}

function logPush(log: ChunkLog, text: string): ChunkLog {
  const length = log.length + 1;
  if (log.length === 0) return loneLog(text);
  const last = log.blocks.length - 1;
  const tail = log.blocks[last];
  if (tail.length < CHUNK_BLOCK) {
    return {
      blocks: [...log.blocks.slice(0, last), [...tail, text]],
      start: log.start,
      offset: log.offset,
      length,
    };
  }
  return { blocks: [...log.blocks, [text]], start: log.start, offset: log.offset, length };
}

/** Drop the oldest chunk. Only called when the log is known non-empty. */
function logShift(log: ChunkLog): ChunkLog {
  const length = log.length - 1;
  const offset = log.offset + 1;
  if (offset < log.blocks[log.start].length) {
    return { blocks: log.blocks, start: log.start, offset, length };
  }
  const start = log.start + 1;
  // Release consumed blocks once they outnumber the live ones: each block is
  // copied into a smaller index at most once per block worth of evictions.
  if (start * 2 < log.blocks.length) {
    return { blocks: log.blocks, start, offset: 0, length };
  }
  return { blocks: log.blocks.slice(start), start: 0, offset: 0, length };
}

/** Retained chunks in arrival order, as a fresh array. */
function logChunks(log: ChunkLog): string[] {
  const chunks: string[] = [];
  for (let index = log.start; index < log.blocks.length; index += 1) {
    const block = log.blocks[index];
    for (let offset = index === log.start ? log.offset : 0; offset < block.length; offset += 1) {
      chunks.push(block[offset]);
    }
  }
  return chunks;
}

/**
 * Fold one event into a running view. This is the cold reference the
 * incremental fold has to match: `events.reduce(reduceEnvironmentRunEvent,
 * emptyView)` and `environmentRunView(events)` must always agree.
 */
export function reduceEnvironmentRunEvent(view: EnvironmentRunView, event: EnvironmentRunEvent): EnvironmentRunView {
  if (isTerminalStatus(view.status)) return view;
  // The view's strings are already assembled text, so they enter the fold as
  // their own chunk; appending keeps them in arrival order.
  const fold: RunFold = {
    status: view.status,
    exitCode: view.exitCode,
    failureDetail: view.failureDetail,
    stdout: view.replyText ? loneLog(view.replyText) : EMPTY_LOG,
    stderr: view.stderrText ? loneLog(view.stderrText) : EMPTY_LOG,
    notes: view.notes.length > 0 ? { blocks: [[...view.notes]], start: 0, offset: 0, length: view.notes.length } : EMPTY_LOG,
    started: view.status === 'running' ? 1 : 0,
  };
  return viewOf(applyPart(fold, partFor(event)));
}

/**
 * Optional bookkeeping for diagnostics and tests. It only observes how much
 * folding a call did; it never changes the view a caller receives.
 */
export type EnvironmentRunViewWork = {
  /** Event parts folded into a run view (incremental or cold). */
  folded?: number;
  /** Event parts taken back out when the cap evicted the head of the log. */
  removed?: number;
  /** Windows that had to be folded from cold (no usable ancestor). */
  rebuilt?: number;
};

type WorkField = 'folded' | 'removed' | 'rebuilt';

function bump(work: EnvironmentRunViewWork | undefined, field: WorkField, amount = 1): void {
  if (work) work[field] = (work[field] ?? 0) + amount;
}

/**
 * What the fold knows so far. Every fold operation returns a new value; the
 * only work it pays for is the part it was handed (plus the one chunk a head
 * eviction takes back out), never the whole retained log.
 */
type RunFold = {
  readonly status: EnvironmentRunStatus;
  readonly exitCode: number | null;
  readonly failureDetail: string | null;
  readonly stdout: ChunkLog;
  readonly stderr: ChunkLog;
  readonly notes: ChunkLog;
  /** `run.started` parts inside the folded prefix; the run is idle at zero. */
  readonly started: number;
};

const EMPTY_FOLD: RunFold = {
  status: 'idle',
  exitCode: null,
  failureDetail: null,
  stdout: EMPTY_LOG,
  stderr: EMPTY_LOG,
  notes: EMPTY_LOG,
  started: 0,
};

function isTerminalStatus(status: EnvironmentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Materialise one fold as the view a caller sees. Every call is its own value. */
function viewOf(fold: RunFold): EnvironmentRunView {
  return {
    status: fold.status,
    replyText: logChunks(fold.stdout).join(''),
    stderrText: logChunks(fold.stderr).join(''),
    exitCode: fold.exitCode,
    failureDetail: fold.failureDetail,
    notes: logChunks(fold.notes),
  };
}

/** Fold one part into a new fold state. */
function applyPart(fold: RunFold, part: RunPart): RunFold {
  // Terminal is one-way (mirrors the Gate's event log): a late or replayed
  // frame must not drag a finished run back to running.
  if (isTerminalStatus(fold.status)) return fold;
  switch (part.kind) {
    case 'start':
      return { ...fold, status: 'running', started: fold.started + 1 };
    case 'output':
      return part.stream === 'stderr'
        ? { ...fold, stderr: logPush(fold.stderr, part.text) }
        : { ...fold, stdout: logPush(fold.stdout, part.text) };
    case 'note':
      return { ...fold, notes: logPush(fold.notes, part.text) };
    case 'completed':
      return { ...fold, status: 'completed', exitCode: part.exitCode ?? 0 };
    case 'failed':
      return {
        ...fold,
        status: 'failed',
        exitCode: part.exitCode,
        failureDetail: part.failureDetail,
      };
    case 'cancelled':
      return { ...fold, status: 'cancelled', failureDetail: part.failureDetail };
    case 'none':
      return fold;
  }
}

/**
 * Take one folded part back out, in arrival order, so evicting the head of the
 * window costs one chunk shift — not a rebuild. Terminal parts are never
 * removed here: they are the last folded event, and a head that would take the
 * terminal with it makes the caller fold the remaining window from cold.
 */
function removePart(fold: RunFold, part: RunPart): RunFold {
  switch (part.kind) {
    case 'start': {
      const started = Math.max(0, fold.started - 1);
      // A window whose `run.started` fell out starts idle again, exactly as a
      // cold fold of that window would say.
      const status = started === 0 && !isTerminalStatus(fold.status) ? 'idle' : fold.status;
      return { ...fold, started, status };
    }
    case 'output':
      return part.stream === 'stderr'
        ? { ...fold, stderr: logShift(fold.stderr) }
        : { ...fold, stdout: logShift(fold.stdout) };
    case 'note':
      return { ...fold, notes: logShift(fold.notes) };
    case 'none':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return fold;
  }
}

/**
 * A fold plus the window it describes. The fold covers the window's **live
 * prefix**: everything up to and including the first terminal part. Frames the
 * cap keeps but cold folding would ignore (anything after a terminal) are
 * inert and are not folded.
 */
type RunFoldState = {
  /** The exact array this state was assembled from. Arrays are snapshots. */
  readonly window: readonly EnvironmentRunEvent[];
  /** How many events the window held when it was folded. */
  readonly size: number;
  readonly fold: RunFold;
  /** How many leading window events the fold covers. */
  readonly live: number;
};

function foldEvent(state: RunFoldState, event: EnvironmentRunEvent, work?: EnvironmentRunViewWork): RunFoldState {
  if (isTerminalStatus(state.fold.status)) return state;
  bump(work, 'folded');
  return { ...state, fold: applyPart(state.fold, partFor(event)), live: state.live + 1 };
}

/** Fold a whole window from nothing, stopping at its first terminal part. */
function coldState(window: readonly EnvironmentRunEvent[], work?: EnvironmentRunViewWork): RunFoldState {
  let state: RunFoldState = { window, size: window.length, fold: EMPTY_FOLD, live: 0 };
  while (state.live < state.size && !isTerminalStatus(state.fold.status)) {
    state = foldEvent(state, window[state.live], work);
  }
  if (window.length > 0) bump(work, 'rebuilt');
  return state;
}

/**
 * Evict `drop` events from the head of the folded window. Their contributions
 * come back out of the same logs in arrival order, so replaying the drop costs
 * one shift per evicted chunk. If the drop takes the whole live prefix with it
 * (including a terminal), state cannot be replayed backwards: the window that
 * remains is folded from cold once.
 */
function dropParts(state: RunFoldState, drop: number, work?: EnvironmentRunViewWork): RunFoldState {
  if (drop <= 0) return state;
  if (drop >= state.live) return coldState(state.window.slice(drop), work);
  let fold = state.fold;
  for (let index = 0; index < drop; index += 1) {
    bump(work, 'removed');
    fold = removePart(fold, partFor(state.window[index]));
  }
  return { ...state, fold, live: state.live - drop };
}

/**
 * Fold one event in at the *front* of the window. `capRunEvents` re-inserts the
 * `run.started` marker this way when the tail has scrambled past it, so this
 * is normally a status marker, never output: it must not reorder the reply.
 * A part that could not be prepended falls back to a cold fold of the window
 * it was building, which keeps the result exact.
 */
function prependPart(state: RunFoldState, event: EnvironmentRunEvent, work?: EnvironmentRunViewWork): RunFoldState {
  const part = partFor(event);
  if (part.kind === 'start' || part.kind === 'none') {
    bump(work, 'folded');
    return {
      ...state,
      fold: part.kind === 'start' ? applyPart(state.fold, part) : state.fold,
      live: state.live + 1,
    };
  }
  return coldState([event, ...state.window], work);
}

/** How one streamed append reshapes the capped window. */
type WindowStep = {
  /** The window the caller keeps. */
  readonly window: EnvironmentRunEvent[];
  /** How many leading events of the appended list the window dropped. */
  readonly drop: number;
  /** An event re-inserted at the front (`run.started`), when the tail lost it. */
  readonly prepend: EnvironmentRunEvent | null;
};

/**
 * How many streamed events one run may keep in memory. A chatty CLI can emit
 * thousands of frames in a single run; the sheet folds them into one reply, so
 * the tail is what matters and the head can go.
 */
export const MAX_RUN_EVENTS = 2000;

/** Work out the retained window, and what it did to the head of the list. */
function capWindow(events: EnvironmentRunEvent[]): WindowStep {
  if (events.length <= MAX_RUN_EVENTS) return { window: events, drop: 0, prepend: null };
  const kept = events.slice(-MAX_RUN_EVENTS);
  const opened = events.find((event) => event.type === 'run.started');
  if (!opened || kept.includes(opened)) {
    return { window: kept, drop: events.length - MAX_RUN_EVENTS, prepend: null };
  }
  return {
    window: [opened, ...kept.slice(-(MAX_RUN_EVENTS - 1))],
    drop: events.length - MAX_RUN_EVENTS + 1,
    prepend: opened,
  };
}

/** Keep the newest MAX_RUN_EVENTS, plus the `run.started` marker if the tail
 *  has already dropped it, so the bubble still says the run opened. */
export function capRunEvents(events: EnvironmentRunEvent[]): EnvironmentRunEvent[] {
  return capWindow(events).window;
}

/**
 * Fold states, keyed by the exact window array they describe. Two arrays with
 * equal contents are still two windows: a state is only reused for the array
 * it was built from, so a streamed append can never read another run's text.
 */
const states = new WeakMap<readonly EnvironmentRunEvent[], RunFoldState>();

/**
 * The most recently folded window. It lets a caller that builds its own
 * immutable extension (`[...events, frame]`) reuse the ancestor's fold instead
 * of re-folding the whole log. The candidate is only accepted after its whole
 * retained prefix is confirmed by reference, so this is a cache, not a guess.
 */
let lastState: RunFoldState | null = null;

/** Reuse the last window's fold when `events` is confirmed to extend it. */
function extendLast(events: readonly EnvironmentRunEvent[], work?: EnvironmentRunViewWork): RunFoldState | null {
  const previous = lastState;
  if (!previous) return null;
  if (events.length <= previous.size) return null;
  for (let index = 0; index < previous.size; index += 1) {
    if (events[index] !== previous.window[index]) return null;
  }
  let state = previous;
  for (let index = previous.size; index < events.length; index += 1) {
    state = foldEvent(state, events[index], work);
  }
  return remember({ ...state, window: events, size: events.length });
}

function remember(state: RunFoldState): RunFoldState {
  states.set(state.window, state);
  lastState = state;
  return state;
}

/** The fold for a window, reusing whatever ancestor is provably the same log. */
function stateFor(events: readonly EnvironmentRunEvent[], work?: EnvironmentRunViewWork): RunFoldState {
  const cached = states.get(events);
  if (cached) {
    if (cached.size === events.length) return cached;
    // The array was appended to in place: derive a longer state, leaving the
    // shorter one that another caller may still hold valid for its own length.
    if (cached.size < events.length) {
      let state = cached;
      for (let index = cached.size; index < events.length; index += 1) {
        state = foldEvent(state, events[index], work);
      }
      return remember({ ...state, window: events, size: events.length });
    }
    // The array shrank under us; fold it as it stands.
    states.delete(events);
  }
  return extendLast(events, work) ?? remember(coldState(events, work));
}

/**
 * Assemble a run's event log into one view.
 *
 * The launcher re-renders on every streamed frame and hands the whole growing
 * list here, but `capRunEvents` trims the head once a run is chatty, so the
 * list is not an extension of the last one and only the retained window may
 * count: text from evicted frames has to disappear with them.
 *
 * The fold therefore lives beside the window: a state follows the log through
 * `appendRunEvent`, folding the appended frame and shifting the evicted head
 * out of the chunk logs. A window with no such ancestor (the first render, a
 * reset, or a run whose terminal frame the cap evicted) is folded from cold
 * exactly once, so the result is always identical to folding the window from
 * nothing. States are immutable, so a window that is asked for again — the
 * second call of a state updater, an interleaved second run, or the frame that
 * preceded an append — is answered from the cache instead of being re-folded.
 */
export function environmentRunView(
  events: readonly EnvironmentRunEvent[],
  work?: EnvironmentRunViewWork,
): EnvironmentRunView {
  return viewOf(stateFor(events, work).fold);
}

/**
 * Append one streamed frame the way the launcher does, keeping the log capped.
 *
 * The returned array carries the updated fold, so the render that follows pays
 * only for the new frame plus the frames the cap dropped — not for the whole
 * retained window. The fold of `events` is never mutated, so calling this
 * twice with the same input (a replayed updater) folds the frame twice at most
 * and both answers are identical.
 */
export function appendRunEvent(
  events: readonly EnvironmentRunEvent[],
  event: EnvironmentRunEvent,
  work?: EnvironmentRunViewWork,
): EnvironmentRunEvent[] {
  const previous = stateFor(events, work);
  const step = capWindow([...events, event]);
  let state = dropParts(previous, step.drop, work);
  if (step.prepend !== null) state = prependPart(state, step.prepend, work);
  state = foldEvent(state, step.window[step.window.length - 1], work);
  remember({ ...state, window: step.window, size: step.window.length });
  return step.window;
}

export type EnvironmentRunBadge = { label: string; tone: 'accent' | 'success' | 'danger' | 'neutral' };

/** The terminal-state badge for a view; null while nothing has happened yet. */
export function environmentRunBadge(
  view: EnvironmentRunView,
  opts: { starting?: boolean } = {},
): EnvironmentRunBadge | null {
  switch (view.status) {
    case 'completed':
      return { label: `Completed · exit ${view.exitCode ?? 0}`, tone: 'success' };
    case 'failed':
      return { label: view.exitCode !== null ? `Failed · exit ${view.exitCode}` : 'Failed', tone: 'danger' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'running':
      return { label: 'Running', tone: 'accent' };
    case 'idle':
      return opts.starting ? { label: 'Starting', tone: 'accent' } : null;
  }
}
