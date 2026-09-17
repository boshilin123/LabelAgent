/**
 * Renderer 侧 CSP 构建（供 webpack HtmlWebpackPlugin 注入 index.ejs 使用）。
 *
 * 打包后渲染层以 file:// 加载，Electron 的 webRequest 无法拦截 file://，
 * 因此生产环境的 CSP 必须以 <meta> 形式内联在 HTML 里（见 index.ejs）。
 * 主进程另有一份同基线的响应头（见 src/main/security/csp.ts），对 http(s) 生效。
 */
import { themeInitHash, themeInitScript } from '../../src/shared/themeInitCsp';

export { themeInitHash, themeInitScript };

/**
 * 渲染层 CSP。
 *
 * 生产：script-src 仅 'self' + 主题脚本 sha256，去掉 'unsafe-inline'，
 * 使内联脚本注入（XSS）无法执行；ws: 仅放行本机（阻断远程 websocket 外联）。
 * 开发：放行 'unsafe-inline' / 'unsafe-eval' 与 ws:，兼容 HMR 与 React Refresh。
 */
export function buildRendererCsp(isDevelopment: boolean): string {
  const scriptSrc = isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'sha256-${themeInitHash()}'`;
  const connectSrc = isDevelopment
    ? "connect-src 'self' https: http: ws:"
    : "connect-src 'self' https: http: ws://localhost:* ws://127.0.0.1:*";

  return [
    "default-src 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http://localhost:9000 http://127.0.0.1:9000",
    "font-src 'self' data:",
    connectSrc,
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "frame-src blob: 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
