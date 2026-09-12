// The native hands-free contract, pinned across the language boundary.
//
// Step 1 declares a set of events and methods in TypeScript; Steps 2–3 declare
// the same events in Kotlin and Swift and wire the methods. Nothing else in the
// build connects those three lists, so an event declared in TS and never
// registered natively (or a native method the TS contract never names) is
// exactly the "declared but never wired" class of defect this plan was
// corrected for. This test reads all three sources and asserts they agree.

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

const EVENTS = [
  'partial',
  'final',
  'noSpeech',
  'speechFinished',
  'interruption',
  'endRequested',
  'fatalError',
  'bargeIn',
  'level',
] as const;

const METHODS = [
  'getAvailability',
  'startSession',
  'startListening',
  'stopListening',
  'speak',
  'stopSpeaking',
  'setMuted',
  'playSendEarcon',
  'stopSession',
] as const;

const types = readSource('modules', 'handsfree-voice', 'src', 'HandsfreeVoice.types.ts');
const tsModule = readSource('modules', 'handsfree-voice', 'src', 'HandsfreeVoiceModule.ts');
const kotlin = readSource(
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeVoiceModule.kt',
);
const service = readSource(
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
);
const swift = readSource('modules', 'handsfree-voice', 'ios', 'HandsfreeVoiceModule.swift');

describe('hands-free native contract', () => {
  it('declares every event in the TypeScript contract', () => {
    for (const event of EVENTS) {
      expect(types).toContain(`${event}:`);
    }
  });

  it('registers every event natively on both platforms', () => {
    for (const event of EVENTS) {
      expect(kotlin).toContain(`"${event}"`);
      expect(swift).toContain(`"${event}"`);
    }
  });

  it('declares every method in the TypeScript contract', () => {
    for (const method of METHODS) {
      expect(tsModule).toContain(`${method}(`);
    }
  });

  it('wires every method natively on both platforms', () => {
    for (const method of METHODS) {
      expect(kotlin).toContain(`AsyncFunction("${method}")`);
      expect(swift).toContain(`AsyncFunction("${method}")`);
    }
  });

  it('emits the declared Android notification event from the service, not only declares it', () => {
    expect(service).toContain('emit("endRequested"');
  });

  it('emits every service-side event through the bridge', () => {
    for (const event of ['partial', 'final', 'noSpeech', 'speechFinished', 'interruption', 'fatalError', 'bargeIn', 'level']) {
      expect(service).toContain(`emit("${event}"`);
    }
  });

  it('emits the iOS service-side events through sendEvent', () => {
    for (const event of ['partial', 'final', 'noSpeech', 'speechFinished', 'interruption', 'fatalError', 'bargeIn', 'level']) {
      expect(swift).toContain(`emit("${event}"`);
    }
  });

  it('reports the availability shape the call path reads', () => {
    for (const key of ['recognition', 'synthesis', 'maxSpeechInputLength']) {
      expect(types).toContain(key);
    }
  });
});
