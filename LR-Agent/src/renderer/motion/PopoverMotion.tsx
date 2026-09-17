import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import type { CSSProperties, ReactNode } from 'react';
import { motionDistance, motionDuration, motionEase } from './tokens';

export type PopoverOrigin = 'top' | 'bottom';

export type FloatingMenuOrigin = 'below-anchor' | 'above-anchor';

export function getFloatingMenuMotionProps(
  origin: FloatingMenuOrigin,
  reducedMotion: boolean | null,
) {
  const enterY =
    origin === 'below-anchor' ? -motionDistance.y / 2 : motionDistance.y / 2;
  const exitY =
    origin === 'below-anchor' ? -motionDistance.y / 4 : motionDistance.y / 4;

  return {
    initial: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, y: enterY, scale: 0.96 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, y: exitY, scale: 0.98 },
    transition: {
      duration: reducedMotion ? 0.1 : motionDuration.popover,
      ease: motionEase,
    },
  } as const;
}

export function getPopoverMotionProps(
  origin: PopoverOrigin,
  reducedMotion: boolean | null,
) {
  const enterY = origin === 'top' ? -motionDistance.y / 2 : motionDistance.y;
  const exitY = origin === 'top' ? -motionDistance.y / 4 : motionDistance.y / 2;

  return {
    initial: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, y: enterY, scale: 0.96 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, y: exitY, scale: 0.98 },
    transition: {
      duration: reducedMotion ? 0.1 : motionDuration.popover,
      ease: motionEase,
    },
  } as const;
}

interface PopoverMotionProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  origin?: PopoverOrigin;
  role?: string;
  'aria-label'?: string;
  innerRef?: React.Ref<HTMLDivElement>;
}

/** Inline popover/dropdown with enter/exit animation. */
export default function PopoverMotion({
  open,
  children,
  className = '',
  style,
  origin = 'top',
  role,
  'aria-label': ariaLabel,
  innerRef,
}: PopoverMotionProps) {
  const reducedMotion = useReducedMotion();
  const motionProps = getPopoverMotionProps(origin, reducedMotion);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          ref={innerRef}
          className={className}
          style={style}
          role={role}
          aria-label={ariaLabel}
          {...motionProps}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
