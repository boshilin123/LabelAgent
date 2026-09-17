import { FormEvent, useState } from 'react';
import * as authService from '../services/auth';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';
import './AuthPage.css';

interface ForgotPasswordFormProps {
  onBackToLogin: () => void;
}

export default function ForgotPasswordForm({
  onBackToLogin,
}: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await authService.forgotPassword(email.trim());
      setSuccess(true);
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
      {success && (
        <div className="auth-success">
          若该邮箱已注册，重置链接已发送，请查收邮件（1 小时内有效）。
        </div>
      )}

      <div className="auth-field">
        <span className="auth-field-label">邮箱</span>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <button
        type="submit"
        className="app-btn app-btn-primary auth-submit"
        disabled={loading}
      >
        {loading ? '发送中…' : '发送重置链接'}
      </button>

      <button
        type="button"
        className="auth-link-button"
        onClick={onBackToLogin}
      >
        返回登录
      </button>
    </form>
  );
}
