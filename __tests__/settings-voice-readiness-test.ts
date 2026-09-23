declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSettings(): string {
  return readSource(['src', 'app', 'gateway', 'settings.tsx']);
}

/** The Voice card, from its headline to the next sibling section. */
function readVoiceCard(): string {
  const src = readSettings();
  const start = src.indexOf('Power hands-free with');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('<NotificationsSection', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The module-level readiness derivation, up to the component it precedes. */
function readVoiceReadiness(): string {
  const src = readSettings();
  const start = src.indexOf('function voiceReadiness(');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** A `useCallback` definition by name, sliced generously. */
function readCallback(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at).toBeGreaterThanOrEqual(0);
  return src.slice(at, at + 700);
}

// The one-shot voice.capabilities read folds every refusal back into null
// (settings.tsx catch), and voiceReadiness answers 'Checking this PC…' for a
// null — so an offline Gate or a Gate that predates voice leaves the This PC
// and Codex rows claiming an in-progress check forever, with no way to re-ask.
describe('gateway settings voice readiness names a failed check', () => {
  test('the screen tracks the capabilities read as checking, ready, or failed', () => {
    expect(readSettings()).toContain("useState<'checking' | 'ready' | 'failed'>('checking')");
  });

  test('a refusal settles failed with the caught message, not just a null', () => {
    const src = readSettings();
    const readAt = src.indexOf('const readVoiceCapabilities = useCallback(');
    expect(readAt).toBeGreaterThanOrEqual(0);
    const readBody = src.slice(readAt, readAt + 700);
    expect(readBody).toContain("'voice.capabilities'");
    expect(readBody).toContain('ok: false');
    expect(readBody).toMatch(/caught instanceof Error \? caught\.message : String\(caught\)/);

    const applyAt = src.indexOf('const applyVoiceRead = useCallback(');
    expect(applyAt).toBeGreaterThanOrEqual(0);
    const applyBody = src.slice(applyAt, applyAt + 700);
    expect(applyBody).toContain("setVoiceCheckState('failed')");
    expect(applyBody).toContain('setVoiceCheckError(');
    expect(applyBody).toContain("setVoiceCheckState('ready')");
  });

  test('the readiness sentence answers the failure instead of "Checking this PC…"', () => {
    const fn = readVoiceReadiness();
    expect(fn).toContain("state === 'failed'");
    expect(fn).toContain('voiceCheckError');
    const failedAt = fn.indexOf("state === 'failed'");
    const checkingAt = fn.indexOf("'Checking this PC…'");
    // The checking copy is only reachable past the failed guard.
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(checkingAt).toBeGreaterThan(failedAt);
  });

  test('a failed check renders an ErrorCard with a Retry above the engine rows', () => {
    const card = readVoiceCard();
    const failedAt = card.indexOf("voiceCheckState === 'failed'");
    const errorCardAt = card.indexOf('<ErrorCard');
    const rowsAt = card.indexOf('VOICE_ENGINE_ROWS.map');
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(errorCardAt).toBeGreaterThan(failedAt);
    expect(rowsAt).toBeGreaterThan(errorCardAt);
    expect(card).toContain('onRetry={retryVoiceCapabilities}');
    expect(card).toContain('voiceCheckError');
  });

  test('the Retry re-issues the voice.capabilities read through the same settler', () => {
    const src = readSettings();
    const retry = readCallback(src, 'retryVoiceCapabilities');
    expect(retry).toContain("setVoiceCheckState('checking')");
    expect(retry).toContain('readVoiceCapabilities');
    expect(retry).toContain('applyVoiceRead');
  });

  test('the mount effect still settles through the same settler', () => {
    const src = readSettings();
    const effectAt = src.indexOf('await loadAppSettings()');
    expect(effectAt).toBeGreaterThanOrEqual(0);
    // The combined mount effect reads stored prefs then the Gate's voice
    // answer; the answer must reach applyVoiceRead, not a raw setState.
    const window = src.slice(effectAt - 200, effectAt + 700);
    expect(window).toContain('readVoiceCapabilities');
    expect(window).toContain('applyVoiceRead');
    expect(window).toContain('cancelled');
  });
});

describe('gateway settings voice readiness keeps working', () => {
  const src = readSettings();

  test('the phone and automatic rows keep their byte-identical sentences', () => {
    expect(src).toContain("if (id === 'phone') return 'Always available on this phone.'");
    expect(src).toContain("if (id === 'auto') return 'Follows whichever engine below is ready.'");
  });

  test('the readiness rows still read the Gate answer and engine copy', () => {
    expect(src).toContain('voiceReadiness(row.id, voiceCapabilities, voiceCheckState, voiceCheckError)');
    expect(src).toContain('voiceEngineReadinessCopy');
    expect(src).toContain('VOICE_ENGINE_ROWS');
    expect(src).toContain("'voice.capabilities'");
  });

  test('the install row and its progress read are untouched', () => {
    expect(src).toContain("'voice.install.start'");
    expect(src).toContain("'voice.install.status'");
    expect(src).toContain('Install on this PC');
  });

  test('the stored choice, Grok row, and usage line stay wired', () => {
    expect(src).toContain('saveAppSettings({ voiceEngine');
    expect(src).toContain('GROK_ROW_LABEL');
    expect(src).toContain('GROK_DISABLED_REASON');
    expect(src).toContain('voiceUsageCopy(voiceCapabilities?.usedToday, voiceCapabilities?.lastError)');
  });

  test('the disabled-Gate and resolved engine sentences are unchanged', () => {
    expect(src).toContain("if (!capabilities.enabled) return 'Gate voice is turned off on this PC.'");
  });
});
