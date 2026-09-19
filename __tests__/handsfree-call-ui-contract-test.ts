import {
  HANDSFREE_AUTOSEND_LABEL,
  HANDSFREE_BANNER_TITLE,
  HANDSFREE_CONFIRMING_HINT,
  HANDSFREE_DISCLOSURE,
  HANDSFREE_END_LABEL,
  HANDSFREE_MUTE_LABEL,
  HANDSFREE_RECOVERY_DISCLOSURE,
  HANDSFREE_SKIP_LABEL,
  HANDSFREE_SPEAKING_HINT,
  HANDSFREE_START_LABEL,
  HANDSFREE_UNMUTE_LABEL,
  handsfreeElapsedCopy,
  handsfreeEndReasonCopy,
  handsfreePhaseLabel,
  handsfreeStartResultCopy,
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

  test('states where a dead call’s words surface — the composer, not silence', () => {
    // Crash recovery is shipped behavior (promoteHandsfreeRecovery): the
    // newest persisted transcript is joined onto the composer draft when a
    // call dies mid-turn. The disclosure is the only place the operator is
    // told, so it must say it — own constant, so the pin moves in one place.
    expect(HANDSFREE_RECOVERY_DISCLOSURE).toBe(
      'If the call is interrupted unexpectedly, what you said can appear in the message box — review it before sending, as always.',
    );
    // The sheet draws it from the same copy module, beside the main
    // disclosure — never a string inlined here.
    expect(sheet).toContain('HANDSFREE_RECOVERY_DISCLOSURE');
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

const provider = readSource('src', 'context', 'handsfree-voice-provider.tsx');

describe('the ambient indicator', () => {
  test('the banner carries no per-sample React write for the level', () => {
    // The sample arrives at the platform's own rate (~10/s). Holding it in
    // React state redraws the whole banner tree per sample for a shape that
    // only answers a number, so the provider holds it in a Reanimated shared
    // value and the Skia circle reads it on the UI thread instead. Both engines
    // (the phone's recognizer and the Gate call) feed the same shared value.
    expect(provider).not.toContain('setLevel');
    expect(provider).toContain('const level = useSharedValue(0)');
    expect(provider.split('level.value = clampLevel(event.level)').length - 1).toBe(2);
    // The native indicator derives its geometry from the shared value in a
    // worklet, never from render-time JS state.
    expect(native).toContain('useDerivedValue');
    expect(native).toContain('level.value');
    expect(native).not.toContain('const clamped = Math.max(0, Math.min(1, level));');
  });

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
    // Both hints ride the one phase line, so a11y and copy move as one.
    expect(banner).toContain('phaseLine');
    expect(banner).toContain('accessibilityLiveRegion="polite"');
  });

  test('the grace window says it is finishing, not dead', () => {
    expect(HANDSFREE_CONFIRMING_HINT).toBe('finishing…');
  });

  test('the confirming hint renders beside the shipped speaking hint, only for confirming', () => {
    expect(banner).toContain('HANDSFREE_CONFIRMING_HINT');
    expect(banner).toContain("phase === 'confirming'");
    // The hint rides the same phase line the speaking hint does, so a11y and
    // copy move as one.
    expect(banner.indexOf('phaseLine')).toBeGreaterThan(-1);
    expect(banner).toContain('{phaseLine}');
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

describe('the call sheet can always be dismissed', () => {
  test('Cancel is never disabled by a start in flight', () => {
    const cancel = sheet.slice(sheet.indexOf('label="Cancel"'), sheet.indexOf('label="Start call"'));
    expect(cancel).not.toContain('disabled={busy}');
  });

  test('a start that throws still clears busy', () => {
    const at = screen.indexOf('const handleStartCall = useCallback(');
    const handler = screen.slice(at, screen.indexOf('}, [activeGateway, botVoice', at));
    expect(handler).toMatch(/try\s*\{[\s\S]*await handsfree\.start\(/);
    expect(handler).toMatch(/finally\s*\{\s*setCallBusy\(false\);\s*\}/);
  });
});

describe('an ended or refused call explains itself', () => {
  test('the operator ending a call is not reported as a failure', () => {
    expect(handsfreeEndReasonCopy('user')).toBeNull();
    expect(handsfreeEndReasonCopy('thread-changed')).toBeNull();
  });

  test('every failure reason and start result has its own sentence', () => {
    const reasons = ['disconnect', 'system-interruption', 'app-killed', 'recognition-failed', 'send-failed', 'speech-failed'] as const;
    const copy = reasons.map(handsfreeEndReasonCopy);
    expect(copy.every((line) => typeof line === 'string' && line.length > 0)).toBe(true);
    expect(new Set(copy).size).toBe(reasons.length);
    expect(new Set([
      handsfreeStartResultCopy('permission-denied'),
      handsfreeStartResultCopy('unavailable'),
      handsfreeStartResultCopy('refused'),
      handsfreeStartResultCopy('identity-unavailable'),
    ]).size).toBe(4);
    expect(handsfreeStartResultCopy('identity-unavailable')).toMatch(/device identity/i);
  });

  test('the chat screen reopens the sheet with the reason when a call ends on its own', () => {
    expect(screen).toContain('handsfreeEndReasonCopy(handsfreeLastEndReason)');
    expect(screen).toMatch(/\[handsfreeCallsEnded, handsfreeLastEndReason\]/);
    expect(screen).toContain('handsfreeStartResultCopy(attempt.result');
  });
});

describe('the call says how long it has been running', () => {
  test('the banner folds the started-at epoch through the copy module, on a per-second tick', () => {
    expect(banner).toContain('handsfreeElapsedCopy(');
    expect(banner).toContain('startedAtMs');
    // The tick is wall-clock truth and unsubscribes cleanly: no drift between
    // the fold and what the operator reads.
    expect(banner).toContain('setInterval');
  });

  test('a call with no recorded start stays silent, never zero', () => {
    // The copy is the single honest fold; the banner renders only when the
    // epoch is known — a brand-new or unrecorded call gains no fake line.
    expect(handsfreeElapsedCopy(undefined, 1_000_000)).toBeNull();
  });

  test('the provider stamps the clock at started, once per call', () => {
    expect(provider).toContain("dispatch({ type: 'started', startedAtMs: Date.now() })");
    // The reducer records it; the context value exposes it.
    expect(provider).toContain('startedAtMs: session.startedAtMs,');
  });
});

describe('the sheet names the engine before consent', () => {
  test('shows "Using:" with a one-tap Change', () => {
    expect(sheet).toContain('Using: {engineLabel}');
    expect(sheet).toContain('onChangeEngine');
    expect(sheet).toContain('Change');
  });

  test('names an unready host engine and withholds Start until the call can open', () => {
    expect(sheet).toContain('engineWarning');
    expect(sheet).toContain('startDisabled');
    expect(sheet).toContain('disabled={Boolean(busy || startDisabled)}');
    expect(screen).toContain('engineWarning={callEngine?.reason}');
    expect(screen).toContain('preferredEngineUnready');
    expect(screen).toContain("handsfreeStartResultCopy('no-session')");
  });

  test('shows the chosen engine’s own disclosure over the default', () => {
    expect(sheet).toContain('disclosure ?? HANDSFREE_DISCLOSURE');
  });

  test('the screen chooses from the stored preference and the Gate readiness', () => {
    expect(screen).toContain('chooseVoiceEngine(');
    expect(screen).toContain("gatewayRequest<VoiceEngineCapabilities>('voice.capabilities'");
    expect(screen).toContain('voiceEngineDisclosure(callEngine.engine)');
    expect(screen).toContain("const transport = callEngine && callEngine.engine !== 'phone' ? 'gate' : 'phone'");
  });
});

describe('an ended call is announced once, not on every visit to Chat', () => {
  test('the screen only reopens the sheet for an end it has not already reported', () => {
    // Observed 2026-09-16: opening Chat re-raised the start sheet carrying
    // "The call ended because another app or a phone call took the audio." from
    // a call that had ended long before. `lastEndReason` lives in the provider
    // and survives this screen, so an effect keyed only on its value re-fires
    // on every mount and re-announces history as news.
    //
    // The guard is a count the screen has already handled: on mount it adopts
    // the provider's current `callsEnded`, and only a HIGHER count is a new
    // end worth surfacing.
    expect(screen).toContain('handledCallEndRef');
    expect(screen).toContain('handledCallEndRef.current === null');
    expect(screen).toContain('handsfreeCallsEnded <= handledCallEndRef.current');
  });

  test('a genuinely new end still reopens the sheet with its reason', () => {
    expect(screen).toContain('setCallError(copy)');
    expect(screen).toContain('setCallSheetVisible(true)');
    // The reducer clears the reason when the next call starts, so a reason only
    // ever describes the call that just ended.
    const session = readSource('src', 'lib', 'voice', 'handsfree-session.ts');
    expect(session).toContain("phase: 'starting', lastEndReason: undefined");
  });
});
