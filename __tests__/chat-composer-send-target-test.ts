declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSendButtonBody(): string {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
    'utf8',
  );
  const m = src.match(/sendButton:\s*\{([^}]+)\}/);
  if (!m) throw new Error('sendButton style not found in chat-composer.tsx');
  return m[1];
}

test('composer send button meets 48dp touch target', () => {
  const body = readSendButtonBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(48);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});