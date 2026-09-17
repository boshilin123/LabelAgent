export type AgentFilePreviewSession = {
  absolutePath: string;
  relativePath: string;
  oldContent: string;
  newContent: string;
  /** rename 提案不进入 diff 预览（目标文件确认前不存在），仅为类型完备 */
  operation: 'write' | 'delete' | 'rename';
};

type Listener = () => void;

let session: AgentFilePreviewSession | null = null;
const listeners = new Set<Listener>();

export function normalizeFsPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function pathsEqual(left: string, right: string): boolean {
  return normalizeFsPath(left) === normalizeFsPath(right);
}

export function getFilePreviewSession(): AgentFilePreviewSession | null {
  return session;
}

export function setFilePreviewSession(
  next: AgentFilePreviewSession | null,
): void {
  session = next;
  listeners.forEach((listener) => listener());
}

export function clearFilePreviewSession(): void {
  setFilePreviewSession(null);
}

export function clearFilePreviewIfPathChanged(filePath: string): void {
  if (session && !pathsEqual(session.absolutePath, filePath)) {
    clearFilePreviewSession();
  }
}

export function dispatchWorkspaceTextFilesChanged(paths: string[]): void {
  if (typeof window === 'undefined') return;
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return;
  window.dispatchEvent(
    new CustomEvent('lr-agent:workspace-text-files-changed', {
      detail: { paths: unique },
    }),
  );
}

/**
 * 已变更但尚未被编辑器消费的文件路径（归一化形态）。
 *
 * Keep All 落盘后，共享 Monaco 实例的 filePath prop 可能正处于 diff 预览
 * 期间的 '' 状态，事件监听器闭包拿不到真实路径而吞掉重载信号；把变更
 * 记为待消费状态，编辑器加载该文件时强制重读磁盘，保证任何时序下
 * 已打开的 tab 都能看到最新内容。
 */
const pendingChangedPaths: string[] = [];

function normalizeChangedPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function markWorkspaceTextFilesChanged(paths: string[]): void {
  for (const path of paths) {
    if (!path) continue;
    const normalized = normalizeChangedPath(path);
    if (normalized && !pendingChangedPaths.includes(normalized)) {
      pendingChangedPaths.push(normalized);
    }
  }
  dispatchWorkspaceTextFilesChanged(paths);
}

export function peekChangedPath(filePath: string): boolean {
  if (pendingChangedPaths.length === 0) return false;
  const normalized = normalizeChangedPath(filePath);
  return pendingChangedPaths.some((changed) => {
    if (normalized === changed) return true;
    // 相对路径（提案）与绝对路径（tab）互为后缀即视为同一文件
    return (
      normalized.endsWith(`/${changed}`) || changed.endsWith(`/${normalized}`)
    );
  });
}

export function consumeChangedPath(filePath: string): void {
  if (pendingChangedPaths.length === 0) return;
  const normalized = normalizeChangedPath(filePath);
  const index = pendingChangedPaths.findIndex((changed) => {
    if (normalized === changed) return true;
    return (
      normalized.endsWith(`/${changed}`) || changed.endsWith(`/${normalized}`)
    );
  });
  if (index >= 0) pendingChangedPaths.splice(index, 1);
}

export function subscribeFilePreview(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
