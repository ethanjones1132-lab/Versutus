import {
  HANDSFREE_AUTOSEND_LABEL,
  HANDSFREE_BANNER_TITLE,
  HANDSFREE_DISCLOSURE,
  HANDSFREE_END_LABEL,
  HANDSFREE_MUTE_LABEL,
  HANDSFREE_SKIP_LABEL,
  HANDSFREE_SPEAKING_HINT,
  HANDSFREE_START_LABEL,
  HANDSFREE_UNMUTE_LABEL,
  handsfreePhaseLabel,
} from '@/lib/voice/handsfree-call-copy';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const sheet = readSource('src', 'components', 'chat', 'handsfree-call-sheet.tsx');
const banner = readSource('src', 'components', 'voice', 'handsfree-call-banner.tsx');
const composer = readSource('src', 'components', 'chat', 'chat-composer.tsx');
const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
const layout = readSource('src', 'app', '_layout.tsx');
const fallback = readSource(
  'src',
  'components',
  'voice',
  'handsfree-call-indicator-fallback.tsx',
);
const native = readSource('src', 'components', 'voice', 'handsfree-call-indicator.native.tsx');

describe('the disclosure a call must show', () => {
  test('spells out auto-send, interruption and background lifetime exactly', () => {
    expect(HANDSFREE_DISCLOSURE).toBe(
      'Hands-free calls listen only after you start them. Speech is sent automatically when you pause. You can interrupt a reply just by talking. The call continues while Versutus is in the background. End it here or from Android’s notification.',
    );
    expect(sheet).toContain('HANDSFREE_DISCLOSURE');
    expect(sheet).toContain('label="Cancel"');
    expect(sheet).toContain('label="Start call"');
  });

  test('never implies always-listening, a wake word, full-duplex or a named competitor', () => {
    for (const source of [sheet, banner, composer, screen, fallback, native]) {
      expect(source).not.toMatch(/wake[\s-]?word/i);
      expect(source).not.toMatch(/always-listening/i);
      expect(source).not.toMatch(/full[\s-]?duplex/i);
      expect(source).not.toMatch(/GPT-Live|Gemini Live/i);
    }
  });
});

describe('the ambient indicator', () => {
  test('is drawn from the level stream, never required by any logic', () => {
    expect(banner).toContain('<HandsfreeCallIndicator');
    expect(banner).toContain('level={level}');
    // No conditional or send/reply path reads `level`.
    expect(banner).not.toMatch(/if \(.*level/);
  });

  test('degrades to the same static shape when no level arrives', () => {
    expect(fallback).toContain('level: number');
    expect(fallback).toContain('const clamped = Math.max(0, Math.min(1, level));');
    expect(fallback).toContain('active ? 0.55 + clamped * 0.45 : 0.55');
  });

  test('is Skia on native and a plain shape everywhere else', () => {
    expect(native).toContain("from '@shopify/react-native-skia'");
    expect(native).toContain('HandsfreeCallIndicatorFallback');
    // A GPU-less mount falls back rather than taking the screen down.
    expect(native).toContain('getDerivedStateFromError');
  });
});

describe('the Call control is separate from push-to-talk', () => {
  test('sits beside the mic and is offered only where Start can succeed', () => {
    const callAt = composer.indexOf('HANDSFREE_START_LABEL');
    const micAt = composer.indexOf("name={{ ios: 'mic.fill'");
    expect(callAt).toBeGreaterThan(-1);
    expect(micAt).toBeGreaterThan(callAt);
    expect(screen).toContain('onStartCall={canStartHandsfree ? openCallSheet : undefined}');
    expect(screen).toContain('callActive={handsfreeActive}');
  });

  test('the mic path still calls only the draft writers and never sends', () => {
    expect(composer).toContain('handleMicPressIn');
    expect(composer).toContain('handleMicPressOut');
    expect(composer).toContain('spokenDraftHold');
    expect(composer).not.toContain('sendChatInput');
  });

  test('a live call holds send and dictation without clearing the draft', () => {
    expect(composer).toContain('callActive');
    expect(composer).toContain('const isActionDisabled = callActive || !canSend');
    expect(composer).toContain('const inputEditable = !callActive && canSend && !isStreaming;');
  });

  test('the screen builds the target from its own state and hands it to start', () => {
    expect(screen).toContain('handsfree.start({');
    expect(screen).toContain('sessionId: draftThread.sessionId');
    expect(screen).toContain("surfaceKind: surface.kind");
    expect(screen).toContain('voice: botVoice ?? {}');
    expect(screen).toContain('const callTargetLabel = useMemo');
    expect(screen).toContain('endHandsfree()');
  });
});

describe('the banner', () => {
  test('is mounted as a sibling of the Stack inside the root View', () => {
    expect(layout).toContain('<HandsfreeCallBanner />');
    const gate = layout.indexOf('</AppLockGate>');
    const bannerAt = layout.indexOf('<HandsfreeCallBanner />');
    const viewClose = layout.indexOf('</View>');
    expect(bannerAt).toBeGreaterThan(gate);
    expect(bannerAt).toBeLessThan(viewClose);
  });

  test('names the thread, the phase and the permanent auto-send contract', () => {
    expect(banner).toContain('HANDSFREE_BANNER_TITLE');
    expect(banner).toContain('HANDSFREE_AUTOSEND_LABEL');
    expect(banner).toContain('handsfreePhaseLabel(phase)');
  });

  test('folds the internal confirming window into Listening', () => {
    expect(handsfreePhaseLabel('confirming')).toBe('Listening');
    expect(handsfreePhaseLabel('listening')).toBe('Listening');
    expect(handsfreePhaseLabel('sending')).toBe('Sending');
    expect(handsfreePhaseLabel('waiting')).toBe('Waiting for reply');
    expect(handsfreePhaseLabel('speaking')).toBe('Speaking');
    expect(handsfreePhaseLabel('muted')).toBe('Muted');
  });

  test('offers Mute/Unmute, a contextual Skip and End with the required labels', () => {
    expect(banner).toContain('HANDSFREE_MUTE_LABEL');
    expect(banner).toContain('HANDSFREE_UNMUTE_LABEL');
    expect(banner).toContain('muted ? unmute : mute');
    expect(banner).toContain('HANDSFREE_SKIP_LABEL');
    expect(banner).toContain('speaking ? (');
    expect(banner).toContain('HANDSFREE_END_LABEL');
    expect(banner).toContain('onPress={end}');
  });

  test('the Speaking state tells the screen reader it can be interrupted', () => {
    expect(banner).toContain('HANDSFREE_SPEAKING_HINT');
    expect(banner).toContain('speakingLine');
    expect(banner).toContain('accessibilityLiveRegion="polite"');
  });

  test('pins the accessibility phrases', () => {
    expect(HANDSFREE_START_LABEL).toBe('Start hands-free call');
    expect(HANDSFREE_MUTE_LABEL).toBe('Mute hands-free call');
    expect(HANDSFREE_UNMUTE_LABEL).toBe('Unmute hands-free call');
    expect(HANDSFREE_SKIP_LABEL).toBe('Skip spoken reply');
    expect(HANDSFREE_END_LABEL).toBe('End hands-free call');
    expect(HANDSFREE_AUTOSEND_LABEL).toBe('speech auto-sends');
    expect(HANDSFREE_BANNER_TITLE).toBe('Hands-free call');
    expect(HANDSFREE_SPEAKING_HINT).toBe('say something to interrupt');
  });
});
