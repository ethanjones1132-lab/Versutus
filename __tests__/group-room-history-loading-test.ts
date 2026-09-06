declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readRoomSource(): string {
  // Normalize line endings so the block regexes below do not depend on the
  // file's on-disk endings (chat-roster.tsx needed the same treatment).
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group room history loading', () => {
  test('the pre-replay window holds layout with two Skeleton rows', () => {
    // The Gate-stored transcript replays async, and the header claimed an
    // empty-room invitation in that window, then popped to the transcript
    // when the replay landed. The header now renders skeletons like the
    // sibling Cron surfaces, so the layout holds instead of flashing the
    // invitation.
    const src = readRoomSource();
    expect(src).toContain('Skeleton');
    const loading = src.match(/\{loadHistory && !historyLoaded \? \([\s\S]*?\) : null\}/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\}/);
  });

  test('the invitation renders only for a genuinely empty room', () => {
    // Once the replay has landed with zero entries, the room must still
    // invite the first message with byte-identical copy — the skeletons
    // belong to the pre-replay window only. Rooms with no transcript read
    // (no loadHistory) never wait, so the invitation shows immediately.
    const src = readRoomSource();
    const empty = src.match(
      /\{entries\.length === 0 && \(!loadHistory \|\| historyLoaded\) \? \([\s\S]*?\) : null\}/,
    )?.[0];
    expect(empty).toBeDefined();
    expect(empty).toContain('Say something to the room. Every reply lands here, attributed to its bot.');
  });

  test('the replay marks history loaded on stored lines and on refusal', () => {
    // A refused replay must reach the honest note + Retry path, never the
    // skeletons: both replay outcomes flip the flag.
    const src = readRoomSource();
    const replay = src.match(/loadHistory\(\)\n      \.then\(\(stored\) => \{[\s\S]*?\n    return \(\) => \{/)?.[0];
    expect(replay).toBeDefined();
    expect(replay).toMatch(/setHistoryLoaded\(true\)/);
    expect(replay?.match(/setHistoryLoaded\(true\)/g)).toHaveLength(2);
  });

  test('the failed-replay note and Retry path are untouched', () => {
    // The skeletons change only what the room shows while it waits; a failed
    // replay still names the missing lines with a retry beside them.
    const src = readRoomSource();
    const historyBlock = src.match(/\{\s*historyError \? \([\s\S]*?\) : null\}/)?.[0];
    expect(historyBlock).toBeDefined();
    expect(historyBlock).toMatch(/Could not load earlier replies from the Gate/);
    const retryBlock = src.match(/\{\s*historyError && loadHistory \? \([\s\S]*?\) : null\}/)?.[0];
    expect(retryBlock).toBeDefined();
    expect(retryBlock).toMatch(/label="Retry"/);
    expect(retryBlock).toMatch(/onPress=\{handleRefresh\}/);
  });
});
