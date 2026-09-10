// The composer's one mic control (FUTURE-ITEMS.md §B1 `:429`, §B3 `:449-452`):
// what that control IS, as a pure fold — nothing at all on a build with no
// recognizer, a disabled mic carrying one reason line while the gateway is
// away, and a live mic otherwise. The composer draws whatever this answers and
// authors no state of its own, so the control and the reason cannot disagree.
//
// The hold's own conversation with the phone is the seam in
// `speech-recognition.ts`; this folder is the rule, and it reaches nothing: no
// recognizer, no storage, no gateway.

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

import { MIC_DISCONNECTED_COPY, micControlState } from '@/lib/voice/mic-state';

/** Every state the live connection can be in, including the live one. */
const CONNECTION_STATUSES = [
  'disconnected',
  'connecting',
  'reconnecting',
  'pairing',
  'connected',
] as const;

/** Every state but `connected`: the gateway is away, however it is on its way. */
const AWAY_STATUSES = CONNECTION_STATUSES.filter((status) => status !== 'connected');

describe('the composer mic control state', () => {
  test('a build whose recognizer answered no is offered no mic and no reason', () => {
    for (const status of CONNECTION_STATUSES) {
      // Not a disabled mic and not a reason line: a control that cannot finish
      // is not drawn at all, in any connection state.
      expect(micControlState({ available: false, status, isStreaming: false })).toEqual({
        kind: 'hidden',
      });
    }
  });

  test('a phone that can hear but a gateway that is away draws a disabled mic with the module line', () => {
    for (const status of AWAY_STATUSES) {
      // Connecting, reconnecting and pairing are all "not yet": the mic waits
      // rather than half-working while the connection settles.
      expect(micControlState({ available: true, status, isStreaming: false })).toEqual({
        kind: 'disabled',
        reason: MIC_DISCONNECTED_COPY,
      });
    }
  });

  test('a connected gateway draws the mic live', () => {
    expect(micControlState({ available: true, status: 'connected', isStreaming: false })).toEqual({
      kind: 'live',
    });
  });

  test('a reply in flight does not take the mic away, the way it does not take send away', () => {
    // The send control beside it stays pressable while a reply streams (it
    // becomes Stop), so the mic must not be the one control that disappears
    // when a reply is arriving — a hold that ends mid-reply leaves its words
    // in the draft for the operator to send when the reply is done.
    expect(micControlState({ available: true, status: 'connected', isStreaming: true })).toEqual({
      kind: 'live',
    });

    // Streaming is not a way back onto a gateway that is away either.
    expect(micControlState({ available: true, status: 'reconnecting', isStreaming: true })).toEqual({
      kind: 'disabled',
      reason: MIC_DISCONNECTED_COPY,
    });
  });

  test('only the disabled state carries a reason, and it is the module own line', () => {
    // A reason is a state's own fact: nothing to say on a hidden control, and
    // nothing to warn about on a live one.
    expect(micControlState({ available: false, status: 'connected', isStreaming: false })).not.toHaveProperty('reason');
    expect(micControlState({ available: true, status: 'connected', isStreaming: false })).not.toHaveProperty('reason');

    // One sentence, no figure in it: the line never reads as a count of
    // anything that did or did not happen.
    expect(MIC_DISCONNECTED_COPY).toMatch(/^[A-Z].*\.$/);
    expect(MIC_DISCONNECTED_COPY).not.toMatch(/\d/);
  });

  test('the fold names no recognizer, no storage and no gateway — a type is all it imports', () => {
    const src = readSource('src', 'lib', 'voice', 'mic-state.ts');

    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line.startsWith('import type ')).toBe(true);
    }
    expect(src).not.toMatch(/expo-speech-recognition|keyValueStorage|loadSpeechRecognitionModule/);
  });
});
