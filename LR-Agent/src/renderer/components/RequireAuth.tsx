import { motion, useReducedMotion } from 'framer-motion';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { motionDistance, motionDuration, motionEase } from '../motion/tokens';
import AuthPage from '../pages/AuthPage';
import './RequireAuth.css';

export default function RequireAuth() {
  const { status } = useAuth();
  const reducedMotion = useReducedMotion();

  if (status === 'loading') {
    return (
      <motion.div
        className="auth-loading"
        initial={
          reducedMotion ? { opacity: 0 } : { opacity: 0, y: motionDistance.y }
        }
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: motionDuration.enter, ease: motionEase }}
      >
        <div className="auth-loading-spinner" aria-hidden />
        <p>正在加载…</p>
      </motion.div>
    );
  }

  if (status === 'unauthenticated') {
    return <AuthPage />;
  }

  return <Outlet />;
}
