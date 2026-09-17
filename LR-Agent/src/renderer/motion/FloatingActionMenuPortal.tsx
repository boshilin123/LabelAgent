import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import {
  computeFloatingMenuPosition,
  type FloatingMenuPosition,
} from '../utils/annotationMenuPosition';
import { getFloatingMenuMotionProps } from './PopoverMotion';

const DEFAULT_MENU_MIN_WIDTH = 140;
const EMPTY_REPOSITION_DEPS: readonly unknown[] = [];

interface FloatingActionMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  onClose: () => void;
  onExitComplete?: () => void;
  className: string;
  openUpClassName?: string;
  children: ReactNode;
  menuMinWidth?: number;
  /** Extra deps that should trigger menu reposition (e.g. item count). */
  repositionDeps?: readonly unknown[];
}

export default function FloatingActionMenuPortal({
  open,
  anchorEl,
  onClose,
  onExitComplete,
  className,
  openUpClassName = '',
  children,
  menuMinWidth = DEFAULT_MENU_MIN_WIDTH,
  repositionDeps = EMPTY_REPOSITION_DEPS,
}: FloatingActionMenuPortalProps) {
  const reducedMotion = useReducedMotion();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);

  const updatePosition = useCallback(() => {
    const menuEl = menuRef.current;
    if (!menuEl) return;
    const next = computeFloatingMenuPosition(
      anchorEl,
      Math.max(menuEl.offsetWidth, menuMinWidth),
      menuEl.offsetHeight,
    );
    setPosition((prev) => {
      if (
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.openUp === next.openUp
      ) {
        return prev;
      }
      return next;
    });
  }, [anchorEl, menuMinWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, ...repositionDeps]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, anchorEl, onClose]);

  const origin = position?.openUp ? 'above-anchor' : 'below-anchor';
  const openUpClass =
    position?.openUp && openUpClassName ? ` ${openUpClassName}` : '';

  return createPortal(
    <AnimatePresence onExitComplete={onExitComplete}>
      {open && (
        <m.div
          ref={menuRef}
          className={`${className}${openUpClass}`.trim()}
          role="menu"
          style={
            position
              ? {
                  top: `${position.top}px`,
                  left: `${position.left}px`,
                }
              : { visibility: 'hidden' }
          }
          {...getFloatingMenuMotionProps(origin, reducedMotion)}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
