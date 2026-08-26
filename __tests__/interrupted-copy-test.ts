import { interruptedSendAgainLabel } from '@/lib/gateway/interrupted-copy';

describe('interruptedSendAgainLabel', () => {
  test('an interrupted bubble says it will send the prompt again', () => {
    expect(interruptedSendAgainLabel()).toBe('Send again');
  });

  test('does not read as a continue of the cut reply', () => {
    expect(interruptedSendAgainLabel()).not.toBe('Resume');
  });
});
