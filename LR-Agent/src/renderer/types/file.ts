export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  isLoading?: boolean;
}

export function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

export function dirname(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (index <= 0) return filePath;
  return filePath.slice(0, index);
}

export function joinPath(...segments: string[]): string {
  const sep = '/';
  return segments
    .map((s) => s.replace(/\\/g, '/').replace(/\/+$/, ''))
    .join(sep);
}

export function relativePath(from: string, to: string): string {
  const fromParts = from.replace(/\\/g, '/').split('/');
  const toParts = to.replace(/\\/g, '/').split('/');
  // 去掉公共前缀
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i] === toParts[i]
  ) {
    i += 1;
  }
  const upCount = fromParts.length - i;
  const relParts = Array(upCount).fill('..').concat(toParts.slice(i));
  if (relParts.length === 0) return '.';
  return relParts.join('/');
}

export function getExtension(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  if (dot === 0) {
    return name.slice(1).toLowerCase();
  }
  return name.slice(dot + 1).toLowerCase();
}
