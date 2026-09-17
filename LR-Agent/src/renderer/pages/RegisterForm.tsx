import { FormEvent, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';
import PasswordField from './PasswordField';
import './AuthPage.css';

interface RegisterFormProps {
  onSwitchToLogin: () => void;
}

export default function RegisterForm({ onSwitchToLogin }: RegisterFormProps) {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    try {
      await register(email.trim(), password);
      setSuccess('注册成功！验证邮件已发送，请查收后登录。');
      setPassword('');
      setConfirmPassword('');
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
      {success && <div className="auth-success">{success}</div>}

      <div className="auth-field">
        <span className="auth-field-label">邮箱</span>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <PasswordField
        id="register-password"
        name="password"
        label="密码"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        minLength={8}
        required
      />

      <PasswordField
        id="register-confirm"
        name="confirmPassword"
        label="确认密码"
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
        {loading ? '注册中…' : '注册'}
      </button>

      <button
        type="button"
        className="auth-link-button"
        onClick={onSwitchToLogin}
      >
        已有账号？登录
      </button>
    </form>
  );
}
