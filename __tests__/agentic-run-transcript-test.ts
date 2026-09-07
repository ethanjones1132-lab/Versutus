import { describe, expect, test } from '@jest/globals';

import { formatRunFailure } from '@/lib/gateway/run-failures';

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

describe('agentic-run transcript surface', () => {
  test('the sheet renders inside a BaseSheet with a replay eyebrow and the run id', () => {
    // The Gate replays both live and finished runs from /v1/runs/{id}/events
    // (server.mjs runEvents route), so the sheet is the only place a finished
    // run the phone never watched tells the operator what it did.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(/import \{[^}]*BaseSheet[^}]*\} from '@\/components\/ui'/);
    expect(src).toMatch(/eyebrow="REPLAY"/);
    expect(src).toMatch(/title="Run transcript"/);
    expect(src).toMatch(/<Text[^}]*selectable>\{runId\}<\/Text>/);
  });

  test('the sheet drains the stream through the loadEvents callback with an AbortSignal', () => {
    // The caller owns the wire and the abort — the sheet just consumes the
    // resolved list. Mirrors how CronRunSheet isolates its `cron.transcript`
    // call so a network refusal lands as a single catch.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(
      /loadEvents:\s*\(runId: string, signal: AbortSignal\) => Promise<RunEvent\[\]>/,
    );
    expect(src).toMatch(/await loadEvents\(id, controller\.signal\)/);
  });

  test('the loading branch renders two skeletons ahead of the Loading copy', () => {
    // Same shape as the cron transcript sheet: a 90%/76% pair at 44px, then
    // the Loading… caption, so the layout holds before the replay lands.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(/Skeleton width="90%" height=\{44\}/);
    expect(src).toMatch(/Skeleton width="76%" height=\{44\}/);
    expect(src).toMatch(/Loading…/);
  });

  test('each replayed event renders as a mono line of "type: runEventPreview(event)"', () => {
    // The same one-liner shape the inline RunCard toggle uses, so the
    // transcript does not invent a new format the operator has to learn.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(
      /event\.type\}: \{runEventPreview\(event\)\}/,
    );
    expect(src).toMatch(/variant="mono" color="tertiary" style=\{styles\.eventLine\}/);
  });

  test('a refused replay surfaces the run_events_unavailable verdict via formatRunFailure', () => {
    // The sheet must catch the same composite the rest of the app catches and
    // render the same one-liner — a finished run with no replay should read
    // identically whether the operator reached for it from the activity card
    // or from anywhere else. Pinned against the existing helper, not a fresh
    // message.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(/formatRunFailure\(error\) \?\? error/);
    expect(src).toMatch(/color="statusDisconnected"/);
    // The helper still maps the composite to a one-liner — no behavioural drift.
    expect(formatRunFailure('run_events_unavailable: run not found')).toMatch(
      /^Replay unavailable — /,
    );
  });

  test('an empty replay (events=[]) renders the "replay completed without events" copy', () => {
    // The Gate can answer 200 with zero events on an empty run; the sheet
    // says so plainly rather than rendering an empty list with no copy.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(/replay completed without events/);
  });

  test('the sheet aborts the in-flight replay on unmount and on run id swap', () => {
    // Background drain protection: a closed sheet must cut the SSE reader so
    // the phone does not keep consuming the run stream after the operator
    // dismissed it.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(/controllerRef\.current\?\.abort()/);
    expect(src).toMatch(/useEffect\([\s\S]*?return \(\) => \{[\s\S]*?controllerRef\.current\?\.abort/);
  });

  test('the sheet is null while runId is null and resets by remount on run id swap', () => {
    // Mirrors CronRunSheet: keyed-by-runId in the parent means a different
    // run arrives as a fresh component with empty state, no setState effect.
    const src = readSource('src', 'components', 'activity', 'agentic-run-sheet.tsx');
    expect(src).toMatch(/if \(!runId\) return null;/);
    expect(src).toMatch(/const tick = setTimeout\(\(\) => \{ void fetch\(runId\); \}, 0\);/);
  });
});

describe('agentic-run transcript wiring', () => {
  test('gateway-provider exposes loadRunEvents that drains streamRunEvents into a list', () => {
    // The provider owns the wire (clientRef, status, abort plumbing). The
    // sheet just consumes the resolved list. Tests pin the exact shape so
    // a future refactor that returns the first event only or skips the
    // signal abort does not silently regress.
    const src = readSource('src', 'context', 'gateway-provider.tsx');
    expect(src).toMatch(
      /loadRunEvents: \(runId: string, signal: AbortSignal\) => Promise<RunEvent\[\]>/,
    );
    const impl = src.match(
      /const loadRunEvents = useCallback\([\s\S]*?\},\s*\[\]\);/,
    )?.[0];
    expect(impl).toBeDefined();
    expect(impl).toMatch(/client\.streamRunEvents\(/);
    expect(impl).toMatch(/if \(signal\.aborted\) return;/);
    expect(impl).toMatch(/return collected;/);
    // The abort signal must be forwarded into the SSE reader so closing the
    // sheet actually cuts the response — not a decorative forwarding. The
    // source passes runId, an onEvent closure, then signal — pinned as the
    // third argument so a future refactor that drops the abort still fails.
    expect(impl).toMatch(/client\.streamRunEvents\(\s*runId,[\s\S]*?collected\.push\(event\);[\s\S]*?signal,/);
    // And the no-capability guard must name run events explicitly.
    expect(src).toMatch(/This gateway does not expose run events\./);
  });

  test('activity screen wires loadRunEvents into the agentic-run transcript sheet', () => {
    // The screen owns the open-state and the loader; the sheet just consumes
    // both. Mirrors how CronRunSheet is keyed on the run id in CronSection.
    const src = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(src).toMatch(/import \{ AgenticRunSheet \} from '@\/components\/activity\/agentic-run-sheet'/);
    expect(src).toMatch(/loadRunEvents,?/);
    expect(src).toMatch(/const \[openAgenticRunId, setOpenAgenticRunId\] = useState<string \| null>\(null\)/);
    expect(src).toMatch(
      /<AgenticRunSheet\s+key=\{openAgenticRunId \?\? 'no-run'\}\s+runId=\{openAgenticRunId\}\s+loadEvents=\{loadRunEvents\}\s+onClose=\{[^}]*setOpenAgenticRunId\(null\)[^}]*\}\s+\/>/,
    );
  });

  test('finished run cards carry the View transcript handler while live cards stay byte-identical', () => {
    // The must-still: a live run still uses the inline preview toggle, and
    // the Stop-run affordance is unchanged. Only the finished card gains the
    // new View transcript handler.
    const screen = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(screen).toMatch(
      /case 'finished':\s*return \([\s\S]*?<RunCard\s+run=\{item\.run\}\s+onOpenTranscript=\{setOpenAgenticRunId\}/,
    );
    // Live cards keep the original shape — no onOpenTranscript passed.
    expect(screen).toMatch(/case 'active':\s*return <RunCard run=\{item\.run\} onStop=\{stopActivityRun\} \/>/);

    // And the card itself only renders the affordance when both gates pass:
    // not live (a live run is already streaming) and a callback is supplied.
    const card = readSource('src', 'components', 'activity', 'run-card.tsx');
    expect(card).toMatch(/!live && onOpenTranscript \?/);
    expect(card).toMatch(/onOpenTranscript\?: \(runId: string\) => void;/);
    expect(card).toMatch(/onPress=\{async \(\) => \{[\s\S]*?onOpenTranscript\(run\.id\)/);
    expect(card).toMatch(/View transcript/);
    expect(card).toMatch(/accessibilityLabel="View run transcript"/);

    // The inline event-log toggle must stay byte-identical (a live run still
    // benefits from the preview summary, even after the new affordance ships).
    expect(card).toMatch(/accessibilityLabel=\{expanded \? 'Hide event log' : 'Show event log'\}/);
    expect(card).toMatch(/onPress=\{async \(\) => \{[\s\S]*?setExpanded\(\(open\) => !open\)/);
    // The Stop-run branch must remain untouched too.
    expect(card).toMatch(/accessibilityLabel="Stop run"/);
  });
});