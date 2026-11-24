import { useCallback, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/**
 * How far content has to travel before the header admits it is covering
 * something. A few pixels, not a scroll distance: the surface is a signal that
 * the page title is no longer the top edge, and it holds in both directions.
 */
export const HEADER_SCROLL_THRESHOLD = 4;

type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/**
 * The one scroll rule shared by every `AppHeader`: `scrolled` flips true once
 * the offset passes the threshold and back at the top, and only those two
 * crossings re-render the screen. An existing handler (the ambient parallax)
 * is still called for every event, in order.
 */
export function useHeaderScrolled(onScroll?: ScrollHandler): {
  scrolled: boolean;
  onScroll: ScrollHandler;
} {
  const [scrolled, setScrolled] = useState(false);
  const scrolledRef = useRef(false);

  const handleScroll = useCallback<ScrollHandler>(
    (event) => {
      onScroll?.(event);
      const next = event.nativeEvent.contentOffset.y > HEADER_SCROLL_THRESHOLD;
      if (next === scrolledRef.current) return;
      scrolledRef.current = next;
      setScrolled(next);
    },
    [onScroll],
  );

  return { scrolled, onScroll: handleScroll };
}
