import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as authService from '../services/auth';
import translateError from '../utils/errors';
import './VerifyEmailPage.css';

type VerifyState = 'loading' | 'success' | 'error' | 'missing';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<VerifyState>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setState('missing');
      setMessage('验证链接无效，缺少 token 参数。');
      return undefined;
    }

    let cancelled = false;

    authService
      .verifyEmail(token)
      .then(() => {
        if (cancelled) return;
        setState('success');
        setMessage('你的邮箱已成功验证。');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : 'request_failed';
        setState('error');
        setMessage(translateError(detail));
      });

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const title =
    state === 'success'
      ? '验证成功'
      : state === 'loading'
        ? '正在验证'
        : '验证失败';

  return (
    <div className="verify-email-page">
      <div className="verify-email-card">
        <h1 className={`verify-email-title verify-email-title-${state}`}>
          {title}
        </h1>
        <p className="verify-email-message">
          {state === 'loading' ? '请稍候，正在验证你的邮箱…' : message}
        </p>
        {state === 'success' && (
          <p className="verify-email-hint">
            请回到 LR-Agent
            客户端，账户资料会自动刷新；若仍显示未验证，重新打开账户设置即可。
          </p>
        )}
      </div>
    </div>
  );
}
