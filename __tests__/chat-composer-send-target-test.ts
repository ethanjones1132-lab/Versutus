declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readComposerSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readSendButtonBody(): string {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-composer.tsx'].join(SEP),
    'utf8',
  );
  const m = src.match(/sendButton:\s*\{([^}]+)\}/);
  if (!m) throw new Error('sendButton style not found in chat-composer.tsx');
  return m[1];
}

/**
 * The mic's two edges, as one region of the composer body — they are declared
 * together, between the send handler above them and the derived send flags
 * below them. What they do is what these cases are about.
 */
function readMicHandlers(src: string): string {
  const start = src.indexOf('const handleMicPressIn');
  const end = src.indexOf('const isActionDisabled');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('the mic handlers are not declared together in chat-composer.tsx');
  }
  return src.slice(start, end);
}

test('composer send button meets 48dp touch target', () => {
  const body = readSendButtonBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(48);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

describe('Chat composer mic control', () => {
  test('the drawn control is the fold answer, and the composer authors no state of its own', () => {
    const src = readComposerSource();

    // One fold decides what the control is; the surface only draws it.
    expect(src).toMatch(/const micState = micControlState\(\{/);
    // No mic is drawn where the seam answered no.
    expect(src).toMatch(/micState\.kind !== 'hidden'/);
    // The reason line is the module's own, never a literal on a surface.
    expect(src).not.toMatch(/MIC_DISCONNECTED_COPY/);
    expect(src).not.toMatch(/Connect a gateway to talk/);
  });

  test('the mic is drawn beside send, inside the composer card', () => {
    const src = readComposerSource();
    const fieldAt = src.indexOf('<TextField');
    const sendAt = src.indexOf('<Animated.View style={sendAnimatedStyle}>');
    const micAt = src.indexOf("micState.kind !== 'hidden'");

    expect(micAt).toBeGreaterThan(fieldAt);
    expect(micAt).toBeLessThan(sendAt);
  });

  test('a mic hold drives the recognizer and never sends', () => {
    const handlers = readMicHandlers(readComposerSource());

    expect(handlers).toMatch(/startSpeechRecognition\(/);
    expect(handlers).toMatch(/stopSpeechRecognition\(/);
    // One light haptic per edge, through the safe vocabulary.
    expect(handlers.match(/haptics\.light\(\)/g) ?? []).toHaveLength(2);
    // The hold reports words into the draft; it never sends and never stops a
    // reply that is already streaming.
    expect(handlers).not.toMatch(/onSend|onStop|handleAction/);
  });
});
