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
    // A toggle-off silences the queue on its way out.
    expect(screen).toMatch(/if \(!next\) void stopSpeech\(\);/);
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
});
