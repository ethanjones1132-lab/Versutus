declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', relative].join(SEP), 'utf8');
}

describe('chat-screen session and model derivations', () => {
  test('the sessions map is memoized on sessionList, not rebuilt every render', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The old bare map — `(sessionList as SessionRecord[]).map(toSessionItem)` —
    // at the `sessions =` binding must be gone; it is now wrapped in useMemo.
    expect(screen).not.toMatch(
      /const sessions = \(sessionList as SessionRecord\[\]\)\.map\(toSessionItem\);/,
    );
    // It still maps the same way, just inside a useMemo keyed by `sessionList`.
    expect(screen).toMatch(/const sessions = useMemo\(/);
    expect(screen).toMatch(/\(sessionList as SessionRecord\[\]\)\.map\(toSessionItem\)/);
    expect(screen).toMatch(/\[sessionList\]/);
  });

  test('the model catalog map is memoized on modelCatalog, not rebuilt inline', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The inline `models={modelCatalog.map(...)}` prop must be gone; the rows
    // are now computed once into a stable `modelRows` and passed by identity.
    expect(screen).not.toMatch(/models=\{\s*modelCatalog\.map\(/);
    // The catalog is still mapped, but inside a useMemo keyed by `modelCatalog`.
    expect(screen).toMatch(/const modelRows = useMemo\(/);
    expect(screen).toMatch(/modelCatalog\.map\(/);
    expect(screen).toMatch(/\[modelCatalog\]/);
    // The prop reads the memoized array by name.
    expect(screen).toMatch(/models=\{\s*modelRows\s*\}/);
  });
});

describe('chat-screen speaker wiring', () => {
  test('the toggle reads the store’s own rule and is offered only where the device has a voice', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The flag is this conversation's, keyed by the shipped draft key and read
    // through the store's own fold: the screen authors no key and no rule.
    expect(screen).toMatch(/speakerPreferenceKey\(draftThread\)/);
    expect(screen).toMatch(/readSpeakerOn\(stored, speakerKey\)/);
    // The platform's own answer decides whether the header is handed a control
    // at all, so a device with no voice is offered no tap that could not finish.
    expect(screen).toMatch(
      /onSpeakerPress=\{\s*threadSurface && speakerKey && speechReady \? handleSpeakerPress : undefined,?\s*\}/,
    );
    // A toggle-off silences the queue on its way out. The call now sits in the
    // block that takes the one-time hint down with it, so the pin names the
    // call rather than the whole line — the claim is the same one.
    expect(screen).toMatch(/if \(!next\) \{\s*void stopSpeech\(\);/);
  });

  test('a completed reply is read once, through the transcript rule', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // What to do about the transcript's tail is the pure fold's answer, never a
    // chain of conditions re-authored here.
    expect(screen).toMatch(/const action = speakerAction\(transcriptTail\);/);
    // A reply already read is not read again: the memory is the message id, so
    // a re-render during a reply cannot speak it twice.
    expect(screen).toMatch(/if \(memory\.id === transcriptTail\?\.id\) return;/);
    // It is read in this Bot's own voice where one is stored, and left to the
    // platform's own defaults where none is.
    expect(screen).toMatch(
      /void speakReply\(action\.text, botVoiceId \? \{ voiceIdentifier: botVoiceId \} : \{\}\);/,
    );
  });

  test('a new turn silences the queue, and a silent conversation is never asked', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The silence edge is the fold's, and it stops what is still queued.
    expect(screen).toMatch(/if \(action\.kind === 'silence'\) \{\s*void stopSpeech\(\);\s*return;\s*\}/);
    // Nothing is spoken while the flag is off: the fold is not even asked.
    expect(screen).toMatch(/if \(!speakerOn\) return;\s*const action = speakerAction\(transcriptTail\);/);
  });
});

describe('chat-screen Bot voice wiring', () => {
  test('the picker’s rows are this device’s own list through the fold', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The list is the platform's, read once through the shipped seam, and the
    // rows are the pure fold's — the screen authors no order and no copy.
    expect(screen).toMatch(/void availableVoices\(\)\.then\(\(voices\) => \{/);
    expect(screen).toMatch(/botVoiceOptions\(deviceVoices, botVoiceId\)/);
    // The Bot chrome is handed the rows only where there is a Bot to key a
    // voice to; a device that named no voice is handed nothing to draw.
    expect(screen).toMatch(/voiceOptions=\{botVoiceKey \? botVoiceChoices : undefined\}/);
    expect(screen).toMatch(/onVoiceSelect=\{botVoiceKey \? handleBotVoiceSelect : undefined\}/);
  });

  test('the choice is the store’s, and the reply is read in it', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // Keyed gateway + Bot by the store's own key, read by the store's own read.
    expect(screen).toMatch(/botVoicePreferenceKey\(activeGateway\.id, botSurfaceId\)/);
    expect(screen).toMatch(/readBotVoice\(stored, botVoiceKey\)\?\.voiceIdentifier/);
    // A pick is written through the store's fold; the default row clears the
    // entry rather than storing a voice nothing could be spoken with.
    expect(screen).toMatch(/applyBotVoice\(stored, key, \{ voiceIdentifier: identifier \}\)/);
    expect(screen).toMatch(/clearVoicePreference\(stored, key\)/);
    // Must still: a conversation's own toggle is a separate key space, folded by
    // its own rule, so a Bot's voice can never move it.
    expect(screen).toMatch(/applySpeakerOn\(stored, key, next\)/);
  });

  test('a voice the operator installs mid-session is offered on the way back in', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The list is this device's, and a voice is installed in the phone's own
    // settings while this app is alive — so it is read again on every return to
    // this surface rather than once at a mount a tab screen never repeats. Both
    // routes back in are needed: a download is made by LEAVING the app, which
    // backgrounds the screen rather than blurring its route, so the foreground
    // edge is what catches that trip and the tab's own focus is what asks the
    // device again once the operator is back.
    expect(screen).toMatch(/useFocusEffect\(refreshDeviceVoices\)/);
    expect(screen).toMatch(/if \(state === 'active'\) refreshDeviceVoices\(\);/);
    // It is the same seam read the rows are folded from, so the rows this
    // device is offered are the list it has now.
    expect(screen).toMatch(/void availableVoices\(\)\.then\(\(voices\) => \{/);
    // Must still: which surfaces draw a Voice section is the fold's answer, not
    // the read's — a device the platform named no voice for is handed nothing.
    expect(screen).toMatch(/botVoiceOptions\(deviceVoices, botVoiceId\)/);
    expect(screen).toMatch(/voiceOptions=\{botVoiceKey \? botVoiceChoices : undefined\}/);
  });

  test('a voice gained mid-session brings the header’s toggle with it', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // Drawing a picker row and offering a toggle tap are two answers to ONE
    // question — what voices this device has now — so both are painted from the
    // same refreshed read instead of read apart and left able to disagree.
    expect(screen).toMatch(/void availableVoices\(\)\.then\(\(voices\) => \{/);
    expect(screen).toMatch(/setSpeechReady\(speechAvailableFrom\(voices\)\)/);
    // The answer is the seam's rule asked of that list, and it is asked nowhere
    // else: a device that gains a voice gains the row and the toggle together.
    expect(screen).not.toMatch(/void speechAvailable\(\)\.then\(/);
    // Must still: the gate the header's control hangs on, and the press behind
    // it, are unchanged.
    expect(screen).toMatch(
      /onSpeakerPress=\{\s*threadSurface && speakerKey && speechReady \? handleSpeakerPress : undefined,?\s*\}/,
    );
    // Must still: which surfaces draw a Voice section stays the fold's answer,
    // so a device the platform named no voice for is handed nothing to draw.
    expect(screen).toMatch(/botVoiceOptions\(deviceVoices, botVoiceId\)/);
    expect(screen).toMatch(/voiceOptions=\{botVoiceKey \? botVoiceChoices : undefined\}/);
  });
});

describe('chat-screen silent-mode hint wiring', () => {
  test('whether this device can be told at all is the store’s rule, on the platform’s own answer', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // B2's iOS caveat (`FUTURE-ITEMS.md:441-442`) is decided by the store's
    // pure fold, handed the platform's own answer — so a device that is not
    // iOS is never owed a hint at all, and the screen authors no platform test
    // of its own that could disagree with it.
    expect(screen).toMatch(/shouldShowSilentModeHint\(stored, Platform\.OS\)/);
    expect(screen).not.toMatch(/Platform\.OS === 'ios'/);
    // The line says the module's own words: the surface ships no copy of its
    // own about what can or cannot be heard.
    expect(screen).toMatch(/\{SILENT_MODE_HINT_COPY\}/);
    expect(screen).not.toMatch(/silent mode/i);
  });

  test('the hint is drawn on the toggle-on edge and acknowledged as it is shown', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The hint is owed on the turn-on edge only, and the acknowledgement rides
    // the SAME write as the flag, so the hint is drawn once and the store says
    // this device has been told.
    expect(screen).toMatch(/const showHint = next && silentHintOwed;/);
    expect(screen).toMatch(
      /if \(showHint\) \{\s*setSilentHintShown\(true\);\s*setSilentHintOwed\(false\);\s*\}/,
    );
    expect(screen).toMatch(
      /saveVoicePreferences\(showHint \? acknowledgeSilentModeHint\(written\) : written\)/,
    );
    // Drawn from the state the edge set, never from a second platform test.
    expect(screen).toMatch(/\{silentHintShown \? \(/);
  });

  test('must still: the flag’s own write is unchanged, and the hint leaves with the speaker', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    // The conversation's flag is still folded by its own rule off the re-read
    // blob, and still read by the store's own read.
    expect(screen).toMatch(/const written = applySpeakerOn\(stored, key, next\);/);
    expect(screen).toMatch(/readSpeakerOn\(stored, speakerKey\)/);
    // A hint is not an error: the line goes when the speaker it came with goes.
    expect(screen).toMatch(
      /if \(!next\) \{\s*void stopSpeech\(\);\s*setSilentHintShown\(false\);\s*\}/,
    );
  });
});
