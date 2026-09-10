// The composer's one mic control (FUTURE-ITEMS.md §B1 `:429`, §B3 `:449-452`):
// what that control IS, as a pure fold — nothing at all on a build with no
// recognizer, a disabled mic carrying one reason line while the gateway is
// away, and a live mic otherwise. The composer draws whatever this answers and
// authors no state of its own, so the control and the reason cannot disagree.
//
// The phone's own answer is one of the fold's inputs: a phone a hold can be
// offered on — it has granted the microphone and speech recognition, or the
// platform will still put its own dialog up — is drawn live, and only a
// refusal the platform will not re-ask is drawn refused in any connection
// state, with the module's own line for that refusal rather than the gateway's.
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

import {
  MIC_DISCONNECTED_COPY,
  MIC_PERMISSION_REFUSED_COPY,
  micControlState,
} from '@/lib/voice/mic-state';

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
      for (const permissionAskable of [true, false]) {
        // Not a disabled mic and not a reason line: a control that cannot finish
        // is not drawn at all, in any connection state — and the phone's own
        // permission cannot bring a mic back to a build that cannot hear.
        expect(
          micControlState({ available: false, status, isStreaming: false, permissionAskable }),
        ).toEqual({ kind: 'hidden' });
      }
    }
  });

  test('a phone a hold can be offered on draws a live mic on a connected gateway', () => {
    // The fold's one phone answer is true for both ways this phone can start a
    // session: it has granted the two already, and it has not but the platform
    // will still put its own dialog up. Either way the control is live, so a
    // fresh install's first hold is where the operator meets that dialog.
    expect(
      micControlState({
        available: true,
        status: 'connected',
        isStreaming: false,
        permissionAskable: true,
      }),
    ).toEqual({ kind: 'live' });
  });

  test('a refusal the platform will not re-ask is drawn refused, whatever the gateway is doing', () => {
    for (const status of CONNECTION_STATUSES) {
      const state = micControlState({
        available: true,
        status,
        isStreaming: false,
        permissionAskable: false,
      });

      // That device fact outranks the connection: a phone that cannot start a
      // session says so on a connected gateway too, rather than drawing a live
      // mic whose hold would fail.
      expect(state).toEqual({ kind: 'disabled', reason: MIC_PERMISSION_REFUSED_COPY });
      expect(state).not.toEqual({ kind: 'disabled', reason: MIC_DISCONNECTED_COPY });
    }
  });

  test('a phone a hold can be offered on, on a gateway that is away, draws the connection line', () => {
    for (const status of AWAY_STATUSES) {
      // Connecting, reconnecting and pairing are all "not yet": the mic waits
      // rather than half-working while the connection settles.
      expect(
        micControlState({ available: true, status, isStreaming: false, permissionAskable: true }),
      ).toEqual({
        kind: 'disabled',
        reason: MIC_DISCONNECTED_COPY,
      });
    }
  });

  test('a reply in flight does not take the mic away, the way it does not take send away', () => {
    // The send control beside it stays pressable while a reply streams (it
    // becomes Stop), so the mic must not be the one control that disappears
    // when a reply is arriving — a hold that ends mid-reply leaves its words
    // in the draft for the operator to send when the reply is done.
    expect(
      micControlState({
        available: true,
        status: 'connected',
        isStreaming: true,
        permissionAskable: true,
      }),
    ).toEqual({ kind: 'live' });

    // Streaming is not a way back onto a gateway that is away either.
    expect(
      micControlState({
        available: true,
        status: 'reconnecting',
        isStreaming: true,
        permissionAskable: true,
      }),
    ).toEqual({
      kind: 'disabled',
      reason: MIC_DISCONNECTED_COPY,
    });
  });

  test('only the disabled state carries a reason, and each refusal is the module own line', () => {
    // A reason is a state's own fact: nothing to say on a hidden control, and
    // nothing to warn about on a live one.
    expect(
      micControlState({
        available: false,
        status: 'connected',
        isStreaming: false,
        permissionAskable: false,
      }),
    ).not.toHaveProperty('reason');
    expect(
      micControlState({
        available: true,
        status: 'connected',
        isStreaming: false,
        permissionAskable: true,
      }),
    ).not.toHaveProperty('reason');

    // One sentence each, no figure in either: a line never reads as a count of
    // anything that did or did not happen.
    expect(MIC_DISCONNECTED_COPY).toMatch(/^[A-Z].*\.$/);
    expect(MIC_DISCONNECTED_COPY).not.toMatch(/\d/);
    expect(MIC_PERMISSION_REFUSED_COPY).toMatch(/^[A-Z].*\.$/);
    expect(MIC_PERMISSION_REFUSED_COPY).not.toMatch(/\d/);

    // The two refusals are worded apart, so a phone that cannot start a
    // session is never told to check the connection and an away gateway is
    // never blamed on the phone.
    expect(MIC_PERMISSION_REFUSED_COPY).not.toBe(MIC_DISCONNECTED_COPY);
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
