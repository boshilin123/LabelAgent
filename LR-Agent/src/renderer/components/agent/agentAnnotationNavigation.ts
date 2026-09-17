import type { AnnotationProject, Modality } from '../../types/annotation';
import { basename } from '../../types/file';
import { resolveWorkspaceAbsolutePath } from '../../utils/workspacePaths';

export type AnnotationOpenTarget =
  { kind: 'file'; absolutePath: string } | { kind: 'synthetic' };

export function isSyntheticAnnotationPath(path: string): boolean {
  return path.replace(/^[/\\]+/, '').startsWith('_synthetic_/');
}

function isLikelyAbsolutePath(path: string): boolean {
  if (!path.trim()) return false;
  if (/^[/\\]/.test(path)) return true;
  return /^[a-zA-Z]:[/\\]/.test(path);
}

export function getOpenActionLabels(
  modality: Modality | undefined,
  relativePath: string,
): { button: string; ariaLabel: string } {
  const name = basename(relativePath) || relativePath;

  if (isSyntheticAnnotationPath(relativePath)) {
    return {
      button: '查看条目',
      ariaLabel: `查看合成标注条目 ${name}`,
    };
  }

  if (modality === 'text') {
    return {
      button: '查看标注',
      ariaLabel: `在标注工作区中打开 ${name}`,
    };
  }

  return {
    button: '画布查看',
    ariaLabel: `在标注画布中打开 ${name}`,
  };
}

export function resolveAnnotationOpenTarget(
  relativePath: string,
  absolutePath: string,
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): AnnotationOpenTarget | null {
  if (!relativePath.trim()) return null;

  if (isSyntheticAnnotationPath(relativePath)) {
    return { kind: 'synthetic' };
  }

  const fromAbsolute =
    absolutePath &&
    !isSyntheticAnnotationPath(absolutePath) &&
    isLikelyAbsolutePath(absolutePath)
      ? absolutePath
      : null;

  const resolved =
    fromAbsolute ??
    resolveWorkspaceAbsolutePath(relativePath, project, workspaceRoot);

  if (!resolved) return null;
  return { kind: 'file', absolutePath: resolved };
}
