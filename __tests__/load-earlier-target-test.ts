declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatScreenSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP),
    'utf8',
  );
}

test('the load-earlier button is size md, reaching the 48dp touch target', () => {
  // The only way back into a long transcript is this ghost button
  // (chat-screen.tsx:1189-1195). sm is paddingVertical 8 over caption
  // lineHeight 18 (Button.tsx:71-73, tokens.ts:101) = ~34dp; md is the base
  // button paddingVertical 13 over body lineHeight 24 (Button.tsx:66,
  // tokens.ts:100) = 50dp.
  const src = readChatScreenSource();
  expect(src).toMatch(
    /label=\{loadingEarlierHistory \? 'Loading…' : 'Load earlier messages'\}[^>]*size="md"/,
  );
});

test('the load-earlier button does not fall back to the sm sizing', () => {
  const src = readChatScreenSource();
  expect(src).not.toMatch(
    /label=\{loadingEarlierHistory \? 'Loading…' : 'Load earlier messages'\}[^>]*size="sm"/,
  );
});