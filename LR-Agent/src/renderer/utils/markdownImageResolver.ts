import { getExtension } from '../types/file';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

export function isRemoteMarkdownImageSrc(src: string): boolean {
  return (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('blob:')
  );
}

function isAbsoluteLocalPath(src: string): boolean {
  if (src.startsWith('/')) return true;
  return /^[a-zA-Z]:[/\\]/.test(src);
}

function normalizeLocalPath(src: string): string {
  if (src.startsWith('file://')) {
    return decodeURIComponent(src.slice('file://'.length));
  }
  return src;
}

function joinPathSegments(root: string, ...parts: string[]): string {
  const useBackslash = /\\/.test(root);
  const segments = root.split(/[/\\]/).filter(Boolean);
  for (const part of parts) {
    for (const seg of part.split(/[/\\]/).filter(Boolean)) {
      if (seg === '..') continue;
      segments.push(seg);
    }
  }
  return segments.join(useBackslash ? '\\' : '/');
}

/** 将 Markdown 图片 src 解析为本地绝对路径（相对 baseDir）。 */
export function resolveMarkdownImageAbsolutePath(
  baseDir: string,
  src: string,
): string | null {
  if (!baseDir.trim()) return null;

  const raw = normalizeLocalPath(src);
  if (isRemoteMarkdownImageSrc(raw)) return null;

  if (isAbsoluteLocalPath(raw)) {
    return raw.replace(/\//g, /\\/.test(raw) ? '\\' : '/');
  }

  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.includes('..')) return null;
  if (!normalized) return null;

  const root = baseDir.replace(/[/\\]+$/, '');
  return joinPathSegments(root, normalized);
}

function mimeTypeForPath(absolutePath: string): string {
  const ext = getExtension(absolutePath);
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export async function loadMarkdownImageBlobUrl(
  absolutePath: string,
): Promise<string | null> {
  const buffer =
    await window.electron?.fileSystem?.readFileBuffer(absolutePath);
  if (!buffer) return null;
  const blob = new Blob([buffer], { type: mimeTypeForPath(absolutePath) });
  return URL.createObjectURL(blob);
}
