import { abortAndClear } from '@/lib/gateway/abort';

describe('abortAndClear', () => {
  it('aborts the in-flight controller and clears the ref', () => {
    const controller = new AbortController();
    const ref = { current: controller as AbortController | null };

    expect(abortAndClear(ref)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(ref.current).toBeNull();
  });

  it('is a no-op when nothing is in flight', () => {
    const ref = { current: null as AbortController | null };
    expect(abortAndClear(ref)).toBe(false);
    expect(ref.current).toBeNull();
  });

  it('is safe to call twice', () => {
    const controller = new AbortController();
    const ref = { current: controller as AbortController | null };

    abortAndClear(ref);
    expect(() => abortAndClear(ref)).not.toThrow();
    expect(abortAndClear(ref)).toBe(false);
  });

  it('does not throw when the controller already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const ref = { current: controller as AbortController | null };

    expect(abortAndClear(ref)).toBe(true);
    expect(ref.current).toBeNull();
  });
});
