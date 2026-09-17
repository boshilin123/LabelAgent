import {
  isResizeObserverLoopError,
  RESIZE_OBSERVER_LOOP_MSG,
} from './resizeObserver';

describe('isResizeObserverLoopError', () => {
  it('matches Chrome ResizeObserver loop messages', () => {
    expect(
      isResizeObserverLoopError(
        `${RESIZE_OBSERVER_LOOP_MSG} completed with undelivered notifications.`,
      ),
    ).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isResizeObserverLoopError('Something went wrong')).toBe(false);
  });

  it('returns false for undefined, null, and empty message', () => {
    expect(isResizeObserverLoopError(undefined)).toBe(false);
    expect(isResizeObserverLoopError('')).toBe(false);
  });
});
