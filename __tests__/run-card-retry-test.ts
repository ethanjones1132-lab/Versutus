import { describe, expect, test } from '@jest/globals';

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

describe('run card retry affordance', () => {
  test('RunCard exposes an optional onRetry prop that forwards the run prompt', () => {
    // The Activity tab wires Retry for failed / cancelled / unresolved runs.
    // The prop is optional so the existing live card and any other caller
    // stay byte-identical — Retry is opt-in and the finished affordance is
    // gated on both status and prompt, not on the prop alone.
    const src = readSource('src', 'components', 'activity', 'run-card.tsx');
    expect(src).toMatch(/onRetry\?: \(prompt: string\) => void;/);
    expect(src).toMatch(/function RunCard\(\{ run, onStop, onOpenTranscript, onRetry \}/);
  });

  test('the Retry button is gated on !live && status !== complete && onRetry && non-empty prompt', () => {
    // The must-still guards: a live run keeps Stop (no Retry alongside — the
    // run is still going); a complete run never gets Retry (it would just
    // re-do finished work); a run with no prompt would forward `/run  ` and
    // the slash command would reply with its own usage line — the card must
    // not invite that.
    const src = readSource('src', 'components', 'activity', 'run-card.tsx');
    expect(src).toMatch(
      /!\s*live\s*&&\s*onRetry\s*&&\s*run\.status\s*!==\s*'complete'\s*&&\s*run\.prompt\.trim\(\)/,
    );
    expect(src).toMatch(/accessibilityLabel="Retry run"/);
    expect(src).toMatch(/Retry run/);
    expect(src).toMatch(/onPress=\{async \(\) => \{[\s\S]*?onRetry\(run\.prompt\)/);
  });

  test('the Retry button uses the established refresh glyph and accent color', () => {
    // The rest of the app (chat overflow Reload, provider Refresh catalog,
    // message actions Retranslate) already uses arrow.clockwise on iOS and
    // refresh on Android / web for the same kind of affordance; the same
    // glyph keeps the activity tab from inventing a fourth icon for retry.
    const src = readSource('src', 'components', 'activity', 'run-card.tsx');
    expect(src).toMatch(
      /name=\{\{\s*ios:\s*'arrow\.clockwise',\s*android:\s*'refresh',\s*web:\s*'refresh'\s*\}\}/,
    );
    expect(src).toMatch(/<Text variant="caption" color="accent">\s*\n\s*Retry run\s*\n\s*<\/Text>/);
  });

  test('the existing live, Stop-run, View-transcript and show-events branches are untouched', () => {
    // must-still: the live branch keeps Stop run (no Retry alongside — the
    // run is still going), the finished branch keeps View transcript, and
    // the show-events toggle is unchanged. A change that "adds a third button"
    // must not silently break the other two.
    const src = readSource('src', 'components', 'activity', 'run-card.tsx');
    expect(src).toMatch(/accessibilityLabel="Stop run"/);
    expect(src).toMatch(/<Icon name=\{\{ ios: 'stop\.fill', android: 'stop', web: 'stop' \}\} size=\{11\}/);
    expect(src).toMatch(/accessibilityLabel="View run transcript"/);
    expect(src).toMatch(/accessibilityLabel=\{expanded \? 'Hide event log' : 'Show event log'\}/);
    expect(src).toMatch(/setExpanded\(\(open\) => !open\)/);
  });
});

describe('activity screen retry wiring', () => {
  test('the finished RunCard renders onRetry that re-runs the same prompt through sendChatInput', () => {
    // The screen already routes Start-a-run through sendChatInput('/run <prompt>')
    // (activity.tsx:78). Retry must land on the same path so the operator does
    // not see a different run lifecycle whether they started a run from the
    // composer or re-tried a failed one from the activity card.
    const screen = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(screen).toMatch(/const retryRun = useCallback\(\s*\n\s*\(run: ActivityRun\) => \{/);
    expect(screen).toMatch(/void sendChatInput\(`\/run \$\{prompt\}`\)/);

    // The finished card passes an arrow that wraps retryRun, so a tap fires
    // sendChatInput(`/run ${run.prompt}`) — the same path the Start-a-run
    // card uses. The arrow's body must call retryRun with item.run (and the
    // prompt it received from the card) so a future swap of the callback
    // signature still fires the same slash command.
    expect(screen).toMatch(
      /case 'finished':\s*return \([\s\S]*?<RunCard[\s\S]*?onOpenTranscript=\{setOpenAgenticRunId\}[\s\S]*?onRetry=\{\s*\(prompt\)\s*=>\s*retryRun\(\{\s*\.\.\.item\.run,\s*prompt\s*\}\)\s*\}\s*\/>/,
    );
    expect(screen).toMatch(/\[stopActivityRun, retryRun\]/);
  });

  test('retryRun trims an empty or whitespace-only prompt and never fires sendChatInput', () => {
    // Defensive guard mirroring the trim guard in startRun (activity.tsx:72)
    // and in the slash command itself (slash-commands.ts:693). Without it a
    // run row whose prompt was somehow lost (the ActivityRun shape makes
    // prompt: string required but a future test or migration might leave it
    // empty) would send `/run  ` and the gateway would reply with its usage
    // line — visibly noise in chat.
    const screen = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(screen).toMatch(
      /const retryRun = useCallback\(\s*\n\s*\(run: ActivityRun\) => \{\s*\n\s*const prompt = run\.prompt\.trim\(\);\s*\n\s*if \(!prompt\) return;\s*\n\s*void sendChatInput\(`\/run \$\{prompt\}`\);\s*\n\s*\},/,
    );
  });

  test('the live (active) RunCard does not pass onRetry', () => {
    // must-still: a live run has its own Stop-run affordance and a Retry
    // alongside would either be inert (the slash path will keep trying) or
    // create a second in-flight run the operator did not ask for. The card
    // prop is optional and the live call site stays untouched.
    const screen = readSource('src', 'app', '(tabs)', 'activity.tsx');
    expect(screen).toMatch(/case 'active':\s*return <RunCard run=\{item\.run\} onStop=\{stopActivityRun\} \/>/);
  });
});