export const MENU_GAP = 4;
export const VIEWPORT_PADDING = 8;

export interface FloatingMenuPosition {
  top: number;
  left: number;
  openUp: boolean;
}

export interface FloatingMenuPositionOptions {
  gap?: number;
  padding?: number;
  /** Align menu trailing edge to anchor trailing edge. */
  alignEnd?: boolean;
  /** Prefer opening upward/downward when viewport allows; otherwise auto-flip. */
  preferOpenUp?: boolean;
}

export function computeFloatingMenuPosition(
  anchorEl: HTMLElement,
  menuWidth: number,
  menuHeight: number,
  options: FloatingMenuPositionOptions = {},
): FloatingMenuPosition {
  const gap = options.gap ?? MENU_GAP;
  const padding = options.padding ?? VIEWPORT_PADDING;
  const alignEnd = options.alignEnd ?? true;

  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - padding;
  const spaceAbove = rect.top - padding;

  let openUp: boolean;
  if (options.preferOpenUp != null) {
    const preferredFits = options.preferOpenUp
      ? spaceAbove >= menuHeight
      : spaceBelow >= menuHeight;
    const alternateFits = options.preferOpenUp
      ? spaceBelow >= menuHeight
      : spaceAbove >= menuHeight;
    if (preferredFits) {
      openUp = options.preferOpenUp;
    } else if (alternateFits) {
      openUp = !options.preferOpenUp;
    } else {
      openUp = spaceAbove > spaceBelow;
    }
  } else {
    openUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;
  }

  const top = openUp
    ? Math.max(padding, rect.top - menuHeight - gap)
    : Math.min(window.innerHeight - menuHeight - padding, rect.bottom + gap);

  const left = alignEnd
    ? Math.min(
        Math.max(padding, rect.right - menuWidth),
        window.innerWidth - menuWidth - padding,
      )
    : Math.min(
        Math.max(padding, rect.left),
        window.innerWidth - menuWidth - padding,
      );

  return { top, left, openUp };
}
