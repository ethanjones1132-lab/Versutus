declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readBubbleSource(): string {
  return readSource(['src', 'components', 'chat', 'message-bubble.tsx']);
}

// The timestamp StyleSheet block that sits beside every bubble.
function readTimestampBlock(): string {
  const src = readBubbleSource();
  const keyAt = src.indexOf('timestamp: {');
  const closeAt = src.indexOf('},', keyAt);
  return src.slice(keyAt, closeAt + 2);
}

test('the timestamp sits on the micro type metrics', () => {
  const block = readTimestampBlock();
  expect(block).toMatch(/fontSize: 11/);
  expect(block).toMatch(/lineHeight: 14/);
  expect(block).not.toMatch(/fontSize: 10/);
  expect(block).not.toMatch(/lineHeight: 13/);
});

test('the timestamp keeps the mono family', () => {
  const block = readTimestampBlock();
  expect(block).toMatch(/fontFamily: FontFamily\.mono/);
});

test('the mono timestamp copy still renders beside every bubble', () => {
  const src = readBubbleSource();
  expect(src).toContain('formatClockTime(message.timestamp)');
  expect(src).toMatch(/variant="micro"[^>]*style=\{styles\.timestamp\}/);
});
