/**
 * 工作区记忆前端服务：标注任务作用域 + MEMORY.md 索引读取（经主进程 IPC）。
 *
 * 仅标注任务且开关打开时启用：projects/{annotationProjectId}
 */

export type MemoryEntry = {
  id: string;
  title: string;
  topicFile: string | null;
  relativePath: string;
  absolutePath: string;
  excerpt: string;
};

export type MemoryOpenTarget = 'explorer' | 'vscode';

const MEMORY_OPEN_TARGET_KEY = 'lr-agent.memoryOpenTarget';

type MemoryBridge = {
  electron?: {
    memory?: {
      readIndex?: (scopeKey: string) => Promise<string | null>;
      openDir?: (scopeKey: string) => Promise<string>;
      setActive?: (enabled: boolean, scopeKey?: string) => Promise<void>;
      listEntries?: (scopeKey: string) => Promise<unknown>;
      openFile?: (
        scopeKey: string,
        relativePath: string,
        target?: MemoryOpenTarget,
      ) => Promise<string>;
      syncFacts?: (options: {
        scopeKey: string;
        projectDir: string;
      }) => Promise<{ annotatedFiles: number; annotationCount: number }>;
    };
  };
};

function getBridge() {
  return (window as Window & typeof globalThis & MemoryBridge).electron?.memory;
}

function sanitizeScopeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '-');
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.relativePath === 'string' &&
    typeof item.absolutePath === 'string' &&
    typeof item.excerpt === 'string' &&
    (item.topicFile === null || typeof item.topicFile === 'string')
  );
}

export function isMemoryOpenTarget(value: unknown): value is MemoryOpenTarget {
  return value === 'explorer' || value === 'vscode';
}

export function getMemoryOpenTarget(): MemoryOpenTarget {
  try {
    const stored = window.localStorage.getItem(MEMORY_OPEN_TARGET_KEY);
    if (isMemoryOpenTarget(stored)) return stored;
  } catch {
    // localStorage 不可用时回退默认
  }
  return 'explorer';
}

export function setMemoryOpenTarget(target: MemoryOpenTarget): void {
  try {
    window.localStorage.setItem(MEMORY_OPEN_TARGET_KEY, target);
  } catch {
    // 忽略配额 / 隐私模式失败
  }
}

/** Electron IPC 失败会包一层 “Error invoking remote method ...” */
export function memoryOpenErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (raw.includes('memory_file_not_found')) {
    return '记忆文件不存在，请先让 Agent 写入或点刷新';
  }
  if (raw.includes('invalid_memory_path')) {
    return '无法打开该记忆文件';
  }
  if (raw.includes('vscode_not_found')) {
    return '未检测到 VS Code';
  }
  if (raw.includes('vscode_open_failed')) {
    return '无法用 VS Code 打开';
  }
  return raw || '无法打开记忆文件';
}

/** 仅标注任务有工作区记忆。无 projectId 时返回 null。 */
export function computeMemoryScopeKey(
  annotationProjectId?: string | null,
): string | null {
  const id = annotationProjectId?.trim();
  if (!id) return null;
  return `projects/${sanitizeScopeSegment(id)}`;
}

/**
 * 读取当前作用域的 MEMORY.md 索引（主进程已截断）。
 * 同时会把该作用域设为活动工作区记忆（MCP memory 工具使用）。
 */
export async function loadMemoryIndex(
  scopeKey: string,
): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge?.readIndex) return null;
  try {
    return await bridge.readIndex(scopeKey);
  } catch {
    return null;
  }
}

/** 开关关闭或离开标注任务时清空 MCP 活动记忆，避免上一轮 scope 残留。 */
export async function setWorkspaceMemoryActive(
  enabled: boolean,
  scopeKey?: string | null,
): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.setActive) return;
  try {
    await bridge.setActive(enabled, scopeKey ?? undefined);
  } catch {
    // 不阻塞发消息
  }
}

export async function listMemoryEntries(
  scopeKey: string,
): Promise<MemoryEntry[]> {
  const bridge = getBridge();
  if (!bridge?.listEntries) return [];
  try {
    const raw = await bridge.listEntries(scopeKey);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isMemoryEntry);
  } catch {
    return [];
  }
}

export async function openMemoryFile(
  scopeKey: string,
  relativePath: string,
  target: MemoryOpenTarget = 'explorer',
): Promise<void> {
  const bridge = getBridge();
  if (!bridge?.openFile) {
    throw new Error('无法打开记忆文件');
  }
  const error = await bridge.openFile(scopeKey, relativePath, target);
  if (error) {
    throw new Error(error);
  }
}
