// A live run's event stream can re-open mid-run: the socket drops, the driver
// polls, then subscribes again — and the Gate replays the run from sequence 0.
// Every replayed frame used to be folded into the Activity preview again, so
// the operator saw the same lines twice. The provider now keeps the highest
// sequence it has shown for the row and admits only strictly increasing frames;
// frames with no sequence keep appending exactly as before.

import { ACTIVITY_EVENT_CAP, advanceRunEventSequence, runEventPreview, type ActivityRun } from '@/lib/gateway/runs';
import type { RunEvent } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function frame(sequence: number | undefined, text: string): RunEvent {
  return {
    type: 'message.delta',
    data: { deltaText: text },
    ...(sequence === undefined ? {} : { sequence }),
  };
}

/**
 * The provider's preview fold, in miniature: one mark carried across frames,
 * appending only what the helper admits, capped and newest-last.
 */
function previewLines(runId: string, frames: RunEvent[]): string[] {
  let mark: ReturnType<typeof advanceRunEventSequence>['mark'] = null;
  const lines: ActivityRun['events'] = [];
  for (const event of frames) {
    const admitted = advanceRunEventSequence(mark, runId, event.sequence);
    mark = admitted.mark;
    if (!admitted.append) continue;
    lines.push({ type: event.type, preview: runEventPreview(event), timestamp: event.timestamp });
  }
  return lines.map((line) => line.preview);
}

describe('advanceRunEventSequence', () => {
  test('a replay from the start is not shown twice', () => {
    const live = [frame(1, 'first'), frame(2, 'second'), frame(3, 'third')];
    // The stream re-opened and the Gate replayed the same run from sequence 1.
    expect(previewLines('run-1', [...live, ...live])).toEqual(['first', 'second', 'third']);
  });

  test('a strictly increasing frame is admitted, an equal or lower one is not', () => {
    const first = advanceRunEventSequence(null, 'run-1', 4);
    expect(first).toEqual({ mark: { runId: 'run-1', highest: 4 }, append: true });

    expect(advanceRunEventSequence(first.mark, 'run-1', 4)).toEqual({
      mark: { runId: 'run-1', highest: 4 },
      append: false,
    });
    expect(advanceRunEventSequence(first.mark, 'run-1', 2)).toEqual({
      mark: { runId: 'run-1', highest: 4 },
      append: false,
    });
    expect(advanceRunEventSequence(first.mark, 'run-1', 5)).toEqual({
      mark: { runId: 'run-1', highest: 5 },
      append: true,
    });
  });

  test('a frame with no numeric sequence appends exactly as today', () => {
    // The wire contract does not require a sequence; dropping these would lose
    // events rather than dedupe them. Repeated frames without a counter still
    // append, which is the pre-dedupe behaviour.
    const noSequence = [frame(undefined, 'same'), frame(undefined, 'same')];
    expect(previewLines('run-1', noSequence)).toEqual(['same', 'same']);

    // A mark from a sequenced phase does not suppress an uncounted frame, and
    // the next numeric frame still has to be strictly above the last counter.
    const mark = advanceRunEventSequence(null, 'run-1', 7).mark;
    expect(advanceRunEventSequence(mark, 'run-1', undefined)).toEqual({
      mark,
      append: true,
    });
    expect(advanceRunEventSequence(mark, 'run-1', 7).append).toBe(false);
  });

  test('a non-numeric `sequence` is treated as absent rather than compared', () => {
    // A misbehaving backend may send the field as a string or NaN. Neither is a
    // counter, so the frame is shown instead of silently vanishing.
    expect(advanceRunEventSequence(null, 'run-1', '3')).toEqual({ mark: null, append: true });
    expect(advanceRunEventSequence(null, 'run-1', Number.NaN)).toEqual({
      mark: null,
      append: true,
    });
    expect(advanceRunEventSequence(null, 'run-1', null)).toEqual({ mark: null, append: true });
  });

  test('re-keying the row to a new run id resets the counter', () => {
    // `onStarted` re-keys the provisional local id to the gateway's run id. A
    // fresh run starts its own counter at 1, which must not be measured against
    // the old run's highest.
    const provisional = advanceRunEventSequence(null, 'local-1', 9).mark;
    expect(advanceRunEventSequence(provisional, 'run-1', 1)).toEqual({
      mark: { runId: 'run-1', highest: 1 },
      append: true,
    });
    // And the old mark is discarded, not carried beside the new one.
    expect(advanceRunEventSequence(provisional, 'run-1', undefined)).toEqual({
      mark: null,
      append: true,
    });
  });

  test('newest-last order and the 50-frame cap survive the fold', () => {
    // The helper admits only new frames, so the row receives exactly the frames
    // it would have received before, in wire order — and the provider still
    // trims to the same cap from the end (newest last).
    const frames = Array.from({ length: ACTIVITY_EVENT_CAP + 5 }, (_v, index) =>
      frame(index + 1, `step-${index + 1}`),
    );
    // A full replay followed by five genuinely new frames.
    const lines = previewLines('run-1', [...frames, ...frames]);
    expect(lines).toHaveLength(ACTIVITY_EVENT_CAP + 5);
    expect(lines[0]).toBe('step-1');
    expect(lines.at(-1)).toBe(`step-${ACTIVITY_EVENT_CAP + 5}`);
    expect(lines.slice(-ACTIVITY_EVENT_CAP)[0]).toBe('step-6');
  });
});

describe('the provider wires the counter into its preview fold', () => {
  const provider = (): string => readSource('src', 'context', 'gateway-provider.tsx');

  function onEventBlock(): string {
    const src = provider();
    const start = src.indexOf('onEvent: (event) => {');
    const end = src.indexOf('onApprovalRequired:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  test('asks the helper with the streaming row id and the frame sequence', () => {
    const block = onEventBlock();
    expect(block).toContain('advanceRunEventSequence(');
    expect(block).toContain('trackedId.current');
    expect(block).toContain('event.sequence');
  });

  test('carries the mark across frames, so a re-opened stream stays deduped', () => {
    // A mark declared inside the callback would reset on every frame and dedupe
    // nothing; it must be assigned back after each admission.
    expect(onEventBlock()).toContain('previewSequence = admitted.mark;');
  });

  test('folds only admitted frames, and keeps the cap and the caller forward', () => {
    const block = onEventBlock();
    const guard = block.indexOf('if (admitted.append)');
    const patch = block.indexOf('patchActivityRuns');
    const forward = block.indexOf('onEvent?.(');
    expect(guard).toBeGreaterThan(-1);
    expect(patch).toBeGreaterThan(guard);
    expect(forward).toBeGreaterThan(patch);
    // The preview still trims to the existing cap from the end (newest last).
    expect(block).toContain('.slice(-ACTIVITY_EVENT_CAP)');
  });
});
