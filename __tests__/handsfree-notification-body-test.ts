// The Android ongoing notification's body line, pinned across the language
// boundary by source (the JVM test in
// modules/handsfree-voice/android/src/test/java/com/versutus/handsfreevoice/
// HandsfreeCallNotificationTest.kt runs where Gradle runs; this file makes the
// same contract visible to `npm run verify`, which has no JVM).
//
// The body must say what the call is doing right now: a muted call is not
// "listening through the microphone", and a call waiting on a provider is not
// listening either. The vocabulary is the JS fold's — handsfreePhaseLabel in
// src/lib/voice/handsfree-call-copy.ts — folded to the phases the service can
// actually see (muted / listening / speaking). A phase the service cannot see
// (sending, waiting) answers the neutral line, never a guess.

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

const NOTIFICATION_KT = [
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeCallNotification.kt',
];
const SERVICE_KT = [
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeCallService.kt',
];
const KOTLIN_TEST_KT = [
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'test',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeCallNotificationTest.kt',
];

const notification = readSource(...NOTIFICATION_KT);
const service = readSource(...SERVICE_KT);
const kotlinTest = readSource(...KOTLIN_TEST_KT);

describe('the Android notification body is the phase the call is in', () => {
  test('the body fold answers the honest phase vocabulary', () => {
    // The fold is the notification's own words, held pure beside the title
    // rule. The neutral TEXT is the shared fallback, not a blanket claim.
    expect(notification).toContain('bodyFor(');
    expect(notification).toContain('"Muted"');
    expect(notification).toContain('"Speaking"');
    expect(notification).toContain('"Listening"');
  });

  test('the neutral line claims no microphone the call is not holding', () => {
    // The old body said "Listening and speaking through the microphone" at
    // every phase — a muted call is neither. The fallback must stand alone
    // without that claim.
    expect(notification).not.toContain('Listening and speaking through the microphone');
    expect(notification).not.toContain('through the microphone');
  });

  test('the service answers the fold with the phase facts it holds', () => {
    // The service reads muted/listening/speaking — the only phases it can
    // see — and passes them straight through; sending/waiting stay JS-side,
    // so they land on the neutral line by construction.
    expect(service).toContain('bodyFor(\n          state.muted,');
    expect(service).toContain('HandsfreeCallNotification.bodyFor');
  });

  test('the notification is re-posted on the phase edges the service owns', () => {
    // Building the body once at foreground start would still be a
    // phase-independent claim: mute, speech and recognition all move the
    // phase while the notification is up.
    expect(service).toContain('postNotification()');
    // Mute/speak/listen edges re-post; the profile the fold answers is what
    // the notification then carries.
    for (const edge of ['setMuted', 'speakInternal', 'startListeningInternal', 'stopListening']) {
      const site = service.indexOf(`fun ${edge}`);
      expect(site).toBeGreaterThan(-1);
      expect(service.slice(site)).toContain('postNotification()');
    }
  });

  test('the JVM test pins the same bodies', () => {
    expect(kotlinTest).toContain('bodyFor');
    expect(kotlinTest).toContain('"Muted"');
    expect(kotlinTest).toContain('"Speaking"');
    expect(kotlinTest).toContain('"Listening"');
  });
});
