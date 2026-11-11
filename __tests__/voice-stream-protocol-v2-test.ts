import {
  MAX_FRAME_BYTES,
  VoiceProtocolError,
  parseGateFrame,
  parsePhoneFrame,
  protocolForFirstGateFrame,
  type GateVoiceFrame,
  type PhoneVoiceFrame,
} from '@/lib/voice/voice-stream-protocol';
import { withVoiceProtocol } from '@/lib/voice/gate-media-url';

declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const fixture = JSON.parse(nodeFs.readFileSync(
  [__dirname, '..', 'gate', '__tests__', 'fixtures', 'voice-protocol.json'].join(SEP), 'utf8',
)) as {
  phoneToGate: PhoneVoiceFrame[];
  gateToPhone: GateVoiceFrame[];
  v2PhoneToGate: PhoneVoiceFrame[];
  v2GateToPhone: GateVoiceFrame[];
  malformed: unknown[];
};

describe('v2 hands-free protocol envelope', () => {
  test('both parsers round-trip every shared v2 fixture frame', () => {
    for (const frame of fixture.v2PhoneToGate) expect(parsePhoneFrame(JSON.stringify(frame))).toEqual(frame);
    for (const frame of fixture.v2GateToPhone) expect(parseGateFrame(JSON.stringify(frame))).toEqual(frame);
  });

  test('the compatibility matrix keeps legacy frames on v1 and selects v2 only after an envelope', () => {
    // Old phone → new Gate: no protocol query and flat frames remain valid.
    expect(parsePhoneFrame(fixture.phoneToGate[0])).toEqual(fixture.phoneToGate[0]);
    // New phone → old Gate: the old Gate's ready/phase proves fallback.
    expect(protocolForFirstGateFrame(fixture.gateToPhone[0])).toBe(1);
    // New phone → new Gate: the enveloped call opening confirms v2.
    expect(protocolForFirstGateFrame(fixture.v2GateToPhone[0])).toBe(2);
    expect(withVoiceProtocol('wss://gate.example/v1/voice/stream?voiceSessionId=vs-1', 2))
      .toBe('wss://gate.example/v1/voice/stream?voiceSessionId=vs-1&protocol=2');
    expect(withVoiceProtocol('wss://gate.example/v1/voice/stream?protocol=1&voiceSessionId=vs-1', 2))
      .toBe('wss://gate.example/v1/voice/stream?voiceSessionId=vs-1&protocol=2');
  });

  test('malformed envelopes, mismatched call identity, and oversized JSON are refused', () => {
    for (const frame of fixture.malformed.filter((value) => Boolean(value && typeof value === 'object' && 'v' in value))) {
      expect(() => parsePhoneFrame(frame)).toThrow(VoiceProtocolError);
    }
    expect(() => parseGateFrame(fixture.v2GateToPhone[0], { callId: 'other-call' })).toThrow(VoiceProtocolError);
    const huge = JSON.stringify({ ...fixture.v2GateToPhone[0], delta: 'x'.repeat(MAX_FRAME_BYTES) });
    expect(() => parseGateFrame(huge)).toThrow(VoiceProtocolError);
  });

  test('resume cursors are non-negative integers and remain in the v2 envelope', () => {
    expect(parsePhoneFrame({ v: 2, callId: 'vs-1', seq: 6, ts: 10, t: 'resume', lastSeq: 8 }))
      .toEqual({ v: 2, callId: 'vs-1', seq: 6, ts: 10, t: 'resume', lastSeq: 8 });
    for (const lastSeq of [-1, 1.5, Number.NaN]) {
      expect(() => parsePhoneFrame({ v: 2, callId: 'vs-1', seq: 6, ts: 10, t: 'resume', lastSeq }))
        .toThrow(VoiceProtocolError);
    }
  });
});
