// The transcript sheet polled on a `setInterval`: a new read every 3s whatever
// the last one was doing, with no in-flight guard and no error backoff. Each
// read is an RPC with the transport's own 30s ceiling, so a link that stopped
// answering had up to ten reads outstanding against a Gate the repo documents
// as serving one request at a time — and a refused read was retried on the same
// 3s cadence as a healthy one. These pin the self-scheduling loop: one read at a
// time, the backoff ladder, its reset, and silence after close.

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Divider: 'Divider',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

const mockTranscript = jest.fn();

const mockCron = { transcript: mockTranscript };

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ cron: mockCron }),
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CronRunSheet } from '@/components/activity/cron-run-sheet';

const TEXT = 'Text' as ElementType;

type Turn = { id: string; role: string; text: string };

function turn(id: string): Turn {
  return { id, role: 'assistant', text: `turn ${id}` };
}

/** How many reads are outstanding right now (issued, not yet settled). */
let outstanding = 0;
/** The high-water mark, which is what "no overlap" is measured against. */
let peakOutstanding = 0;
/** Answers the reads that are out: 'ok' resolves, 'fail' rejects. */
const gates: { resolve: () => void; reject: (error: Error) => void }[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  outstanding = 0;
  peakOutstanding = 0;
  gates.length = 0;
  mockTranscript.mockReset();
  mockTranscript.mockImplementation(async () => {
    outstanding += 1;
    peakOutstanding = Math.max(peakOutstanding, outstanding);
    try {
      await new Promise<void>((resolve, reject) => {
        gates.push({ resolve, reject });
      });
      return [turn('t1')];
    } finally {
      outstanding -= 1;
    }
  });
});

afterEach(async () => {
  jest.useRealTimers();
});

/** Open the sheet and let the deferred first read go out. */
async function open(runId = 'run-1'): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(CronRunSheet, { runId, onClose: () => undefined }));
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  return renderer;
}

/** Settle the oldest outstanding read, successfully. */
async function answerOk(): Promise<void> {
  const gate = gates.shift();
  expect(gate).toBeDefined();
  await act(async () => {
    gate?.resolve();
    // Drain: the read's own continuation (and its decrement) must land before
    // the next read is allowed out.
    await jest.advanceTimersByTimeAsync(0);
  });
}

/** Settle the oldest outstanding read with a refusal. */
async function answerFail(): Promise<void> {
  const gate = gates.shift();
  expect(gate).toBeDefined();
  await act(async () => {
    gate?.reject(new Error('Gate is not answering'));
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('the transcript poll is one read at a time', () => {
  it('a read slower than the cadence does not stack reads', async () => {
    await open();

    // Ten seconds of cadence go by with the first read still out.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });

    // One read issued, still outstanding: `setInterval` would have started ten.
    expect(mockTranscript).toHaveBeenCalledTimes(1);
    expect(peakOutstanding).toBe(1);
  });

  it('the next read is armed only once the previous one has settled', async () => {
    await open();
    await answerOk();
    expect(mockTranscript).toHaveBeenCalledTimes(1);

    // The healthy cadence: one more read, three seconds on.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_999);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(2);

    await answerOk();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(3);
    expect(peakOutstanding).toBe(1);
  });

  it('a null run renders nothing and reads nothing', async () => {
    await act(async () => {
      create(createElement(CronRunSheet, { runId: null, onClose: () => undefined }));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(mockTranscript).not.toHaveBeenCalled();
  });
});

describe('a refused read backs off, and a healthy one resets the ladder', () => {
  it('each refusal waits longer than the last, up to the cap', async () => {
    await open();
    await answerFail();

    // 3s: still nothing — the first refusal already waits longer than the
    // healthy cadence, which is what a Gate that is not answering needs.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(2);

    await answerFail();
    // Second refusal: 12s.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(11_999);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(3);

    await answerFail();
    // Third: the 30s cap, and it repeats there.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(4);

    await answerFail();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(5);
    expect(peakOutstanding).toBe(1);
  });

  it('the refusal is shown inline while it retries', async () => {
    const renderer = await open();
    await answerOk();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await answerFail();

    const shown = renderer.root.findAllByType(TEXT).map((node) => String(node.props.children));
    expect(JSON.stringify(renderer.toJSON())).toContain('Gate is not answering');
    expect(shown.length).toBeGreaterThan(0);

    // The last good transcript stays: a gap in freshness is not an empty run.
    expect(JSON.stringify(renderer.toJSON())).toContain('turn t1');
  });

  it('a healthy read drops back to the 3s cadence', async () => {
    await open();
    await answerFail();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6_000);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(2);

    await answerOk();
    // The ladder is reset: the next read is three seconds on, not twelve.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockTranscript).toHaveBeenCalledTimes(3);
  });
});

describe('closing the sheet silences it', () => {
  it('no further reads are issued after unmount', async () => {
    const renderer = await open();
    await answerOk();
    expect(mockTranscript).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(mockTranscript).toHaveBeenCalledTimes(1);
  });

  it('a read still in flight at close is ignored, and arms nothing', async () => {
    const renderer = await open();
    expect(mockTranscript).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
    // The read answers after the sheet is gone: its result must be dropped.
    await answerOk();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(mockTranscript).toHaveBeenCalledTimes(1);
    expect(peakOutstanding).toBe(1);
  });
});