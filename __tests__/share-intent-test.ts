// A text shared into Versutus from another app (FUTURE-ITEMS.md:193-194, item
// 5's Android half): the platform hands the app a SEND intent, and the words
// become the same `ComposeRequest` a `versutus://compose` link folds to, so
// they reach a thread's composer as a draft and nothing sends them.
//
// What is pinned here is the fold (what a payload becomes), the platform
// conversation (subscribe, the ask for the share that launched the app, forget
// what was handed over), the loader that answers a build with no native side,
// and the config that gives the app an Android share entry at all. The root
// layout's own wiring is pinned off the source, the way the deep-link suite
// pins it.
//
// `expo-share-intent` cannot be loaded under jest — it reaches for the native
// module and for `expo-constants` — so the seam takes the package from its own
// loader (the `speech-recognition-native.ts` split) and this suite hands the
// seam a package instead.

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

const mockLoad = jest.fn();

jest.mock('@/lib/gateway/share-intent-native', () => ({
  loadShareIntentPackage: () => mockLoad(),
}));

import { Platform } from 'react-native';

import {
  dismissSharedText,
  listenForSharedText,
  sharedTextRequest,
} from '@/lib/gateway/share-intent';

/** What the platform reports on `onChange`: a JSON string, or Android's map. */
type ReportedShare = string | Record<string, unknown>;

/**
 * The package as the seam reads it, shaped like the real one: a native module
 * with the three calls the seam makes, plus the helpers it takes a parsed
 * payload and a storage key from. `parseShareIntent` stands in for the
 * package's own parse, which answers the payload shape it documents — the
 * shared string kept whole in `text`, with any URL it holds lifted out beside
 * it (`node_modules/expo-share-intent/build/utils.js`) — which is why the fold
 * reads `text` alone.
 */
function fakePackage() {
  const listeners = new Map<string, (event: { value: ReportedShare }) => void>();

  const module = {
    addListener: jest.fn((event: string, listener: (event: { value: ReportedShare }) => void) => {
      listeners.set(event, listener);
      return {
        remove: jest.fn(() => {
          listeners.delete(event);
        }),
      };
    }),
    getShareIntent: jest.fn(async () => undefined),
    clearShareIntent: jest.fn(async () => undefined),
  };

  return {
    ShareIntentModule: module,
    parseShareIntent: jest.fn((value: ReportedShare) => ({
      files: null,
      type: 'text',
      webUrl: null,
      text: typeof value === 'string' ? value : ((value.text as string | undefined) ?? null),
    })),
    getShareExtensionKey: jest.fn(() => 'versutusShareKey'),
    emit: (value: ReportedShare) => listeners.get('onChange')?.({ value }),
    openListeners: () => listeners.size,
  };
}

beforeEach(() => {
  mockLoad.mockReset();
});

// `jest.replaceProperty` puts the platform back only when it is asked to, and
// two cases below flip it: a suite that ran as Android for the rest of its
// tests would be pinning the wrong platform.
afterEach(() => {
  jest.restoreAllMocks();
});

describe('what a share asks for', () => {
  test('the shared words become a draft request, and the request names no Bot', () => {
    const request = sharedTextRequest({ text: 'send this to the fleet' });

    expect(request).toEqual({ text: 'send this to the fleet' });
    // The sheet the operator shares from has nowhere to say which Bot the text
    // is for, so the draft belongs to whichever thread is up — the rule
    // `composeRequestApplies` already follows for a link that names no Bot.
    expect(request).not.toHaveProperty('botId');
  });

  test('the text is carried as the other app wrote it', () => {
    // Shared content is untrusted input: this fold decides only whether there
    // is anything to carry, and does not re-word what it carries.
    const text = '  two  spaces, a\nnewline and "quotes"  ';

    expect(sharedTextRequest({ text })).toEqual({ text });
  });

  test('a share with no words asks for no draft', () => {
    // The rule `deepLinkTarget` already follows for a composed link: a text
    // that is absent, empty or only whitespace is nothing to prefill. A share
    // of a file is the same answer here — files are a later slice, and a draft
    // naming a path is not the words the operator shared.
    expect(sharedTextRequest(null)).toBeNull();
    expect(sharedTextRequest({})).toBeNull();
    expect(sharedTextRequest({ text: null })).toBeNull();
    expect(sharedTextRequest({ text: '' })).toBeNull();
    expect(sharedTextRequest({ text: '   \n ' })).toBeNull();
  });
});

describe('the platform conversation', () => {
  test('a share the platform hands over is reported, parsed', async () => {
    const shareIntent = fakePackage();
    mockLoad.mockResolvedValue(shareIntent);
    const onShared = jest.fn();

    await listenForSharedText(onShared);
    // Android reports a map; iOS reports the extension's JSON string. Both are
    // the package's own parse to read, and the seam reports what it answers.
    shareIntent.emit({ text: 'send this to the fleet', type: 'text' });

    expect(onShared).toHaveBeenCalledTimes(1);
    expect(onShared).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'send this to the fleet' }),
    );
  });

  test('the platform is asked for the share that launched the app, after the listener is up', async () => {
    // This suite runs as iOS, and the ask is Android's — the platform whose
    // shares launch the app through an intent rather than an extension — so it
    // is flipped for this case and restored after it.
    jest.replaceProperty(Platform, 'OS', 'android');
    const shareIntent = fakePackage();
    mockLoad.mockResolvedValue(shareIntent);

    await listenForSharedText(jest.fn());

    // A share that launched the app was recorded before any listener existed,
    // so the ask happens after the subscription: an answer that arrives before
    // there is anywhere to put it is an answer the operator never sees.
    expect(shareIntent.ShareIntentModule.getShareIntent).toHaveBeenCalledWith('');
    const subscribed = shareIntent.ShareIntentModule.addListener.mock.invocationCallOrder[0];
    const asked = shareIntent.ShareIntentModule.getShareIntent.mock.invocationCallOrder[0];
    expect(subscribed).toBeLessThan(asked);
  });

  test('an iOS build is not asked the question the share extension answers instead', async () => {
    const shareIntent = fakePackage();
    mockLoad.mockResolvedValue(shareIntent);
    const onShared = jest.fn();

    await listenForSharedText(onShared);
    // No launch-intent ask on iOS, and none needed: a share that arrives while
    // the app is running — the only kind this cut carries on either platform —
    // is delivered through the listener, which is the whole path here.
    shareIntent.emit({ text: 'shared from a running app', type: 'text' });

    expect(shareIntent.ShareIntentModule.getShareIntent).not.toHaveBeenCalled();
    expect(onShared).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'shared from a running app' }),
    );
  });

  test('stopping the listener retires the subscription', async () => {
    const shareIntent = fakePackage();
    mockLoad.mockResolvedValue(shareIntent);
    const onShared = jest.fn();

    const stop = await listenForSharedText(onShared);
    expect(shareIntent.openListeners()).toBe(1);

    stop();
    shareIntent.emit('too late');

    expect(shareIntent.openListeners()).toBe(0);
    expect(onShared).not.toHaveBeenCalled();
  });
});

describe('a build with no share-intent support', () => {
  test('no package is no share and no throw', async () => {
    mockLoad.mockResolvedValue(null);
    const onShared = jest.fn();

    const stop = await listenForSharedText(onShared);

    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
    expect(onShared).not.toHaveBeenCalled();
  });

  test('a package whose native module is absent is the same answer', async () => {
    mockLoad.mockResolvedValue({ ...fakePackage(), ShareIntentModule: null });

    // Expo Go, and any client built before the config plugin ran a prebuild:
    // the package is there and the platform behind it is not.
    const stop = await listenForSharedText(jest.fn());

    expect(typeof stop).toBe('function');
  });

  test('a platform that will not subscribe leaves a stop function behind', async () => {
    const shareIntent = fakePackage();
    shareIntent.ShareIntentModule.addListener.mockImplementation(() => {
      throw new Error('no bridge');
    });
    mockLoad.mockResolvedValue(shareIntent);

    const stop = await listenForSharedText(jest.fn());

    expect(typeof stop).toBe('function');
    expect(shareIntent.openListeners()).toBe(0);
    // The stop function is still a stop function: whoever holds it stops
    // nothing rather than being handed null to guard against.
    expect(() => stop()).not.toThrow();
  });

  test('an ask the platform refuses leaves the listener up', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const shareIntent = fakePackage();
    shareIntent.ShareIntentModule.getShareIntent.mockRejectedValue(new Error('no activity'));
    mockLoad.mockResolvedValue(shareIntent);
    const onShared = jest.fn();

    const stop = await listenForSharedText(onShared);
    shareIntent.emit('arrived after the ask failed');

    // The ask failing is not the app giving up on shares: the listener it
    // already has is still the path a running app's share arrives on.
    expect(onShared).toHaveBeenCalledWith(expect.objectContaining({ text: 'arrived after the ask failed' }));
    expect(shareIntent.openListeners()).toBe(1);
    stop();
  });
});

describe('forgetting the share that was handed over', () => {
  test('the platform is told to forget it under its own key', async () => {
    const shareIntent = fakePackage();
    mockLoad.mockResolvedValue(shareIntent);

    await dismissSharedText();

    // The key is the package's own (its scheme plus `ShareKey`), not a string
    // this app spells itself; the platform holds the share past handing it over,
    // and a second read would put the same words in the draft twice.
    expect(shareIntent.getShareExtensionKey).toHaveBeenCalled();
    expect(shareIntent.ShareIntentModule.clearShareIntent).toHaveBeenCalledWith('versutusShareKey');
  });

  test('a build with no native side has nothing to forget', async () => {
    mockLoad.mockResolvedValue(null);

    await expect(dismissSharedText()).resolves.toBeUndefined();
  });

  test('a platform that throws on the forget is not an error the operator sees', async () => {
    const shareIntent = fakePackage();
    shareIntent.ShareIntentModule.clearShareIntent.mockRejectedValue(new Error('no bridge'));
    mockLoad.mockResolvedValue(shareIntent);

    await expect(dismissSharedText()).resolves.toBeUndefined();
  });
});

describe('the device loader', () => {
  const native = jest.requireActual<
    typeof import('@/lib/gateway/share-intent-native')
  >('@/lib/gateway/share-intent-native');

  test('a load under a platform with no native side answers null, never a throw', async () => {
    // jest has no ExpoShareIntentModule, so this is the client the loader
    // exists for. The package either fails to load or loads with a null module;
    // both are no share-intent support, and neither may be a rejection into the
    // router.
    const loaded = await native.loadShareIntentPackage();

    expect(loaded === null || loaded.ShareIntentModule === null).toBe(true);
  });
});

describe('the Android share entry', () => {
  type Plugin = string | [string, Record<string, unknown>];

  type AppConfig = {
    expo: {
      plugins: Plugin[];
      ios: { icon: string; infoPlist: Record<string, string> };
    };
  };

  const config = (): AppConfig => JSON.parse(readSource('app.json')) as AppConfig;

  const shareEntries = (plugins: Plugin[]) =>
    plugins.filter(
      (plugin) => typeof plugin !== 'string' && plugin[0] === 'expo-share-intent',
    ) as [string, Record<string, unknown>][];

  test('the app declares the plugin once and last, with the text filters this cut ships', () => {
    const plugins = config().expo.plugins;
    const entries = shareEntries(plugins);

    // Appended rather than inserted: every entry the app already ships keeps
    // its place and its order, `expo-router` stays first, and the share entry
    // is the last thing in the list and there is only one of it.
    expect(plugins[0]).toBe('expo-router');
    expect(entries).toHaveLength(1);
    expect(plugins[plugins.length - 1]).toEqual(entries[0]);
    expect(entries[0]).toEqual([
      'expo-share-intent',
      {
        // The iOS half of the package is a share extension rather than an
        // intent and is not this slice: with it off, no extension target and no
        // Info.plist keys are added to the iOS build.
        disableIOS: true,
        // `text/*` is a shared text and a shared link — the two kinds this
        // slice carries. An image or a file shared into the app is a later
        // slice, and declaring the filter now would open a door nothing reads.
        androidIntentFilters: ['text/*'],
        // A share has to reach this app while it is already running, not only
        // launch it: `singleTask` is what makes the second share an
        // `onNewIntent` the listener hears rather than a second activity.
        androidMainActivityAttributes: { 'android:launchMode': 'singleTask' },
      },
    ]);
  });

  test('the installed plugin reads those option names — an upgrade that renames one is caught here', () => {
    const plugin = readSource('node_modules', 'expo-share-intent', 'plugin', 'build', 'index.js');
    // Both halves are opt-out: the plugin skips the iOS mods when it is told to
    // and the Android mods when it is told to, so a rename would silently put
    // the share extension back into the iOS build. The iOS mods are the
    // extension's Info.plist keys, its entitlements and its Xcode target, and
    // every one of them sits behind the guard the entry above sets.
    expect(plugin).toMatch(/!params\.disableIOS/);
    expect(plugin).toMatch(/withIosShareExtensionXcodeTarget/);
    expect(plugin).toMatch(/!params\.disableAndroid/);

    const filters = readSource(
      'node_modules',
      'expo-share-intent',
      'plugin',
      'build',
      'android',
      'withAndroidIntentFilters.js',
    );
    expect(filters).toMatch(/parameters\?\.androidIntentFilters/);

    const attributes = readSource(
      'node_modules',
      'expo-share-intent',
      'plugin',
      'build',
      'android',
      'withAndroidMainActivityAttributes.js',
    );
    expect(attributes).toMatch(/parameters\?\.androidMainActivityAttributes/);
  });

  test('the entries the app already ships, and the iOS block, are untouched', () => {
    const { expo } = config();

    // The must-still of this slice: the share entry is appended and moves
    // nothing — every plugin the app already declares keeps its place and its
    // options, and the iOS half of the config is exactly as shipped, because
    // the iOS extension target is phase 7 (ROADMAP.md:115-117) and the charter
    // forbids one before it. `app-lock-test.ts` pins the face-ID string itself.
    expect(expo.plugins.slice(0, 8)).toEqual([
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
      [
        'expo-speech-recognition',
        {
          microphonePermission:
            'Versutus uses the microphone to turn what you say into a message draft, and for a hands-free call you start yourself.',
          speechRecognitionPermission:
            'Versutus uses speech recognition to write down what you say so you can review it before sending, and to understand a hands-free call you start yourself.',
        },
      ],
    ]);
    expect(expo.ios).toEqual({
      icon: './assets/expo.icon',
      infoPlist: {
        NSFaceIDUsageDescription:
          'Versutus asks for Face ID to unlock the app when the app lock is on.',
        UIBackgroundModes: ['audio'],
      },
    });
  });

  test('the installed parse keeps the shared words in `text`, the field the fold reads', () => {
    const parse = readSource('node_modules', 'expo-share-intent', 'build', 'utils.js');

    // The premise the fold rests on: whatever else a payload carries — the type,
    // the extracted `webUrl`, the meta title — the words are in `text`. A
    // version that moved them would hand the composer nothing, silently.
    expect(parse).toMatch(/text:\s*shareIntent\.text/);
  });
});

describe('the root layout wiring', () => {
  /** Just the shared-text router, so a `send` elsewhere in the file cannot pass for one here. */
  function sharedTextRouter(): string {
    const layout = readSource('src', 'app', '_layout.tsx');
    const start = layout.indexOf('function SharedTextRouter()');
    expect(start).toBeGreaterThan(-1);
    return layout.slice(start, layout.indexOf('\nexport default function RootLayout', start));
  }

  test('a share brings the Chat tab up and hands the words to the composer slot', () => {
    const router = sharedTextRouter();

    expect(router).toMatch(/listenForSharedText\(/);
    expect(router).toMatch(/sharedTextRequest\(payload\)/);
    expect(router).toMatch(/requestComposeRequest\(request\)/);
    expect(router).toMatch(/router\.navigate\('\/chat'\)/);
    expect(readSource('src', 'app', '_layout.tsx')).toMatch(/<SharedTextRouter \/>/);
  });

  test('the shared-text path sends nothing', () => {
    // The whole point of the slice (FUTURE-ITEMS.md:193-194): shared content
    // becomes a draft the operator reviews, never a message.
    expect(sharedTextRouter()).not.toMatch(/sendChatInput/);
  });
});
