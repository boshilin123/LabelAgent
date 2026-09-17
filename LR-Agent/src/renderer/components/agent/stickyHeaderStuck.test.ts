import { describe, expect, it } from '@jest/globals';
import {
  isStickyHeaderStuck,
  resolveStickyObserverRoot,
  STICKY_SCROLL_ROOT_SELECTOR,
} from './stickyHeaderStuck';

describe('stickyHeaderStuck', () => {
  it('treats a hidden sentinel as the sticky header being stuck', () => {
    expect(isStickyHeaderStuck(true)).toBe(false);
    expect(isStickyHeaderStuck(false)).toBe(true);
  });

  it('resolves the overlay scroll content as the observer root', () => {
    const root = document.createElement('div');
    root.className = STICKY_SCROLL_ROOT_SELECTOR.slice(1);
    const turn = document.createElement('div');
    const sentinel = document.createElement('div');
    root.appendChild(turn);
    turn.appendChild(sentinel);
    document.body.appendChild(root);

    expect(resolveStickyObserverRoot(sentinel)).toBe(root);
    expect(resolveStickyObserverRoot(null)).toBeNull();

    root.remove();
  });
});
