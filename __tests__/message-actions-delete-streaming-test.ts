declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

function sheetSrc(): string {
  return readSource('src', 'components', 'chat', 'message-actions-sheet.tsx');
}

test('delete-hidden-while-streaming: the Delete row is gated off a still-streaming message', () => {
  const src = sheetSrc();
  // A live turn can only be ended via the Cancel/Stop path — Delete must not
  // be offered while the stream is still running.
  expect(src).toMatch(/message\.streaming/);
  expect(src).toMatch(/\{canDelete \? \(/);
});

test('delete-hidden-while-command-running: the Delete row is gated off a running command', () => {
  const src = sheetSrc();
  // Slash-command turns carry status on message.command, not the streaming
  // flag — the gate must cover both, mirroring the bubble's Cancel row.
  expect(src).toContain("message.command?.status === 'running'");
  expect(src).toMatch(/const isLive = /);
});

test('delete-shown-when-settled: settled messages keep Delete exactly as today', () => {
  const src = sheetSrc();
  expect(src).toContain('Delete from view');
  expect(src).toContain('onDelete(message.id)');
});

test('cancel-path-untouched: chat-screen still wires Cancel and Delete side by side', () => {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  const screen = nodeFs.readFileSync([__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP), 'utf8');
  expect(screen).toContain('onCancel={cancelCommand}');
  expect(screen).toContain('onDelete={deleteLocalMessage}');
});

test('note-copy-untouched: the gateway-keeps-history note still tells the truth', () => {
  const src = sheetSrc();
  expect(src).toContain('Delete removes the message locally — the gateway keeps its history.');
});
