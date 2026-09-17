import { useEffect, useState, type RefObject } from 'react';

export const STICKY_SCROLL_ROOT_SELECTOR =
  '.overlay-vertical-scroll-area__content';

export function resolveStickyObserverRoot(
  sentinel: Element | null,
): Element | null {
  if (!sentinel) return null;
  return sentinel.closest(STICKY_SCROLL_ROOT_SELECTOR);
}

/** 哨兵滚出滚动容器顶部后，sticky 用户气泡处于吸顶态。 */
export function isStickyHeaderStuck(isIntersecting: boolean): boolean {
  return !isIntersecting;
}

export function useStickyHeaderStuck(
  sentinelRef: RefObject<HTMLElement | null>,
): boolean {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const root = resolveStickyObserverRoot(sentinel);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        setStuck(isStickyHeaderStuck(entry.isIntersecting));
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef]);

  return stuck;
}
