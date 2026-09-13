import {
  MAX_FRAME_BYTES,
  VoiceProtocolError,
  parseGateFrame,
  parsePhoneFrame,
  serializeFrame,
  type GateVoiceFrame,
  type PhoneVoiceFrame,
} from '@/lib/voice/voice-stream-protocol';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const fixture = JSON.parse(
  nodeFs.readFileSync(
    [__dirname, '..', 'gate', '__tests__', 'fixtures', 'voice-protocol.json'].join(SEP),
    'utf8',
  ),
) as {
  phoneToGate: PhoneVoiceFrame[];
  gateToPhone: GateVoiceFrame[];
  malformed: unknown[];
};

function acceptedByEither(frame: unknown): boolean {
  for (const parse of [parsePhoneFrame, parseGateFrame]) {
    try {
      parse(JSON.stringify(frame));
      return true;
    } catch {
      // try the other side
    }
  }
  return false;
}

describe('the app parses the shared voice protocol fixture', () => {
  test('every phone frame parses', () => {
    for (const frame of fixture.phoneToGate) {
      expect(parsePhoneFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });

  test('every Gate frame parses', () => {
    for (const frame of fixture.gateToPhone) {
      expect(parseGateFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });

  test('every malformed frame is rejected', () => {
    for (const frame of fixture.malformed) {
      expect(acceptedByEither(frame)).toBe(false);
    }
  });

  test('a frame over the size cap is refused', () => {
    const huge = JSON.stringify({ t: 'partial', text: 'x'.repeat(MAX_FRAME_BYTES + 1) });
    expect(() => parseGateFrame(huge)).toThrow(VoiceProtocolError);
  });

  test('serializeFrame round-trips through the app parser', () => {
    for (const frame of fixture.gateToPhone) {
      expect(parseGateFrame(serializeFrame(frame))).toEqual(frame);
    }
  });
});
