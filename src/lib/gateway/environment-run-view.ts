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

const EMPTY_VIEW: EnvironmentRunView = {
  status: 'idle',
  replyText: '',
  stderrText: '',
  exitCode: null,
  failureDetail: null,
  notes: [],
};

function eventText(payload: Record<string, unknown>): string | null {
  const candidate = payload.text ?? payload.delta ?? payload.output;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function noteFor(event: EnvironmentRunEvent): string {
  const payload = JSON.stringify(event.payload ?? {});
  return `${event.type} ${payload}`.trim();
}

function terminalView(
  status: Extract<EnvironmentRunStatus, 'completed' | 'failed' | 'cancelled'>,
  view: EnvironmentRunView,
  event: EnvironmentRunEvent,
): EnvironmentRunView {
  const payload = event.payload ?? {};
  const next = { ...view, status };
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
  if (status === 'completed') {
    next.exitCode = exitCode ?? 0;
    return next;
  }
  if (status === 'failed') {
    next.exitCode = exitCode;
    next.failureDetail =
      typeof payload.message === 'string' && payload.message
        ? payload.message
        : exitCode !== null
          ? `exited with code ${exitCode}`
          : 'run failed';
    return next;
  }
  next.failureDetail = typeof payload.reason === 'string' && payload.reason ? payload.reason : null;
  return next;
}

/** Fold one event into the running view. Unknown shapes degrade to notes, never throw. */
export function reduceEnvironmentRunEvent(view: EnvironmentRunView, event: EnvironmentRunEvent): EnvironmentRunView {
  // Terminal is one-way (mirrors the Gate's event log): a late or replayed
  // frame must not drag a finished run back to running.
  if (view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled') {
    return view;
  }
  if (/^run\.(completed|failed|cancelled)$/.test(event.type)) {
    return terminalView(event.type.slice(4) as 'completed' | 'failed' | 'cancelled', view, event);
  }
  if (event.type === 'run.started') {
    return { ...view, status: 'running' };
  }
  if (event.type === 'run.output') {
    const payload = event.payload ?? {};
    const text = eventText(payload);
    if (!text) return { ...view, notes: [...view.notes, noteFor(event)] };
    const stream = payload.stream;
    if (stream === 'stderr') {
      return { ...view, stderrText: view.stderrText + text };
    }
    return { ...view, replyText: view.replyText + text };
  }
  // Approval requests render as their own action card in the launcher.
  if (/approval/i.test(event.type)) return view;
  // A Gate-emitted note carries operator-facing text (e.g. a dead credential
  // binding warning); show its message rather than raw JSON.
  if (event.type === 'run.note') {
    const message = event.payload?.message;
    return { ...view, notes: [...view.notes, typeof message === 'string' && message ? message : noteFor(event)] };
  }
  return { ...view, notes: [...view.notes, noteFor(event)] };
}

/** Assemble the full event log into one view. */
export function environmentRunView(events: readonly EnvironmentRunEvent[]): EnvironmentRunView {
  return events.reduce(reduceEnvironmentRunEvent, EMPTY_VIEW);
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
