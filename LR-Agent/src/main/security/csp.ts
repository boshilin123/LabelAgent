/**
 * 主进程响应头安全加固。
 *
 * 打包后渲染层走 file://，Electron webRequest 无法拦截 file://，因此生产 CSP
 * 以 index.ejs 的 <meta> 为准（见 .erb/configs/rendererCsp.ts）。这里对 http(s)
 * 加载（开发服务器等）补充同一基线的 CSP 与若干加固头。两份 CSP 会取交集，
 * 所以此处构建的策略必须是 meta 基线的超集，额外只为动态 origin 服务。
 */
import { themeInitHash } from '../../shared/themeInitCsp';

export interface MainCspContext {
  isDevelopment: boolean;
  /** 运行时才知道的 origin（后端地址、本地 Agent / MCP 服务） */
  origins: (string | null | undefined)[];
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildMainCsp(ctx: MainCspContext): string {
  const scriptSrc = ctx.isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'sha256-${themeInitHash()}'`;
  const connectBase = ctx.isDevelopment
    ? ["'self'", 'https:', 'http:', 'ws:']
    : ["'self'", 'https:', 'http:', 'ws://localhost:*', 'ws://127.0.0.1:*'];
  const extras = ctx.origins
    .map((origin) => originOf(origin))
    .filter((value): value is string => Boolean(value));
  const connectSrc = `connect-src ${[
    ...new Set([...connectBase, ...extras]),
  ].join(' ')}`;

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

/** 与 CSP 配套的通用加固头 */
export const EXTRA_SECURITY_HEADERS: Record<string, string[]> = {
  'X-Content-Type-Options': ['nosniff'],
  'Referrer-Policy': ['no-referrer'],
};
