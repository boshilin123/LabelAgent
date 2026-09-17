/**
 * 主进程侧"当前工作区"记录。
 *
 * 渲染层打开工作区时经 workspace:startWatch 登记（关闭时清除），
 * 供主进程内需要以工作区为基准的能力使用（如 Skill 脚本执行 cwd）。
 * 只记一个根：与 UI 的单工作区模型一致，与 authorizedRoots 的多根授权集合互补。
 */
import path from 'path';

let activeRoot: string | null = null;

/** 登记当前工作区根（传空/非法值时视为关闭工作区） */
export function setActiveWorkspaceRoot(rootPath: unknown): void {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    activeRoot = null;
    return;
  }
  try {
    activeRoot = path.resolve(rootPath);
  } catch {
    // 非法路径不更新
  }
}

/** 当前工作区根；未打开时返回 null */
export function getActiveWorkspaceRoot(): string | null {
  return activeRoot;
}

/** 仅测试用 */
export function resetActiveWorkspaceRoot(): void {
  activeRoot = null;
}
