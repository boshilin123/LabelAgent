/** Chrome message when RO callbacks mutate layout in the same frame. */
export const RESIZE_OBSERVER_LOOP_MSG = 'ResizeObserver loop';

/**
 * Coalesce ResizeObserver notifications to the next animation frame
 * to avoid "ResizeObserver loop completed with undelivered notifications".
 */
export function createResizeObserver(
  callback: () => void,
): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;

  let rafId = 0;
  return new ResizeObserver(() => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      callback();
    });
  });
}

export function isResizeObserverLoopError(
  message: string | undefined,
): boolean {
  return (
    typeof message === 'string' && message.includes(RESIZE_OBSERVER_LOOP_MSG)
  );
}
