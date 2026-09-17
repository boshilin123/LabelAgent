import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import * as authService from '../services/auth';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';
import './EmailVerifyBanner.css';

export default function EmailVerifyBanner() {
  const { user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);

  if (!user || user.email_verified) {
    return null;
  }

  const handleResend = async () => {
    setLoading(true);
    try {
      await authService.resendVerificationEmail();
      showToast('验证邮件已发送，请查收邮箱（含垃圾箱）', { type: 'success' });
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      showToast(translateError(detail), { type: 'error' });
      if (detail === 'email_already_verified') {
        await refreshUser();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="email-verify-banner" role="status">
      <span>邮箱尚未验证（{user.email}）。请查收验证邮件并完成验证。</span>
      <button
        type="button"
        className="email-verify-banner-btn"
        onClick={handleResend}
        disabled={loading}
      >
        {loading ? '发送中…' : '重发验证邮件'}
      </button>
    </div>
  );
}
