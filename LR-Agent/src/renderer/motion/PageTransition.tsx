import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ReactNode } from 'react';
import { motionDistance, motionDuration, motionEase } from './tokens';
import './motion.css';

interface PageTransitionProps {
  routeKey: string;
  children: ReactNode;
  className?: string;
}

export default function PageTransition({
  routeKey,
  children,
  className = '',
}: PageTransitionProps) {
  const reducedMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        className={`page-transition-root ${className}`.trim()}
        initial={
          reducedMotion ? { opacity: 0 } : { opacity: 0, y: motionDistance.y }
        }
        animate={{ opacity: 1, y: 0 }}
        exit={
          reducedMotion
            ? { opacity: 0 }
            : { opacity: 0, y: -motionDistance.y / 2 }
        }
        transition={{
          duration: reducedMotion ? 0.1 : motionDuration.enter,
          ease: motionEase,
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
