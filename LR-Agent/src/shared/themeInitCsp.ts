/**
 * 主题引导脚本及其 CSP 哈希（渲染层 index.ejs 与主进程安全头共用）。
 *
 * 打包后渲染层以 file:// 加载，CSP 必须内联在 HTML；生产环境用本脚本的
 * sha256 放行，从而去掉 script-src 'unsafe-inline'。脚本必须与 index.ejs
 * 注入的内容逐字节一致，因此集中在此处定义、由 webpack 模板参数注入。
 */
import crypto from 'crypto';

export const themeInitScript =
  "(function(){var K='lr-agent:colorTheme';var p=localStorage.getItem(K)||'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;r.style.backgroundColor=d?'#1e1e1e':'#ffffff';})();";

export function themeInitHash(): string {
  return crypto
    .createHash('sha256')
    .update(themeInitScript, 'utf8')
    .digest('base64');
}
