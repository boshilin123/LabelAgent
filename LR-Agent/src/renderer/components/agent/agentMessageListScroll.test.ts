import { describe, expect, it } from '@jest/globals';
import {
  distanceFromBottom,
  easeOutCubic,
  interpolateScrollTop,
  isNearBottom,
  nextScrollTopAfterAnchorShift,
  resolvePinnedAfterUserScroll,
  shouldFollowPinnedContent,
  shouldLoadOlderMessages,
} from './agentMessageListScroll';

describe('agentMessageListScroll', () => {
  it('treats the viewport as near bottom within the threshold', () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 940, clientHeight: 50 }),
    ).toBe(true);
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 50 }),
    ).toBe(false);
    expect(
      distanceFromBottom({
        scrollHeight: 1000,
        scrollTop: 800,
        clientHeight: 50,
      }),
    ).toBe(150);
  });

  it('keeps the visible row offset when older messages prepend', () => {
    expect(nextScrollTopAfterAnchorShift(40, 12, 812)).toBe(840);
  });

  it('ignores height added below the reading position', () => {
    expect(nextScrollTopAfterAnchorShift(40, 12, 12)).toBe(40);
  });

  it('unpins as soon as the user scrolls up, even near the bottom', () => {
    expect(
      resolvePinnedAfterUserScroll({
        previousScrollTop: 940,
        currentlyPinned: true,
        next: { scrollHeight: 1000, scrollTop: 920, clientHeight: 50 },
      }),
    ).toBe(false);
    expect(
      resolvePinnedAfterUserScroll({
        previousScrollTop: 800,
        currentlyPinned: false,
        next: { scrollHeight: 1000, scrollTop: 940, clientHeight: 50 },
      }),
    ).toBe(true);
  });

  it('does not re-pin when content grows and scrollTop stays put', () => {
    expect(
      resolvePinnedAfterUserScroll({
        previousScrollTop: 920,
        currentlyPinned: false,
        next: { scrollHeight: 1200, scrollTop: 920, clientHeight: 50 },
      }),
    ).toBe(false);
  });

  it('only follows new content when pinned and not editing', () => {
    expect(shouldFollowPinnedContent({ pinned: true, editing: false })).toBe(
      true,
    );
    expect(shouldFollowPinnedContent({ pinned: false, editing: false })).toBe(
      false,
    );
    expect(shouldFollowPinnedContent({ pinned: true, editing: true })).toBe(
      false,
    );
  });

  it('eases jump-to-bottom quickly and lands on the target', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8);
    expect(interpolateScrollTop(100, 500, 0)).toBe(100);
    expect(interpolateScrollTop(100, 500, 1)).toBe(500);
  });

  it('does not load older messages while pinned or programmatically scrolling', () => {
    expect(
      shouldLoadOlderMessages({
        programmatic: false,
        pinned: false,
        hasMore: true,
        loading: false,
        scrollTop: 20,
      }),
    ).toBe(true);
    expect(
      shouldLoadOlderMessages({
        programmatic: true,
        pinned: false,
        hasMore: true,
        loading: false,
        scrollTop: 20,
      }),
    ).toBe(false);
    expect(
      shouldLoadOlderMessages({
        programmatic: false,
        pinned: true,
        hasMore: true,
        loading: false,
        scrollTop: 20,
      }),
    ).toBe(false);
  });
});
