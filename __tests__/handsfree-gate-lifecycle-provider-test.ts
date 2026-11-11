// tokens.ts imports Easing from reanimated, whose native worklets cannot load under Jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { shouldEndCallForGatewayStatus } from '@/context/handsfree-voice-provider';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const fs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const gateMedia = fs.readFileSync(
  [
    __dirname,
    '..',
    'modules',
    'handsfree-voice',
    'android',
    'src',
    'main',
    'java',
    'com',
    'versutus',
    'handsfreevoice',
    'HandsfreeGateMedia.kt',
  ].join(SEP),
  'utf8',
).replace(/\r\n/g, '\n');

describe('Gate call lifecycle during gateway status changes', () => {
  test('a gateway blip does not end Gate media before its resume window', () => {
    expect(shouldEndCallForGatewayStatus('disconnected', true)).toBe(false);
    expect(shouldEndCallForGatewayStatus('connecting', true)).toBe(false);
  });

  test('a phone call still ends when its gateway disconnects', () => {
    expect(shouldEndCallForGatewayStatus('disconnected', false)).toBe(true);
  });

  test('a connected gateway never ends either transport', () => {
    expect(shouldEndCallForGatewayStatus('connected', true)).toBe(false);
    expect(shouldEndCallForGatewayStatus('connected', false)).toBe(false);
  });

  test('concurrent terminal paths release GateMedia through a one-shot stop', () => {
    expect(gateMedia).toMatch(/@Synchronized fun stop\(\) \{\s*if \(stopped\) return/);
  });
});
