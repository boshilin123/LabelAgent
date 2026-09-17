import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { motionDuration, motionEase } from '../motion/tokens';
import './ToastContainer.css';

export interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

const ICONS: Record<ToastItem['type'], string> = {
  success: 'codicon-check',
  error: 'codicon-error',
  info: 'codicon-info',
};

export default function ToastContainer({
  toasts,
  onDismiss,
}: ToastContainerProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div
      className="toast-viewport"
      aria-live="polite"
      aria-relevant="additions"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            role="status"
            layout={!reducedMotion}
            initial={
              reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, x: 0 }
            }
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, x: 8 }}
            transition={{
              duration: reducedMotion ? 0.1 : motionDuration.tab,
              ease: motionEase,
            }}
          >
            <span
              className={`toast-icon codicon ${ICONS[toast.type]}`}
              aria-hidden="true"
            />
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭"
              onClick={() => onDismiss(toast.id)}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
