import type { AnnotationProject } from '../types/annotation';
import { joinPath } from '../types/file';

export function resolveWorkspaceRoot(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  return project?.directoryPath ?? workspaceRoot;
}

export function resolveWorkspaceAbsolutePath(
  relativePath: string,
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  const root = resolveWorkspaceRoot(project, workspaceRoot);
  if (!root || !relativePath.trim()) return null;
  const cleaned = relativePath.replace(/\\/g, '/').trim();
  if (!cleaned) return null;

  // Windows 盘符路径是绝对路径：仅当指向 root 内部（不含 root 目录本身）
  // 时放行，否则 joinPath 会拼出 "root/C:/..." 垃圾路径，编辑器照样以
  // 同名打开一个读不到内容的 tab（历史 bug：两个同名文件）。
  if (/^[a-zA-Z]:\//.test(cleaned)) {
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const targetNorm = cleaned.replace(/\/+$/, '').toLowerCase();
    if (targetNorm === rootNorm) return null;
    if (!targetNorm.startsWith(`${rootNorm}/`)) return null;
    return cleaned;
  }

  // 以 / 开头的路径与后端 normalize_relative_path 语义一致：视为 root
  // 相对路径，剥掉前导斜杠与 ./ 前缀
  const rel = cleaned.replace(/^\/+/, '').replace(/^(\.\/)+/, '');
  if (!rel || rel === '.' || rel.startsWith('../') || rel.includes('/../')) {
    return null;
  }
  return joinPath(root, rel);
}
