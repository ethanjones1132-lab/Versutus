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

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

const provider = readSource('src', 'context', 'handsfree-voice-provider.tsx');
const layout = readSource('src', 'app', '_layout.tsx');
const reply = readSource('src', 'lib', 'voice', 'handsfree-reply.ts');
const banner = readSource('src', 'components', 'voice', 'handsfree-call-banner.tsx');

describe('the call provider sits outside navigation and inside the gateway', () => {
  test('is mounted between GatewayProvider and FontProvider', () => {
    const open = between(layout, '<GatewayProvider>', '</GatewayProvider>');
    const callAt = open.indexOf('<HandsfreeVoiceProvider>');
    const fontAt = open.indexOf('<FontProvider>');
    expect(callAt).toBeGreaterThan(-1);
    expect(fontAt).toBeGreaterThan(callAt);
  });

  test('exposes the phase, transcript, target label, level and controls', () => {
    for (const key of [
      'phase',
      'active',
      'partial',
      'label',
      'reason',
      'lastEndReason',
      'level',
      'canStart',
      'start',
      'mute',
      'unmute',
      'skipReply',
      'end',
    ]) {
      expect(provider).toMatch(new RegExp(`\\b${key}[?]?:`));
    }
    expect(provider).toContain('useHandsfreeVoice');
  });
});

describe('the phase-to-native wiring table', () => {
  const runEffect = between(
    provider,
    'const runEffect = (effect: HandsfreeEffect) => {',
    'useEffect(() => {\n    runEffectRef.current = runEffect;',
  );

  test('every reducer effect has a native destination', () => {
    expect(runEffect).toContain("case 'start-listening':");
    expect(runEffect).toContain('startListeningWithRetry()');
    expect(runEffect).toContain("case 'stop-listening':");
    expect(runEffect).toContain('stopListening()');
    expect(runEffect).toContain("case 'set-muted':");
    expect(runEffect).toContain('setMuted(effect.muted)');
    expect(runEffect).toContain("case 'play-earcon':");
    expect(runEffect).toContain('playSendEarcon()');
    expect(runEffect).toContain("case 'stop-speaking':");
    expect(runEffect).toContain('stopSpeaking()');
    expect(runEffect).toContain("case 'speak-reply':");
    expect(runEffect).toContain("case 'stop-session':");
    expect(runEffect).toContain('teardown()');
    expect(runEffect).toContain("case 'send-turn':");
    expect(runEffect).toContain('performSend(effect.text)');
  });

  test('the native events are all subscribed, and level stays out of the reducer', () => {
    for (const event of [
      'partial',
      'final',
      'noSpeech',
      'speechFinished',
      'interruption',
      'endRequested',
      'fatalError',
      'bargeIn',
      'level',
    ]) {
      expect(provider).toContain(`addListener('${event}'`);
    }
    // speechFinished and bargeIn both reopen listening through the reducer.
    expect(provider).toContain("dispatch({ type: 'speechFinished' })");
    expect(provider).toContain("dispatch({ type: 'bargeIn' })");
    // The amplitude sample is banner-only, and it is level data: a shared
    // value the Skia dot reads on the UI thread, never a state write that
    // would redraw the banner per sample.
    expect(provider).toContain('level.value = clampLevel(event.level)');
  });

  test('a send stops listening first, then sends the accumulated turn', () => {
    const sendEffect = provider.indexOf("case 'send-turn':");
    const stop = provider.indexOf("case 'stop-listening':");
    expect(stop).toBeGreaterThan(-1);
    // The reducer orders stop-listening before send-turn; the provider runs
    // effects in order, so listening is stopped before the send is handed over.
    expect(stop).toBeLessThan(sendEffect);
    expect(provider).toContain("source: 'handsfree-call'");
    expect(provider).toContain('messageId: id');
  });

  test('End and the notification End take the same path', () => {
    expect(provider).toContain("dispatch({ type: 'endRequested' })");
    expect(provider).toContain("dispatch({ type: 'end' })");
  });
});

describe('one send per completed turn', () => {
  test('performSend is invoked only by the reducer’s send-turn effect', () => {
    const calls = provider.match(/void performSend\(/g) ?? [];
    // Exactly one call site, and it is the send-turn effect.
    expect(calls.length).toBe(1);
    expect(provider).toContain("case 'send-turn':\n        void performSend(effect.text);");
  });

  test('the turn is sent with a fresh voice-call id and recovery is cleared only after sent', () => {
    expect(provider).toContain("createMessageId('voice-call')");
    expect(provider).toContain("if (outcome === 'sent')");
    expect(provider).toContain('clearHandsfreeRecovery(thread)');
    // The words are persisted as they arrive and promoted on teardown.
    expect(provider).toContain('saveHandsfreeRecovery');
    expect(provider).toContain('promoteHandsfreeRecovery');
  });

  test('busy, offline and failed outcomes are terminal through the reducer', () => {
    expect(provider).toContain("{ type: 'send-busy' }");
    expect(provider).toContain("{ type: 'send-offline' }");
    expect(provider).toContain("{ type: 'send-failed' }");
  });
});

describe('a long streaming reply does not kill the call at the watchdog', () => {
  // A reply that appeared proves the turn left; the watchdog's own contract is
  // a reply nothing produced, so it is disarmed on the reply-appeared edge.
  test('the watchdog is cleared on the reply-appeared edge, not only when speech starts', () => {
    const watcher = between(
      provider,
      'const turnId = turnIdRef.current;',
      'streamReplyText(reply.text',
    );
    const clearAt = watcher.indexOf('clearWatchdog()');
    const replyAt = watcher.indexOf("dispatch({ type: 'reply-appeared' })");
    expect(clearAt).toBeGreaterThan(-1);
    expect(replyAt).toBeGreaterThan(-1);
    // Clearing runs at the SAME stateful edge, before the phase turns.
    expect(clearAt).toBeLessThan(replyAt);
    expect(watcher).not.toContain("dispatch({ type: 'end' })");
  });

  test('a watchdog that still fires while a reply id is bound reopens the mic, not the call', () => {
    const arm = between(provider, 'const armWatchdog = useCallback(', '}, [clearWatchdog, dispatch]);').trim();
    const fire = between(arm, 'watchdogRef.current = setTimeout(() => {', '}, HANDSFREE_REPLY_WATCHDOG_MS);');
    expect(fire).toContain('replyIdRef.current');
    // The fire branches on the reply id: a bound id is the reply-failed reopen
    // arm, no id is still a genuinely silent turn and stays send-failed.
    expect(fire).toMatch(/replyIdRef\.current\s*\?\s*\{\s*type:\s*'reply-failed'\s*\}\s*:\s*\{\s*type:\s*'send-failed'\s*\}/);
  });
});

describe('reply correlation and progressive speech', () => {
  test('the send promise does not move the phase; the placeholder does', () => {
    expect(provider).toContain('handsfreeReplyForTurn(messages, turnId)');
    const sending = between(provider, "if (phase === 'sending') {", "if (phase === 'waiting') {");
    expect(sending).toContain("dispatch({ type: 'reply-appeared' })");
    const waiting = between(provider, "if (phase === 'waiting') {", 'streamReplyText(reply.text');
    expect(waiting).toContain("dispatch({ type: 'reply-content' })");
    // The send promise only clears recovery / arms the watchdog; it never moves
    // the phase.
    const send = between(provider, 'const performSend = useCallback(', 'const runEffect =');
    expect(send).not.toContain('reply-appeared');
    expect(send).not.toContain("dispatch({ type: 'reply-content' })");
  });

  test('progressive speech reuses the pure planner and the native bound', () => {
    expect(provider).toContain('planHandsfreeSpeech');
    expect(provider).toContain('availabilityRef.current?.maxSpeechInputLength');
    expect(provider).toContain('streamReplyText(reply.text, Boolean(reply.streaming))');
  });

  test('a mutated stream falls back to wait-for-completion for the turn', () => {
    expect(provider).toContain('if (plan.mutated) {');
    expect(provider).toContain('fallbackRef.current = true');
    expect(provider).toContain('waitForCompletion: fallbackRef.current');
  });

  test('the call path never imports expo-speech', () => {
    expect(provider).not.toContain('expo-speech');
    expect(reply).not.toContain('expo-speech');
  });

  test('a failed or retracted reply is handled, never spoken to the end', () => {
    expect(provider).toContain('isFailedReply(reply)');
    expect(provider).toContain("{ type: 'reply-failed' }");
  });
});

describe('owning the audio and releasing it', () => {
  test('the B2 guard is taken on start and released on teardown', () => {
    expect(provider).toContain('beginHandsfreeCall()');
    expect(provider).toContain('endHandsfreeCall()');
    expect(provider).toContain('await stopSpeech()');
  });

  test('teardown is once, on terminal and on unmount', () => {
    expect(provider).toContain('if (endingRef.current) return;');
    expect(provider).toContain('teardownRef.current');
    expect(provider).toContain('void teardownRef.current();');
  });
});

describe('start preconditions and captured target', () => {
  test('start takes the caller-built target and checks every precondition', () => {
    expect(provider).toContain('async (target: HandsfreeCallTarget)');
    expect(provider).toContain("AppState.currentState !== 'active'");
    expect(provider).toContain("snapshot.status !== 'connected'");
    expect(provider).toContain('snapshot.activeGateway.id !== target.gatewayId');
    expect(provider).toContain('snapshot.isSending || snapshot.isCommandRunning || snapshot.pendingRunApproval');
  });

  test('availability must report recognition, synthesis and a positive bound', () => {
    expect(provider).toContain('read.recognition');
    expect(provider).toContain('read.synthesis');
    expect(provider).toContain('read.maxSpeechInputLength > 0');
    expect(provider).toContain("startSession({ title: target.label })");
  });

  test('a refusal returns to idle and starts no service', () => {
    expect(provider).toContain("dispatch({ type: 'start-refused' })");
    expect(provider).toContain("if (sessionRef.current.phase !== 'idle') return 'refused'");
  });

  test('the captured gateway, session and Bot are watched, and any move ends the call', () => {
    expect(provider).toContain("dispatch({ type: 'thread-changed' })");
    expect(provider).toContain('activeGateway?.id !== target.gatewayId');
    expect(provider).toContain("(currentSessionId ?? '') !== (target.sessionId ?? '')");
    expect(provider).toContain('(selectedBotId ?? undefined) !== (target.botId ?? undefined)');
    expect(provider).toContain("dispatch({ type: 'disconnect' })");
  });

  test('no backend-name branch and no invented realtime capability', () => {
    expect(provider).not.toMatch(/hermes|opencode|codex|claude-code/i);
    expect(provider).not.toContain('realtime-voice');
  });
});

describe('starting a call cannot strand the provider', () => {
  const start = between(provider, 'const start = useCallback(', 'const mute = useCallback(');

  test('listeners attach before the native session starts, so early events land', () => {
    const subscribeAt = start.indexOf('subscribe(module)');
    const startAt = start.indexOf('module.startSession(');
    expect(subscribeAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(subscribeAt);
  });

  test('a native start that throws is refused, never left in starting', () => {
    expect(start).toMatch(/try\s*\{\s*outcome = await module\.startSession\(\{ title: target\.label \}\);\s*\}\s*catch/);
    expect(start).toContain("dispatch({ type: 'start-refused' })");
    expect(start).toContain('unsubscribe()');
  });

  test('a session that a fatal event already ended is not reported as started', () => {
    expect(start).toContain("sessionRef.current.phase !== 'starting'");
  });
});

describe('a listen that could not start is retried, then named', () => {
  test('the start-listening effect awaits the boolean and fails the call only after retries', () => {
    const listen = between(provider, 'const startListeningWithRetry = useCallback(', '}, [dispatch]);');
    expect(listen).toContain('await module.startListening()');
    expect(listen).toContain('HANDSFREE_LISTEN_RETRY_LIMIT');
    expect(listen).toContain("dispatch({ type: 'fatalError', reason: 'recognition-failed' })");
  });
});

describe('the Call control is not hidden by ordinary chat activity', () => {
  test('canStart no longer depends on a stream, a command or an approval', () => {
    const canStart = between(provider, 'const canStart =', ';');
    expect(canStart).not.toContain('isSending');
    expect(canStart).not.toContain('isCommandRunning');
    expect(canStart).not.toContain('pendingRunApproval');
  });

  test('the provider reports what blocks a start instead', () => {
    expect(provider).toContain('startBlocker: handsfreeStartBlocker(');
  });
});

describe('the availability probe recovers on its own', () => {
  const probe = between(provider, '// Read the device\'s call capability', '// A call is bound to the gateway');

  test('re-probes when the app returns to the foreground', () => {
    expect(probe).toContain("AppState.addEventListener('change'");
  });

  test('retries a probe that answered no recognition or threw', () => {
    expect(probe).toContain('HANDSFREE_PROBE_RETRIES');
  });
});

describe('a Gate-powered call is one transport away from the phone engine', () => {
  test('start branches on the transport, not on an engine or backend name', () => {
    expect(provider).toContain("if (target.transport === 'gate')");
    expect(provider).toContain('startGateCall');
    expect(provider).toContain("'voice.session.start'");
    expect(provider).toContain('startGateMedia');
    expect(provider).toContain("addListener('gate'");
    expect(provider).toContain('reduceGateCall');
    expect(provider).toContain('sendGateControl');
    expect(provider).toContain('reloadHistory');
    // Still no backend-name branch anywhere in the provider.
    expect(provider).not.toMatch(/hermes|opencode|claude-code/i);
  });

  test('the phone engine effects are inert while the Gate owns the loop', () => {
    expect(provider).toContain('if (gateModeRef.current) {');
    expect(provider).toContain("if (effect.kind === 'stop-session') void teardown();");
  });

  test('the Gate banner is folded from frames and the session is ended once', () => {
    expect(provider).toContain('appPhaseForGate(gateBanner.phase)');
    expect(provider).toContain('stopGateMedia');
    expect(provider).toContain("gatewayRequest('voice.session.stop'");
  });
});

describe('a call names the engine it is using and never hides a fallback', () => {
  test('the provider carries the engine and the reason the Gate fell back', () => {
    expect(provider).toContain('engineReason: engineInfo?.reason');
    expect(provider).toContain('setEngineInfo({ engine: grant.engine');
    expect(provider).toContain("setEngineInfo({ engine: 'phone' })");
    expect(provider).toContain('engine?: string;');
    expect(provider).toContain('engineReason?: string;');
  });

  test('the banner draws the engine and the fallback reason', () => {
    expect(banner).toContain('engineReason');
    expect(banner).toContain('Using {engine}');
  });
});
