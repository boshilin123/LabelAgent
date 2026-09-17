import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import type {
  AriaRole,
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from 'react';
import { motionDuration, motionEase } from './tokens';

const listItemVariants = {
  initial: { opacity: 0, y: 4 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: motionDuration.enter, ease: motionEase },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: motionDuration.exit, ease: motionEase },
  },
};

const listItemVariantsReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.1 } },
  exit: { opacity: 0, transition: { duration: 0.08 } },
};

interface AnnotationMotionListProps {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  as?: 'div' | 'ul';
}

/** Wrapper for annotation list columns. `sync` avoids popLayout reparent jank on bulk replace. */
export function AnnotationMotionList({
  className,
  style,
  children,
  as = 'div',
}: AnnotationMotionListProps) {
  const Tag = as;
  return (
    <Tag className={className} style={style}>
      <AnimatePresence initial={false} mode="sync">
        {children}
      </AnimatePresence>
    </Tag>
  );
}

interface AnnotationMotionListItemProps {
  className?: string;
  style?: CSSProperties;
  layoutKey: string;
  /** When true, row mounts without entrance motion (image switch bulk load). */
  skipEnterAnimation?: boolean;
  children: ReactNode;
  as?: 'div' | 'li';
  onClick?: MouseEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  role?: AriaRole;
  tabIndex?: number;
  'aria-pressed'?: boolean;
  'aria-label'?: string;
}

export function AnnotationMotionListItem({
  className,
  style,
  layoutKey,
  skipEnterAnimation,
  children,
  as = 'div',
  onClick,
  onKeyDown,
  role,
  tabIndex,
  'aria-pressed': ariaPressed,
  'aria-label': ariaLabel,
}: AnnotationMotionListItemProps) {
  const reducedMotion = useReducedMotion();
  const Component = as === 'li' ? m.li : m.div;

  return (
    <Component
      key={layoutKey}
      layout={false}
      className={className}
      style={style}
      variants={reducedMotion ? listItemVariantsReduced : listItemVariants}
      initial={skipEnterAnimation || reducedMotion ? false : 'initial'}
      animate="animate"
      exit="exit"
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={role}
      tabIndex={tabIndex}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
    >
      {children}
    </Component>
  );
}
