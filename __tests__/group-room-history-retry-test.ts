declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomViewSource(): string {
  // Normalize line endings so the block regexes below do not depend on the
  // file's on-disk endings (chat-roster.tsx needed the same treatment).
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group room history retry', () => {
  test('a failed history read offers a Retry action wired to the refresh handler', () => {
    // A failed room transcript read left the operator with a bare micro-copy
    // note and pull-to-refresh as the only recourse. The header now carries
    // the same re-read gesture as a visible Retry button.
    const src = readGroupRoomViewSource();
    const retryBlock = src.match(/\{\s*historyError && loadHistory \? \([\s\S]*?\) : null\}/)?.[0];
    expect(retryBlock).toBeDefined();
    expect(retryBlock).toMatch(/label="Retry"/);
    expect(retryBlock).toMatch(/variant="ghost"/);
    expect(retryBlock).toMatch(/onPress=\{handleRefresh\}/);
  });

  test('the history Retry is offered only when there is something to re-read', () => {
    // handleRefresh is a no-op without loadHistory (rooms on gateways without
    // the transcript read), so gating on loadHistory is exactly "wired to
    // handleRefresh when defined" with no extra conditional — and no Retry
    // renders without a history note to retry.
    const src = readGroupRoomViewSource();
    expect(src).toMatch(/\{\s*historyError && loadHistory \? \(/);
  });

  test('the historyError honest copy is unchanged', () => {
    const src = readGroupRoomViewSource();
    const historyBlock = src.match(/\{\s*historyError \? \([\s\S]*?\) : null\}/)?.[0];
    expect(historyBlock).toBeDefined();
    expect(historyBlock).toMatch(/variant="micro"/);
    expect(historyBlock).toMatch(/style=\{styles\.emptyHint\}/);
    expect(historyBlock).toMatch(/Could not load earlier replies from the Gate/);
  });

  test('a failed re-read never wipes what is already on screen', () => {
    // The re-read folds stored lines in with the merge-only helper and only
    // flips the error flag on failure — entries are never assigned or
    // cleared in either branch.
    const src = readGroupRoomViewSource();
    const refreshBlock = src.match(/const handleRefresh = useCallback\(\(\) => \{[\s\S]*?\}, \[loadHistory, refreshing\]\);/)?.[0];
    expect(refreshBlock).toBeDefined();
    expect(refreshBlock).toMatch(/mergeTranscriptRows/);
    expect(refreshBlock).not.toMatch(/setEntries\(\[\]\)/);
    expect(refreshBlock).not.toMatch(/setEntries\(\(\) =>/);
  });

  test('pull-to-refresh still offers the same gesture on the list itself', () => {
    const src = readGroupRoomViewSource();
    expect(src).toMatch(/refreshControl=\{/);
    expect(src).toMatch(/onRefresh=\{handleRefresh\}/);
  });
});
