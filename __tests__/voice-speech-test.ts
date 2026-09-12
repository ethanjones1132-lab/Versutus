// Solution B2's spoken-reply seam (FUTURE-ITEMS.md §B2, `:429-435`): the one
// place the app drives `expo-speech` — the chunk queue behind a reply, and the
// stop that silences it. The package loads its native module the moment it is
// imported, so a client built without the native side would die at boot on a
// static import; the device seam's whole job is to answer honestly there
// instead — no voice, never a throw. What is pinned here is the conversation
// with the platform (the availability answer, the bound the chunks are cut at,
// the order they are spoken in, the stop that clears the queue, and a refusal
// that answers `false`) and the loader that is the only file naming the
// package. The header's own toggle is a later slice; this seam drives no
// surface.

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

// The device touch is its own module (the `speech-recognition-native.ts`
// split), which is what lets these cases hand the seam an engine at all:
// `expo-speech` cannot load under jest, so the real loader is pinned on its
// own below and the seam is pinned against the answers it takes.
const mockLoad = jest.fn();

jest.mock('@/lib/voice/speech-device', () => ({
  loadSpeechEngine: () => mockLoad(),
}));

import {
  availableVoices,
  beginHandsfreeCall,
  endHandsfreeCall,
  handsfreeOwnsSpeech,
  speakReply,
  speechAvailable,
  speechAvailableFrom,
  stopSpeech,
} from '@/lib/voice/speech';

/** The options the seam hands the platform for one utterance. */
type SpeakOptions = {
  voice?: string;
  rate?: number;
  pitch?: number;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: () => void;
};

const voice = (identifier: string, quality: 'Default' | 'Enhanced' = 'Default') => ({
  identifier,
  name: identifier,
  quality,
  language: 'en-US',
});

/**
 * An engine standing in for the platform's: it records the utterances it was
 * handed, in order, and `finish` plays back the platform reporting that the
 * utterance it was last given has been spoken to its end. It names one voice
 * and a bound a short reply fits inside, so the shipped cases keep testing the
 * conversation they were written for.
 */
function fakeEngine(options: { voices?: unknown[]; bound?: number } = {}) {
  const spoken: string[] = [];
  const ends: (() => void)[] = [];

  return {
    maxSpeechInputLength: options.bound ?? 1000,
    getAvailableVoicesAsync: jest.fn(async () => options.voices ?? [voice('com.apple.voice')]),
    speak: jest.fn((text: string, settings?: SpeakOptions) => {
      spoken.push(text);
      ends.push(settings?.onDone ?? (() => undefined));
    }),
    stop: jest.fn(async () => undefined),
    spoken,
    /** The platform finishing the oldest utterance still in flight. */
    finish() {
      ends.shift()?.();
    },
    optionsFor(call: number) {
      return (this.speak.mock.calls[call]?.[1] ?? {}) as SpeakOptions;
    },
  };
}

beforeEach(async () => {
  // The seam's queue is module-level on purpose (one reply at a time), so a
  // case that ends mid-reply must not leak its chunks into the next one.
  await stopSpeech();
  mockLoad.mockReset();
});

describe('a client with no native module', () => {
  test('the shipped loader answers no engine rather than throwing', async () => {
    const real = jest.requireActual('@/lib/voice/speech-device') as {
      loadSpeechEngine: () => Promise<unknown>;
    };

    // This is the client that ships today: CNG-managed, no `ios/`/`android/`,
    // so the package's own `requireNativeModule` throws where it is imported.
    // The seam reads that as no engine instead of a boot-time crash.
    await expect(real.loadSpeechEngine()).resolves.toBeNull();
  });

  test('the seam offers no speaker and speaks nothing', async () => {
    mockLoad.mockResolvedValue(null);

    await expect(speechAvailable()).resolves.toBe(false);
    await expect(speakReply('Anything at all.')).resolves.toBe(false);
    // Stop is still safe to call on a client with nothing to stop.
    await expect(stopSpeech()).resolves.toBeUndefined();
  });

  test('the one file naming the package loads it on the first call', () => {
    const device = readSource('src', 'lib', 'voice', 'speech-device.ts');

    // A static import would be read at boot, where the native module is
    // missing; the import lives inside a call the app makes instead.
    expect(device).toContain("import('expo-speech')");
    expect(device).toMatch(/try\s*\{/);
    expect(device).not.toMatch(/^import .*expo-speech/m);
  });
});

describe('the availability answer', () => {
  test('a device whose platform names a voice has one', async () => {
    mockLoad.mockResolvedValue(fakeEngine());

    await expect(speechAvailable()).resolves.toBe(true);
  });

  test('a platform that names no voice is no voice', async () => {
    // Android's own module answers an empty list when its text-to-speech
    // engine failed to initialise, which is a device nothing can be read on.
    mockLoad.mockResolvedValue(fakeEngine({ voices: [] }));

    await expect(speechAvailable()).resolves.toBe(false);
  });

  test('a voice list that cannot be read is no voice rather than a guess', async () => {
    const engine = fakeEngine();
    engine.getAvailableVoicesAsync.mockRejectedValue(new Error('no speech service'));
    mockLoad.mockResolvedValue(engine);

    await expect(speechAvailable()).resolves.toBe(false);
  });

  test('the same question asked of a list already in hand is the same answer', () => {
    // What lets one read paint both surfaces: the rule is the list's length and
    // it is the seam's, so a caller holding the list the picker's rows were
    // folded from asks it here rather than writing a test of its own that could
    // disagree with this one.
    expect(speechAvailableFrom([])).toBe(false);
    expect(speechAvailableFrom([voice('voice.one')])).toBe(true);
  });
});

describe('the voices this device offers', () => {
  test('the platform’s own list is handed on as it answered', async () => {
    const engine = fakeEngine({ voices: [voice('voice.one'), voice('voice.two', 'Enhanced')] });
    mockLoad.mockResolvedValue(engine);

    // Unread: the order the picker draws and what counts as a voice are
    // `botVoiceRows`'s rules, so the seam hands on exactly what it was given.
    await expect(availableVoices()).resolves.toEqual([
      voice('voice.one'),
      voice('voice.two', 'Enhanced'),
    ]);
  });

  test('a client with no native module offers no voices', async () => {
    mockLoad.mockResolvedValue(null);

    await expect(availableVoices()).resolves.toEqual([]);
  });

  test('a list that cannot be read is no voices rather than a guess', async () => {
    const engine = fakeEngine();
    engine.getAvailableVoicesAsync.mockRejectedValue(new Error('no speech service'));
    mockLoad.mockResolvedValue(engine);

    await expect(availableVoices()).resolves.toEqual([]);
    // The availability answer is that same read, so neither can disagree with
    // the other about what this device has.
    await expect(speechAvailable()).resolves.toBe(false);
  });
});

describe('reading a reply', () => {
  test('a reply is spoken one sentence-chunk at a time, in order', async () => {
    const engine = fakeEngine({ bound: 20 });
    mockLoad.mockResolvedValue(engine);

    await expect(speakReply('First sentence. Second sentence. Third.')).resolves.toBe(true);

    // One utterance at a time: the platform is handed the first chunk, and the
    // rest of the reply waits for that one to finish.
    expect(engine.spoken).toEqual(['First sentence. ']);
    engine.finish();
    expect(engine.spoken).toEqual(['First sentence. ', 'Second sentence. ']);
    engine.finish();
    expect(engine.spoken).toEqual(['First sentence. ', 'Second sentence. ', 'Third.']);
    engine.finish();
    expect(engine.speak).toHaveBeenCalledTimes(3);
  });

  test('the chunks are cut at the bound the platform itself reports', async () => {
    const engine = fakeEngine({ bound: 20 });
    mockLoad.mockResolvedValue(engine);
    await speakReply('First sentence. Second sentence. Third.');
    await stopSpeech();

    // The same reply under the platform's own iOS bound (`Number.MAX_VALUE`) is
    // one utterance: nothing in it is over the bound, so nothing is cut.
    const whole = fakeEngine({ bound: Number.MAX_VALUE });
    mockLoad.mockResolvedValue(whole);
    await speakReply('First sentence. Second sentence. Third.');

    expect(engine.speak).toHaveBeenCalledTimes(1);
    expect(whole.speak).toHaveBeenCalledTimes(1);
    expect(whole.spoken).toEqual(['First sentence. Second sentence. Third.']);
  });

  test('a bound nothing can be spoken under speaks nothing', async () => {
    const engine = fakeEngine({ bound: 0 });
    mockLoad.mockResolvedValue(engine);

    await expect(speakReply('First sentence. Second sentence.')).resolves.toBe(false);
    expect(engine.speak).not.toHaveBeenCalled();
  });

  test('a reply carrying no words speaks nothing', async () => {
    const engine = fakeEngine();
    mockLoad.mockResolvedValue(engine);

    await expect(speakReply('   \n  ')).resolves.toBe(false);
    expect(engine.speak).not.toHaveBeenCalled();
  });

  test('a second reply queues behind the one being read', async () => {
    const engine = fakeEngine({ bound: 20 });
    mockLoad.mockResolvedValue(engine);

    await speakReply('First sentence. Second sentence. Third.');
    await expect(speakReply('Another reply.')).resolves.toBe(true);

    // The reply already being read finishes before the new one starts.
    expect(engine.spoken).toEqual(['First sentence. ']);
    engine.finish();
    engine.finish();
    engine.finish();

    expect(engine.spoken).toEqual([
      'First sentence. ',
      'Second sentence. ',
      'Third.',
      'Another reply.',
    ]);
  });

  test('a platform that refuses the first chunk answers false', async () => {
    const engine = fakeEngine({ bound: 20 });
    engine.speak.mockImplementation(() => {
      throw new Error('no speech service');
    });
    mockLoad.mockResolvedValue(engine);

    await expect(speakReply('First sentence. Second sentence.')).resolves.toBe(false);

    // The refused reply is not asked for again chunk by chunk.
    expect(engine.speak).toHaveBeenCalledTimes(1);
  });

  test('the voice a reply is read in is the platform’s own option', async () => {
    const engine = fakeEngine();
    mockLoad.mockResolvedValue(engine);

    await speakReply('Hello.', { voiceIdentifier: 'com.apple.voice.premium.en-US', rate: 0.9, pitch: 1.1 });

    expect(engine.optionsFor(0)).toEqual(
      expect.objectContaining({
        voice: 'com.apple.voice.premium.en-US',
        rate: 0.9,
        pitch: 1.1,
      }),
    );
  });

  test('a reply with no voice configured leaves the platform its own defaults', async () => {
    const engine = fakeEngine();
    mockLoad.mockResolvedValue(engine);

    await speakReply('Hello.');

    // No voice is invented for a Bot that has none: the platform's own defaults
    // are what an unconfigured voice means.
    expect(engine.optionsFor(0).voice).toBeUndefined();
    expect(engine.optionsFor(0).rate).toBeUndefined();
    expect(engine.optionsFor(0).pitch).toBeUndefined();
  });
});

describe('silencing the queue', () => {
  test('a stop clears the chunk being read and every chunk behind it', async () => {
    const engine = fakeEngine({ bound: 20 });
    mockLoad.mockResolvedValue(engine);

    await speakReply('First sentence. Second sentence. Third.');
    await stopSpeech();
    // The platform reports the utterance it stopped finishing afterwards; the
    // queue that utterance belonged to is gone, so nothing follows it.
    engine.finish();

    expect(engine.speak).toHaveBeenCalledTimes(1);
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  test('a reply spoken after a stop starts again', async () => {
    const engine = fakeEngine({ bound: 20 });
    mockLoad.mockResolvedValue(engine);

    await speakReply('First sentence. Second sentence. Third.');
    await stopSpeech();
    await expect(speakReply('Fresh reply.')).resolves.toBe(true);

    // The silenced reply's remaining chunks are gone; the new one is not
    // treated as a continuation of it.
    expect(engine.spoken).toEqual(['First sentence. ', 'Fresh reply.']);
  });

  test('a platform that will not stop is not asked twice', async () => {
    const engine = fakeEngine({ bound: 20 });
    engine.stop.mockRejectedValue(new Error('nothing to stop'));
    mockLoad.mockResolvedValue(engine);

    await expect(stopSpeech()).resolves.toBeUndefined();
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });
});

describe('a hands-free call owning audio', () => {
  afterEach(() => {
    // The ownership flag is module-level on purpose; a case must not leak it.
    endHandsfreeCall();
  });

  test('speakReply answers false while a call owns audio, speaking nothing', async () => {
    const engine = fakeEngine();
    mockLoad.mockResolvedValue(engine);

    beginHandsfreeCall();
    expect(handsfreeOwnsSpeech()).toBe(true);
    await expect(speakReply('A reply the call is already reading.')).resolves.toBe(false);
    expect(engine.speak).not.toHaveBeenCalled();
  });

  test('the ordinary speaker resumes the instant the call releases audio', async () => {
    const engine = fakeEngine();
    mockLoad.mockResolvedValue(engine);

    beginHandsfreeCall();
    endHandsfreeCall();
    expect(handsfreeOwnsSpeech()).toBe(false);
    await expect(speakReply('Hello.')).resolves.toBe(true);
    expect(engine.spoken).toEqual(['Hello.']);
  });
});

describe('the seam that speaks', () => {
  test('it reaches the engine only through the device seam', () => {
    const seam = readSource('src', 'lib', 'voice', 'speech.ts');

    // The one file that names the package is down there, so this one can be
    // read as rules rather than as a native call.
    expect(seam).not.toContain('expo-speech');
    expect(seam).toContain("from '@/lib/voice/speech-device'");
  });

  test('the platform’s own bound is what cuts the reply', () => {
    const seam = readSource('src', 'lib', 'voice', 'speech.ts');

    // No bound is invented here: the caller hands in the platform's own answer
    // to `Speech.maxSpeechInputLength`.
    expect(seam).toContain('speechChunks(text, engine.maxSpeechInputLength)');
  });
});
