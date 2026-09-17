import { FormEvent, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import * as authService from '../services/auth';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';
import PasswordField from './PasswordField';
import './AuthPage.css';
import './ResetPasswordPage.css';

type ResetViewState = 'form' | 'success' | 'missing';

export default function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Electron 深链经 navigate 的 state.token 传入；浏览器模式回退 query ?token=
  const stateToken =
    (location.state as { token?: string } | null)?.token ?? null;
  const queryToken = searchParams.get('token');
  const token = stateToken ?? queryToken;

  const [viewState, setViewState] = useState<ResetViewState>(
    token ? 'form' : 'missing',
  );
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    try {
      await authService.resetPassword(token ?? '', password);
      await authService.clearSession();
      setViewState('success');
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      setError(translateError(detail));
    } finally {
      setLoading(false);
    }
  };

  if (viewState === 'missing') {
    return (
      <div className="reset-password-page">
        <div className="reset-password-card">
          <h1 className="reset-password-title reset-password-title-error">
            链接无效
          </h1>
          <p className="reset-password-message">
            重置链接无效，缺少 token 参数。请在登录页重新发起找回密码。
          </p>
          <button
            type="button"
            className="app-btn app-btn-primary"
            onClick={() => navigate('/auth')}
          >
            返回登录
          </button>
        </div>
      </div>
    );
  }

  if (viewState === 'success') {
    return (
      <div className="reset-password-page">
        <div className="reset-password-card">
          <h1 className="reset-password-title reset-password-title-success">
            重置成功
          </h1>
          <p className="reset-password-message">
            密码已重置，请使用新密码重新登录。
          </p>
          <button
            type="button"
            className="app-btn app-btn-primary"
            onClick={() => navigate('/auth')}
          >
            去登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="reset-password-page">
      <div className="reset-password-card">
        <h1 className="reset-password-title">重置密码</h1>
        <form className="auth-form" onSubmit={handleSubmit}>
          {error && <div className="auth-error">{error}</div>}

          <PasswordField
            id="reset-password"
            name="password"
            label="新密码"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
            required
          />

          <PasswordField
            id="reset-password-confirm"
            name="confirmPassword"
            label="确认新密码"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            minLength={8}
            required
          />

          <button
            type="submit"
            className="app-btn app-btn-primary auth-submit"
            disabled={loading}
          >
            {loading ? '提交中…' : '重置密码'}
          </button>
        </form>
      </div>
    </div>
  );
}
