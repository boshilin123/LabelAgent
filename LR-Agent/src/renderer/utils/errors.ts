import { ApiError } from '../types/auth';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: '邮箱或密码错误',
  email_already_registered: '该邮箱已注册',
  password_must_contain_lowercase: '密码需包含小写字母',
  password_must_contain_uppercase: '密码需包含大写字母',
  password_must_contain_digit: '密码需包含数字',
  session_expired: '登录已过期，请重新登录',
  not_authenticated: '请先登录后再使用此功能',
  token_reuse_detected: '登录状态异常，请重新登录',
  request_failed: '请求失败，请稍后重试',
  invalid_or_expired_token: '验证链接无效或已过期',
  email_already_verified: '邮箱已验证，无需重复发送',
  verification_email_sent: '验证邮件已发送，请查收',
  rate_limit_exceeded: '操作过于频繁，请稍后再试',
  username_already_taken: '用户名已被占用',
  invalid_username: '用户名格式无效（3-32 位字母、数字或下划线）',
  invalid_image_type: '仅支持 JPEG、PNG、WebP 图片',
  invalid_image: '图片无效或已损坏',
  file_too_large: '图片不能超过 2MB',
  avatar_not_found: '当前没有头像',
  account_deleted: '账号已注销',
  network_unavailable: '当前离线，此功能需要联网',
};

export default function translateError(detail: string): string {
  return ERROR_MESSAGES[detail] ?? detail;
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 401) {
    return true;
  }
  if (err instanceof Error) {
    return [
      'session_expired',
      'not_authenticated',
      'invalid_credentials',
      'token_reuse_detected',
    ].includes(err.message);
  }
  return false;
}

export function resolveErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return translateError(err.detail);
  }
  if (err instanceof Error && err.message) {
    return translateError(err.message);
  }
  return fallback;
}
