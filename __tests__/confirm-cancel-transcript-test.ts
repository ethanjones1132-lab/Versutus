declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const source = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function sendChatInputSource(): string {
  const start = source.indexOf('const sendChatInput = useCallback(');
  return source.slice(start, source.indexOf('const openModelPicker = useCallback(', start));
}

describe('confirm cancel transcript', () => {
  test('a confirmation command records the line so cancel can remove it', () => {
    const send = sendChatInputSource();
    const branch = send.slice(send.indexOf('if (needsConfirmation) {'), send.indexOf("return 'confirmation';"));
    expect(branch).toContain("pendingConfirmationMessageIdRef.current = appendLocalMessage('user', trimmed);");
    expect(branch).toContain('pendingConfirmationMessageIdRef.current = options.messageId;');
  });

  test('a plain slash command appends its line after the confirmation branch', () => {
    const send = sendChatInputSource();
    const confirmationReturn = send.indexOf("return 'confirmation';");
    const resendGuard = send.indexOf('if (!confirmationResendRef.current)', confirmationReturn);
    const append = send.indexOf("appendLocalMessage('user', trimmed);", resendGuard);

    expect(confirmationReturn).toBeGreaterThanOrEqual(0);
    expect(resendGuard).toBeGreaterThan(confirmationReturn);
    expect(append).toBeGreaterThan(resendGuard);
  });

  test('cancel removes the line the confirmation sheet was holding', () => {
    const cancel = source.slice(
      source.indexOf('const cancelPendingConfirmation = useCallback'),
      source.indexOf('const selectModel = useCallback'),
    );
    expect(cancel).toContain('const messageId = pendingConfirmationMessageIdRef.current;');
    expect(cancel).toContain('prev.filter((m) => m.id !== messageId)');
  });

  test('the --confirm resend does not append twice and resets the resend flag', () => {
    const send = sendChatInputSource();
    const confirmationReturn = send.indexOf("return 'confirmation';");
    const resendGuard = send.indexOf('if (!confirmationResendRef.current)', confirmationReturn);
    expect(resendGuard).toBeGreaterThan(confirmationReturn);

    const confirm = source.slice(
      source.indexOf('const confirmPendingAction = useCallback'),
      source.indexOf('const cancelPendingConfirmation = useCallback'),
    );
    expect(confirm).toMatch(
      /confirmationBypassRef\.current = true;\s*\n\s*confirmationResendRef\.current = true;[\s\S]*\.finally\(\(\) => \{\s*\n\s*confirmationBypassRef\.current = false;\s*\n\s*confirmationResendRef\.current = false;/,
    );
  });
});
