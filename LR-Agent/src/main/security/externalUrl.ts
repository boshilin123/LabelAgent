/**
 * 主进程侧外部 URL 放行判断。
 *
 * shell.openExternal / setWindowOpenHandler 必须校验协议：Windows 上 smb: 会泄露
 * NTLM 凭据，ms-msdt: / search-ms: 等自定义协议历史上都是 RCE 载体。
 * 这里仅放行 https 与本机 http（开发服务器/本地后端）。
 */
export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') {
      return (
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]' ||
        parsed.hostname === '::1'
      );
    }
    return false;
  } catch {
    return false;
  }
}
