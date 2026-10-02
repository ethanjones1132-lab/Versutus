// MODEL-5: picking a model on an OpenClaw gateway routed the pick through
// `sendChatInput('/model set …')`. When the phone was not exactly `connected`
// that pre-flight parked a `/model set …` user bubble in the transcript and
// left the Gate unchanged. The pick is now recorded on the profile locally and
// the command is only sent while connected. Pinned off the source.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

function selectModelBody(): string {
  const start = provider.indexOf('const selectModel = useCallback');
  expect(start).toBeGreaterThan(-1);
  return provider.slice(start, provider.indexOf('const selectSession = useCallback', start));
}

describe('MODEL-5: an OpenClaw model pick off `connected` is recorded, not queued', () => {
  test('the OpenClaw branch writes the profile before it considers the command', () => {
    const body = selectModelBody();
    const openclaw = body.slice(body.indexOf("activeGateway?.kind === 'openclaw'"));
    const recordAt = openclaw.indexOf('setActiveGateway(recorded);');
    const commandAt = openclaw.indexOf('void sendChatInput(`/model set ${modelId}`)');
    expect(recordAt).toBeGreaterThan(-1);
    expect(commandAt).toBeGreaterThan(recordAt);
    // The command is gated on a live, connected client.
    expect(openclaw).toContain("if (clientRef.current && statusRef.current === 'connected') {");
  });

  test('the command is never sent from inside the offline pre-flight', () => {
    const body = selectModelBody();
    const openclaw = body.slice(body.indexOf("activeGateway?.kind === 'openclaw'"));
    // No unconditional `void sendChatInput('/model set …')` remains.
    expect(openclaw).not.toMatch(/\n\s*void sendChatInput\(`\/model set \$\{modelId\}`\);\s*\n\s*return;/);
  });

  test('the profile write uses withSelectedModel, so a Bot pick stays on the Bot', () => {
    const body = selectModelBody();
    const openclaw = body.slice(body.indexOf("activeGateway?.kind === 'openclaw'"));
    expect(openclaw).toContain('withSelectedModel(activeGateway, modelId, selectedBackendId, selectedBotId)');
    expect(openclaw).toContain('withSelectedModel(activeGateway, modelId, selectedBackendId)');
  });
});
