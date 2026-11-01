import {
  appendRunEvent,
  environmentRunBadge,
  environmentRunView,
  MAX_RUN_EVENTS,
  reduceEnvironmentRunEvent,
  type EnvironmentRunView,
  type EnvironmentRunViewWork,
} from '@/lib/gateway/environment-run-view';
import type { EnvironmentRunEvent } from '@/lib/gateway/environment-types';

function event(sequence: number, type: string, payload: Record<string, unknown> = {}): EnvironmentRunEvent {
  return { runId: 'run-1', sequence, timestamp: '2026-08-21T00:00:00.000Z', type, payload };
}

const IDLE_VIEW: EnvironmentRunView = {
  status: 'idle',
  replyText: '',
  stderrText: '',
  exitCode: null,
  failureDetail: null,
  notes: [],
};

/**
 * The reference assembly: fold the list one event at a time from an empty
 * view. `environmentRunView` must always agree with it, including after the
 * log cap has dropped events from the head.
 */
function coldFold(events: readonly EnvironmentRunEvent[]): EnvironmentRunView {
  return events.reduce(reduceEnvironmentRunEvent, IDLE_VIEW);
}

describe('environment run view', () => {
  it('assembles split stdout deltas into one reply in arrival order', () => {
    const view = environmentRunView([
      event(1, 'run.started', { operation: 'prompt', sandbox: 'workspace' }),
      event(2, 'run.output', { stream: 'stdout', text: 'Hel' }),
      event(3, 'run.output', { stream: 'stdout', text: 'lo, ' }),
      event(4, 'run.output', { stream: 'stdout', text: 'world\n' }),
    ]);
    expect(view.replyText).toBe('Hello, world\n');
    expect(view.stderrText).toBe('');
    expect(view.status).toBe('running');
  });

  it('keeps stderr out of the reply', () => {
    const view = environmentRunView([
      event(1, 'run.output', { stream: 'stderr', text: 'warn: legacy flag\n' }),
      event(2, 'run.output', { stream: 'stdout', text: 'pong' }),
    ]);
    expect(view.replyText).toBe('pong');
    expect(view.stderrText).toBe('warn: legacy flag\n');
  });

  it('treats output without a stream marker as reply text', () => {
    const view = environmentRunView([event(1, 'run.output', { text: 'plain' })]);
    expect(view.replyText).toBe('plain');
  });

  it('accepts delta and output payload fallbacks', () => {
    const view = environmentRunView([
      event(1, 'run.output', { delta: 'a' }),
      event(2, 'run.output', { output: 'b' }),
    ]);
    expect(view.replyText).toBe('ab');
  });

  it('marks completion with the exit code', () => {
    const view = environmentRunView([
      event(1, 'run.output', { stream: 'stdout', text: 'pong' }),
      event(2, 'run.completed', { exitCode: 0 }),
    ]);
    expect(view.status).toBe('completed');
    expect(view.exitCode).toBe(0);
    expect(view.failureDetail).toBeNull();
  });

  it('carries a failed run message and exit code', () => {
    const view = environmentRunView([event(1, 'run.failed', { message: 'spawn ENOENT', exitCode: 127 })]);
    expect(view.status).toBe('failed');
    expect(view.exitCode).toBe(127);
    expect(view.failureDetail).toBe('spawn ENOENT');
  });

  it('describes a failure that only has an exit code', () => {
    const view = environmentRunView([event(1, 'run.failed', { exitCode: 2 })]);
    expect(view.failureDetail).toBe('exited with code 2');
  });

  it('records a cancellation reason', () => {
    const view = environmentRunView([event(1, 'run.cancelled', { reason: 'cancelled' })]);
    expect(view.status).toBe('cancelled');
    expect(view.failureDetail).toBe('cancelled');
  });

  it('keeps unrecognised events as notes instead of dropping them', () => {
    const view = environmentRunView([event(1, 'run.paused', { until: 'later' })]);
    expect(view.notes).toEqual(['run.paused {"until":"later"}']);
  });

  it('does not duplicate approval events as notes', () => {
    const view = environmentRunView([event(1, 'run.approval.requested', { approvalId: 'a1', command: 'rm -rf' })]);
    expect(view.notes).toEqual([]);
  });

  it('degrades an output event with no text to a note', () => {
    const view = environmentRunView([event(1, 'run.output', {})]);
    expect(view.replyText).toBe('');
    expect(view.notes).toEqual(['run.output {}']);
  });

  it('shows a gate note as its message, not raw JSON', () => {
    const view = environmentRunView([
      event(1, 'run.started', { operation: 'prompt', sandbox: 'read_only' }),
      event(2, 'run.note', {
        level: 'warning',
        variable: 'ANTHROPIC_API_KEY',
        reference: 'provider/anthropic/api-key',
        message:
          'ANTHROPIC_API_KEY is bound to provider/anthropic/api-key but no value is stored for that reference — ' +
          'set the key on the Providers screen or remove the binding; this task starts without it.',
      }),
      event(3, 'run.output', { stream: 'stdout', text: 'pong' }),
    ]);
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]).toContain('no value is stored');
    expect(view.notes[0]).not.toContain('run.note');
    expect(view.replyText).toBe('pong');
  });

  it('falls back to raw JSON for a note without a message', () => {
    const view = environmentRunView([event(1, 'run.note', { level: 'info' })]);
    expect(view.notes).toEqual(['run.note {"level":"info"}']);
  });

  it('starts idle and empty', () => {
    const view = environmentRunView([]);
    expect(view).toEqual({
      status: 'idle',
      replyText: '',
      stderrText: '',
      exitCode: null,
      failureDetail: null,
      notes: [],
    });
  });

  it('ignores events after the terminal event', () => {
    const view = reduceEnvironmentRunEvent(
      environmentRunView([event(1, 'run.completed', { exitCode: 0 })]),
      event(2, 'run.output', { stream: 'stdout', text: 'late' }),
    );
    expect(view.replyText).toBe('');
    expect(view.status).toBe('completed');
  });

  describe('incremental folding', () => {
    it('folds only newly appended events instead of refolding the whole log', () => {
      let reads = 0;
      const makeOutput = (index: number): EnvironmentRunEvent => {
        const payload = new Proxy(
          { stream: 'stdout', text: `line ${index}\n` },
          {
            get: (target, property, receiver) => {
              if (property === 'text') reads += 1;
              return Reflect.get(target, property, receiver);
            },
          },
        );
        return {
          runId: 'run-1',
          sequence: index + 1,
          timestamp: '2026-08-21T00:00:00.000Z',
          type: 'run.output',
          payload,
        };
      };

      let events: EnvironmentRunEvent[] = [];
      for (let index = 0; index < 60; index += 1) {
        events = [...events, makeOutput(index)];
        environmentRunView(events);
      }

      // Refolding the retained log every frame rereads O(n²) payloads; an
      // incremental fold reads each event once.
      expect(reads).toBeLessThanOrEqual(120);
    });

    it('counts one fold per appended frame before the cap', () => {
      const work: EnvironmentRunViewWork = {};
      const frames = 60;
      let log: EnvironmentRunEvent[] = [event(1, 'run.started', { operation: 'prompt' })];
      environmentRunView(log, work);
      for (let index = 0; index < frames; index += 1) {
        log = appendRunEvent(log, event(index + 2, 'run.output', { stream: 'stdout', text: `line ${index}\n` }), work);
        environmentRunView(log, work);
      }

      // Folding the retained log on every frame would fold 1 + 2 + … + 61
      // parts; an incremental fold folds the start once and each frame once.
      expect(work.folded).toBeLessThanOrEqual(frames + 2);
      expect(work.removed ?? 0).toBe(0);
      const view = environmentRunView(log);
      expect(view).toEqual(coldFold(log));
      expect(view.replyText).toContain(`line ${frames - 1}\n`);
    });

    it('folds only the appended frames when the caller builds its own array', () => {
      const work: EnvironmentRunViewWork = {};
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      environmentRunView(log, work);
      const baseline = work.folded ?? 0;
      for (let index = 0; index < 50; index += 1) {
        log = [...log, event(index + 2, 'run.output', { stream: 'stdout', text: `${index}` })];
        environmentRunView(log, work);
      }

      // The extension is confirmed by reference, so only the new frame folds.
      expect((work.folded ?? 0) - baseline).toBeLessThanOrEqual(50);
      expect(work.rebuilt).toBe(1);
      expect(environmentRunView(log)).toEqual(coldFold(log));
    });

    it('folds one part per frame before the cap and nothing for the render that follows', () => {
      const work: EnvironmentRunViewWork = {};
      const frames = 300;
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      environmentRunView(log, work);

      for (let index = 0; index < frames; index += 1) {
        const before = work.folded ?? 0;
        log = appendRunEvent(log, event(index + 2, 'run.output', { stream: 'stdout', text: `line-${index}\n` }), work);
        const rendered = environmentRunView(log, work);
        // The append folds exactly its own frame; the render reads the state
        // the append left behind and folds nothing at all.
        expect((work.folded ?? 0) - before).toBe(1);
        expect(rendered.replyText).toContain(`line-${index}\n`);
        expect((work.removed ?? 0)).toBe(0);
      }

      expect(work.rebuilt).toBe(1);
      expect(environmentRunView(log)).toEqual(coldFold(log));
    });

    it('keeps an ancestor window folded after the log has grown out of it', () => {
      const work: EnvironmentRunViewWork = {};
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      environmentRunView(log, work);

      for (let index = 0; index < 120; index += 1) {
        const ancestor = log;
        log = appendRunEvent(log, event(index + 2, 'run.output', { stream: 'stdout', text: `a${index}\n` }), work);
        const before = work.folded ?? 0;
        // Reading the window the caller held before the append must still be a
        // cache hit: advancing the fold may not invalidate older windows.
        const view = environmentRunView(ancestor, work);
        expect((work.folded ?? 0) - before).toBe(0);
        expect(view).toEqual(coldFold(ancestor));
      }

      expect(work.rebuilt).toBe(1);
    });

    it('derives every append from immutable state, so a replayed updater cannot refold the log', () => {
      const work: EnvironmentRunViewWork = {};
      const frames = MAX_RUN_EVENTS + 40;
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      environmentRunView(log, work);

      for (let index = 0; index < frames; index += 1) {
        const frame = event(index + 2, 'run.output', { stream: 'stdout', text: `r${index}\n` });
        const before = work.folded ?? 0;
        const first = appendRunEvent(log, frame, work);
        // React StrictMode replays a state updater with the same input; the
        // replay must derive the same window without folding the log again.
        const replay = appendRunEvent(log, frame, work);
        expect(replay).toEqual(first);
        // At most two parts fold per call: the frame and the re-inserted
        // start once the cap is dropping the head.
        expect((work.folded ?? 0) - before).toBeLessThanOrEqual(4);
        if (index === 0 || (index >= MAX_RUN_EVENTS - 2 && index <= MAX_RUN_EVENTS + 2) || index === frames - 1) {
          expect(environmentRunView(first, work)).toEqual(coldFold(first));
        }
        log = first;
      }

      // One cold fold for the first render, never one per streamed frame.
      expect(work.rebuilt).toBe(1);
      expect(environmentRunView(log)).toEqual(coldFold(log));
    });
  });

  describe('folding across the event cap', () => {
    it('assembles the retained window and drops the text of evicted frames', () => {
      const frames = MAX_RUN_EVENTS + 40;
      let log: EnvironmentRunEvent[] = [event(1, 'run.started', { operation: 'prompt' })];
      for (let index = 0; index < frames; index += 1) {
        log = appendRunEvent(log, event(index + 2, 'run.output', { stream: 'stdout', text: `chunk-${index}\n` }));
        environmentRunView(log);
      }

      const view = environmentRunView(log);
      expect(log).toHaveLength(MAX_RUN_EVENTS);
      expect(view).toEqual(coldFold(log));
      expect(view.status).toBe('running');
      expect(view.replyText).toContain(`chunk-${frames - 1}\n`);
      // Text that left the window has to leave the reply with it: a fold that
      // reused the previous view would keep streaming evicted output forever.
      expect(view.replyText).not.toContain('chunk-0\n');
      const retained = log
        .filter((entry) => entry.payload?.stream === 'stdout')
        .map((entry) => String(entry.payload.text))
        .join('');
      expect(view.replyText).toBe(retained);
    });

    it('keeps the terminal outcome of a capped run', () => {
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      for (let index = 0; index < MAX_RUN_EVENTS + 10; index += 1) {
        log = appendRunEvent(log, event(index + 2, 'run.output', { stream: 'stdout', text: 'x' }));
      }
      log = appendRunEvent(log, event(MAX_RUN_EVENTS + 12, 'run.completed', { exitCode: 0 }));

      const view = environmentRunView(log);
      const retainedOutputs = log.filter((entry) => entry.type === 'run.output').length;
      expect(view).toEqual(coldFold(log));
      expect(view.status).toBe('completed');
      expect(view.exitCode).toBe(0);
      expect(view.replyText).toBe('x'.repeat(retainedOutputs));
    });

    it('interprets each streamed frame once even as the cap rewrites the window', () => {
      let reads = 0;
      const frames = MAX_RUN_EVENTS + 200;
      const frame = (index: number): EnvironmentRunEvent => ({
        runId: 'run-1',
        sequence: index + 1,
        timestamp: '2026-08-21T00:00:00.000Z',
        type: 'run.output',
        payload: new Proxy(
          { stream: 'stdout', text: `line ${index}\n` },
          {
            get: (target, property, receiver) => {
              if (property === 'text') reads += 1;
              return Reflect.get(target, property, receiver);
            },
          },
        ),
      });

      let log: EnvironmentRunEvent[] = [];
      for (let index = 0; index < frames; index += 1) {
        log = appendRunEvent(log, frame(index));
        environmentRunView(log);
      }

      const view = environmentRunView(log);
      // Re-reading the retained window on every frame would touch the payloads
      // of the whole cap for each of the last 200 frames; a frame is read once
      // wherever the window puts it.
      expect(reads).toBeLessThanOrEqual(frames * 2);
      expect(view.replyText).toContain(`line ${frames - 1}\n`);
      expect(view.replyText).not.toContain('line 0\n');
    });

    it('agrees with a cold fold at every stage of a mixed stream across the cap', () => {
      const work: EnvironmentRunViewWork = {};
      let log: EnvironmentRunEvent[] = [event(1, 'run.started', { operation: 'prompt' })];
      const frames = MAX_RUN_EVENTS + 30;

      for (let index = 0; index < frames; index += 1) {
        const sequence = index + 2;
        let frame: EnvironmentRunEvent;
        if (index === 1) frame = event(sequence, 'run.output', { stream: 'stdout', text: 'early-stdout\n' });
        else if (index === 3) frame = event(sequence, 'run.note', { message: 'early-note' });
        else if (index === 4) frame = event(sequence, 'run.output', { stream: 'stderr', text: 'early-stderr\n' });
        else if (index % 5 === 0) frame = event(sequence, 'run.output', { stream: 'stderr', text: `err-${index}\n` });
        else if (index % 7 === 0) frame = event(sequence, 'run.note', { message: `note-${index}` });
        else frame = event(sequence, 'run.output', { stream: 'stdout', text: `out-${index}\n` });

        log = appendRunEvent(log, frame, work);
        const view = environmentRunView(log, work);
        // Early frames and every frame of the cap crossing are compared with a
        // window folded from nothing.
        if (index < 8 || index >= MAX_RUN_EVENTS - 4) {
          expect(view).toEqual(coldFold(log));
          expect(log).toHaveLength(Math.min(index + 2, MAX_RUN_EVENTS));
        }
      }

      const view = environmentRunView(log, work);
      expect(view).toEqual(coldFold(log));
      // Evicted stdout, stderr and notes leave every stream of the view.
      expect(view.replyText).not.toContain('early-stdout\n');
      expect(view.stderrText).not.toContain('early-stderr\n');
      expect(view.notes).not.toContain('early-note');
      expect(view.replyText).toContain(`out-${frames - 1}\n`);
      expect(work.removed ?? 0).toBeGreaterThan(0);
      // Only the appended frame (plus the re-inserted start) folds per frame.
      expect(work.folded ?? 0).toBeLessThanOrEqual(frames + (frames - MAX_RUN_EVENTS) + 10);
    });

    it('re-folds once, not per frame, when the cap evicts the terminal event', () => {
      const work: EnvironmentRunViewWork = {};
      let log: EnvironmentRunEvent[] = [
        event(1, 'run.started'),
        event(2, 'run.output', { stream: 'stdout', text: 'before-completion\n' }),
        event(3, 'run.completed', { exitCode: 0 }),
      ];
      environmentRunView(log, work);

      const frames = MAX_RUN_EVENTS + 20;
      for (let index = 0; index < frames; index += 1) {
        log = appendRunEvent(log, event(index + 4, 'run.output', { stream: 'stdout', text: `after-${index}\n` }), work);
        // Compare the frames around the cap crossing and the eviction itself.
        if (index >= MAX_RUN_EVENTS - 6) {
          expect(environmentRunView(log, work)).toEqual(coldFold(log));
        }
      }

      const view = environmentRunView(log, work);
      expect(view).toEqual(coldFold(log));
      expect(log.some((entry) => entry.type === 'run.completed')).toBe(false);
      // The completion left the retained window with the evicted head, so the
      // run is mid-stream again — exactly what a cold fold of the window says.
      expect(view.status).toBe('running');
      expect(view.exitCode).toBeNull();
      expect(view.replyText).not.toContain('before-completion');
      expect(view.replyText).toContain(`after-${frames - 1}\n`);
      // One cold fold when the terminal fell out of the window, then back to
      // incremental appends: never a full fold per frame.
      expect(work.rebuilt ?? 0).toBeLessThanOrEqual(3);
      expect(work.folded ?? 0).toBeLessThanOrEqual(frames * 2 + 10);
    });

    it('folds only the new frame and the re-inserted start for every frame after the cap', () => {
      const work: EnvironmentRunViewWork = {};
      const frames = MAX_RUN_EVENTS + 150;
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      environmentRunView(log, work);
      const foldedDeltas: number[] = [];
      const removedDeltas: number[] = [];
      const checkpoints = new Set([MAX_RUN_EVENTS - 2, MAX_RUN_EVENTS - 1, MAX_RUN_EVENTS, MAX_RUN_EVENTS + 1]);
      let lastView = environmentRunView(log, work);

      for (let index = 0; index < frames; index += 1) {
        const foldedBefore = work.folded ?? 0;
        const removedBefore = work.removed ?? 0;
        log = appendRunEvent(log, event(index + 2, 'run.output', { stream: 'stdout', text: `f-${index}\n` }), work);
        // The render that follows folds nothing: it reads the state the append
        // left behind.
        const rendered = environmentRunView(log, work);
        const foldedDelta = (work.folded ?? 0) - foldedBefore;
        const removedDelta = (work.removed ?? 0) - removedBefore;
        if (index < MAX_RUN_EVENTS - 1) {
          expect(foldedDelta).toBe(1);
          expect(removedDelta).toBe(0);
        } else {
          foldedDeltas.push(foldedDelta);
          removedDeltas.push(removedDelta);
        }
        if (checkpoints.has(index)) expect(rendered).toEqual(coldFold(log));
        lastView = rendered;
      }

      // Post-cap a frame costs its own part, the start prepended back into the
      // window, and the two parts the cap evicted — never the 2000 retained
      // ones. A fold that walked the window would trip this by three orders of
      // magnitude.
      expect(foldedDeltas).toHaveLength(frames - (MAX_RUN_EVENTS - 1));
      expect(Math.max(...foldedDeltas)).toBeLessThanOrEqual(2);
      expect(Math.max(...removedDeltas)).toBeLessThanOrEqual(2);
      expect(work.rebuilt).toBe(1);
      // In total the stream folds fewer parts than it emitted frames, twice
      // over: no frame is ever folded as part of a later frame's window.
      expect(work.folded ?? 0).toBeLessThanOrEqual(frames * 2 + 2);
      expect(lastView).toEqual(coldFold(log));
      expect(environmentRunView(log)).toEqual(coldFold(log));
    });

    it('reads the same capped window repeatedly without folding it again', () => {
      const work: EnvironmentRunViewWork = {};
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      for (let index = 0; index < MAX_RUN_EVENTS + 75; index += 1) {
        const frame =
          index % 11 === 0
            ? event(index + 2, 'run.note', { message: `note-${index}` })
            : event(index + 2, 'run.output', { stream: index % 3 === 0 ? 'stderr' : 'stdout', text: `v-${index}\n` });
        log = appendRunEvent(log, frame, work);
      }

      const before = work.folded ?? 0;
      const first = environmentRunView(log, work);
      const second = environmentRunView(log, work);

      expect(work.folded ?? 0).toBe(before);
      expect(work.rebuilt).toBe(1);
      expect(second).toEqual(first);
      // Every read is its own value, so a caller that mutates what it was
      // handed cannot corrupt the cached fold.
      expect(second).not.toBe(first);
      expect(second.notes).not.toBe(first.notes);
      second.notes.push('tampered');
      expect(environmentRunView(log)).toEqual(coldFold(log));
      expect(environmentRunView(log).notes).not.toContain('tampered');
    });

    it('drops evicted stdout, stderr and notes at the same cap boundary', () => {
      const work: EnvironmentRunViewWork = {};
      let log: EnvironmentRunEvent[] = [event(1, 'run.started')];
      // Three streams and a note; the head of each is older than the cap and
      // must leave its stream while newer chunks stay.
      const streamAt = (index: number): EnvironmentRunEvent => {
        if (index === 0) return event(2, 'run.output', { stream: 'stderr', text: 'old-stderr\n' });
        if (index === 1) return event(3, 'run.note', { message: 'old-note' });
        if (index === 2) return event(4, 'run.output', { stream: 'stdout', text: 'old-stdout\n' });
        if (index % 17 === 0) return event(index + 2, 'run.note', { message: `fresh-note-${index}` });
        if (index % 5 === 0) return event(index + 2, 'run.output', { stream: 'stderr', text: `fresh-stderr-${index}\n` });
        return event(index + 2, 'run.output', { stream: 'stdout', text: `fresh-stdout-${index}\n` });
      };

      for (let index = 0; index < MAX_RUN_EVENTS + 6; index += 1) {
        const before = log.length;
        log = appendRunEvent(log, streamAt(index), work);
        expect(log.length).toBe(Math.min(before + 1, MAX_RUN_EVENTS));
      }

      const view = environmentRunView(log, work);
      expect(view).toEqual(coldFold(log));
      expect(view.replyText).not.toContain('old-stdout\n');
      expect(view.stderrText).not.toContain('old-stderr\n');
      expect(view.notes).not.toContain('old-note');
      expect(view.replyText).toContain(`fresh-stdout-${MAX_RUN_EVENTS - 1}\n`);
      expect(work.rebuilt).toBe(1);
      expect(work.removed ?? 0).toBeGreaterThan(0);
    });

    it('never lets one run’s window leak into another run’s reply', () => {
      const first = [event(1, 'run.output', { text: 'first' })];
      const second = [{ ...event(1, 'run.output', { text: 'second' }), runId: 'run-2' }];
      expect(environmentRunView(first).replyText).toBe('first');
      expect(environmentRunView(second).replyText).toBe('second');
      expect(environmentRunView(first).replyText).toBe('first');
    });
  });

  describe('fold ownership', () => {
    it('keeps two runs’ folds apart when their windows interleave', () => {
      let first = appendRunEvent([], event(1, 'run.output', { text: 'first' }));
      let second = appendRunEvent([], { ...event(1, 'run.output', { text: 'second' }), runId: 'run-2' });
      first = appendRunEvent(first, event(2, 'run.output', { text: '!' }));
      second = appendRunEvent(second, { ...event(2, 'run.output', { text: '?' }), runId: 'run-2' });

      expect(environmentRunView(first).replyText).toBe('first!');
      expect(environmentRunView(second).replyText).toBe('second?');
      expect(environmentRunView(first).replyText).toBe('first!');
    });

    it('hands every call its own view, even when the window is unchanged', () => {
      const log = [event(1, 'run.note', { message: 'alpha' }), event(2, 'run.output', { text: 'pong' })];
      const first = environmentRunView(log);
      const second = environmentRunView(log);

      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(second.notes).not.toBe(first.notes);
      first.notes.push('tampered');
      expect(environmentRunView(log).notes).toEqual(['alpha']);
    });

    it('never mutates the events or the window it folds', () => {
      const payload: Record<string, unknown> = { stream: 'stdout', text: 'pong' };
      Object.freeze(payload);
      const pinned: EnvironmentRunEvent = Object.freeze({
        runId: 'run-1',
        sequence: 2,
        timestamp: '2026-08-21T00:00:00.000Z',
        type: 'run.output',
        payload,
      });
      const started = event(1, 'run.started');
      const log: readonly EnvironmentRunEvent[] = Object.freeze([started, pinned]);
      const view = environmentRunView(log);

      const extended = appendRunEvent(log, event(3, 'run.output', { stream: 'stdout', text: '!' }));
      expect(environmentRunView(extended).replyText).toBe('pong!');
      // The old window still folds as it stood, and the frames are untouched.
      expect(environmentRunView(log)).toEqual(view);
      expect(pinned.payload.text).toBe('pong');
      expect(started.payload).toEqual({});
    });
  });

  describe('badge', () => {
    it('is null while idle', () => {
      expect(environmentRunBadge(environmentRunView([]))).toBeNull();
    });

    it('shows starting when asked', () => {
      expect(environmentRunBadge(environmentRunView([]), { starting: true })).toEqual({
        label: 'Starting',
        tone: 'accent',
      });
    });

    it('shows running', () => {
      expect(environmentRunBadge(environmentRunView([event(1, 'run.started')]))).toEqual({
        label: 'Running',
        tone: 'accent',
      });
    });

    it('shows completed with the exit code', () => {
      expect(environmentRunBadge(environmentRunView([event(1, 'run.completed', { exitCode: 0 })]))).toEqual({
        label: 'Completed · exit 0',
        tone: 'success',
      });
    });

    it('shows failed with the exit code', () => {
      expect(environmentRunBadge(environmentRunView([event(1, 'run.failed', { exitCode: 1 })]))).toEqual({
        label: 'Failed · exit 1',
        tone: 'danger',
      });
    });

    it('shows cancelled as neutral', () => {
      expect(environmentRunBadge(environmentRunView([event(1, 'run.cancelled', {})]))).toEqual({
        label: 'Cancelled',
        tone: 'neutral',
      });
    });
  });
});
