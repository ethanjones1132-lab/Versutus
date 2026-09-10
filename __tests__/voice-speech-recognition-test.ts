// Solution B's speech-to-text seam (FUTURE-ITEMS.md §B1, `:409-425`): the one
// place the app talks to `expo-speech-recognition`. The package loads its
// native module the moment it is imported, so a client built without the
// native side (no dev build yet) would die at boot on a static import; the
// seam's whole job is to answer honestly there instead — no mic, never a
// throw. What is pinned here is the platform conversation (the availability
// answer, start / stop / cancel, and the partial transcript) and the config
// plugin entry that declares the two permissions iOS reads. The composer's
// own control is a later slice; this seam drives no surface.

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

// The device touch is its own module (the `app-lock.ts` / `app-lock-device.ts`
// split), which is what lets these cases hand the seam a recognizer at all:
// `expo-speech-recognition` cannot load under jest, so the real loader is
// pinned on its own below and the seam is pinned against the answers it takes.
const mockLoad = jest.fn();

jest.mock('@/lib/voice/speech-recognition-native', () => ({
  loadSpeechRecognitionModule: () => mockLoad(),
}));

import {
  cancelSpeechRecognition,
  speechRecognitionAvailable,
  startSpeechRecognition,
  stopSpeechRecognition,
} from '@/lib/voice/speech-recognition';

type SpeechEvent = { isFinal: boolean; results: { transcript: string; confidence: number }[] };

/**
 * A recognizer standing in for the native one: it records what the seam asked
 * it to do, and `emit` plays back what the platform would have reported. The
 * subscriptions it hands out are removable, because whether the seam retires
 * them is half of what these cases are about.
 */
function fakeRecognizer() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  return {
    isRecognitionAvailable: jest.fn(() => true),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    addListener: jest.fn((event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set<(event: unknown) => void>();
      set.add(listener);
      listeners.set(event, set);
      return { remove: jest.fn(() => set.delete(listener)) };
    }),
    emit(event: string, payload: unknown) {
      listeners.get(event)?.forEach((listener) => listener(payload));
    },
    openListeners() {
      return [...listeners.values()].reduce((count, set) => count + set.size, 0);
    },
  };
}

const partial = (transcript: string, isFinal = false): SpeechEvent => ({
  isFinal,
  results: [{ transcript, confidence: 0.5 }],
});

beforeEach(async () => {
  // The seam's session is module-level on purpose (one hold at a time), so a
  // case that ends mid-hold must not leak its listener into the next one.
  await cancelSpeechRecognition();
  mockLoad.mockReset();
});

describe('a client with no native module', () => {
  test('the shipped loader answers no recognizer rather than throwing', async () => {
    const real = jest.requireActual('@/lib/voice/speech-recognition-native') as {
      loadSpeechRecognitionModule: () => Promise<unknown>;
    };

    // This is the client that ships today: CNG-managed, no `ios/`/`android/`,
    // so the package's own `requireNativeModule` throws where it is imported.
    // The seam reads that as no recognizer instead of a boot-time crash.
    await expect(real.loadSpeechRecognitionModule()).resolves.toBeNull();
  });

  test('the seam offers no mic and refuses to start one', async () => {
    mockLoad.mockResolvedValue(null);
    const onTranscript = jest.fn();

    await expect(speechRecognitionAvailable()).resolves.toBe(false);
    await expect(startSpeechRecognition({}, onTranscript)).resolves.toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();

    // Stop and cancel are still safe to call on a client with nothing to stop.
    await expect(stopSpeechRecognition()).resolves.toBeUndefined();
    await expect(cancelSpeechRecognition()).resolves.toBeUndefined();
  });
});

describe('the availability answer', () => {
  test('a recognizer that says it is available is available', async () => {
    mockLoad.mockResolvedValue(fakeRecognizer());

    await expect(speechRecognitionAvailable()).resolves.toBe(true);
  });

  test('a recognizer that cannot answer is not available', async () => {
    const recognizer = fakeRecognizer();
    recognizer.isRecognitionAvailable.mockImplementation(() => {
      throw new Error('no recognition service');
    });
    mockLoad.mockResolvedValue(recognizer);

    await expect(speechRecognitionAvailable()).resolves.toBe(false);
  });
});

describe('a held mic', () => {
  test('starting reaches the recognizer and asks it for interim results', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);

    await expect(startSpeechRecognition({ lang: 'en-GB' }, jest.fn())).resolves.toBe(true);

    // The seam owns the interim-results flag: a partial transcript is the
    // reason it exists, so the operator's own options cannot turn it off.
    expect(recognizer.start).toHaveBeenCalledWith({ lang: 'en-GB', interimResults: true });
  });

  test('a partial transcript reaches the listener, and the final one keeps its mark', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);
    const onTranscript = jest.fn();

    await startSpeechRecognition({}, onTranscript);
    recognizer.emit('result', partial('where is'));
    recognizer.emit('result', partial('where is the fleet', true));

    expect(onTranscript.mock.calls).toEqual([
      ['where is', false],
      ['where is the fleet', true],
    ]);
  });

  test('a result event carrying no transcript reports nothing rather than a guess', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);
    const onTranscript = jest.fn();

    await startSpeechRecognition({}, onTranscript);
    recognizer.emit('result', { isFinal: false, results: [] });

    expect(onTranscript.mock.calls).toEqual([['', false]]);
  });

  test('a start the recognizer refuses answers false and leaves no listener behind', async () => {
    const recognizer = fakeRecognizer();
    recognizer.start.mockImplementation(() => {
      throw new Error('service-not-allowed');
    });
    mockLoad.mockResolvedValue(recognizer);

    await expect(startSpeechRecognition({}, jest.fn())).resolves.toBe(false);

    expect(recognizer.openListeners()).toBe(0);
  });

  test('a second hold retires the first one instead of hearing it too', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);
    const first = jest.fn();
    const second = jest.fn();

    await startSpeechRecognition({}, first);
    await startSpeechRecognition({}, second);
    recognizer.emit('result', partial('second message'));

    expect(recognizer.openListeners()).toBe(3); // result, end, error — one hold's worth
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('ending a hold', () => {
  test('stopping asks for the final result and still hears it', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);
    const onTranscript = jest.fn();

    await startSpeechRecognition({}, onTranscript);
    await stopSpeechRecognition();
    recognizer.emit('result', partial('send it', true));

    expect(recognizer.stop).toHaveBeenCalledTimes(1);
    // A stop promises a final result through the same listener, so the
    // listener outlives the stop call.
    expect(onTranscript).toHaveBeenCalledWith('send it', true);
  });

  test('the session ending on its own retires the listener', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);
    const onTranscript = jest.fn();

    await startSpeechRecognition({}, onTranscript);
    recognizer.emit('end', null);
    recognizer.emit('result', partial('too late'));

    expect(recognizer.openListeners()).toBe(0);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  test('a session that ends in an error retires the listener too', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);

    await startSpeechRecognition({}, jest.fn());
    recognizer.emit('error', { error: 'audio-capture', message: 'no microphone' });

    expect(recognizer.openListeners()).toBe(0);
  });

  test('cancelling aborts and hears nothing further', async () => {
    const recognizer = fakeRecognizer();
    mockLoad.mockResolvedValue(recognizer);
    const onTranscript = jest.fn();

    await startSpeechRecognition({}, onTranscript);
    await cancelSpeechRecognition();
    // An abort returns no final result, so anything the platform still
    // reports is not this operator's message.
    recognizer.emit('result', partial('discarded', true));

    expect(recognizer.abort).toHaveBeenCalledTimes(1);
    expect(recognizer.openListeners()).toBe(0);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe('the config plugin entry', () => {
  type Plugin = string | [string, Record<string, unknown>];

  const config = (): { expo: { plugins: Plugin[] } } =>
    JSON.parse(readSource('app.json')) as { expo: { plugins: Plugin[] } };

  test('the plugin carries this app its own two iOS permission strings', () => {
    const entry = config().expo.plugins.find(
      (plugin) => typeof plugin !== 'string' && plugin[0] === 'expo-speech-recognition',
    );

    // Both keys are read straight into Info.plist; a plugged-in speech plugin
    // with neither would build a device that cannot be asked.
    expect(entry).toBeDefined();
    const options = (entry as [string, Record<string, unknown>])[1];
    expect(options.microphonePermission).toEqual(expect.stringContaining('microphone'));
    expect(options.speechRecognitionPermission).toEqual(
      expect.stringContaining('speech recognition'),
    );
  });

  test('the seven entries that were already there are untouched', () => {
    // The must-still of this slice: adding the recognizer may not move,
    // reorder or re-word any plugin the app already shipped.
    expect(config().expo.plugins.slice(0, 7)).toEqual([
      'expo-router',
      './plugins/with-openclaw-discovery.js',
      ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
      [
        'expo-splash-screen',
        {
          backgroundColor: '#08080A',
          android: { image: './assets/images/splash-icon.png', imageWidth: 76 },
        },
      ],
      'expo-secure-store',
      'expo-web-browser',
      'expo-notifications',
    ]);
  });
});
