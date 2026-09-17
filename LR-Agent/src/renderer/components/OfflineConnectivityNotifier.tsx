import { useEffect, useRef } from 'react';
import { useAuth, type AuthStatus } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export default function OfflineConnectivityNotifier() {
  const { status } = useAuth();
  const { showToast } = useToast();
  const prevStatusRef = useRef<AuthStatus | null>(null);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prev === null || prev === 'loading') {
      return;
    }

    if (prev === 'authenticated' && status === 'authenticated_offline') {
      showToast('已进入离线模式，本地功能可继续使用', { type: 'info' });
      return;
    }

    if (prev === 'authenticated_offline' && status === 'authenticated') {
      showToast('已恢复在线', { type: 'success' });
    }
  }, [status, showToast]);

  return null;
}
