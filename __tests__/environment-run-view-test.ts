import { environmentRunBadge, environmentRunView, reduceEnvironmentRunEvent } from '@/lib/gateway/environment-run-view';
import type { EnvironmentRunEvent } from '@/lib/gateway/environment-types';

function event(sequence: number, type: string, payload: Record<string, unknown> = {}): EnvironmentRunEvent {
  return { runId: 'run-1', sequence, timestamp: '2026-08-21T00:00:00.000Z', type, payload };
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
