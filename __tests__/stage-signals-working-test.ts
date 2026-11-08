import { getStageSignals, resetStageSignals, signalWorking, subscribeStageSignals } from '@/lib/stage/signals';

beforeEach(() => resetStageSignals());

describe('the working signal', () => {
  test('a quiet room is not working', () => {
    expect(getStageSignals().working).toBe(false);
  });

  test('is set and cleared, and listeners hear each real change once', () => {
    let heard = 0;
    const off = subscribeStageSignals(() => {
      heard += 1;
    });
    signalWorking(true);
    signalWorking(true);
    expect(getStageSignals().working).toBe(true);
    expect(heard).toBe(1);
    signalWorking(false);
    expect(getStageSignals().working).toBe(false);
    expect(heard).toBe(2);
    off();
  });

  test('resetting the room clears it', () => {
    signalWorking(true);
    resetStageSignals();
    expect(getStageSignals().working).toBe(false);
  });
});
