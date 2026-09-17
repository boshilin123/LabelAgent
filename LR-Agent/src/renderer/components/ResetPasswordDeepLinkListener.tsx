import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 订阅 Electron 主进程派发的 lr-agent:// 重置密码深链事件，
 * 收到 token 后导航到 /reset-password（经 state 传递 token）。
 * 浏览器模式（无 window.electron）下不生效，由 /reset-password 页面自行读 query。
 */
export default function ResetPasswordDeepLinkListener() {
  const navigate = useNavigate();

  useEffect(() => {
    const authBridge = window.electron?.auth;
    if (!authBridge) {
      return undefined;
    }

    let disposed = false;

    const goToReset = (token: string) => {
      if (!token || disposed) return;
      navigate('/reset-password', { state: { token } });
    };

    authBridge
      .getPendingResetToken()
      .then((token) => {
        if (token) goToReset(token);
      })
      .catch(() => undefined);

    const unsubscribe = authBridge.onResetPasswordDeepLink(goToReset);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [navigate]);

  return null;
}
