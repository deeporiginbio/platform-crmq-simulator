/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * useVirtualScroll
 * =================
 * Lightweight virtual scrolling hook — renders only the
 * items visible in the viewport plus a small overscan buffer.
 *
 * All items must have the same estimated height.
 * The hook returns:
 *   - containerRef  — attach to the scrollable wrapper
 *   - visibleItems  — the slice of items to render
 *   - topPad / bottomPad — spacers for correct scroll height
 *   - startIndex    — offset of the first visible item
 */

import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
} from 'react';

export interface VirtualScrollResult<T> {
  containerRef: React.RefObject<HTMLDivElement>;
  visibleItems: T[];
  startIndex: number;
  topPad: number;
  bottomPad: number;
  onScroll: () => void;
}

export function useVirtualScroll<T>(
  items: T[],
  /** Estimated height of each item in px */
  itemHeight: number,
  /** Height of the scrollable container in px */
  containerHeight: number,
  /** Extra items above/below viewport */
  overscan = 5,
): VirtualScrollResult<T> {
  const containerRef =
    useRef<HTMLDivElement>(null!);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Reset scroll when items change drastically
  // (e.g. scenario load)
  const prevLen = useRef(items.length);
  useEffect(() => {
    if (
      Math.abs(items.length - prevLen.current) > 50
    ) {
      const el = containerRef.current;
      if (el) el.scrollTop = 0;
      setScrollTop(0);
    }
    prevLen.current = items.length;
  }, [items.length]);

  const totalHeight = items.length * itemHeight;

  const startIndex = useMemo(() => {
    const raw = Math.floor(scrollTop / itemHeight);
    return Math.max(0, raw - overscan);
  }, [scrollTop, itemHeight, overscan]);

  const endIndex = useMemo(() => {
    const visibleCount = Math.ceil(
      containerHeight / itemHeight,
    );
    const raw =
      Math.floor(scrollTop / itemHeight) +
      visibleCount +
      overscan;
    return Math.min(items.length, raw);
  }, [
    scrollTop,
    itemHeight,
    containerHeight,
    items.length,
    overscan,
  ]);

  const visibleItems = useMemo(
    () => items.slice(startIndex, endIndex),
    [items, startIndex, endIndex],
  );

  const topPad = startIndex * itemHeight;
  const bottomPad = Math.max(
    0,
    totalHeight - endIndex * itemHeight,
  );

  return {
    containerRef,
    visibleItems,
    startIndex,
    topPad,
    bottomPad,
    onScroll,
  };
}
