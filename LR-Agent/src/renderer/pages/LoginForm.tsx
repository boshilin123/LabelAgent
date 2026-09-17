import { FormEvent, useEffect, useState } from 'react';
import { REMEMBERED_EMAIL_KEY } from '../config';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';
import PasswordField from './PasswordField';
import './AuthPage.css';

interface LoginFormProps {
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
}

export default function LoginForm({
  onSwitchToRegister,
  onForgotPassword,
}: LoginFormProps) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberEmail, setRememberEmail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(REMEMBERED_EMAIL_KEY);
    if (saved) {
      setEmail(saved);
      setRememberEmail(true);
    }
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      if (rememberEmail) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
      } else {
        localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      setError(translateError(detail));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      {error && <div className="auth-error">{error}</div>}

      <div className="auth-field">
        <span className="auth-field-label">邮箱</span>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <PasswordField
        id="login-password"
        name="password"
        label="密码"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        required
      />

      <div className="auth-checkbox-row">
        <label className="auth-checkbox" htmlFor="remember-email">
          <input
            id="remember-email"
            type="checkbox"
            checked={rememberEmail}
            onChange={(e) => setRememberEmail(e.target.checked)}
          />
          记住邮箱
        </label>
        <button
          type="button"
          className="auth-link-button"
          onClick={onForgotPassword}
        >
          忘记密码？
        </button>
      </div>

      <button
        type="submit"
        className="app-btn app-btn-primary auth-submit"
        disabled={loading}
      >
        {loading ? '登录中…' : '登录'}
      </button>

      <button
        type="button"
        className="auth-link-button"
        onClick={onSwitchToRegister}
      >
        没有账号？注册
      </button>
    </form>
  );
}
