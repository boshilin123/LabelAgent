import { loadMarkdownImageBlobUrl } from '../../utils/markdownImageResolver';

/** 将 Markdown 中的 charts/xxx.png 解析为报告 run 目录下的绝对路径。 */
export function resolveReportImageAbsolutePath(
  reportRootPath: string,
  src: string,
): string | null {
  if (!reportRootPath.trim()) return null;
  if (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('blob:')
  ) {
    return null;
  }

  const normalized = src.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.includes('..')) return null;

  const root = reportRootPath.replace(/[/\\]+$/, '');
  const useBackslash = /\\/.test(root);
  const join = (...parts: string[]) => {
    const segments = root.split(/[/\\]/).filter(Boolean);
    for (const part of parts) {
      for (const seg of part.split(/[/\\]/).filter(Boolean)) {
        if (seg === '..') continue;
        segments.push(seg);
      }
    }
    return segments.join(useBackslash ? '\\' : '/');
  };

  if (normalized.startsWith('charts/')) {
    return join(normalized);
  }

  const fileName = normalized.split('/').pop();
  if (!fileName) return null;
  return join('charts', fileName);
}

export async function loadReportImageBlobUrl(
  absolutePath: string,
): Promise<string | null> {
  return loadMarkdownImageBlobUrl(absolutePath);
}
