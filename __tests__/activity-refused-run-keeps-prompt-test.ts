declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readProvider(): string {
  return readSource(['src', 'context', 'gateway-provider.tsx']);
}

function readActivity(): string {
  return readSource(['src', 'app', '(tabs)', 'activity.tsx']);
}

// `startRun` cleared `runPrompt` after `await sendChatInput('/run …')`
// unconditionally, but `sendChatInput` catches every slash refusal
// internally (lastError + a chat "Command failed" bubble) and resolves
// void — so Activity could not tell refusal from success and the
// operator's draft vanished even though nothing started. `sendChatInput`
// now reports the command outcome to its caller and Activity clears the
// prompt only when the command actually completed.
describe('activity refused run keeps the typed prompt', () => {
  test('sendChatInput reports the command outcome instead of resolving void', () => {
    const src = readProvider();
    expect(src).toContain('SendChatInputOutcome');
    expect(src).toContain("return 'complete';");
    expect(src).toContain("return 'error';");
  });

  test('the Activity prompt clears only when the command completed', () => {
    const src = readActivity();
    expect(src).toContain('await sendChatInput(`/run ${prompt}`);');
    expect(src).toContain("setRunPrompt('');");
    // The clear is gated on the reported outcome — a refusal keeps the draft.
    expect(src).toMatch(/if \(outcome === 'complete'\)/);
  });

  test('the chat Command-failed bubble and lastError path stay byte-identical', () => {
    const src = readProvider();
    expect(src).toContain('setLastError(message);');
    expect(src).toContain('text: `Command failed: ${message}`,');
    expect(src).toContain("status: 'error', ephemeral: true");
  });

  test('the offline-queue busy-slash and confirmation early returns still resolve as today', () => {
    const src = readProvider();
    expect(src).toContain('queueOfflineInput(trimmed);');
    expect(src).toContain("appendLocalMessage('assistant', busySlash.note);");
    expect(src).toContain('setPendingConfirmation(preview);');
  });

  test('the success bubble still lands as complete with the transcript write', () => {
    const src = readProvider();
    expect(src).toContain("status: 'complete',");
    expect(src).toContain('void updateTranscript(');
  });

  test('the retry-run card path still fires without reading the outcome', () => {
    const src = readActivity();
    expect(src).toMatch(/void sendChatInput\(`\/run \$\{prompt\}`\);/);
  });
});
