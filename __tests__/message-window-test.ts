import {
  MESSAGE_WINDOW_CAP,
  appendBounded,
  boundWindow,
  hasEarlierHistory,
  prependEarlier,
} from '@/lib/gateway/messages';

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('boundWindow', () => {
  test('returns the same array when the list is within the cap', () => {
    const list = seq(5);
    expect(boundWindow(list, 10)).toBe(list);
  });

  test('keeps the newest entries when the list exceeds the cap', () => {
    expect(boundWindow(seq(6), 3)).toEqual([3, 4, 5]);
  });

  test('defaults to the shared message window cap', () => {
    expect(boundWindow(seq(MESSAGE_WINDOW_CAP + 10)).length).toBe(MESSAGE_WINDOW_CAP);
  });
});

describe('prependEarlier', () => {
  const msg = (id: string) => ({ id });

  test('places earlier messages ahead of the current window', () => {
    expect(prependEarlier([msg('c')], [msg('a'), msg('b')])).toEqual([msg('a'), msg('b'), msg('c')]);
  });

  test('drops earlier messages already in the window', () => {
    // Paging back overlaps with what is already loaded; duplicates would render twice.
    expect(prependEarlier([msg('b'), msg('c')], [msg('a'), msg('b')])).toEqual([
      msg('a'),
      msg('b'),
      msg('c'),
    ]);
  });

  test('returns the same reference when nothing new arrived', () => {
    const current = [msg('a'), msg('b')];
    expect(prependEarlier(current, [msg('a')])).toBe(current);
    expect(prependEarlier(current, [])).toBe(current);
  });

  test('does not re-apply the streaming cap to explicitly paged history', () => {
    // The cap guards runaway streaming, not a deliberate "load earlier" tap —
    // re-bounding here would discard exactly what the user just asked for.
    const current = Array.from({ length: MESSAGE_WINDOW_CAP }, (_, i) => msg(`cur-${i}`));
    const earlier = Array.from({ length: 80 }, (_, i) => msg(`old-${i}`));
    const result = prependEarlier(current, earlier);
    expect(result).toHaveLength(MESSAGE_WINDOW_CAP + 80);
    expect(result[0]).toEqual(msg('old-0'));
  });
});

describe('hasEarlierHistory', () => {
  test('more to load when the gateway returned a full page', () => {
    expect(hasEarlierHistory(80, 80)).toBe(true);
  });

  test('nothing more once the gateway returns fewer than requested', () => {
    // The gateway has no offset/cursor — the only signal that history is
    // exhausted is a page shorter than what was asked for.
    expect(hasEarlierHistory(37, 80)).toBe(false);
  });

  test('an empty session has no earlier history', () => {
    expect(hasEarlierHistory(0, 80)).toBe(false);
  });
});

describe('appendBounded', () => {
  test('appends while the list is under the cap', () => {
    expect(appendBounded([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });

  test('drops the oldest entry once the cap is reached', () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  test('does not mutate the input list', () => {
    const list = [1, 2, 3];
    appendBounded(list, 4, 3);
    expect(list).toEqual([1, 2, 3]);
  });

  test('bounds an unbounded stream of appends', () => {
    let list: number[] = [];
    for (let i = 0; i < 1000; i += 1) list = appendBounded(list, i, 200);
    expect(list.length).toBe(200);
    expect(list[0]).toBe(800);
    expect(list[199]).toBe(999);
  });
});
