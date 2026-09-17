// 深链（lr-agent://reset-password?token=...）解析与 pending token 暂存。
// 后端在 send_password_reset_email 中按 email_deep_link_base(默认 "lr-agent://")
// 生成 "lr-agent://reset-password?token=..." 链接。
//
// 残余风险：自定义协议注册在本机是全局的，恶意程序可注册同名协议或在应用未运行时
// 抢先处理链接，从而窃取 token。客户端无法彻底解决，需后端配合缩短 token 有效期
// 并做一次性绑定（使用后立即失效）。此处仅做格式/长度校验与用后即清，降低注入面。

const DEEP_LINK_SCHEME = 'lr-agent://';
const RESET_PATH_PREFIX = 'reset-password';

// 允许 URL-safe base64 / JWT / 通用不透明 token 字符集。
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;
const RESET_TOKEN_MIN_LENGTH = 16;
const RESET_TOKEN_MAX_LENGTH = 2048;

let pendingResetToken: string | null = null;

export function isValidResetToken(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  if (
    token.length < RESET_TOKEN_MIN_LENGTH ||
    token.length > RESET_TOKEN_MAX_LENGTH
  ) {
    return false;
  }
  return RESET_TOKEN_PATTERN.test(token);
}

export function parseResetDeepLink(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(DEEP_LINK_SCHEME)) return null;

  const rest = url.slice(DEEP_LINK_SCHEME.length);
  const queryIndex = rest.indexOf('?');
  const pathname = (queryIndex < 0 ? rest : rest.slice(0, queryIndex)).replace(
    /\/+$/,
    '',
  );
  if (pathname !== RESET_PATH_PREFIX) return null;
  if (queryIndex < 0) return null;

  const params = new URLSearchParams(rest.slice(queryIndex + 1));
  const token = params.get('token');
  return isValidResetToken(token) ? token : null;
}

export function setPendingResetToken(token: string): void {
  // 只接受通过校验的 token，避免把非法输入暂存后在渲染层被当作凭据使用。
  pendingResetToken = isValidResetToken(token) ? token : null;
}

export function takePendingResetToken(): string | null {
  const token = pendingResetToken;
  pendingResetToken = null;
  return token;
}
