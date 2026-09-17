import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ReactNode } from 'react';
import { motionDistance, motionDuration, motionEase } from './tokens';

interface PanelTransitionProps {
  panelKey: string;
  children: ReactNode;
  className?: string;
  direction?: 'left' | 'up';
}

export default function PanelTransition({
  panelKey,
  children,
  className = '',
  direction = 'left',
}: PanelTransitionProps) {
  const reducedMotion = useReducedMotion();
  const offset =
    direction === 'left'
      ? { x: -motionDistance.x, y: 0 }
      : { x: 0, y: motionDistance.y };

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={panelKey}
        className={className}
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, ...offset }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        exit={
          reducedMotion
            ? { opacity: 0 }
            : {
                opacity: 0,
                x: direction === 'left' ? motionDistance.x / 2 : 0,
                y: direction === 'up' ? -motionDistance.y / 2 : 0,
              }
        }
        transition={{
          duration: reducedMotion ? 0.1 : motionDuration.tab,
          ease: motionEase,
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
