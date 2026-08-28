declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomViewSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
    'utf8',
  );
}

test('the group dock Send button is size md, reaching the 48dp touch target', () => {
  // The one primary control of a live room (group-room-view.tsx:555-561).
  // sm is paddingVertical 8 over caption lineHeight 18 (Button.tsx:71-73,
  // tokens.ts:101) = ~34dp; md is the base button paddingVertical 13 over
  // body lineHeight 24 (Button.tsx:66, tokens.ts:100) = 50dp.
  const src = readGroupRoomViewSource();
  expect(src).toMatch(
    /label=\{sending \? 'Round running…' : 'Send'\}\s*variant="primary"\s*size="md"/,
  );
});

test('the group dock Send button does not fall back to the sm sizing', () => {
  const src = readGroupRoomViewSource();
  expect(src).not.toMatch(
    /label=\{sending \? 'Round running…' : 'Send'\}\s*variant="primary"\s*size="sm"/,
  );
});