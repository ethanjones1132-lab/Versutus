import { createRefCounter } from '@/lib/motion/refcount';

describe('createRefCounter', () => {
  test('starts on the first acquire and stops on the last release', () => {
    const events: string[] = [];
    const acquire = createRefCounter(
      () => events.push('start'),
      () => events.push('stop'),
    );
    const a = acquire();
    const b = acquire();
    expect(events).toEqual(['start']);
    a();
    expect(events).toEqual(['start']);
    b();
    expect(events).toEqual(['start', 'stop']);
  });

  test('releasing twice is harmless', () => {
    const events: string[] = [];
    const acquire = createRefCounter(
      () => events.push('start'),
      () => events.push('stop'),
    );
    const a = acquire();
    const b = acquire();
    a();
    a();
    expect(events).toEqual(['start']);
    b();
    expect(events).toEqual(['start', 'stop']);
  });

  test('can start again after stopping', () => {
    const events: string[] = [];
    const acquire = createRefCounter(
      () => events.push('start'),
      () => events.push('stop'),
    );
    acquire()();
    acquire()();
    expect(events).toEqual(['start', 'stop', 'start', 'stop']);
  });
});
