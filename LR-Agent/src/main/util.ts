import { URL, fileURLToPath } from 'url';
import path from 'path';

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}

/**
 * True when the URL stays inside this app.
 *
 * 生产环境不再放行任意 file:，只允许应用自身渲染产物目录（../renderer）下的路径，
 * 避免被诱导导航到本机任意文件（如 file:///C:/Windows/...）。
 */
export function isAppOwnedNavigation(url: string): boolean {
  try {
    const target = new URL(url);
    if (process.env.NODE_ENV === 'development') {
      const app = new URL(resolveHtmlPath('index.html'));
      return target.origin === app.origin;
    }
    if (target.protocol !== 'file:') return false;
    const appRoot = path.resolve(__dirname, '../renderer/');
    const targetPath = path.resolve(fileURLToPath(target));
    const rel = path.relative(appRoot, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}
