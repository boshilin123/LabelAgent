import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FormEvent, MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motionDuration, motionEase } from './tokens';

interface ModalMotionProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  dialogClassName?: string;
  overlayClassName?: string;
  labelledBy?: string;
  dialogRole?: 'dialog' | 'form';
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** When false, clicking the backdrop does not call onClose. Default true. */
  closeOnBackdropClick?: boolean;
}

export default function ModalMotion({
  open,
  onClose,
  children,
  dialogClassName = '',
  overlayClassName = '',
  labelledBy,
  dialogRole = 'dialog',
  onSubmit,
  closeOnBackdropClick = true,
}: ModalMotionProps) {
  const reducedMotion = useReducedMotion();

  const dialogMotion = {
    initial: reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 },
    transition: {
      duration: reducedMotion ? 0.1 : motionDuration.modal,
      ease: motionEase,
    },
  };

  const stopPropagation = (event: MouseEvent) => {
    event.stopPropagation();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={`modal-motion-root ${overlayClassName}`.trim()}
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: reducedMotion ? 0.1 : motionDuration.modal,
            ease: motionEase,
          }}
          onClick={closeOnBackdropClick ? onClose : undefined}
        >
          {dialogRole === 'form' ? (
            <motion.form
              className={dialogClassName}
              role="dialog"
              aria-modal="true"
              aria-labelledby={labelledBy}
              onSubmit={onSubmit}
              onClick={stopPropagation}
              {...dialogMotion}
            >
              {children}
            </motion.form>
          ) : (
            <motion.div
              className={dialogClassName}
              role="dialog"
              aria-modal="true"
              aria-labelledby={labelledBy}
              onClick={stopPropagation}
              {...dialogMotion}
            >
              {children}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
