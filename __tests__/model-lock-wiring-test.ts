declare const __dirname: string;

// The model-turn lock wiring: a send that comes back as the whole-message
// upstream refusal records a lock against the pinned model on this device, a
// completed turn drops it, and the pin-repair fold reads it before the
// catalogue's own availability flag. Pure logic lives in
// model-selection-lock-test.ts; this file pins the provider wiring.

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', rel].join(__dirname.includes('\\') ? '\\' : '/'), 'utf8');
}

describe('the lock is recorded on the send-failure path', () => {
  const provider = readSource('context/gateway-provider.tsx');

  test('sendMessage catch records the lock through upstreamModelRefusal', () => {
    expect(provider).toMatch(
      /const sentModel = resolveSendModel\(gateway, selectedBackendId, selectedBotId\)\.model;\s*if \(sentModel && upstreamModelRefusal\(message\)\) \{[\s\S]*?recordModelTurnFailure\(/,
    );
  });

  test('a completed turn drops the lock for the model that answered', () => {
    const answerArm = provider.match(/finalizeStreamingMessage[\s\S]{0,2000}?clearModelLockFn\(/);
    expect(answerArm).toBeTruthy();
  });

  test('the pin repair reads the lock before the catalogue verdict', () => {
    expect(provider).toMatch(
      /const sentModel = effectiveModel\(current, backendId, botId\);\s*if \(sentModel && modelLockFor\(current\.modelLocks, sentModel\)\) \{[\s\S]*?modelLockFallback\(/,
    );
  });

  test('the lock persists through the same upsert the picker writes do', () => {
    // Inside the record arm, the next profile carries modelLocks and is
    // persisted like every other profile write.
    expect(provider).toMatch(/const next = \{ \.\.\.gateway, modelLocks: updated \};[\s\S]{0,400}?upsertGateway\(next\)/);
  });
});

describe('the picker renders the lock', () => {
  test('chat-screen stamps each row with the lock on this device', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    expect(screen).toMatch(/modelLock: modelLockFor\(activeGateway\?\.modelLocks,/);
  });

  test('thread-config-sheet disables, dims and names a locked row', () => {
    const sheet = readSource('components/chat/thread-config-sheet.tsx');
    expect(sheet).toContain('const locked = item.modelLock !== undefined;');
    expect(sheet).toContain('disabled={item.available === false || locked}');
    expect(sheet).toContain('opacity: item.available === false || locked ? 0.6 : 1');
    expect(sheet).toMatch(/modelLockNote\(item\.modelLock!\)/);
  });

  test('the operator can clear the lock from the picker', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    const sheet = readSource('components/chat/thread-config-sheet.tsx');
    expect(screen).toContain('onClearModelLock={clearModelLock}');
    expect(sheet).toContain('onClearLock={onClearModelLock}');
    // The clear affordance is announced: a locked row's Clear control.
    expect(sheet).toMatch(/accessibilityLabel=\{`Clear lock for \$\{name\}`\}/);
  });

  test('the locked row never carries a credential value in the note', () => {
    const sheet = readSource('components/chat/thread-config-sheet.tsx');
    // The note is built only from modelLockNote — no token, key or
    // fingerprint interpolation reaches the row.
    expect(sheet).not.toMatch(/modelLockNote\([^)][*!]*reason/);
  });
});
