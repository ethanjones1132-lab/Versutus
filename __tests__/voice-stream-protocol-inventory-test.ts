import {
  GATE_FRAME_TYPES,
  PHONE_FRAME_TYPES,
  parseGateFrame,
  parsePhoneFrame,
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
  v2PhoneToGate: PhoneVoiceFrame[];
  v2GateToPhone: GateVoiceFrame[];
};

function typesOf(frames: Array<{ t: string }>): string[] {
  return [...new Set(frames.map((frame) => frame.t))].sort();
}

// The same inventory the Gate checks, so a type added to one parser without a
// frame the other side can produce fails here rather than on a call.
describe('the app declares exactly the frame inventory the fixture proves', () => {
  test('every declared phone type is in the fixture and parses', () => {
    const frames = [...fixture.phoneToGate, ...fixture.v2PhoneToGate];
    expect(typesOf(frames)).toEqual([...PHONE_FRAME_TYPES].sort());
    for (const frame of fixture.phoneToGate) {
      expect(parsePhoneFrame(JSON.stringify(frame))).toEqual(frame);
    }
    for (const frame of fixture.v2PhoneToGate) {
      expect(parsePhoneFrame(frame, { callId: 'vs-1' })).toEqual(frame);
    }
  });

  test('every declared Gate type is in the fixture and parses', () => {
    const frames = [...fixture.gateToPhone, ...fixture.v2GateToPhone];
    expect(typesOf(frames)).toEqual([...GATE_FRAME_TYPES].sort());
    for (const frame of fixture.gateToPhone) {
      expect(parseGateFrame(JSON.stringify(frame))).toEqual(frame);
    }
    for (const frame of fixture.v2GateToPhone) {
      expect(parseGateFrame(frame, { callId: 'vs-1' })).toEqual(frame);
    }
  });
});
