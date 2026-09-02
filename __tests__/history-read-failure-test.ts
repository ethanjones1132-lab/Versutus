import { readHistory } from '@/lib/gateway/history-read';

describe('readHistory', () => {
  test('an initial history failure keeps the last-good transcript and reports the read failure', async () => {
    const lastGood = [{ id: 'turn-1' }];

    const result = await readHistory(
      async () => {
        throw new Error('session_read_failed');
      },
      lastGood,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the initial history read to fail');
    expect(result.value).toBe(lastGood);
    expect(result.error).toBe('session_read_failed');
  });

  test('a load-earlier history failure keeps the visible transcript and reports the read failure', async () => {
    const visible = [{ id: 'turn-2' }, { id: 'turn-3' }];

    const result = await readHistory(
      async () => {
        throw new Error('older page unavailable');
      },
      visible,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the load-earlier history read to fail');
    expect(result.value).toEqual(visible);
    expect(result.error).toBe('older page unavailable');
  });

  test('a successful empty history envelope remains an empty transcript without an error', async () => {
    const result = await readHistory(async () => [] as { id: string }[], [{ id: 'old' }]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the empty history envelope to succeed');
    expect(result.value).toEqual([]);
  });
});
