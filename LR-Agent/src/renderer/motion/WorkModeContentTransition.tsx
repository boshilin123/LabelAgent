import { ReactNode, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { motionDuration, motionEase } from './tokens';

interface WorkModeContentTransitionProps {
  workMode: string;
  children: ReactNode;
  className?: string;
}

/**
 * Fades content on work-mode change without unmounting children (keeps Monaco alive).
 */
export default function WorkModeContentTransition({
  workMode,
  children,
  className = '',
}: WorkModeContentTransitionProps) {
  const reducedMotion = useReducedMotion();
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    if (reducedMotion) {
      setOpacity(1);
      return undefined;
    }

    setOpacity(0);
    const frameId = requestAnimationFrame(() => {
      setOpacity(1);
    });
    return () => cancelAnimationFrame(frameId);
  }, [workMode, reducedMotion]);

  return (
    <motion.div
      className={className}
      initial={false}
      animate={{ opacity }}
      transition={{
        duration: reducedMotion ? 0.1 : motionDuration.tab,
        ease: motionEase,
      }}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {children}
    </motion.div>
  );
}
