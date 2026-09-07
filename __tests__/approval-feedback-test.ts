declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readCardSource(): string {
  // approval-decision-card.tsx is CRLF on disk; normalize so the regexes
  // below are line-ending independent.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'approval-decision-card.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readActivitySource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'app', '(tabs)', 'activity.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('approval decision card feedback', () => {
  const src = readCardSource();

  test('the onResolve signature now accepts an optional feedback string', () => {
    // The whole point of the item: the resolver plumbs feedback (see
    // gateway-provider.tsx:1933-1937 and runs.ts:42,228), but the card
    // signature used to drop it on the floor. The new shape must carry
    // it so Deny can hand a comment to the gateway.
    expect(src).toMatch(/onResolve:\s*\(\s*approved:\s*boolean\s*,\s*feedback\?:\s*string\s*\)\s*=>\s*void/);
    // The old single-arg signature must not survive.
    expect(src).not.toMatch(/onResolve:\s*\(\s*approved:\s*boolean\s*\)\s*=>\s*void/);
  });

  test('feedback is tracked in card state and trimmed before hand-off', () => {
    // The card must remember the operator's reply across re-renders, and
    // must trim whitespace before forwarding — a stray space would arrive
    // at the gateway as a whitespace-only payload otherwise.
    expect(src).toMatch(/const\s+\[feedbackText,\s*setFeedbackText\]\s*=\s*useState\(\s*['"]['"]\s*\)/);
    expect(src).toMatch(/feedbackText\.trim\(\)/);
  });

  test('Approve never carries feedback', () => {
    // The silent Approve is the common case — never thread the reply text
    // through it. The card sends `undefined` so the resolver short-circuits
    // and the gateway's replyApproval stays a bare approved.
    expect(src).toMatch(/const\s+feedback\s*=\s*approved\s*\?\s*undefined\s*:\s*trimmed/);
    expect(src).toMatch(/setTimeout\(\(\)\s*=>\s*onResolve\(\s*approved\s*,\s*feedback\s*\)/);
  });

  test('Deny forwards the trimmed text and the card still exits cleanly on empty', () => {
    // An empty Deny is a valid decision — the user can refuse without
    // commenting. The trimmed string may be '' and must still reach the
    // resolver as '' (not dropped), so the gateway sees a real decision.
    const decideBlock = src.match(/const\s+decide\s*=\s*\([\s\S]*?\n\s*\};/)?.[0];
    expect(decideBlock).toBeDefined();
    expect(decideBlock!).toMatch(/const\s+trimmed\s*=\s*feedbackText\.trim\(\)/);
    expect(decideBlock!).toMatch(/const\s+feedback\s*=\s*approved\s*\?\s*undefined\s*:\s*trimmed/);
    expect(decideBlock!).toMatch(/setTimeout\(\(\)\s*=>\s*onResolve\(\s*approved\s*,\s*feedback\s*\)/);
  });

  test('the reply field uses the kit TextField with prose-friendly defaults', () => {
    // A Deny reply is sentences, not a URL — the kit's form defaults
    // (none / no autocorrect) would over-correct and break the comment.
    // multiline so a long reply keeps its paragraphs.
    expect(src).toContain("import { Button, Card, Icon, PressableScale, Text, TextField }");
    const field = src.match(/<TextField[\s\S]*?\/>/)?.[0];
    expect(field).toBeDefined();
    expect(field!).toContain('value={feedbackText}');
    expect(field!).toContain('onChangeText={setFeedbackText}');
    expect(field!).toContain('multiline');
    expect(field!).toMatch(/autoCapitalize=\{?['"]sentences['"]\}?/);
    expect(field!).toMatch(/autoCorrect/);
    expect(field!).toMatch(/accessibilityLabel=\{?['"]Deny reply['"]\}?/);
  });

  test('the existing exit motion and haptics are unchanged', () => {
    // Must still: the card's exiting motion, busy flag, and haptics stay
    // untouched. A fix that broke them would still pass the gate but ship
    // a regression. The original literals are pinned by the existing
    // approval-exit-test, so we only need to confirm the new decide body
    // did not drop them.
    expect(src).toContain("void haptics.success()");
    expect(src).toContain("void haptics.warning()");
    expect(src).toContain('withTiming(0.92');
    expect(src).toContain('withTiming(0');
    expect(src).toContain('withTiming(1');
    expect(src).toMatch(/scale\.value\s*=\s*withTiming\(0\.92/);
    expect(src).toMatch(/opacity\.value\s*=\s*withTiming\(0/);
    expect(src).toMatch(/borderProgress\.value\s*=\s*withTiming\(1/);
    // The setTimeout call still keys on the exit duration, so the card
    // animates off before onResolve fires — the existing UX.
    expect(src).toMatch(/approvalExitDuration\(next\)/);
  });

  test('the activity tab wires the feedback argument through to the resolver', () => {
    // The screen sits between the card and the gateway-provider resolver.
    // If the screen still calls resolveRunApproval(approved) without
    // forwarding feedback, the new card surface would change nothing on
    // the wire — and the gate would still pass it.
    const activity = readActivitySource();
    expect(activity).toMatch(
      /onResolve=\{\s*\(\s*approved\s*,\s*feedback\s*\)\s*=>\s*resolveRunApproval\(\s*approved\s*,\s*feedback\s*\)\s*\}/,
    );
    // The old single-arg forwarding must be gone.
    expect(activity).not.toMatch(/resolveRunApproval\(\s*approved\s*\)/);
  });
});