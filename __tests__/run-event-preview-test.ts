import { runEventPreview } from '@/lib/gateway/runs';
import type { RunEvent } from '@/lib/gateway/types';

/**
 * `runEventPreview` is the one-liner helper every run-event reader on the
 * Activity tab uses: the AgenticRunSheet's replay map (agentic-run-sheet.tsx
 * :108-116) and the inline RunCard event-log toggle (run-card.tsx:114-124).
 * Both readers render `event.type}: <preview>` as a mono line, so a defective
 * helper turns every finished run on the phone into a JSON blob.
 *
 * The precedence order in the helper is the contract: streaming candidates
 * first (`deltaText` / `text` / `message`), then `result` so the common
 * `run.completed` case reads as the answer instead of JSON, then `status`,
 * then `error` / `errorMessage` so a `run.failed` surfaces its verdict.
 */

function event(data: Record<string, unknown> | undefined, type = 'test'): RunEvent {
  return { type, data };
}

describe('runEventPreview result candidate', () => {
  test('a run.completed event with a string `result` renders the answer, not JSON', () => {
    // The Gate emits `run.completed` as { result: <final text>, subtype: 'success' }
    // (docs/opencode-backend-contract.md:216). Before this change, the helper
    // had no `result` candidate and the event fell through to JSON.stringify
    // — the operator saw `run.completed: {"result":"the answer"}` on the
    // Activity tab. With `result` in the precedence list, the line reads as
    // the actual answer the run produced.
    const preview = runEventPreview(event({ result: 'the answer the run produced' }, 'run.completed'));
    expect(preview).toBe('the answer the run produced');
  });

  test('a run.completed event whose result carries line breaks flattens them to single spaces', () => {
    // `replace(/\s+/g, ' ').trim()` is the existing flattening rule; verify
    // the new candidate still respects it (so the preview never spans lines).
    const preview = runEventPreview(
      event({ result: 'line one\n\nline two\nline three' }, 'run.completed'),
    );
    expect(preview).toBe('line one line two line three');
  });

  test('an empty or whitespace-only result still falls back to JSON.stringify', () => {
    // The helper's empty-string guard is `typeof candidate === 'string' && candidate`,
    // and a `result: ''` fails that guard — same as every other candidate.
    // We do not silently emit `''` for a finished run; the JSON fallback
    // makes the absence of a result visible.
    const preview = runEventPreview(event({ result: '', subtype: 'success' }, 'run.completed'));
    expect(preview).toBe('{"result":"","subtype":"success"}');
  });

  test('a non-string result falls back to JSON.stringify instead of crashing', () => {
    // Mirrors the existing guard for `deltaText` / `text` / etc: a non-string
    // `result` (an object from a misbehaving backend) must not render as
    // `[object Object]`. The fallback is JSON.stringify, which is what every
    // other unrecognized shape falls through to.
    const preview = runEventPreview(event({ result: { nested: 'value' } }, 'run.completed'));
    expect(preview).toBe('{"result":{"nested":"value"}}');
  });
});

describe('runEventPreview precedence order', () => {
  test('deltaText wins over result so streaming chunks still show their text', () => {
    // A `message.delta` event carries the per-chunk text in `deltaText`; the
    // helper must prefer it over a stale `result` field if both happen to be
    // present (e.g. a replay that mixes completed-frame data with delta
    // frames). Streaming > terminal-result.
    const preview = runEventPreview(
      event({ deltaText: 'stream chunk', result: 'final answer' }, 'message.delta'),
    );
    expect(preview).toBe('stream chunk');
  });

  test('text wins over result when deltaText is absent', () => {
    // A legacy or non-streaming backend that uses `text` instead of
    // `deltaText`: `text` is the documented second-precedence candidate and
    // must still beat `result`.
    const preview = runEventPreview(event({ text: 'mid-run answer', result: 'final' }, 'message'));
    expect(preview).toBe('mid-run answer');
  });

  test('message wins over result when text is also absent', () => {
    const preview = runEventPreview(event({ message: 'bubble text', result: 'final' }, 'assistant'));
    expect(preview).toBe('bubble text');
  });

  test('status wins over result, mirroring the existing status-vs-error rule', () => {
    // The original helper already had `status` winning over `error` /
    // `errorMessage`; `result` lands below all three so that rule survives
    // untouched. A `run.completed` event that carries both a status string
    // and a result still shows the status — same shape as the original
    // `status ?? error` precedence, just one rung deeper. The common case
    // (data = { result, subtype: 'success' }, no `status` field) is what
    // `result` actually wins on, and is pinned by the first test in this
    // describe block.
    const preview = runEventPreview(
      event({ result: 'the answer', status: 'completed', subtype: 'success' }, 'run.completed'),
    );
    expect(preview).toBe('completed');
  });

  test('error wins over result so a run.failed surfaces the failure, not the answer text', () => {
    // The must-still clause from the item: `error` / `errorMessage` ahead of
    // `result` so a `run.failed` event still shows the failure. The contract
    // is that `result` is the success answer; on `run.failed` the helper
    // must reach for the error string the Gate also carried.
    const preview = runEventPreview(
      event({ result: 'partial text before the failure', error: 'gateway refused' }, 'run.failed'),
    );
    expect(preview).toBe('gateway refused');
  });

  test('errorMessage also wins over result', () => {
    // Some Gate wordings emit `errorMessage` instead of `error`; same precedence rule.
    const preview = runEventPreview(
      event({ result: 'partial', errorMessage: 'timeout' }, 'run.failed'),
    );
    expect(preview).toBe('timeout');
  });
});

describe('runEventPreview fallback and length rules', () => {
  test('an event with no recognized field still falls through to JSON.stringify', () => {
    // tool.started carries { toolName, input } with no candidate field. The
    // JSON fallback is the existing behavior and the must-still clause
    // requires it survives the precedence change.
    const preview = runEventPreview(event({ toolName: 'ls', input: { path: '/' } }, 'tool.started'));
    expect(preview).toBe('{"toolName":"ls","input":{"path":"/"}}');
  });

  test('a result longer than 140 characters is truncated with an ellipsis', () => {
    // The existing 140-char rule must apply to the new candidate too, so a
    // very long final answer does not blow out the event log layout.
    const longResult = 'x'.repeat(200);
    const preview = runEventPreview(event({ result: longResult }, 'run.completed'));
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBe(141); // 140 chars + the ellipsis glyph
  });

  test('undefined data still produces an empty fallback rather than throwing', () => {
    // A malformed event with no data at all: `event.data` is undefined and
    // the helper must not crash on the first candidate.
    const preview = runEventPreview({ type: 'no-data' });
    expect(preview).toBe('{}');
  });

  test('an event whose only recognized field is the empty string still falls back to JSON', () => {
    // Same empty-string guard as before: a `result: ''` does not satisfy
    // `candidate` and the JSON.stringify fallback fires, so the operator
    // sees the full data shape instead of a silent empty line.
    const preview = runEventPreview(event({ result: '' }, 'run.completed'));
    expect(preview).toBe('{"result":""}');
  });
});