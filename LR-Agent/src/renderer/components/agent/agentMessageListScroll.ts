export const BOTTOM_THRESHOLD_PX = 64;
export const TOP_LOAD_THRESHOLD_PX = 64;
export const JUMP_TO_BOTTOM_DURATION_MS = 220;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface PrependAnchor {
  element: HTMLElement;
  offset: number;
}

export function distanceFromBottom(el: ScrollMetrics): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(
  el: ScrollMetrics,
  thresholdPx = BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(el) < thresholdPx;
}

/** 锚点相对视口的偏移变化量，用来在顶部插入内容后保持阅读位置。 */
export function nextScrollTopAfterAnchorShift(
  scrollTop: number,
  previousOffset: number,
  nextOffset: number,
): number {
  return scrollTop + (nextOffset - previousOffset);
}

export function measurePrependAnchor(
  scroller: HTMLElement,
  container: HTMLElement,
): PrependAnchor | null {
  const element = container.querySelector('.agent-message-item');
  if (!(element instanceof HTMLElement)) return null;
  return {
    element,
    offset:
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top,
  };
}

export function nextScrollTopAfterAnchor(
  scroller: HTMLElement,
  anchor: PrependAnchor,
): number {
  if (!anchor.element.isConnected) return scroller.scrollTop;
  const nextOffset =
    anchor.element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top;
  return nextScrollTopAfterAnchorShift(
    scroller.scrollTop,
    anchor.offset,
    nextOffset,
  );
}

/**
 * 上滑立刻取消贴底；只有用户主动下滚且已靠近底部才重新贴底。
 * 内容在底部增高（scrollTop 不变）时保持原状态。
 */
export function resolvePinnedAfterUserScroll(options: {
  previousScrollTop: number;
  next: ScrollMetrics;
  currentlyPinned: boolean;
}): boolean {
  if (options.next.scrollTop < options.previousScrollTop) return false;
  if (options.next.scrollTop > options.previousScrollTop) {
    return isNearBottom(options.next);
  }
  return options.currentlyPinned;
}

export function shouldFollowPinnedContent(options: {
  pinned: boolean;
  editing: boolean;
}): boolean {
  return options.pinned && !options.editing;
}

export function easeOutCubic(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return 1 - (1 - t) ** 3;
}

export function interpolateScrollTop(
  from: number,
  to: number,
  progress: number,
): number {
  return from + (to - from) * easeOutCubic(progress);
}

export function shouldLoadOlderMessages(options: {
  programmatic: boolean;
  pinned: boolean;
  hasMore: boolean;
  loading: boolean;
  scrollTop: number;
  thresholdPx?: number;
}): boolean {
  if (
    options.programmatic ||
    options.pinned ||
    options.loading ||
    !options.hasMore
  ) {
    return false;
  }
  return options.scrollTop < (options.thresholdPx ?? TOP_LOAD_THRESHOLD_PX);
}
