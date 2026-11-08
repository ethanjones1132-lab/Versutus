/**
 * A reference counter around a start/stop pair: `onFirst` runs when the count
 * goes 0 to 1, `onLast` when it returns to 0. Each acquire returns its own
 * release, safe to call more than once.
 */
export function createRefCounter(onFirst: () => void, onLast: () => void): () => () => void {
  let count = 0;
  return () => {
    if (count === 0) onFirst();
    count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      count -= 1;
      if (count === 0) onLast();
    };
  };
}
